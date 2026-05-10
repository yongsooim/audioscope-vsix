#include "config.h"

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/opt.h"
#include "libswresample/swresample.h"

#include "loudness_graph.h"

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

static int process_decoded_frame(
    AVFrame *decoded_frame,
    SwrContext *resampler,
    const AVChannelLayout *output_layout,
    int output_sample_rate,
    int64_t *output_pts,
    ConvertedFrameCache *converted_frame_cache,
    AVFilterContext *source_context,
    AVFilterContext *sink_context,
    AVFrame *sink_frame
) {
    AVFrame *converted_frame;
    int dst_samples;
    int converted_samples;
    int result;

    dst_samples = av_rescale_rnd(
        swr_get_delay(resampler, decoded_frame->sample_rate) + decoded_frame->nb_samples,
        output_sample_rate,
        decoded_frame->sample_rate,
        AV_ROUND_UP
    );

    result = audioscope_ensure_converted_frame_capacity(
        converted_frame_cache,
        output_layout,
        output_sample_rate,
        dst_samples
    );
    if (result < 0) {
        return result;
    }

    converted_frame = converted_frame_cache->frame;
    converted_samples = swr_convert(
        resampler,
        converted_frame->extended_data,
        dst_samples,
        (const uint8_t **) decoded_frame->extended_data,
        decoded_frame->nb_samples
    );
    if (converted_samples < 0) {
        return converted_samples;
    }

    converted_frame->nb_samples = converted_samples;
    converted_frame->pts = *output_pts;
    *output_pts += converted_samples;

    result = av_buffersrc_add_frame_flags(source_context, converted_frame, AV_BUFFERSRC_FLAG_KEEP_REF);
    if (result < 0) {
        return result;
    }

    result = audioscope_drain_filter_sink(sink_context, sink_frame);
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
    ConvertedFrameCache *converted_frame_cache,
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
            converted_frame_cache,
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
    ConvertedFrameCache converted_frame_cache = { 0 };
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
        int graph_result = audioscope_create_loudness_graph(
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
                    &converted_frame_cache,
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
            &converted_frame_cache,
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
        int sink_result = audioscope_drain_filter_sink(buffer_sink_context, sink_frame);

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
    av_frame_free(&converted_frame_cache.frame);
    av_frame_free(&sink_frame);
    avfilter_graph_free(&filter_graph);
    swr_free(&resampler);
    avcodec_free_context(&decoder_context);
    avformat_close_input(&format_context);
    return result;
}
