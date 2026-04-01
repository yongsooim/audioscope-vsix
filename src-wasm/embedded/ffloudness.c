#include "config.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavfilter/avfilter.h"
#include "libavfilter/buffersink.h"
#include "libavfilter/buffersrc.h"
#include "libavfilter/f_ebur128.h"
#include "libavformat/avformat.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/frame.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/samplefmt.h"
#include "libswresample/swresample.h"

struct hist_entry {
    unsigned count;
    double energy;
    double loudness;
};

struct integrator {
    double *cache;
    int cache_pos;
    int cache_size;
    double *sum;
    int filled;
    double rel_threshold;
    double sum_kept_powers;
    int nb_kept_powers;
    struct hist_entry *histogram;
};

struct rect {
    int x;
    int y;
    int w;
    int h;
};

typedef struct AudioscopeEbur128Context {
    const AVClass *class;
    EBUR128DSPContext dsp;
    int peak_mode;
    double true_peak;
    double *true_peaks;
    double sample_peak;
    double *sample_peaks;
    double *true_peaks_per_frame;
#if CONFIG_SWRESAMPLE
    SwrContext *swr_ctx;
    double *swr_buf;
    int swr_linesize;
#endif
    int do_video;
    int w;
    int h;
    struct rect text;
    struct rect graph;
    struct rect gauge;
    AVFrame *outpicref;
    int meter;
    int scale_range;
    int y_zero_lu;
    int y_opt_max;
    int y_opt_min;
    int *y_line_ref;
    int nb_channels;
    double *ch_weighting;
    int sample_count;
    int nb_samples;
    int idx_insample;
    AVFrame *insamples;
    struct integrator i400;
    struct integrator i3000;
    double integrated_loudness;
    double loudness_range;
    double lra_low;
    double lra_high;
    int loglevel;
    int metadata;
    int dual_mono;
    double pan_law;
    int target;
    int gauge_type;
    int scale;
} AudioscopeEbur128Context;

static void print_usage(void) {
    fprintf(stderr, "usage: ffloudness <input>\n");
}

static void print_ffmpeg_error(const char *prefix, int error_code) {
    char error_buffer[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error_code, error_buffer, sizeof(error_buffer));
    fprintf(stderr, "%s: %s\n", prefix, error_buffer);
}

static void print_json_number_field(const char *name, double value, int *first_field) {
    if (!*first_field) {
        fputc(',', stdout);
    }

    fprintf(stdout, "\"%s\":", name);

    if (isfinite(value)) {
        fprintf(stdout, "%.6f", value);
    } else {
        fputs("null", stdout);
    }

    *first_field = 0;
}

static int drain_filter_sink(AVFilterContext *sink_context, AVFrame *sink_frame) {
    while (1) {
        int result = av_buffersink_get_frame(sink_context, sink_frame);

        if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) {
            return result;
        }

        if (result < 0) {
            return result;
        }

        av_frame_unref(sink_frame);
    }
}

static int create_loudness_graph(
    AVFilterGraph **graph_out,
    AVFilterContext **source_out,
    AVFilterContext **ebur128_out,
    AVFilterContext **sink_out,
    int sample_rate,
    const AVChannelLayout *channel_layout
) {
    AVFilterGraph *graph = NULL;
    AVFilterContext *source_context = NULL;
    AVFilterContext *ebur128_context = NULL;
    AVFilterContext *sink_context = NULL;
    char source_args[512];
    char channel_layout_description[128];
    int result;

    const AVFilter *buffer_source = avfilter_get_by_name("abuffer");
    const AVFilter *buffer_sink = avfilter_get_by_name("abuffersink");
    const AVFilter *ebur128_filter = avfilter_get_by_name("ebur128");

    if (buffer_source == NULL || buffer_sink == NULL || ebur128_filter == NULL) {
        return AVERROR_FILTER_NOT_FOUND;
    }

    result = av_channel_layout_describe(channel_layout, channel_layout_description, sizeof(channel_layout_description));
    if (result < 0) {
        return result;
    }

    snprintf(
        source_args,
        sizeof(source_args),
        "time_base=1/%d:sample_rate=%d:sample_fmt=%s:channel_layout=%s",
        sample_rate,
        sample_rate,
        av_get_sample_fmt_name(AV_SAMPLE_FMT_DBL),
        channel_layout_description
    );

    graph = avfilter_graph_alloc();
    if (graph == NULL) {
        return AVERROR(ENOMEM);
    }

    result = avfilter_graph_create_filter(&source_context, buffer_source, "in", source_args, NULL, graph);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_graph_create_filter(
        &ebur128_context,
        ebur128_filter,
        "loudness",
        "video=0:framelog=quiet:peak=sample+true",
        NULL,
        graph
    );
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_graph_create_filter(&sink_context, buffer_sink, "out", NULL, NULL, graph);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_link(source_context, 0, ebur128_context, 0);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_link(ebur128_context, 0, sink_context, 0);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_graph_config(graph, NULL);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    *graph_out = graph;
    *source_out = source_context;
    *ebur128_out = ebur128_context;
    *sink_out = sink_context;
    return 0;
}

static int process_decoded_frame(
    AVFrame *decoded_frame,
    SwrContext *resampler,
    const AVChannelLayout *output_layout,
    int output_sample_rate,
    int64_t *output_pts,
    AVFilterContext *source_context,
    AVFilterContext *sink_context,
    AVFrame *sink_frame
) {
    AVFrame *converted_frame = NULL;
    int dst_samples;
    int converted_samples;
    int result;

    dst_samples = av_rescale_rnd(
        swr_get_delay(resampler, decoded_frame->sample_rate) + decoded_frame->nb_samples,
        output_sample_rate,
        decoded_frame->sample_rate,
        AV_ROUND_UP
    );

    converted_frame = av_frame_alloc();
    if (converted_frame == NULL) {
        return AVERROR(ENOMEM);
    }

    converted_frame->format = AV_SAMPLE_FMT_DBL;
    converted_frame->nb_samples = dst_samples;
    converted_frame->sample_rate = output_sample_rate;
    result = av_channel_layout_copy(&converted_frame->ch_layout, output_layout);
    if (result < 0) {
        av_frame_free(&converted_frame);
        return result;
    }

    result = av_frame_get_buffer(converted_frame, 0);
    if (result < 0) {
        av_frame_free(&converted_frame);
        return result;
    }

    converted_samples = swr_convert(
        resampler,
        converted_frame->extended_data,
        dst_samples,
        (const uint8_t **) decoded_frame->extended_data,
        decoded_frame->nb_samples
    );
    if (converted_samples < 0) {
        av_frame_free(&converted_frame);
        return converted_samples;
    }

    converted_frame->nb_samples = converted_samples;
    converted_frame->pts = *output_pts;
    *output_pts += converted_samples;

    result = av_buffersrc_add_frame_flags(source_context, converted_frame, AV_BUFFERSRC_FLAG_KEEP_REF);
    av_frame_free(&converted_frame);
    if (result < 0) {
        return result;
    }

    result = drain_filter_sink(sink_context, sink_frame);
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) {
        return 0;
    }

    return result;
}

static int flush_decoder(
    AVCodecContext *decoder_context,
    SwrContext *resampler,
    const AVChannelLayout *output_layout,
    int output_sample_rate,
    int64_t *output_pts,
    AVFilterContext *source_context,
    AVFilterContext *sink_context,
    AVFrame *decoded_frame,
    AVFrame *sink_frame
) {
    int result = avcodec_send_packet(decoder_context, NULL);
    if (result < 0 && result != AVERROR_EOF) {
        return result;
    }

    while (1) {
        result = avcodec_receive_frame(decoder_context, decoded_frame);

        if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) {
          return 0;
        }

        if (result < 0) {
            return result;
        }

        result = process_decoded_frame(
            decoded_frame,
            resampler,
            output_layout,
            output_sample_rate,
            output_pts,
            source_context,
            sink_context,
            sink_frame
        );
        av_frame_unref(decoded_frame);
        if (result < 0) {
            return result;
        }
    }
}

int main(int argc, char **argv) {
    const char *input_path;
    AVFormatContext *format_context = NULL;
    const AVCodec *decoder = NULL;
    AVCodecContext *decoder_context = NULL;
    AVPacket *packet = NULL;
    AVFrame *decoded_frame = NULL;
    AVFrame *sink_frame = NULL;
    AVFilterGraph *filter_graph = NULL;
    AVFilterContext *buffer_source_context = NULL;
    AVFilterContext *ebur128_filter_context = NULL;
    AVFilterContext *buffer_sink_context = NULL;
    SwrContext *resampler = NULL;
    AVChannelLayout output_layout = { 0 };
    AudioscopeEbur128Context *ebur128 = NULL;
    int audio_stream_index;
    int output_sample_rate;
    int64_t output_pts = 0;
    int first_field = 1;
    int result = 1;

    av_log_set_level(AV_LOG_QUIET);

    if (argc == 2 && strcmp(argv[1], "-version") == 0) {
        fprintf(stdout, "ffloudness version 1\n");
        return 0;
    }

    if (argc != 2) {
        print_usage();
        return 1;
    }

    input_path = argv[1];

    if (avformat_open_input(&format_context, input_path, NULL, NULL) < 0) {
        fprintf(stderr, "Unable to open input file.\n");
        goto cleanup;
    }

    if (avformat_find_stream_info(format_context, NULL) < 0) {
        fprintf(stderr, "Unable to read input stream info.\n");
        goto cleanup;
    }

    audio_stream_index = av_find_best_stream(format_context, AVMEDIA_TYPE_AUDIO, -1, -1, &decoder, 0);
    if (audio_stream_index < 0 || decoder == NULL) {
        fprintf(stderr, "Input file does not contain a decodable audio stream.\n");
        goto cleanup;
    }

    decoder_context = avcodec_alloc_context3(decoder);
    if (decoder_context == NULL) {
        fprintf(stderr, "Unable to allocate decoder context.\n");
        goto cleanup;
    }

    if (avcodec_parameters_to_context(
            decoder_context,
            format_context->streams[audio_stream_index]->codecpar
        ) < 0) {
        fprintf(stderr, "Unable to copy decoder parameters.\n");
        goto cleanup;
    }

    if (avcodec_open2(decoder_context, decoder, NULL) < 0) {
        fprintf(stderr, "Unable to open audio decoder.\n");
        goto cleanup;
    }

    if (decoder_context->ch_layout.nb_channels > 0 && decoder_context->ch_layout.order != AV_CHANNEL_ORDER_UNSPEC) {
        if (av_channel_layout_copy(&output_layout, &decoder_context->ch_layout) < 0) {
            fprintf(stderr, "Unable to copy output channel layout.\n");
            goto cleanup;
        }
    } else {
        av_channel_layout_default(&output_layout, decoder_context->ch_layout.nb_channels > 0 ? decoder_context->ch_layout.nb_channels : 2);
    }

    output_sample_rate = decoder_context->sample_rate > 0 ? decoder_context->sample_rate : 44100;

    if (swr_alloc_set_opts2(
            &resampler,
            &output_layout,
            AV_SAMPLE_FMT_DBL,
            output_sample_rate,
            &decoder_context->ch_layout,
            decoder_context->sample_fmt,
            decoder_context->sample_rate,
            0,
            NULL
        ) < 0 || resampler == NULL) {
        fprintf(stderr, "Unable to configure audio resampler.\n");
        goto cleanup;
    }

    if (swr_init(resampler) < 0) {
        fprintf(stderr, "Unable to initialize audio resampler.\n");
        goto cleanup;
    }

    {
        int graph_result = create_loudness_graph(
            &filter_graph,
            &buffer_source_context,
            &ebur128_filter_context,
            &buffer_sink_context,
            output_sample_rate,
            &output_layout
        );
        if (graph_result < 0) {
            print_ffmpeg_error("Unable to configure loudness filter graph", graph_result);
            goto cleanup;
        }
    }

    packet = av_packet_alloc();
    decoded_frame = av_frame_alloc();
    sink_frame = av_frame_alloc();
    if (packet == NULL || decoded_frame == NULL || sink_frame == NULL) {
        fprintf(stderr, "Unable to allocate FFmpeg packet/frame.\n");
        goto cleanup;
    }

    while (av_read_frame(format_context, packet) >= 0) {
        int send_result;

        if (packet->stream_index != audio_stream_index) {
            av_packet_unref(packet);
            continue;
        }

        send_result = avcodec_send_packet(decoder_context, packet);
        av_packet_unref(packet);

        if (send_result < 0) {
            print_ffmpeg_error("Unable to send packet to decoder", send_result);
            goto cleanup;
        }

        while (1) {
            int receive_result = avcodec_receive_frame(decoder_context, decoded_frame);

            if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
                break;
            }

            if (receive_result < 0) {
                print_ffmpeg_error("Decoder failed", receive_result);
                goto cleanup;
            }

            if (process_decoded_frame(
                    decoded_frame,
                    resampler,
                    &output_layout,
                    output_sample_rate,
                    &output_pts,
                    buffer_source_context,
                    buffer_sink_context,
                    sink_frame
                ) < 0) {
                fprintf(stderr, "Unable to process decoded audio frame.\n");
                goto cleanup;
            }

            av_frame_unref(decoded_frame);
        }
    }

    if (flush_decoder(
            decoder_context,
            resampler,
            &output_layout,
            output_sample_rate,
            &output_pts,
            buffer_source_context,
            buffer_sink_context,
            decoded_frame,
            sink_frame
        ) < 0) {
        fprintf(stderr, "Unable to flush audio decoder.\n");
        goto cleanup;
    }

    {
        int flush_result = av_buffersrc_add_frame_flags(buffer_source_context, NULL, 0);
        if (flush_result < 0) {
            print_ffmpeg_error("Unable to flush loudness filter graph", flush_result);
            goto cleanup;
        }
    }

    while (1) {
        int sink_result = drain_filter_sink(buffer_sink_context, sink_frame);

        if (sink_result == AVERROR_EOF) {
            break;
        }

        if (sink_result == AVERROR(EAGAIN)) {
            continue;
        }

        if (sink_result < 0) {
            print_ffmpeg_error("Unable to drain loudness filter graph", sink_result);
            goto cleanup;
        }
    }

    if (ebur128_filter_context == NULL || ebur128_filter_context->priv == NULL) {
        fprintf(stderr, "Loudness filter state is unavailable.\n");
        goto cleanup;
    }

    ebur128 = (AudioscopeEbur128Context *) ebur128_filter_context->priv;

    fputc('{', stdout);
    print_json_number_field("integratedLufs", ebur128->integrated_loudness, &first_field);
    print_json_number_field("integratedThresholdLufs", ebur128->i400.rel_threshold, &first_field);
    print_json_number_field("loudnessRangeLu", ebur128->loudness_range, &first_field);
    print_json_number_field("rangeThresholdLufs", ebur128->i3000.rel_threshold, &first_field);
    print_json_number_field("lraLowLufs", ebur128->lra_low, &first_field);
    print_json_number_field("lraHighLufs", ebur128->lra_high, &first_field);
    print_json_number_field("samplePeakDbfs", ebur128->sample_peak, &first_field);
    print_json_number_field("truePeakDbtp", ebur128->true_peak, &first_field);
    fprintf(stdout, ",\"channelCount\":%d", output_layout.nb_channels);
    {
        char channel_layout_description[128];
        if (av_channel_layout_describe(&output_layout, channel_layout_description, sizeof(channel_layout_description)) >= 0) {
            fprintf(stdout, ",\"channelLayout\":\"%s\"", channel_layout_description);
        } else {
            fputs(",\"channelLayout\":null", stdout);
        }
    }
    fputs("}\n", stdout);
    result = 0;

cleanup:
    av_channel_layout_uninit(&output_layout);
    av_packet_free(&packet);
    av_frame_free(&decoded_frame);
    av_frame_free(&sink_frame);
    avfilter_graph_free(&filter_graph);
    swr_free(&resampler);
    avcodec_free_context(&decoder_context);
    avformat_close_input(&format_context);
    return result;
}
