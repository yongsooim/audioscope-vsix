import type { SpectrogramDefaultsPayload } from '../externalAudioTools';
import {
  DEFAULT_SPECTROGRAM_DEFAULTS,
  FFT_SIZE_OPTIONS,
  MEL_BAND_OPTIONS,
  MFCC_COEFFICIENT_OPTIONS,
  OVERLAP_OPTIONS,
  SCALOGRAM_HOP_OPTIONS,
  SCALOGRAM_OMEGA_OPTIONS,
  SCALOGRAM_ROW_DENSITY_OPTIONS,
} from './constants';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLoudnessRefLevel(value: unknown): number | null {
  if (value === null || value === 'off') {
    return null;
  }

  return Number.isFinite(Number(value))
    ? Math.round(clamp(Number(value), -70, 6))
    : DEFAULT_SPECTROGRAM_DEFAULTS.loudnessRefLevel;
}

function normalizeLoudnessYAxisRange(minValue: unknown, maxValue: unknown): {
  loudnessYAxisMax: number;
  loudnessYAxisMin: number;
} {
  const minimumSpan = 5;
  let loudnessYAxisMin = Number.isFinite(Number(minValue))
    ? Math.round(Number(minValue))
    : DEFAULT_SPECTROGRAM_DEFAULTS.loudnessYAxisMin;
  let loudnessYAxisMax = Number.isFinite(Number(maxValue))
    ? Math.round(Number(maxValue))
    : DEFAULT_SPECTROGRAM_DEFAULTS.loudnessYAxisMax;

  loudnessYAxisMin = clamp(loudnessYAxisMin, -70, 6 - minimumSpan);
  loudnessYAxisMax = clamp(loudnessYAxisMax, -70 + minimumSpan, 6);

  if (loudnessYAxisMax < loudnessYAxisMin + minimumSpan) {
    loudnessYAxisMax = Math.min(6, loudnessYAxisMin + minimumSpan);
    loudnessYAxisMin = Math.min(loudnessYAxisMin, loudnessYAxisMax - minimumSpan);
  }

  return { loudnessYAxisMax, loudnessYAxisMin };
}

export function normalizeSpectrogramDefaults(value: unknown): SpectrogramDefaultsPayload {
  const input = (value && typeof value === 'object') ? value as Partial<SpectrogramDefaultsPayload> : {};
  const analysisType = input.analysisType === 'chroma'
    || input.analysisType === 'loudness'
    || input.analysisType === 'mel'
    || input.analysisType === 'mfcc'
    || input.analysisType === 'scalogram'
    ? input.analysisType
    : 'spectrogram';
  const colormapDistribution = input.colormapDistribution === 'contrast' || input.colormapDistribution === 'soft'
    ? input.colormapDistribution
    : 'balanced';
  const fftSize = FFT_SIZE_OPTIONS.has(Number(input.fftSize)) ? Number(input.fftSize) : DEFAULT_SPECTROGRAM_DEFAULTS.fftSize;
  const frequencyScale = input.frequencyScale === 'linear' || input.frequencyScale === 'mixed'
    ? input.frequencyScale
    : 'log';
  const loudnessCurves = input.loudnessCurves === 'momentary' || input.loudnessCurves === 'shortTerm'
    ? input.loudnessCurves
    : 'both';
  const loudnessRefLevel = normalizeLoudnessRefLevel(input.loudnessRefLevel);
  const loudnessShowPeak = input.loudnessShowPeak === true;
  const loudnessYAxisMode = input.loudnessYAxisMode === 'fixed' ? 'fixed' : 'auto';
  const { loudnessYAxisMax, loudnessYAxisMin } = normalizeLoudnessYAxisRange(
    input.loudnessYAxisMin,
    input.loudnessYAxisMax,
  );
  const melBandCount = MEL_BAND_OPTIONS.has(Number(input.melBandCount)) ? Number(input.melBandCount) : DEFAULT_SPECTROGRAM_DEFAULTS.melBandCount;
  const mfccCoefficientCount = MFCC_COEFFICIENT_OPTIONS.has(Number(input.mfccCoefficientCount))
    ? Number(input.mfccCoefficientCount)
    : DEFAULT_SPECTROGRAM_DEFAULTS.mfccCoefficientCount;
  const mfccMelBandCount = MEL_BAND_OPTIONS.has(Number(input.mfccMelBandCount))
    ? Number(input.mfccMelBandCount)
    : DEFAULT_SPECTROGRAM_DEFAULTS.mfccMelBandCount;
  const overlapRatio = OVERLAP_OPTIONS.has(Number(input.overlapRatio))
    ? Number(input.overlapRatio)
    : DEFAULT_SPECTROGRAM_DEFAULTS.overlapRatio;
  const scalogramHopSamples = SCALOGRAM_HOP_OPTIONS.has(Number(input.scalogramHopSamples))
    ? Number(input.scalogramHopSamples)
    : DEFAULT_SPECTROGRAM_DEFAULTS.scalogramHopSamples;
  const scalogramOmega0 = SCALOGRAM_OMEGA_OPTIONS.has(Number(input.scalogramOmega0))
    ? Number(input.scalogramOmega0)
    : DEFAULT_SPECTROGRAM_DEFAULTS.scalogramOmega0;
  const scalogramRowDensity = SCALOGRAM_ROW_DENSITY_OPTIONS.has(Number(input.scalogramRowDensity))
    ? Number(input.scalogramRowDensity)
    : DEFAULT_SPECTROGRAM_DEFAULTS.scalogramRowDensity;
  const windowFunction = input.windowFunction === 'hamming'
    || input.windowFunction === 'blackman'
    || input.windowFunction === 'rectangular'
    ? input.windowFunction
    : 'hann';
  const minDecibels = Number.isFinite(Number(input.minDecibels))
    ? Math.round(clamp(Number(input.minDecibels), -120, 6))
    : DEFAULT_SPECTROGRAM_DEFAULTS.minDecibels;
  const maxDecibels = Number.isFinite(Number(input.maxDecibels))
    ? Math.round(clamp(Number(input.maxDecibels), minDecibels + 6, 12))
    : DEFAULT_SPECTROGRAM_DEFAULTS.maxDecibels;
  const scalogramMinFrequency = Number.isFinite(Number(input.scalogramMinFrequency))
    ? Math.round(clamp(Number(input.scalogramMinFrequency), 20, 19_999))
    : DEFAULT_SPECTROGRAM_DEFAULTS.scalogramMinFrequency;
  const scalogramMaxFrequency = Number.isFinite(Number(input.scalogramMaxFrequency))
    ? Math.round(clamp(Number(input.scalogramMaxFrequency), scalogramMinFrequency + 1, 20_000))
    : DEFAULT_SPECTROGRAM_DEFAULTS.scalogramMaxFrequency;

  return {
    analysisType,
    colormapDistribution,
    fftSize,
    frequencyScale,
    loudnessCurves,
    loudnessRefLevel,
    loudnessShowPeak,
    loudnessYAxisMax,
    loudnessYAxisMin,
    loudnessYAxisMode,
    maxDecibels,
    melBandCount,
    mfccCoefficientCount,
    mfccMelBandCount,
    minDecibels,
    overlapRatio,
    scalogramHopSamples,
    scalogramMaxFrequency,
    scalogramMinFrequency,
    scalogramOmega0,
    scalogramRowDensity,
    windowFunction,
  };
}
