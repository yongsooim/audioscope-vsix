// Native wrapper around the same decoder and retained-PCM loudness implementation
// as ffdecode_module.wasm. PCM goes to a temporary file; stdout contains a
// 16-byte ADP1 readiness header followed by the loudness JSON.
#include "ffdecode_module.c"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static void write_u32_le(uint8_t *destination, uint32_t value) {
    destination[0] = (uint8_t) value;
    destination[1] = (uint8_t) (value >> 8);
    destination[2] = (uint8_t) (value >> 16);
    destination[3] = (uint8_t) (value >> 24);
}

static void write_number(const char *name, double value) {
    printf(",\"%s\":", name);
    if (isfinite(value)) {
        printf("%.17g", value);
    } else {
        fputs("null", stdout);
    }
}

int main(int argc, char **argv) {
    uint8_t header[16] = { 'A', 'D', 'P', '1' };
    FILE *pcm_file = NULL;
    int channel_index;
    int result = 1;

    if (argc != 3) {
        fprintf(stderr, "usage: ffdecode <input> <output.pcm>\n");
        return 1;
    }
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    av_log_set_level(AV_LOG_ERROR);
    if (wave_decode_file(argv[1]) != 0) {
        fprintf(stderr, "%s\n", wave_get_last_error_ptr());
        goto cleanup;
    }
    write_u32_le(header + 4, (uint32_t) g_sample_rate);
    write_u32_le(header + 8, (uint32_t) g_channel_count);
    write_u32_le(header + 12, (uint32_t) g_frame_count);
    pcm_file = fopen(argv[2], "wb");
    if (pcm_file == NULL) {
        fprintf(stderr, "Unable to open PCM output: %s\n", strerror(errno));
        goto cleanup;
    }
    for (channel_index = 0; channel_index < g_channel_count; channel_index += 1) {
        if (fwrite(g_channel_buffers[channel_index], sizeof(float), g_frame_count, pcm_file) != (size_t) g_frame_count) {
            goto cleanup;
        }
    }
    if (fclose(pcm_file) != 0) {
        pcm_file = NULL;
        goto cleanup;
    }
    pcm_file = NULL;
    if (fwrite(header, 1, sizeof(header), stdout) != sizeof(header)) {
        goto cleanup;
    }
    // Release the PCM to the host before starting the more expensive analysis.
    if (fflush(stdout) != 0) {
        goto cleanup;
    }
    if (wave_measure_loudness_from_decoded_output() != 0) {
        fprintf(stderr, "%s\n", wave_get_last_error_ptr());
        goto cleanup;
    }
    // av_channel_layout_describe produces FFmpeg's fixed layout names.
    printf("{\"channelCount\":%d,\"channelLayout\":\"%s\"", g_channel_count, wave_get_output_channel_layout_ptr());
    write_number("integratedLufs", g_integrated_lufs);
    write_number("integratedThresholdLufs", g_integrated_threshold_lufs);
    write_number("loudnessRangeLu", g_loudness_range_lu);
    write_number("rangeThresholdLufs", g_range_threshold_lufs);
    write_number("lraLowLufs", g_lra_low_lufs);
    write_number("lraHighLufs", g_lra_high_lufs);
    write_number("samplePeakDbfs", g_sample_peak_dbfs);
    write_number("truePeakDbtp", g_true_peak_dbtp);
    fputs("}\n", stdout);
    result = ferror(stdout) ? 1 : 0;
cleanup:
    if (pcm_file != NULL) fclose(pcm_file);
    wave_clear_decode_output();
    return result;
}
