#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/samplefmt.h"
#include "libswresample/swresample.h"

static void print_usage(void) {
    fprintf(stderr, "usage: ffdecode <input> <output.wav>\n");
}

static int write_wav_header(FILE *file, int sample_rate, int channels, int bytes_written) {
    const uint16_t audio_format = 3; // IEEE float
    const uint16_t bits_per_sample = 32;
    const uint16_t channels_u16 = (uint16_t) channels;
    const uint16_t block_align = (uint16_t) (channels * (bits_per_sample / 8));
    const uint32_t byte_rate = (uint32_t) sample_rate * block_align;
    const uint32_t riff_size = (uint32_t) (36 + bytes_written);
    const uint32_t data_size = (uint32_t) bytes_written;

    if (fseek(file, 0, SEEK_SET) != 0) {
        return AVERROR(errno);
    }

    fwrite("RIFF", 1, 4, file);
    fwrite(&riff_size, sizeof(riff_size), 1, file);
    fwrite("WAVE", 1, 4, file);
    fwrite("fmt ", 1, 4, file);
    {
        const uint32_t fmt_chunk_size = 16;
        fwrite(&fmt_chunk_size, sizeof(fmt_chunk_size), 1, file);
    }
    fwrite(&audio_format, sizeof(audio_format), 1, file);
    fwrite(&channels_u16, sizeof(channels_u16), 1, file);
    fwrite(&sample_rate, sizeof(uint32_t), 1, file);
    fwrite(&byte_rate, sizeof(byte_rate), 1, file);
    fwrite(&block_align, sizeof(block_align), 1, file);
    fwrite(&bits_per_sample, sizeof(bits_per_sample), 1, file);
    fwrite("data", 1, 4, file);
    fwrite(&data_size, sizeof(data_size), 1, file);

    return ferror(file) ? AVERROR(errno) : 0;
}

static void print_ffmpeg_error(const char *prefix, int error_code) {
    char error_buffer[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error_code, error_buffer, sizeof(error_buffer));
    fprintf(stderr, "%s: %s\n", prefix, error_buffer);
}

int main(int argc, char **argv) {
    const char *input_path;
    const char *output_path;
    AVFormatContext *format_context = NULL;
    const AVCodec *decoder = NULL;
    AVCodecContext *decoder_context = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    SwrContext *resampler = NULL;
    FILE *output_file = NULL;
    uint8_t *resampled_data = NULL;
    int resampled_capacity = 0;
    int bytes_written = 0;
    int audio_stream_index;
    int output_channels;
    int output_sample_rate;
    AVChannelLayout output_layout = { 0 };
    int result = 1;

    if (argc == 2 && strcmp(argv[1], "-version") == 0) {
        fprintf(stdout, "ffdecode version 1\n");
        return 0;
    }

    if (argc != 3) {
      print_usage();
      return 1;
    }

    input_path = argv[1];
    output_path = argv[2];

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
        output_layout = (AVChannelLayout) AV_CHANNEL_LAYOUT_STEREO;
    }
    output_channels = output_layout.nb_channels;
    output_sample_rate = decoder_context->sample_rate > 0 ? decoder_context->sample_rate : 44100;

    if (swr_alloc_set_opts2(
            &resampler,
            &output_layout,
            AV_SAMPLE_FMT_FLT,
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

    output_file = fopen(output_path, "wb+");
    if (output_file == NULL) {
        fprintf(stderr, "Unable to open output file.\n");
        goto cleanup;
    }

    {
        uint8_t placeholder[44] = { 0 };
        fwrite(placeholder, sizeof(placeholder), 1, output_file);
    }

    packet = av_packet_alloc();
    frame = av_frame_alloc();
    if (packet == NULL || frame == NULL) {
        fprintf(stderr, "Unable to allocate FFmpeg packet/frame.\n");
        goto cleanup;
    }

    while (av_read_frame(format_context, packet) >= 0) {
        if (packet->stream_index != audio_stream_index) {
            av_packet_unref(packet);
            continue;
        }

        if (avcodec_send_packet(decoder_context, packet) < 0) {
            av_packet_unref(packet);
            fprintf(stderr, "Unable to send packet to decoder.\n");
            goto cleanup;
        }
        av_packet_unref(packet);

        while (1) {
            int receive_result = avcodec_receive_frame(decoder_context, frame);
            int dst_samples;
            int required_bytes;

            if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
                break;
            }

            if (receive_result < 0) {
                print_ffmpeg_error("Decoder failed", receive_result);
                goto cleanup;
            }

            dst_samples = av_rescale_rnd(
                swr_get_delay(resampler, decoder_context->sample_rate) + frame->nb_samples,
                output_sample_rate,
                decoder_context->sample_rate,
                AV_ROUND_UP
            );
            required_bytes = av_samples_get_buffer_size(
                NULL,
                output_channels,
                dst_samples,
                AV_SAMPLE_FMT_FLT,
                1
            );

            if (required_bytes < 0) {
                fprintf(stderr, "Unable to size output sample buffer.\n");
                goto cleanup;
            }

            if (required_bytes > resampled_capacity) {
                uint8_t *next_buffer = av_realloc(resampled_data, required_bytes);
                if (next_buffer == NULL) {
                    fprintf(stderr, "Unable to allocate resample buffer.\n");
                    goto cleanup;
                }
                resampled_data = next_buffer;
                resampled_capacity = required_bytes;
            }

            {
                uint8_t *output_planes[] = { resampled_data, NULL };
                int converted_samples = swr_convert(
                    resampler,
                    output_planes,
                    dst_samples,
                    (const uint8_t **) frame->extended_data,
                    frame->nb_samples
                );

                if (converted_samples < 0) {
                    fprintf(stderr, "Unable to convert audio samples.\n");
                    goto cleanup;
                }

                required_bytes = av_samples_get_buffer_size(
                    NULL,
                    output_channels,
                    converted_samples,
                    AV_SAMPLE_FMT_FLT,
                    1
                );

                if (required_bytes < 0 || fwrite(resampled_data, 1, required_bytes, output_file) != (size_t) required_bytes) {
                    fprintf(stderr, "Unable to write output WAV data.\n");
                    goto cleanup;
                }

                bytes_written += required_bytes;
            }

            av_frame_unref(frame);
        }
    }

    if (avcodec_send_packet(decoder_context, NULL) < 0) {
        fprintf(stderr, "Unable to flush decoder.\n");
        goto cleanup;
    }

    while (1) {
        int receive_result = avcodec_receive_frame(decoder_context, frame);
        int dst_samples;
        int required_bytes;

        if (receive_result == AVERROR_EOF || receive_result == AVERROR(EAGAIN)) {
            break;
        }

        if (receive_result < 0) {
            print_ffmpeg_error("Decoder flush failed", receive_result);
            goto cleanup;
        }

        dst_samples = av_rescale_rnd(
            swr_get_delay(resampler, decoder_context->sample_rate) + frame->nb_samples,
            output_sample_rate,
            decoder_context->sample_rate,
            AV_ROUND_UP
        );
        required_bytes = av_samples_get_buffer_size(
            NULL,
            output_channels,
            dst_samples,
            AV_SAMPLE_FMT_FLT,
            1
        );

        if (required_bytes > resampled_capacity) {
            uint8_t *next_buffer = av_realloc(resampled_data, required_bytes);
            if (next_buffer == NULL) {
                fprintf(stderr, "Unable to allocate resample buffer.\n");
                goto cleanup;
            }
            resampled_data = next_buffer;
            resampled_capacity = required_bytes;
        }

        {
            uint8_t *output_planes[] = { resampled_data, NULL };
            int converted_samples = swr_convert(
                resampler,
                output_planes,
                dst_samples,
                (const uint8_t **) frame->extended_data,
                frame->nb_samples
            );

            if (converted_samples < 0) {
                fprintf(stderr, "Unable to convert audio samples.\n");
                goto cleanup;
            }

            required_bytes = av_samples_get_buffer_size(
                NULL,
                output_channels,
                converted_samples,
                AV_SAMPLE_FMT_FLT,
                1
            );

            if (required_bytes < 0 || fwrite(resampled_data, 1, required_bytes, output_file) != (size_t) required_bytes) {
                fprintf(stderr, "Unable to write output WAV data.\n");
                goto cleanup;
            }

            bytes_written += required_bytes;
        }

        av_frame_unref(frame);
    }

    if (write_wav_header(output_file, output_sample_rate, output_channels, bytes_written) < 0) {
        fprintf(stderr, "Unable to finalize WAV header.\n");
        goto cleanup;
    }

    result = 0;

cleanup:
    if (output_file != NULL) {
        fclose(output_file);
    }
    if (resampled_data != NULL) {
        av_free(resampled_data);
    }
    if (resampler != NULL) {
        swr_free(&resampler);
    }
    if (frame != NULL) {
        av_frame_free(&frame);
    }
    if (packet != NULL) {
        av_packet_free(&packet);
    }
    if (decoder_context != NULL) {
        avcodec_free_context(&decoder_context);
    }
    if (format_context != NULL) {
        avformat_close_input(&format_context);
    }
    av_channel_layout_uninit(&output_layout);

    return result;
}
