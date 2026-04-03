// Shared analysis configuration and option constants.
export const MIN_FREQUENCY = 50;
export const MAX_FREQUENCY = 20000;
export const ROW_BUCKET_SIZE = 16;
export const DEFAULT_MFCC_COEFFICIENT_COUNT = 20;
export const VISIBLE_ROW_OVERSAMPLE = 1.35;
export const LIBROSA_DEFAULT_MEL_BAND_COUNT = 256;
export const DEFAULT_MFCC_MEL_BAND_COUNT = 128;
export const MFCC_COEFFICIENT_OPTIONS = [13, 20, 32, 40];
export const MEL_BAND_COUNT_OPTIONS = [128, 256, 512];
export const DEFAULT_SCALOGRAM_OMEGA0 = 6;
export const DEFAULT_SCALOGRAM_ROW_DENSITY = 1;
export const DEFAULT_SCALOGRAM_HOP_SAMPLES = 1024;
export const SCALOGRAM_OMEGA_OPTIONS = [4, 5, 6, 7, 8, 10, 12];
export const SCALOGRAM_ROW_DENSITY_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
export const SCALOGRAM_HOP_SAMPLES_OPTIONS = [256, 512, 1024, 2048, 4096];

export const QUALITY_PRESETS = {
  balanced: {
    rowsMultiplier: 1.5,
    colsMultiplier: 2.5,
    lowFrequencyDecimationFactor: 2,
  },
  high: {
    rowsMultiplier: 2.5,
    colsMultiplier: 4,
    lowFrequencyDecimationFactor: 4,
  },
  max: {
    rowsMultiplier: 4,
    colsMultiplier: 6,
    lowFrequencyDecimationFactor: 4,
  },
};

export const FFT_SIZE_OPTIONS = [1024, 2048, 4096, 8192, 16384];
export const OVERLAP_RATIO_OPTIONS = [0.5, 0.75, 0.875, 0.9375];
export const SPECTROGRAM_COLUMN_CHUNK_SIZE = 32;
export const SCALOGRAM_COLUMN_CHUNK_SIZE = 32;
export const SCALOGRAM_ROW_BLOCK_SIZE = 32;
export const WEBGPU_OVERVIEW_TILE_SUBMIT_BATCH_SIZE = 4;
export const WEBGPU_VISIBLE_TILE_SUBMIT_BATCH_SIZE = 8;
export const WEBGPU_LINEAR_WORKGROUP_SIZE = 64;
export const SCALOGRAM_FFT_ROW_BATCH_SIZE = 8;
export const WEBGPU_STFT_PARAM_ENTRIES_PER_SLOT = 32;
export const WEBGPU_SCALOGRAM_FFT_PARAM_ENTRY_COUNT = 32;
export const WEBGPU_STFT_SCRATCH_SLOT_COUNT = WEBGPU_VISIBLE_TILE_SUBMIT_BATCH_SIZE;
export const MAX_SCALOGRAM_FFT_WINDOW_CACHE_ENTRIES = 16;
export const MAX_TILE_CACHE_ENTRIES = 24;
export const MAX_TILE_CACHE_BYTES = 96 * 1024 * 1024;
export const ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR = true;
export const ENABLE_EXPERIMENTAL_WEBGPU_SPECTROGRAM_COMPUTE = true;
export const ENABLE_EXPERIMENTAL_WEBGPU_SCALOGRAM_FFT = true;
export const WEBGPU_TILE_TEXTURE_FORMAT = 'rgba8unorm';
export const SCALOGRAM_FFT_MAX_INPUT_SAMPLES = 131072;
export const LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY = 1200;
export const MIXED_FREQUENCY_PIVOT_HZ = 1000;
export const MIXED_FREQUENCY_PIVOT_RATIO = 0.5;
export const MIN_DECIBELS = -80;
export const MAX_DECIBELS = 0;
export const SPECTROGRAM_DB_WINDOW_LIMITS = {
  max: 12,
  min: -120,
  minimumSpan: 6,
} as const;
export const ANALYSIS_TYPE_CODES = {
  spectrogram: 0,
  mel: 1,
  scalogram: 2,
  mfcc: 3,
  chroma: 5,
  chroma_cqt: 5,
};
export const FREQUENCY_SCALE_CODES = {
  log: 0,
  linear: 1,
  mixed: 2,
};
export const COLORMAP_DISTRIBUTION_GAMMAS = {
  balanced: 1,
  contrast: 1.18,
  soft: 0.84,
} as const;

export const SLANEY_MEL_FREQUENCY_MIN = 0;
export const SLANEY_MEL_FREQUENCY_STEP = 200 / 3;
export const SLANEY_MEL_LOG_REGION_START_HZ = 1000;
export const SLANEY_MEL_LOG_REGION_START_MEL = (SLANEY_MEL_LOG_REGION_START_HZ - SLANEY_MEL_FREQUENCY_MIN) / SLANEY_MEL_FREQUENCY_STEP;
export const SLANEY_MEL_LOG_STEP = Math.log(6.4) / 27;
