#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/mem.h"
#include "libavutil/samplefmt.h"
#include "libswresample/swresample.h"

static float **g_channel_buffers = NULL;
static int g_channel_capacity = 0;
static int g_channel_count = 0;
static int g_frame_count = 0;
static char *g_last_error = NULL;
static int g_sample_rate = 0;

static void clear_last_error(void) {
    if (g_last_error != NULL) {
        av_free(g_last_error);
        g_last_error = NULL;
    }
}

static void set_last_error(const char *format, ...) {
    va_list args;
    char stack_buffer[512];
    int written;

    clear_last_error();

    va_start(args, format);
    written = vsnprintf(stack_buffer, sizeof(stack_buffer), format, args);
    va_end(args);

    if (written < 0) {
        return;
    }

    g_last_error = av_malloc((size_t) written + 1);
    if (g_last_error == NULL) {
        return;
    }

    memcpy(g_last_error, stack_buffer, (size_t) written);
    g_last_error[written] = '\0';
}

static void set_ffmpeg_error(const char *prefix, int error_code) {
    char error_buffer[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error_code, error_buffer, sizeof(error_buffer));
    set_last_error("%s: %s", prefix, error_buffer);
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

EMSCRIPTEN_KEEPALIVE int wave_decode_file(const char *input_path) {
    AVFormatContext *format_context = NULL;
    const AVCodec *decoder = NULL;
    AVCodecContext *decoder_context = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    SwrContext *resampler = NULL;
    AVChannelLayout output_layout = { 0 };
    int audio_stream_index;
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

    if (decoder_context->ch_layout.nb_channels > 0 && decoder_context->ch_layout.order != AV_CHANNEL_ORDER_UNSPEC) {
        if (av_channel_layout_copy(&output_layout, &decoder_context->ch_layout) < 0) {
            set_last_error("Unable to copy output channel layout.");
            goto cleanup;
        }
    } else {
        output_layout = (AVChannelLayout) AV_CHANNEL_LAYOUT_STEREO;
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

EMSCRIPTEN_KEEPALIVE const char *wave_get_last_error_ptr(void) {
    return g_last_error != NULL ? g_last_error : "";
}

EMSCRIPTEN_KEEPALIVE int wave_get_last_error_length(void) {
    return g_last_error != NULL ? (int) strlen(g_last_error) : 0;
}
