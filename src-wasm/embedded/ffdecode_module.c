#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/opt.h"
#include "libswresample/swresample.h"

#include "loudness_graph.h"

static float **g_channel_buffers = NULL;
static int g_channel_capacity = 0;
static int g_channel_count = 0;
static int g_frame_count = 0;
static char *g_last_error = NULL;
static int g_sample_rate = 0;
static char *g_channel_layout_description = NULL;
static double g_integrated_lufs = NAN;
static double g_integrated_threshold_lufs = NAN;
static double g_loudness_range_lu = NAN;
static double g_range_threshold_lufs = NAN;
static double g_lra_low_lufs = NAN;
static double g_lra_high_lufs = NAN;
static double g_sample_peak_dbfs = NAN;
static double g_true_peak_dbtp = NAN;

static void clear_last_error(void) {
    if (g_last_error != NULL) {
        av_free(g_last_error);
        g_last_error = NULL;
    }
}

static void set_last_error(const char *format, ...) {
    va_list args;
    va_list retry_args;
    char stack_buffer[512];
    size_t required_size;
    int written;

    clear_last_error();

    va_start(args, format);
    va_copy(retry_args, args);
    written = vsnprintf(stack_buffer, sizeof(stack_buffer), format, args);
    va_end(args);

    if (written < 0) {
        va_end(retry_args);
        return;
    }

    required_size = (size_t) written + 1;
    g_last_error = av_malloc(required_size);
    if (g_last_error == NULL) {
        va_end(retry_args);
        return;
    }

    if (required_size <= sizeof(stack_buffer)) {
        memcpy(g_last_error, stack_buffer, required_size);
        va_end(retry_args);
        return;
    }

    vsnprintf(g_last_error, required_size, format, retry_args);
    va_end(retry_args);
}

static void set_ffmpeg_error(const char *prefix, int error_code) {
    char error_buffer[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error_code, error_buffer, sizeof(error_buffer));
    set_last_error("%s: %s", prefix, error_buffer);
}

static void clear_channel_layout_description(void) {
    if (g_channel_layout_description != NULL) {
        av_free(g_channel_layout_description);
        g_channel_layout_description = NULL;
    }
}

static void clear_loudness_summary(void) {
    g_integrated_lufs = NAN;
    g_integrated_threshold_lufs = NAN;
    g_loudness_range_lu = NAN;
    g_range_threshold_lufs = NAN;
    g_lra_low_lufs = NAN;
    g_lra_high_lufs = NAN;
    g_sample_peak_dbfs = NAN;
    g_true_peak_dbtp = NAN;
}

static void set_output_channel_layout_description(const AVChannelLayout *output_layout) {
    char description[128];

    clear_channel_layout_description();

    if (output_layout == NULL) {
        return;
    }

    if (av_channel_layout_describe(output_layout, description, sizeof(description)) < 0) {
        return;
    }

    g_channel_layout_description = av_strdup(description);
}

EMSCRIPTEN_KEEPALIVE void wave_clear_decode_output(void) {
    int channel_index;

    if (g_channel_buffers != NULL) {
        for (channel_index = 0; channel_index < g_channel_count; channel_index += 1) {
            av_free(g_channel_buffers[channel_index]);
        }
        av_free(g_channel_buffers);
        g_channel_buffers = NULL;
    }

    g_channel_capacity = 0;
    g_channel_count = 0;
    g_frame_count = 0;
    g_sample_rate = 0;
    clear_channel_layout_description();
    clear_loudness_summary();
}

static int ensure_output_capacity(int required_frames) {
    int next_capacity;
    int channel_index;

    if (required_frames <= g_channel_capacity) {
        return 0;
    }

    next_capacity = g_channel_capacity > 0 ? g_channel_capacity : 4096;
    while (next_capacity < required_frames) {
        next_capacity *= 2;
    }

    for (channel_index = 0; channel_index < g_channel_count; channel_index += 1) {
        float *next_buffer = av_realloc(
            g_channel_buffers[channel_index],
            (size_t) next_capacity * sizeof(float)
        );

        if (next_buffer == NULL) {
            set_last_error("Unable to allocate decoded PCM output buffer.");
            return AVERROR(ENOMEM);
        }

        g_channel_buffers[channel_index] = next_buffer;
    }

    g_channel_capacity = next_capacity;
    return 0;
}

static int push_converted_frame_to_loudness_graph(
    AVFrame *converted_frame,
    int64_t *output_pts,
    AVFilterContext *source_context,
    AVFilterContext *sink_context,
    AVFrame *sink_frame
) {
    int result;

    converted_frame->pts = *output_pts;
    *output_pts += converted_frame->nb_samples;

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

static int process_pcm_chunk_for_loudness(
    const AVChannelLayout *output_layout,
    int output_sample_rate,
    SwrContext *resampler,
    ConvertedFrameCache *converted_frame_cache,
    const uint8_t **input_planes,
    int frame_offset,
    int sample_count,
    int64_t *output_pts,
    AVFilterContext *source_context,
    AVFilterContext *sink_context,
    AVFrame *sink_frame
) {
    AVFrame *converted_frame;
    int dst_samples;
    int converted_samples;
    int channel_index;
    int result;

    dst_samples = av_rescale_rnd(
        swr_get_delay(resampler, output_sample_rate) + sample_count,
        output_sample_rate,
        output_sample_rate,
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

    for (channel_index = 0; channel_index < g_channel_count; channel_index += 1) {
        input_planes[channel_index] = (const uint8_t *) (g_channel_buffers[channel_index] + frame_offset);
    }

    converted_frame = converted_frame_cache->frame;
    converted_samples = swr_convert(
        resampler,
        converted_frame->extended_data,
        dst_samples,
        input_planes,
        sample_count
    );
    if (converted_samples < 0) {
        return converted_samples;
    }

    if (converted_samples == 0) {
        return 0;
    }

    converted_frame->nb_samples = converted_samples;
    return push_converted_frame_to_loudness_graph(
        converted_frame,
        output_pts,
        source_context,
        sink_context,
        sink_frame
    );
}

static int flush_loudness_resampler(
    const AVChannelLayout *output_layout,
    int output_sample_rate,
    SwrContext *resampler,
    ConvertedFrameCache *converted_frame_cache,
    int64_t *output_pts,
    AVFilterContext *source_context,
    AVFilterContext *sink_context,
    AVFrame *sink_frame
) {
    while (1) {
        AVFrame *converted_frame;
        int dst_samples = av_rescale_rnd(
            swr_get_delay(resampler, output_sample_rate),
            output_sample_rate,
            output_sample_rate,
            AV_ROUND_UP
        );
        int converted_samples;
        int result;

        if (dst_samples <= 0) {
            return 0;
        }

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
            NULL,
            0
        );
        if (converted_samples < 0) {
            return converted_samples;
        }

        if (converted_samples == 0) {
            return 0;
        }

        converted_frame->nb_samples = converted_samples;
        result = push_converted_frame_to_loudness_graph(
            converted_frame,
            output_pts,
            source_context,
            sink_context,
            sink_frame
        );
        if (result < 0) {
            return result;
        }
    }
}

static int measure_loudness_from_decoded_output(const AVChannelLayout *output_layout) {
    AVFilterGraph *filter_graph = NULL;
    AVFilterContext *buffer_source_context = NULL;
    AVFilterContext *ebur128_filter_context = NULL;
    AVFilterContext *buffer_sink_context = NULL;
    AVFrame *sink_frame = NULL;
    SwrContext *resampler = NULL;
    ConvertedFrameCache converted_frame_cache = { 0 };
    const uint8_t **input_planes = NULL;
    AudioscopeEbur128Context *ebur128 = NULL;
    int64_t output_pts = 0;
    int result;
    int frame_offset = 0;

    if (g_channel_buffers == NULL || g_channel_count <= 0 || g_frame_count <= 0) {
        set_last_error("Decoded PCM output is unavailable for loudness analysis.");
        return AVERROR(EINVAL);
    }

    result = audioscope_create_loudness_graph(
        &filter_graph,
        &buffer_source_context,
        &ebur128_filter_context,
        &buffer_sink_context,
        g_sample_rate,
        output_layout
    );
    if (result < 0) {
        set_ffmpeg_error("Unable to configure loudness filter graph", result);
        goto cleanup;
    }

    result = swr_alloc_set_opts2(
        &resampler,
        output_layout,
        AV_SAMPLE_FMT_DBL,
        g_sample_rate,
        output_layout,
        AV_SAMPLE_FMT_FLTP,
        g_sample_rate,
        0,
        NULL
    );
    if (result < 0 || resampler == NULL) {
        set_last_error("Unable to configure loudness resampler.");
        result = result < 0 ? result : AVERROR(ENOMEM);
        goto cleanup;
    }

    result = swr_init(resampler);
    if (result < 0) {
        set_ffmpeg_error("Unable to initialize loudness resampler", result);
        goto cleanup;
    }

    sink_frame = av_frame_alloc();
    if (sink_frame == NULL) {
        set_last_error("Unable to allocate loudness sink frame.");
        result = AVERROR(ENOMEM);
        goto cleanup;
    }

    input_planes = av_calloc((size_t) g_channel_count, sizeof(*input_planes));
    if (input_planes == NULL) {
        set_last_error("Unable to allocate loudness input planes.");
        result = AVERROR(ENOMEM);
        goto cleanup;
    }

    while (frame_offset < g_frame_count) {
        int sample_count = g_frame_count - frame_offset;
        if (sample_count > 4096) {
            sample_count = 4096;
        }

        result = process_pcm_chunk_for_loudness(
            output_layout,
            g_sample_rate,
            resampler,
            &converted_frame_cache,
            input_planes,
            frame_offset,
            sample_count,
            &output_pts,
            buffer_source_context,
            buffer_sink_context,
            sink_frame
        );
        if (result < 0) {
            set_ffmpeg_error("Unable to process decoded PCM for loudness", result);
            goto cleanup;
        }

        frame_offset += sample_count;
    }

    result = flush_loudness_resampler(
        output_layout,
        g_sample_rate,
        resampler,
        &converted_frame_cache,
        &output_pts,
        buffer_source_context,
        buffer_sink_context,
        sink_frame
    );
    if (result < 0) {
        set_ffmpeg_error("Unable to flush loudness resampler", result);
        goto cleanup;
    }

    result = av_buffersrc_add_frame_flags(buffer_source_context, NULL, 0);
    if (result < 0) {
        set_ffmpeg_error("Unable to flush loudness filter graph", result);
        goto cleanup;
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
            set_ffmpeg_error("Unable to drain loudness filter graph", sink_result);
            result = sink_result;
            goto cleanup;
        }
    }

    if (ebur128_filter_context == NULL || ebur128_filter_context->priv == NULL) {
        set_last_error("Loudness filter state is unavailable.");
        result = AVERROR(EINVAL);
        goto cleanup;
    }

    ebur128 = (AudioscopeEbur128Context *) ebur128_filter_context->priv;
    g_integrated_threshold_lufs = ebur128->i400.rel_threshold;
    g_range_threshold_lufs = ebur128->i3000.rel_threshold;

    if (av_opt_get_double(ebur128_filter_context->priv, "integrated", 0, &g_integrated_lufs) < 0) {
        g_integrated_lufs = ebur128->integrated_loudness;
    }
    if (av_opt_get_double(ebur128_filter_context->priv, "range", 0, &g_loudness_range_lu) < 0) {
        g_loudness_range_lu = ebur128->loudness_range;
    }
    if (av_opt_get_double(ebur128_filter_context->priv, "lra_low", 0, &g_lra_low_lufs) < 0) {
        g_lra_low_lufs = ebur128->lra_low;
    }
    if (av_opt_get_double(ebur128_filter_context->priv, "lra_high", 0, &g_lra_high_lufs) < 0) {
        g_lra_high_lufs = ebur128->lra_high;
    }
    if (av_opt_get_double(ebur128_filter_context->priv, "sample_peak", 0, &g_sample_peak_dbfs) < 0) {
        g_sample_peak_dbfs = ebur128->sample_peak;
    }
    if (av_opt_get_double(ebur128_filter_context->priv, "true_peak", 0, &g_true_peak_dbtp) < 0) {
        g_true_peak_dbtp = ebur128->true_peak;
    }
    result = 0;

cleanup:
    av_freep(&input_planes);
    av_frame_free(&converted_frame_cache.frame);
    av_frame_free(&sink_frame);
    avfilter_graph_free(&filter_graph);
    swr_free(&resampler);
    return result;
}

static int wave_decode_file_internal(const char *input_path) {
    AVFormatContext *format_context = NULL;
    const AVCodec *decoder = NULL;
    AVCodecContext *decoder_context = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    SwrContext *resampler = NULL;
    AVChannelLayout output_layout = { 0 };
    int audio_stream_index;
    int fallback_channel_count;
    int output_channel_count;
    int result = -1;

    clear_last_error();
    wave_clear_decode_output();

    if (input_path == NULL || input_path[0] == '\0') {
        set_last_error("Input path is empty.");
        return -1;
    }

    if (avformat_open_input(&format_context, input_path, NULL, NULL) < 0) {
        set_last_error("Unable to open input file.");
        goto cleanup;
    }

    if (avformat_find_stream_info(format_context, NULL) < 0) {
        set_last_error("Unable to read input stream info.");
        goto cleanup;
    }

    audio_stream_index = av_find_best_stream(format_context, AVMEDIA_TYPE_AUDIO, -1, -1, &decoder, 0);
    if (audio_stream_index < 0 || decoder == NULL) {
        set_last_error("Input file does not contain a decodable audio stream.");
        goto cleanup;
    }

    decoder_context = avcodec_alloc_context3(decoder);
    if (decoder_context == NULL) {
        set_last_error("Unable to allocate decoder context.");
        goto cleanup;
    }

    if (avcodec_parameters_to_context(
            decoder_context,
            format_context->streams[audio_stream_index]->codecpar
        ) < 0) {
        set_last_error("Unable to copy decoder parameters.");
        goto cleanup;
    }

    if (avcodec_open2(decoder_context, decoder, NULL) < 0) {
        set_last_error("Unable to open audio decoder.");
        goto cleanup;
    }

    fallback_channel_count = decoder_context->ch_layout.nb_channels;
    if (fallback_channel_count <= 0) {
        fallback_channel_count = format_context->streams[audio_stream_index]->codecpar->ch_layout.nb_channels;
    }
    if (fallback_channel_count <= 0) {
        fallback_channel_count = 2;
    }

    if (decoder_context->ch_layout.nb_channels > 0 && decoder_context->ch_layout.order != AV_CHANNEL_ORDER_UNSPEC) {
        if (av_channel_layout_copy(&output_layout, &decoder_context->ch_layout) < 0) {
            set_last_error("Unable to copy output channel layout.");
            goto cleanup;
        }
    } else {
        av_channel_layout_default(&output_layout, fallback_channel_count);
    }

    output_channel_count = output_layout.nb_channels;
    if (output_channel_count <= 0) {
        set_last_error("Decoded audio has no output channels.");
        goto cleanup;
    }

    g_channel_buffers = av_calloc((size_t) output_channel_count, sizeof(float *));
    if (g_channel_buffers == NULL) {
        set_last_error("Unable to allocate decoded PCM channel buffers.");
        goto cleanup;
    }

    g_channel_count = output_channel_count;
    g_sample_rate = decoder_context->sample_rate > 0 ? decoder_context->sample_rate : 44100;
    set_output_channel_layout_description(&output_layout);

    if (swr_alloc_set_opts2(
            &resampler,
            &output_layout,
            AV_SAMPLE_FMT_FLTP,
            g_sample_rate,
            &decoder_context->ch_layout,
            decoder_context->sample_fmt,
            decoder_context->sample_rate,
            0,
            NULL
        ) < 0 || resampler == NULL) {
        set_last_error("Unable to configure audio resampler.");
        goto cleanup;
    }

    if (swr_init(resampler) < 0) {
        set_last_error("Unable to initialize audio resampler.");
        goto cleanup;
    }

    packet = av_packet_alloc();
    frame = av_frame_alloc();
    if (packet == NULL || frame == NULL) {
        set_last_error("Unable to allocate FFmpeg packet/frame.");
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
            set_ffmpeg_error("Unable to send packet to decoder", send_result);
            goto cleanup;
        }

        while (1) {
            int receive_result = avcodec_receive_frame(decoder_context, frame);
            int dst_samples;
            int ensure_result;
            int converted_samples;
            uint8_t *output_planes[AV_NUM_DATA_POINTERS] = { 0 };
            int channel_index;

            if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
                break;
            }

            if (receive_result < 0) {
                set_ffmpeg_error("Decoder failed", receive_result);
                goto cleanup;
            }

            dst_samples = av_rescale_rnd(
                swr_get_delay(resampler, decoder_context->sample_rate) + frame->nb_samples,
                g_sample_rate,
                decoder_context->sample_rate,
                AV_ROUND_UP
            );

            ensure_result = ensure_output_capacity(g_frame_count + dst_samples);
            if (ensure_result < 0) {
                goto cleanup;
            }

            for (channel_index = 0; channel_index < g_channel_count; channel_index += 1) {
                output_planes[channel_index] = (uint8_t *) (g_channel_buffers[channel_index] + g_frame_count);
            }

            converted_samples = swr_convert(
                resampler,
                output_planes,
                dst_samples,
                (const uint8_t **) frame->extended_data,
                frame->nb_samples
            );

            if (converted_samples < 0) {
                set_ffmpeg_error("Unable to convert audio samples", converted_samples);
                goto cleanup;
            }

            g_frame_count += converted_samples;
            av_frame_unref(frame);
        }
    }

    if (avcodec_send_packet(decoder_context, NULL) < 0) {
        set_last_error("Unable to flush decoder.");
        goto cleanup;
    }

    while (1) {
        int receive_result = avcodec_receive_frame(decoder_context, frame);
        int dst_samples;
        int ensure_result;
        int converted_samples;
        uint8_t *output_planes[AV_NUM_DATA_POINTERS] = { 0 };
        int channel_index;

        if (receive_result == AVERROR_EOF || receive_result == AVERROR(EAGAIN)) {
            break;
        }

        if (receive_result < 0) {
            set_ffmpeg_error("Decoder flush failed", receive_result);
            goto cleanup;
        }

        dst_samples = av_rescale_rnd(
            swr_get_delay(resampler, decoder_context->sample_rate) + frame->nb_samples,
            g_sample_rate,
            decoder_context->sample_rate,
            AV_ROUND_UP
        );

        ensure_result = ensure_output_capacity(g_frame_count + dst_samples);
        if (ensure_result < 0) {
            goto cleanup;
        }

        for (channel_index = 0; channel_index < g_channel_count; channel_index += 1) {
            output_planes[channel_index] = (uint8_t *) (g_channel_buffers[channel_index] + g_frame_count);
        }

        converted_samples = swr_convert(
            resampler,
            output_planes,
            dst_samples,
            (const uint8_t **) frame->extended_data,
            frame->nb_samples
        );

        if (converted_samples < 0) {
            set_ffmpeg_error("Unable to convert audio samples", converted_samples);
            goto cleanup;
        }

        g_frame_count += converted_samples;
        av_frame_unref(frame);
    }

    result = 0;

cleanup:
    if (frame != NULL) {
        av_frame_free(&frame);
    }
    if (packet != NULL) {
        av_packet_free(&packet);
    }
    if (resampler != NULL) {
        swr_free(&resampler);
    }
    if (decoder_context != NULL) {
        avcodec_free_context(&decoder_context);
    }
    if (format_context != NULL) {
        avformat_close_input(&format_context);
    }
    av_channel_layout_uninit(&output_layout);

    if (result != 0) {
        wave_clear_decode_output();
    }

    return result;
}

EMSCRIPTEN_KEEPALIVE int wave_decode_file(const char *input_path) {
    return wave_decode_file_internal(input_path);
}

EMSCRIPTEN_KEEPALIVE int wave_measure_loudness_from_decoded_output(void) {
    AVChannelLayout output_layout = { 0 };
    int result;

    clear_last_error();
    clear_loudness_summary();

    if (g_channel_count <= 0 || g_frame_count <= 0) {
        set_last_error("Decoded PCM output is unavailable for loudness analysis.");
        return -1;
    }

    if (
        g_channel_layout_description == NULL
        || av_channel_layout_from_string(&output_layout, g_channel_layout_description) < 0
    ) {
        av_channel_layout_default(&output_layout, g_channel_count);
    }

    result = measure_loudness_from_decoded_output(&output_layout);
    av_channel_layout_uninit(&output_layout);
    return result;
}

EMSCRIPTEN_KEEPALIVE int wave_decode_file_with_loudness(const char *input_path) {
    int result = wave_decode_file_internal(input_path);
    if (result != 0) {
        return result;
    }

    return wave_measure_loudness_from_decoded_output();
}

EMSCRIPTEN_KEEPALIVE int wave_get_output_channel_count(void) {
    return g_channel_count;
}

EMSCRIPTEN_KEEPALIVE int wave_get_output_sample_rate(void) {
    return g_sample_rate;
}

EMSCRIPTEN_KEEPALIVE int wave_get_output_frame_count(void) {
    return g_frame_count;
}

EMSCRIPTEN_KEEPALIVE uintptr_t wave_get_output_channel_ptr(int channel_index) {
    if (channel_index < 0 || channel_index >= g_channel_count || g_channel_buffers == NULL) {
        return 0;
    }

    return (uintptr_t) g_channel_buffers[channel_index];
}

EMSCRIPTEN_KEEPALIVE int wave_get_output_channel_byte_length(void) {
    return g_frame_count > 0 ? (int) ((size_t) g_frame_count * sizeof(float)) : 0;
}

EMSCRIPTEN_KEEPALIVE const char *wave_get_output_channel_layout_ptr(void) {
    return g_channel_layout_description != NULL ? g_channel_layout_description : "";
}

EMSCRIPTEN_KEEPALIVE int wave_get_output_channel_layout_length(void) {
    return g_channel_layout_description != NULL ? (int) strlen(g_channel_layout_description) : 0;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_integrated_lufs(void) {
    return g_integrated_lufs;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_integrated_threshold_lufs(void) {
    return g_integrated_threshold_lufs;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_range_lu(void) {
    return g_loudness_range_lu;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_range_threshold_lufs(void) {
    return g_range_threshold_lufs;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_lra_low_lufs(void) {
    return g_lra_low_lufs;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_lra_high_lufs(void) {
    return g_lra_high_lufs;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_sample_peak_dbfs(void) {
    return g_sample_peak_dbfs;
}

EMSCRIPTEN_KEEPALIVE double wave_get_loudness_true_peak_dbtp(void) {
    return g_true_peak_dbtp;
}

EMSCRIPTEN_KEEPALIVE const char *wave_get_last_error_ptr(void) {
    return g_last_error != NULL ? g_last_error : "";
}

EMSCRIPTEN_KEEPALIVE int wave_get_last_error_length(void) {
    return g_last_error != NULL ? (int) strlen(g_last_error) : 0;
}
