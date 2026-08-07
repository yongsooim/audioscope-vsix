// Exports a time range of the first audio stream to wav / flac / m4a / mp3.
// Decodes from the start of the file and counts samples (no container seek),
// so the cut is sample-accurate on the decoded timeline the UI displays.
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/audio_fifo.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/samplefmt.h"
#include "libswresample/swresample.h"

typedef struct ExportFormatSpec {
    const char *name;           // CLI format argument
    const char *muxer_name;     // avformat output format name
    const char *encoder_name;   // avcodec encoder name
    enum AVSampleFormat sample_format;
    int64_t bit_rate;           // 0 = leave encoder default
    int max_channels;           // 0 = no limit
} ExportFormatSpec;

static const ExportFormatSpec FORMAT_SPECS[] = {
    { "wav", "wav", "pcm_s16le", AV_SAMPLE_FMT_S16, 0, 0 },
    { "flac", "flac", "flac", AV_SAMPLE_FMT_S16, 0, 0 },
    { "m4a", "ipod", "aac", AV_SAMPLE_FMT_FLTP, 192000, 0 },
    { "mp3", "mp3", "libmp3lame", AV_SAMPLE_FMT_FLTP, 192000, 2 },
};

static void print_usage(void) {
    fprintf(stderr, "usage: ffencode <input> <output> <wav|flac|m4a|mp3> <start_seconds> <end_seconds>\n");
}

static void print_ffmpeg_error(const char *prefix, int error_code) {
    char error_buffer[AV_ERROR_MAX_STRING_SIZE];
    av_strerror(error_code, error_buffer, sizeof(error_buffer));
    fprintf(stderr, "%s: %s\n", prefix, error_buffer);
}

static const ExportFormatSpec *find_format_spec(const char *name) {
    for (size_t index = 0; index < sizeof(FORMAT_SPECS) / sizeof(FORMAT_SPECS[0]); index += 1) {
        if (strcmp(FORMAT_SPECS[index].name, name) == 0) {
            return &FORMAT_SPECS[index];
        }
    }

    return NULL;
}

// Sends one encoder frame (or NULL to flush) and writes the produced packets.
static int encode_and_write(
    AVFormatContext *output_context,
    AVCodecContext *encoder_context,
    AVStream *output_stream,
    AVPacket *packet,
    AVFrame *frame
) {
    int send_result = avcodec_send_frame(encoder_context, frame);
    if (send_result < 0) {
        print_ffmpeg_error("Unable to send frame to encoder", send_result);
        return send_result;
    }

    while (1) {
        int receive_result = avcodec_receive_packet(encoder_context, packet);
        if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
            return 0;
        }
        if (receive_result < 0) {
            print_ffmpeg_error("Encoder failed", receive_result);
            return receive_result;
        }

        av_packet_rescale_ts(packet, encoder_context->time_base, output_stream->time_base);
        packet->stream_index = output_stream->index;

        int write_result = av_interleaved_write_frame(output_context, packet);
        av_packet_unref(packet);
        if (write_result < 0) {
            print_ffmpeg_error("Unable to write output packet", write_result);
            return write_result;
        }
    }
}

// Drains the FIFO into fixed-size encoder frames. When `flush_partial` is set
// the trailing partial frame is encoded too (end of the export range).
static int drain_fifo(
    AVAudioFifo *fifo,
    int encoder_frame_size,
    int flush_partial,
    AVFormatContext *output_context,
    AVCodecContext *encoder_context,
    AVStream *output_stream,
    AVPacket *packet,
    int64_t *next_pts
) {
    while (1) {
        int available = av_audio_fifo_size(fifo);
        int take = available >= encoder_frame_size
            ? encoder_frame_size
            : (flush_partial && available > 0 ? available : 0);

        if (take <= 0) {
            return 0;
        }

        AVFrame *encode_frame = av_frame_alloc();
        if (encode_frame == NULL) {
            fprintf(stderr, "Unable to allocate encoder frame.\n");
            return AVERROR(ENOMEM);
        }

        encode_frame->nb_samples = take;
        encode_frame->format = encoder_context->sample_fmt;
        encode_frame->sample_rate = encoder_context->sample_rate;
        int layout_result = av_channel_layout_copy(&encode_frame->ch_layout, &encoder_context->ch_layout);
        int buffer_result = layout_result >= 0 ? av_frame_get_buffer(encode_frame, 0) : layout_result;
        if (buffer_result < 0) {
            print_ffmpeg_error("Unable to allocate encoder frame buffer", buffer_result);
            av_frame_free(&encode_frame);
            return buffer_result;
        }

        if (av_audio_fifo_read(fifo, (void **) encode_frame->data, take) < take) {
            fprintf(stderr, "Unable to read samples from FIFO.\n");
            av_frame_free(&encode_frame);
            return AVERROR_UNKNOWN;
        }

        encode_frame->pts = *next_pts;
        *next_pts += take;

        int encode_result = encode_and_write(output_context, encoder_context, output_stream, packet, encode_frame);
        av_frame_free(&encode_frame);
        if (encode_result < 0) {
            return encode_result;
        }
    }
}

// Slices the decoded frame to its overlap with [start_frame, end_frame),
// converts it to the encoder layout/format, buffers it, and encodes any full
// encoder frames that became available. Advances *input_position.
static int process_decoded_frame(
    AVFrame *frame,
    const AVCodecContext *decoder_context,
    const AVChannelLayout *source_layout,
    const AVChannelLayout *target_layout,
    SwrContext *resampler,
    AVAudioFifo *fifo,
    AVFormatContext *output_context,
    AVCodecContext *encoder_context,
    AVStream *output_stream,
    AVPacket *output_packet,
    int encoder_frame_size,
    int sample_rate,
    int64_t start_frame,
    int64_t end_frame,
    int64_t *input_position,
    int64_t *next_pts
) {
    int64_t frame_start = *input_position;
    int64_t frame_end = frame_start + frame->nb_samples;
    *input_position = frame_end;

    int64_t take_start = frame_start > start_frame ? frame_start : start_frame;
    int64_t take_end = frame_end < end_frame ? frame_end : end_frame;

    if (take_end <= take_start) {
        return 0;
    }

    int offset = (int) (take_start - frame_start);
    int take = (int) (take_end - take_start);
    const uint8_t *input_planes[AV_NUM_DATA_POINTERS] = { NULL };
    int bytes_per_sample = av_get_bytes_per_sample(decoder_context->sample_fmt);
    int is_planar = av_sample_fmt_is_planar(decoder_context->sample_fmt);
    int plane_count = is_planar ? source_layout->nb_channels : 1;
    int stride = is_planar ? bytes_per_sample : bytes_per_sample * source_layout->nb_channels;

    for (int plane = 0; plane < plane_count && plane < AV_NUM_DATA_POINTERS; plane += 1) {
        input_planes[plane] = frame->extended_data[plane] + (size_t) offset * stride;
    }

    AVFrame *converted_frame = av_frame_alloc();
    if (converted_frame == NULL) {
        fprintf(stderr, "Unable to allocate conversion frame.\n");
        return AVERROR(ENOMEM);
    }
    converted_frame->nb_samples = take;
    converted_frame->format = encoder_context->sample_fmt;
    converted_frame->sample_rate = sample_rate;
    if (av_channel_layout_copy(&converted_frame->ch_layout, target_layout) < 0
        || av_frame_get_buffer(converted_frame, 0) < 0) {
        fprintf(stderr, "Unable to allocate conversion buffer.\n");
        av_frame_free(&converted_frame);
        return AVERROR(ENOMEM);
    }

    int converted = swr_convert(
        resampler,
        converted_frame->data,
        take,
        input_planes,
        take
    );
    if (converted < 0) {
        fprintf(stderr, "Unable to convert audio samples.\n");
        av_frame_free(&converted_frame);
        return converted;
    }

    if (converted > 0 && av_audio_fifo_write(fifo, (void **) converted_frame->data, converted) < converted) {
        fprintf(stderr, "Unable to buffer converted samples.\n");
        av_frame_free(&converted_frame);
        return AVERROR_UNKNOWN;
    }

    av_frame_free(&converted_frame);

    return drain_fifo(fifo, encoder_frame_size, 0, output_context, encoder_context, output_stream, output_packet, next_pts);
}

int main(int argc, char **argv) {
    AVFormatContext *format_context = NULL;
    AVFormatContext *output_context = NULL;
    const AVCodec *decoder = NULL;
    AVCodecContext *decoder_context = NULL;
    const AVCodec *encoder = NULL;
    AVCodecContext *encoder_context = NULL;
    AVStream *output_stream = NULL;
    AVPacket *packet = NULL;
    AVPacket *output_packet = NULL;
    AVFrame *frame = NULL;
    SwrContext *resampler = NULL;
    AVAudioFifo *fifo = NULL;
    AVChannelLayout source_layout = { 0 };
    AVChannelLayout target_layout = { 0 };
    const ExportFormatSpec *spec;
    const char *input_path;
    const char *output_path;
    double start_seconds;
    double end_seconds;
    int audio_stream_index;
    int sample_rate;
    int encoder_frame_size;
    int64_t start_frame;
    int64_t end_frame;
    int64_t input_position = 0;
    int64_t next_pts = 0;
    int header_written = 0;
    int result = 1;

    if (argc == 2 && strcmp(argv[1], "-version") == 0) {
        fprintf(stdout, "ffencode version 1\n");
        return 0;
    }

    if (argc != 6) {
        print_usage();
        return 1;
    }

    input_path = argv[1];
    output_path = argv[2];
    spec = find_format_spec(argv[3]);
    start_seconds = atof(argv[4]);
    end_seconds = atof(argv[5]);

    if (spec == NULL) {
        print_usage();
        return 1;
    }

    if (!(end_seconds > start_seconds) || start_seconds < 0) {
        fprintf(stderr, "Invalid export range.\n");
        return 1;
    }

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

    sample_rate = decoder_context->sample_rate > 0 ? decoder_context->sample_rate : 44100;
    start_frame = (int64_t) (start_seconds * sample_rate + 0.5);
    end_frame = (int64_t) (end_seconds * sample_rate + 0.5);

    if (decoder_context->ch_layout.nb_channels > 0 && decoder_context->ch_layout.order != AV_CHANNEL_ORDER_UNSPEC) {
        if (av_channel_layout_copy(&source_layout, &decoder_context->ch_layout) < 0) {
            fprintf(stderr, "Unable to copy source channel layout.\n");
            goto cleanup;
        }
    } else {
        int fallback_channels = decoder_context->ch_layout.nb_channels > 0
            ? decoder_context->ch_layout.nb_channels
            : 2;
        av_channel_layout_default(&source_layout, fallback_channels);
    }

    if (spec->max_channels > 0 && source_layout.nb_channels > spec->max_channels) {
        av_channel_layout_default(&target_layout, spec->max_channels);
    } else if (av_channel_layout_copy(&target_layout, &source_layout) < 0) {
        fprintf(stderr, "Unable to copy target channel layout.\n");
        goto cleanup;
    }

    encoder = avcodec_find_encoder_by_name(spec->encoder_name);
    if (encoder == NULL) {
        fprintf(stderr, "Encoder %s is unavailable in this build.\n", spec->encoder_name);
        goto cleanup;
    }

    if (avformat_alloc_output_context2(&output_context, NULL, spec->muxer_name, output_path) < 0 || output_context == NULL) {
        fprintf(stderr, "Unable to allocate output context.\n");
        goto cleanup;
    }

    encoder_context = avcodec_alloc_context3(encoder);
    if (encoder_context == NULL) {
        fprintf(stderr, "Unable to allocate encoder context.\n");
        goto cleanup;
    }

    encoder_context->sample_fmt = spec->sample_format;
    encoder_context->sample_rate = sample_rate;
    encoder_context->time_base = (AVRational) { 1, sample_rate };
    if (spec->bit_rate > 0) {
        encoder_context->bit_rate = spec->bit_rate;
    }
    if (av_channel_layout_copy(&encoder_context->ch_layout, &target_layout) < 0) {
        fprintf(stderr, "Unable to set encoder channel layout.\n");
        goto cleanup;
    }
    if (output_context->oformat->flags & AVFMT_GLOBALHEADER) {
        encoder_context->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    }

    {
        int open_result = avcodec_open2(encoder_context, encoder, NULL);
        if (open_result < 0) {
            print_ffmpeg_error("Unable to open encoder (unsupported sample rate or channel count?)", open_result);
            goto cleanup;
        }
    }

    output_stream = avformat_new_stream(output_context, NULL);
    if (output_stream == NULL) {
        fprintf(stderr, "Unable to allocate output stream.\n");
        goto cleanup;
    }
    output_stream->time_base = encoder_context->time_base;
    if (avcodec_parameters_from_context(output_stream->codecpar, encoder_context) < 0) {
        fprintf(stderr, "Unable to copy encoder parameters.\n");
        goto cleanup;
    }

    if (!(output_context->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&output_context->pb, output_path, AVIO_FLAG_WRITE) < 0) {
            fprintf(stderr, "Unable to open output file.\n");
            goto cleanup;
        }
    }

    if (avformat_write_header(output_context, NULL) < 0) {
        fprintf(stderr, "Unable to write output header.\n");
        goto cleanup;
    }
    header_written = 1;

    if (swr_alloc_set_opts2(
            &resampler,
            &target_layout,
            encoder_context->sample_fmt,
            sample_rate,
            &source_layout,
            decoder_context->sample_fmt,
            sample_rate,
            0,
            NULL
        ) < 0 || resampler == NULL || swr_init(resampler) < 0) {
        fprintf(stderr, "Unable to configure sample converter.\n");
        goto cleanup;
    }

    encoder_frame_size = encoder_context->frame_size > 0 ? encoder_context->frame_size : 4096;
    fifo = av_audio_fifo_alloc(encoder_context->sample_fmt, target_layout.nb_channels, encoder_frame_size * 2);
    packet = av_packet_alloc();
    output_packet = av_packet_alloc();
    frame = av_frame_alloc();
    if (fifo == NULL || packet == NULL || output_packet == NULL || frame == NULL) {
        fprintf(stderr, "Unable to allocate FFmpeg objects.\n");
        goto cleanup;
    }

    while (input_position < end_frame && av_read_frame(format_context, packet) >= 0) {
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
            if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
                break;
            }
            if (receive_result < 0) {
                print_ffmpeg_error("Decoder failed", receive_result);
                goto cleanup;
            }

            int process_result = process_decoded_frame(
                frame, decoder_context, &source_layout, &target_layout, resampler, fifo,
                output_context, encoder_context, output_stream, output_packet,
                encoder_frame_size, sample_rate, start_frame, end_frame, &input_position, &next_pts
            );
            av_frame_unref(frame);
            if (process_result < 0) {
                goto cleanup;
            }

            if (input_position >= end_frame) {
                break;
            }
        }
    }

    // Flush the decoder: codecs with decoder delay (aac, mp3, …) still hold
    // buffered frames after the last packet, which matter when the range end
    // reaches the end of the file.
    if (input_position < end_frame) {
        if (avcodec_send_packet(decoder_context, NULL) < 0) {
            fprintf(stderr, "Unable to flush decoder.\n");
            goto cleanup;
        }

        while (input_position < end_frame) {
            int receive_result = avcodec_receive_frame(decoder_context, frame);
            if (receive_result == AVERROR(EAGAIN) || receive_result == AVERROR_EOF) {
                break;
            }
            if (receive_result < 0) {
                print_ffmpeg_error("Decoder flush failed", receive_result);
                goto cleanup;
            }

            int process_result = process_decoded_frame(
                frame, decoder_context, &source_layout, &target_layout, resampler, fifo,
                output_context, encoder_context, output_stream, output_packet,
                encoder_frame_size, sample_rate, start_frame, end_frame, &input_position, &next_pts
            );
            av_frame_unref(frame);
            if (process_result < 0) {
                goto cleanup;
            }
        }
    }

    if (drain_fifo(fifo, encoder_frame_size, 1, output_context, encoder_context, output_stream, output_packet, &next_pts) < 0) {
        goto cleanup;
    }

    if (next_pts <= 0) {
        fprintf(stderr, "The requested range contained no audio samples.\n");
        goto cleanup;
    }

    if (encode_and_write(output_context, encoder_context, output_stream, output_packet, NULL) < 0) {
        goto cleanup;
    }

    if (av_write_trailer(output_context) < 0) {
        fprintf(stderr, "Unable to finalize output file.\n");
        goto cleanup;
    }
    header_written = 0;

    result = 0;

cleanup:
    if (header_written) {
        av_write_trailer(output_context);
    }
    if (frame != NULL) {
        av_frame_free(&frame);
    }
    if (packet != NULL) {
        av_packet_free(&packet);
    }
    if (output_packet != NULL) {
        av_packet_free(&output_packet);
    }
    if (fifo != NULL) {
        av_audio_fifo_free(fifo);
    }
    if (resampler != NULL) {
        swr_free(&resampler);
    }
    if (decoder_context != NULL) {
        avcodec_free_context(&decoder_context);
    }
    if (encoder_context != NULL) {
        avcodec_free_context(&encoder_context);
    }
    if (output_context != NULL) {
        if (!(output_context->oformat->flags & AVFMT_NOFILE) && output_context->pb != NULL) {
            avio_closep(&output_context->pb);
        }
        avformat_free_context(output_context);
    }
    if (format_context != NULL) {
        avformat_close_input(&format_context);
    }
    av_channel_layout_uninit(&source_layout);
    av_channel_layout_uninit(&target_layout);

    return result;
}
