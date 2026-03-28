#include <emscripten/emscripten.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "third_party/pffft/pffft.h"

#define MIN_LEVEL_BLOCK_SIZE 16
#define LEVEL_SCALE_FACTOR 4
#define MIN_LEVEL_BUCKETS 512

#define HARD_MIN_FREQUENCY 20.0f
#define HARD_MAX_FREQUENCY 20000.0f
#define MIN_DB -92.0f
#define MAX_DB -12.0f
#define LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY 1200.0f

typedef struct {
  int block_size;
  int block_count;
  float *min_peaks;
  float *max_peaks;
} WaveLevel;

typedef struct FftResource {
  int fft_size;
  PFFFT_Setup *setup;
  float *input;
  float *output;
  float *work;
  float *window;
  struct FftResource *next;
} FftResource;

typedef struct {
  int start_bin;
  int end_bin;
  float start_frequency;
  float end_frequency;
} BandRange;

typedef struct {
  float *samples;
  int sample_count;
  float sample_rate;
  float duration;
  float min_frequency;
  float max_frequency;
  WaveLevel *levels;
  int level_count;
  FftResource *fft_resources;
} WaveSession;

static WaveSession g_session = {0};

static inline float clampf32(float value, float min_value, float max_value) {
  if (value < min_value) {
    return min_value;
  }

  if (value > max_value) {
    return max_value;
  }

  return value;
}

static inline double clampf64(double value, double min_value, double max_value) {
  if (value < min_value) {
    return min_value;
  }

  if (value > max_value) {
    return max_value;
  }

  return value;
}

static inline int clampi32(int value, int min_value, int max_value) {
  if (value < min_value) {
    return min_value;
  }

  if (value > max_value) {
    return max_value;
  }

  return value;
}

static inline int ceil_div_i32(int numerator, int denominator) {
  return (numerator + denominator - 1) / denominator;
}

static inline int min_i32(int left, int right) {
  return left < right ? left : right;
}

static inline int max_i32(int left, int right) {
  return left > right ? left : right;
}

static inline float min_f32(float left, float right) {
  return left < right ? left : right;
}

static inline float max_f32(float left, float right) {
  return left > right ? left : right;
}

static void free_wave_levels(void) {
  if (!g_session.levels) {
    g_session.level_count = 0;
    return;
  }

  for (int index = 0; index < g_session.level_count; index += 1) {
    free(g_session.levels[index].min_peaks);
    free(g_session.levels[index].max_peaks);
  }

  free(g_session.levels);
  g_session.levels = NULL;
  g_session.level_count = 0;
}

static void free_fft_resources(void) {
  FftResource *resource = g_session.fft_resources;

  while (resource) {
    FftResource *next = resource->next;

    if (resource->setup) {
      pffft_destroy_setup(resource->setup);
    }

    if (resource->input) {
      pffft_aligned_free(resource->input);
    }

    if (resource->output) {
      pffft_aligned_free(resource->output);
    }

    if (resource->work) {
      pffft_aligned_free(resource->work);
    }

    free(resource->window);
    free(resource);
    resource = next;
  }

  g_session.fft_resources = NULL;
}

static void reset_session_state(void) {
  free_wave_levels();
  free_fft_resources();
  free(g_session.samples);
  g_session.samples = NULL;
  g_session.sample_count = 0;
  g_session.sample_rate = 0;
  g_session.duration = 0;
  g_session.min_frequency = HARD_MIN_FREQUENCY;
  g_session.max_frequency = HARD_MAX_FREQUENCY;
}

static int compute_level_count(int sample_count) {
  if (sample_count <= 0) {
    return 0;
  }

  int level_count = 0;
  int block_size = MIN_LEVEL_BLOCK_SIZE;

  while (block_size < sample_count) {
    level_count += 1;

    if (ceil_div_i32(sample_count, block_size) <= MIN_LEVEL_BUCKETS) {
      break;
    }

    block_size *= LEVEL_SCALE_FACTOR;
  }

  return level_count;
}

static FftResource *get_fft_resource(int fft_size) {
  FftResource *resource = g_session.fft_resources;

  while (resource) {
    if (resource->fft_size == fft_size) {
      return resource;
    }

    resource = resource->next;
  }

  resource = (FftResource *)calloc(1, sizeof(FftResource));

  if (!resource) {
    return NULL;
  }

  resource->fft_size = fft_size;
  resource->setup = pffft_new_setup(fft_size, PFFFT_REAL);

  if (!resource->setup) {
    free(resource);
    return NULL;
  }

  resource->input = (float *)pffft_aligned_malloc((size_t)fft_size * sizeof(float));
  resource->output = (float *)pffft_aligned_malloc((size_t)fft_size * sizeof(float));
  resource->work = (float *)pffft_aligned_malloc((size_t)fft_size * sizeof(float));
  resource->window = (float *)malloc((size_t)fft_size * sizeof(float));

  if (!resource->input || !resource->output || !resource->work || !resource->window) {
    if (resource->setup) {
      pffft_destroy_setup(resource->setup);
    }

    if (resource->input) {
      pffft_aligned_free(resource->input);
    }

    if (resource->output) {
      pffft_aligned_free(resource->output);
    }

    if (resource->work) {
      pffft_aligned_free(resource->work);
    }

    free(resource->window);
    free(resource);
    return NULL;
  }

  for (int index = 0; index < fft_size; index += 1) {
    resource->window[index] = 0.5f * (1.0f - cosf((2.0f * (float)M_PI * (float)index) / (float)(fft_size - 1)));
  }

  resource->next = g_session.fft_resources;
  g_session.fft_resources = resource;
  return resource;
}

static const WaveLevel *pick_waveform_level(double samples_per_pixel) {
  const WaveLevel *selected = NULL;

  for (int index = 0; index < g_session.level_count; index += 1) {
    const WaveLevel *level = &g_session.levels[index];

    if ((double)level->block_size <= samples_per_pixel * 1.5) {
      selected = level;
      continue;
    }

    break;
  }

  return selected;
}

static void get_sample_range(int start_sample, int end_sample, float *min_value, float *max_value) {
  int clamped_start = max_i32(0, start_sample);
  int clamped_end = min_i32(g_session.sample_count, end_sample);
  float local_min = 1.0f;
  float local_max = -1.0f;

  for (int sample_index = clamped_start; sample_index < clamped_end; sample_index += 1) {
    float value = g_session.samples[sample_index];

    if (value < local_min) {
      local_min = value;
    }

    if (value > local_max) {
      local_max = value;
    }
  }

  *min_value = local_min;
  *max_value = local_max;
}

static void get_level_range(const WaveLevel *level, int start_sample, int end_sample, float *min_value, float *max_value) {
  int start_block = max_i32(0, start_sample / level->block_size);
  int end_block = min_i32(level->block_count, ceil_div_i32(end_sample, level->block_size));
  float local_min = 1.0f;
  float local_max = -1.0f;

  for (int block_index = start_block; block_index < end_block; block_index += 1) {
    float block_min = level->min_peaks[block_index];
    float block_max = level->max_peaks[block_index];

    if (block_min < local_min) {
      local_min = block_min;
    }

    if (block_max > local_max) {
      local_max = block_max;
    }
  }

  *min_value = local_min;
  *max_value = local_max;
}

static void write_power_spectrum(int fft_size, const float *output, float *power_spectrum) {
  int maximum_bin = max_i32(2, fft_size / 2);
  float normalization_factor = (float)((fft_size / 2) * (fft_size / 2));

  memset(power_spectrum, 0, (size_t)(maximum_bin + 1) * sizeof(float));

  for (int bin = 1; bin < maximum_bin; bin += 1) {
    float real = output[bin * 2];
    float imaginary = output[(bin * 2) + 1];
    power_spectrum[bin] = ((real * real) + (imaginary * imaginary)) / normalization_factor;
  }
}

static void write_decimated_fft_input(FftResource *resource, int center_sample, int decimation_factor) {
  int decimated_window_start = center_sample - ((resource->fft_size * decimation_factor) / 2);

  for (int offset = 0; offset < resource->fft_size; offset += 1) {
    float sum = 0;

    for (int tap = 0; tap < decimation_factor; tap += 1) {
      int source_index = decimated_window_start + (offset * decimation_factor) + tap;

      if (source_index >= 0 && source_index < g_session.sample_count) {
        sum += g_session.samples[source_index];
      }
    }

    resource->input[offset] = (sum / (float)decimation_factor) * resource->window[offset];
  }
}

static void create_log_band_ranges(
  BandRange *ranges,
  int rows,
  int fft_size,
  float sample_rate,
  float min_frequency,
  float max_frequency
) {
  float nyquist = sample_rate / 2.0f;
  int maximum_bin = max_i32(2, fft_size / 2);
  float safe_min_frequency = max_f32(1.0f, min_frequency);
  float safe_max_frequency = max_f32(safe_min_frequency * 1.01f, max_frequency);

  for (int row = 0; row < rows; row += 1) {
    float start_ratio = (float)row / (float)rows;
    float end_ratio = (float)(row + 1) / (float)rows;
    float start_frequency = safe_min_frequency * powf(safe_max_frequency / safe_min_frequency, start_ratio);
    float end_frequency = safe_min_frequency * powf(safe_max_frequency / safe_min_frequency, end_ratio);
    int start_bin = clampi32((int)floorf((start_frequency / nyquist) * (float)maximum_bin), 1, maximum_bin - 1);
    int end_bin = clampi32((int)ceilf((end_frequency / nyquist) * (float)maximum_bin), start_bin + 1, maximum_bin);

    ranges[row].start_bin = start_bin;
    ranges[row].end_bin = end_bin;
    ranges[row].start_frequency = start_frequency;
    ranges[row].end_frequency = end_frequency;
  }
}

static void create_band_ranges_for_sample_rate(
  BandRange *output,
  const BandRange *template_ranges,
  int rows,
  int fft_size,
  float sample_rate,
  float min_frequency,
  float max_frequency
) {
  float nyquist = sample_rate / 2.0f;
  int maximum_bin = max_i32(2, fft_size / 2);

  for (int row = 0; row < rows; row += 1) {
    float start_frequency = min_f32(
      max_f32(min_frequency, template_ranges[row].start_frequency),
      max_frequency * 0.999f
    );
    float end_frequency = min_f32(
      max_frequency,
      max_f32(start_frequency * 1.01f, template_ranges[row].end_frequency)
    );
    int start_bin = clampi32((int)floorf((start_frequency / nyquist) * (float)maximum_bin), 1, maximum_bin - 1);
    int end_bin = clampi32((int)ceilf((end_frequency / nyquist) * (float)maximum_bin), start_bin + 1, maximum_bin);

    output[row].start_bin = start_bin;
    output[row].end_bin = end_bin;
    output[row].start_frequency = start_frequency;
    output[row].end_frequency = end_frequency;
  }
}

static void write_palette_color(float normalized, uint8_t *output) {
  float t = clampf32(normalized, 0.0f, 1.0f);
  float local_t = 0.0f;
  float start_r = 0.0f;
  float start_g = 0.0f;
  float start_b = 0.0f;
  float end_r = 0.0f;
  float end_g = 0.0f;
  float end_b = 0.0f;

  if (t < 0.14f) {
    local_t = t / 0.14f;
    start_r = 4.0f;
    start_g = 4.0f;
    start_b = 12.0f;
    end_r = 34.0f;
    end_g = 17.0f;
    end_b = 70.0f;
  } else if (t < 0.34f) {
    local_t = (t - 0.14f) / 0.2f;
    start_r = 34.0f;
    start_g = 17.0f;
    start_b = 70.0f;
    end_r = 91.0f;
    end_g = 31.0f;
    end_b = 126.0f;
  } else if (t < 0.58f) {
    local_t = (t - 0.34f) / 0.24f;
    start_r = 91.0f;
    start_g = 31.0f;
    start_b = 126.0f;
    end_r = 179.0f;
    end_g = 68.0f;
    end_b = 112.0f;
  } else if (t < 0.82f) {
    local_t = (t - 0.58f) / 0.24f;
    start_r = 179.0f;
    start_g = 68.0f;
    start_b = 112.0f;
    end_r = 248.0f;
    end_g = 143.0f;
    end_b = 84.0f;
  } else {
    local_t = (t - 0.82f) / 0.18f;
    start_r = 248.0f;
    start_g = 143.0f;
    start_b = 84.0f;
    end_r = 252.0f;
    end_g = 236.0f;
    end_b = 176.0f;
  }

  output[0] = (uint8_t)lrintf(start_r + ((end_r - start_r) * local_t));
  output[1] = (uint8_t)lrintf(start_g + ((end_g - start_g) * local_t));
  output[2] = (uint8_t)lrintf(start_b + ((end_b - start_b) * local_t));
  output[3] = 255;
}

EMSCRIPTEN_KEEPALIVE
void wave_dispose_session(void) {
  reset_session_state();
}

EMSCRIPTEN_KEEPALIVE
int wave_prepare_session(int sample_count, float sample_rate, float duration) {
  reset_session_state();

  if (sample_count <= 0 || sample_rate <= 0.0f || duration <= 0.0f) {
    return 0;
  }

  g_session.samples = (float *)malloc((size_t)sample_count * sizeof(float));

  if (!g_session.samples) {
    reset_session_state();
    return 0;
  }

  g_session.sample_count = sample_count;
  g_session.sample_rate = sample_rate;
  g_session.duration = duration;
  g_session.min_frequency = HARD_MIN_FREQUENCY;
  g_session.max_frequency = min_f32(HARD_MAX_FREQUENCY, sample_rate / 2.0f);
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int wave_get_pcm_ptr(void) {
  return (int)(intptr_t)g_session.samples;
}

EMSCRIPTEN_KEEPALIVE
int wave_build_waveform_pyramid(void) {
  if (!g_session.samples || g_session.sample_count <= 0) {
    return 0;
  }

  free_wave_levels();

  int level_count = compute_level_count(g_session.sample_count);

  if (level_count <= 0) {
    return 0;
  }

  g_session.levels = (WaveLevel *)calloc((size_t)level_count, sizeof(WaveLevel));

  if (!g_session.levels) {
    return 0;
  }

  g_session.level_count = level_count;

  int block_size = MIN_LEVEL_BLOCK_SIZE;

  for (int level_index = 0; level_index < level_count; level_index += 1) {
    WaveLevel *level = &g_session.levels[level_index];
    int block_count = ceil_div_i32(g_session.sample_count, block_size);

    level->block_size = block_size;
    level->block_count = block_count;
    level->min_peaks = (float *)malloc((size_t)block_count * sizeof(float));
    level->max_peaks = (float *)malloc((size_t)block_count * sizeof(float));

    if (!level->min_peaks || !level->max_peaks) {
      free_wave_levels();
      return 0;
    }

    for (int block_index = 0; block_index < block_count; block_index += 1) {
      int start = block_index * block_size;
      int end = min_i32(g_session.sample_count, start + block_size);
      float min_peak = 1.0f;
      float max_peak = -1.0f;

      for (int sample_index = start; sample_index < end; sample_index += 1) {
        float value = clampf32(g_session.samples[sample_index], -1.0f, 1.0f);

        if (value < min_peak) {
          min_peak = value;
        }

        if (value > max_peak) {
          max_peak = value;
        }
      }

      level->min_peaks[block_index] = min_peak;
      level->max_peaks[block_index] = max_peak;
    }

    if (ceil_div_i32(g_session.sample_count, block_size) <= MIN_LEVEL_BUCKETS) {
      break;
    }

    block_size *= LEVEL_SCALE_FACTOR;
  }

  return g_session.level_count;
}

EMSCRIPTEN_KEEPALIVE
int wave_extract_waveform_slice(double view_start, double view_end, int column_count, int output_ptr) {
  if (!g_session.samples || !output_ptr || column_count <= 0 || view_end <= view_start || g_session.duration <= 0.0f) {
    return 0;
  }

  double clamped_start = clampf64(view_start, 0.0, (double)g_session.duration);
  double clamped_end = clampf64(view_end, clamped_start + 0.0001, (double)g_session.duration);
  int start_sample = (int)floor((clamped_start / (double)g_session.duration) * (double)g_session.sample_count);
  int end_sample = (int)ceil((clamped_end / (double)g_session.duration) * (double)g_session.sample_count);
  int visible_samples = max_i32(1, end_sample - start_sample);
  double samples_per_pixel = (double)visible_samples / (double)column_count;
  const WaveLevel *selected_level = pick_waveform_level(samples_per_pixel);
  float *output = (float *)(intptr_t)output_ptr;

  for (int column_index = 0; column_index < column_count; column_index += 1) {
    int column_start_sample = (int)floor((double)start_sample + (((double)column_index / (double)column_count) * (double)visible_samples));
    int column_end_sample = (int)ceil((double)start_sample + ((((double)column_index + 1.0) / (double)column_count) * (double)visible_samples));
    float min_value = 1.0f;
    float max_value = -1.0f;

    if (selected_level) {
      get_level_range(selected_level, column_start_sample, column_end_sample, &min_value, &max_value);
    } else {
      get_sample_range(column_start_sample, column_end_sample, &min_value, &max_value);
    }

    output[column_index * 2] = min_value;
    output[(column_index * 2) + 1] = max_value;
  }

  return 1;
}

EMSCRIPTEN_KEEPALIVE
int wave_render_spectrogram_tile_rgba(
  double tile_start,
  double tile_end,
  int column_count,
  int row_count,
  int fft_size,
  int decimation_factor,
  float min_frequency,
  float max_frequency,
  int output_ptr
) {
  if (
    !g_session.samples ||
    !output_ptr ||
    column_count <= 0 ||
    row_count <= 0 ||
    fft_size <= 0 ||
    tile_end <= tile_start
  ) {
    return 0;
  }

  FftResource *resource = get_fft_resource(fft_size);

  if (!resource) {
    return 0;
  }

  int power_spectrum_length = max_i32(2, (fft_size / 2) + 1);
  float *power_spectrum = (float *)malloc((size_t)power_spectrum_length * sizeof(float));
  float *low_power_spectrum = NULL;
  BandRange *band_ranges = (BandRange *)malloc((size_t)row_count * sizeof(BandRange));
  BandRange *enhanced_band_ranges = NULL;

  if (!power_spectrum || !band_ranges) {
    free(power_spectrum);
    free(band_ranges);
    return 0;
  }

  float safe_min_frequency = max_f32(g_session.min_frequency, min_frequency);
  float safe_max_frequency = min_f32(g_session.max_frequency, max_frequency);
  float low_frequency_maximum = 0.0f;
  int use_low_frequency_enhancement = 0;

  create_log_band_ranges(
    band_ranges,
    row_count,
    fft_size,
    g_session.sample_rate,
    safe_min_frequency,
    safe_max_frequency
  );

  if (decimation_factor > 1) {
    float effective_sample_rate = g_session.sample_rate / (float)decimation_factor;

    low_frequency_maximum = min_f32(
      LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY,
      min_f32((effective_sample_rate / 2.0f) * 0.92f, safe_max_frequency)
    );

    if (low_frequency_maximum > (safe_min_frequency * 1.25f)) {
      low_power_spectrum = (float *)malloc((size_t)power_spectrum_length * sizeof(float));
      enhanced_band_ranges = (BandRange *)malloc((size_t)row_count * sizeof(BandRange));

      if (low_power_spectrum && enhanced_band_ranges) {
        create_band_ranges_for_sample_rate(
          enhanced_band_ranges,
          band_ranges,
          row_count,
          fft_size,
          effective_sample_rate,
          safe_min_frequency,
          low_frequency_maximum
        );
        use_low_frequency_enhancement = 1;
      }
    }
  }

  uint8_t *output = (uint8_t *)(intptr_t)output_ptr;
  double safe_tile_span = max_f32(1.0f / g_session.sample_rate, (float)(tile_end - tile_start));

  for (int column_index = 0; column_index < column_count; column_index += 1) {
    double center_ratio = column_count == 1 ? 0.5 : ((double)column_index + 0.5) / (double)column_count;
    double center_time = tile_start + (center_ratio * safe_tile_span);
    int center_sample = (int)llround(center_time * (double)g_session.sample_rate);
    int window_start = center_sample - (fft_size / 2);

    for (int offset = 0; offset < fft_size; offset += 1) {
      int source_index = window_start + offset;
      float sample = 0.0f;

      if (source_index >= 0 && source_index < g_session.sample_count) {
        sample = g_session.samples[source_index];
      }

      resource->input[offset] = sample * resource->window[offset];
    }

    pffft_transform_ordered(resource->setup, resource->input, resource->output, resource->work, PFFFT_FORWARD);
    write_power_spectrum(fft_size, resource->output, power_spectrum);

    if (use_low_frequency_enhancement) {
      write_decimated_fft_input(resource, center_sample, decimation_factor);
      pffft_transform_ordered(resource->setup, resource->input, resource->output, resource->work, PFFFT_FORWARD);
      write_power_spectrum(fft_size, resource->output, low_power_spectrum);
    }

    for (int row = 0; row < row_count; row += 1) {
      const BandRange *base_range = &band_ranges[row];
      const BandRange *active_range = base_range;
      const float *active_power_spectrum = power_spectrum;

      if (use_low_frequency_enhancement && base_range->end_frequency <= low_frequency_maximum) {
        active_range = &enhanced_band_ranges[row];
        active_power_spectrum = low_power_spectrum;
      }

      int band_size = max_i32(1, active_range->end_bin - active_range->start_bin);
      float weighted_energy = 0.0f;
      float total_weight = 0.0f;

      for (int bin = active_range->start_bin; bin < active_range->end_bin; bin += 1) {
        float position = band_size == 1 ? 0.5f : ((float)(bin - active_range->start_bin) + 0.5f) / (float)band_size;
        float taper = 1.0f - fabsf((position * 2.0f) - 1.0f);
        float weight = 0.7f + (taper * 0.3f);

        weighted_energy += active_power_spectrum[bin] * weight;
        total_weight += weight;
      }

      float rms = sqrtf(weighted_energy / max_f32(total_weight, 1e-8f));
      float decibels = 20.0f * log10f(rms + 1e-7f);
      float normalized = (decibels - MIN_DB) / (MAX_DB - MIN_DB);
      int target_row = row_count - row - 1;
      size_t pixel_offset = ((size_t)target_row * (size_t)column_count + (size_t)column_index) * 4U;

      write_palette_color(normalized, output + pixel_offset);
    }
  }

  free(power_spectrum);
  free(low_power_spectrum);
  free(band_ranges);
  free(enhanced_band_ranges);
  return 1;
}
