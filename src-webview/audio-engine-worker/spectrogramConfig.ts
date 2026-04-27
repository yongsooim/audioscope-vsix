import type { SpectrogramAnalysisType } from '../audioEngineProtocol';

const HARD_MAX_FREQUENCY = 20_000;

export const DEFAULT_MFCC_COEFFICIENT_COUNT = 20;
export const DEFAULT_MFCC_MEL_BAND_COUNT = 128;
export const MFCC_COEFFICIENT_OPTIONS = [13, 20, 32, 40];
export const LIBROSA_DEFAULT_MEL_BAND_COUNT = 256;
export const MEL_BAND_COUNT_OPTIONS = [128, 256, 512];
export const DEFAULT_SCALOGRAM_OMEGA0 = 6;
export const DEFAULT_SCALOGRAM_ROW_DENSITY = 1;
export const DEFAULT_SCALOGRAM_MIN_FREQUENCY = 20;
export const DEFAULT_SCALOGRAM_MAX_FREQUENCY = 20_000;
export const DEFAULT_SCALOGRAM_HOP_SAMPLES = 1024;
export const SCALOGRAM_OMEGA_OPTIONS = [4, 5, 6, 7, 8, 10, 12];
export const SCALOGRAM_ROW_DENSITY_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
export const FFT_SIZE_OPTIONS = [1024, 2048, 4096, 8192, 16384];
export const OVERLAP_RATIO_OPTIONS = [0.5, 0.75, 0.875, 0.9375];
export const SPECTROGRAM_DB_WINDOW_LIMITS = {
  max: 12,
  min: -120,
  minimumSpan: 6,
} as const;

export function getDefaultSpectrogramDbWindow(analysisType: SpectrogramAnalysisType): {
  maxDecibels: number;
  minDecibels: number;
} {
  if (analysisType === 'mel') {
    return { minDecibels: -92, maxDecibels: 0 };
  }
  if (analysisType === 'mfcc') {
    return { minDecibels: -80, maxDecibels: 0 };
  }
  if (analysisType === 'scalogram') {
    return { minDecibels: -72, maxDecibels: 0 };
  }
  return { minDecibels: -80, maxDecibels: 0 };
}

export function normalizeSpectrogramDbWindow(
  minValue: unknown,
  maxValue: unknown,
  analysisType: SpectrogramAnalysisType,
): {
  maxDecibels: number;
  minDecibels: number;
} {
  const defaults = getDefaultSpectrogramDbWindow(analysisType);
  let minDecibels = Number.isFinite(Number(minValue)) ? Math.round(Number(minValue)) : defaults.minDecibels;
  let maxDecibels = Number.isFinite(Number(maxValue)) ? Math.round(Number(maxValue)) : defaults.maxDecibels;

  minDecibels = clamp(
    minDecibels,
    SPECTROGRAM_DB_WINDOW_LIMITS.min,
    SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
  );
  maxDecibels = clamp(
    maxDecibels,
    SPECTROGRAM_DB_WINDOW_LIMITS.min + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    SPECTROGRAM_DB_WINDOW_LIMITS.max,
  );

  if (maxDecibels < minDecibels + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan) {
    maxDecibels = Math.min(
      SPECTROGRAM_DB_WINDOW_LIMITS.max,
      minDecibels + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    );
    minDecibels = Math.min(
      minDecibels,
      maxDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    );
  }

  return { minDecibels, maxDecibels };
}

export function normalizeMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return MEL_BAND_COUNT_OPTIONS.includes(numericValue)
    ? numericValue
    : LIBROSA_DEFAULT_MEL_BAND_COUNT;
}

export function normalizeMfccCoefficientCount(value: unknown): number {
  const numericValue = Number(value);
  return MFCC_COEFFICIENT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_MFCC_COEFFICIENT_COUNT;
}

export function normalizeMfccMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return MEL_BAND_COUNT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_MFCC_MEL_BAND_COUNT;
}

export function normalizeScalogramOmega0(value: unknown): number {
  const numericValue = Number(value);
  return SCALOGRAM_OMEGA_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_OMEGA0;
}

export function normalizeScalogramRowDensity(value: unknown): number {
  const numericValue = Number(value);
  return SCALOGRAM_ROW_DENSITY_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_ROW_DENSITY;
}

export function normalizeScalogramHopSamples(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.max(1, Math.round(numericValue))
    : DEFAULT_SCALOGRAM_HOP_SAMPLES;
}

export function normalizeScalogramFrequencyRange(
  maxAvailableFrequency: number,
  minValue: unknown,
  maxValue: unknown,
): {
  maxFrequency: number;
  minFrequency: number;
} {
  const ceiling = Math.max(
    DEFAULT_SCALOGRAM_MIN_FREQUENCY + 1,
    Math.min(HARD_MAX_FREQUENCY, Math.round(maxAvailableFrequency || DEFAULT_SCALOGRAM_MAX_FREQUENCY)),
  );
  let minFrequency = Number.isFinite(Number(minValue))
    ? Math.round(Number(minValue))
    : DEFAULT_SCALOGRAM_MIN_FREQUENCY;
  let maxFrequency = Number.isFinite(Number(maxValue))
    ? Math.round(Number(maxValue))
    : Math.min(DEFAULT_SCALOGRAM_MAX_FREQUENCY, ceiling);

  minFrequency = clamp(
    minFrequency,
    DEFAULT_SCALOGRAM_MIN_FREQUENCY,
    Math.max(DEFAULT_SCALOGRAM_MIN_FREQUENCY, ceiling - 1),
  );
  maxFrequency = clamp(
    maxFrequency,
    Math.min(ceiling, minFrequency + 1),
    ceiling,
  );

  if (maxFrequency <= minFrequency) {
    maxFrequency = Math.min(ceiling, minFrequency + 1);
    minFrequency = Math.min(minFrequency, maxFrequency - 1);
  }

  return { minFrequency, maxFrequency };
}

export function isChromaAnalysisType(analysisType: SpectrogramAnalysisType): boolean {
  return analysisType === 'chroma';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
