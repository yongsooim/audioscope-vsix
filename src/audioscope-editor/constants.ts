import type { SpectrogramDefaultsPayload } from '../externalAudioTools';

export const KNOWN_AUDIO_EXTENSIONS = new Set([
  'wav',
  'wave',
  'mp3',
  'ogg',
  'oga',
  'flac',
  'm4a',
  'aac',
  'opus',
  'aif',
  'aiff',
]);

export const DEFAULT_SPECTROGRAM_DEFAULTS: SpectrogramDefaultsPayload = {
  analysisType: 'spectrogram',
  colormapDistribution: 'balanced',
  fftSize: 4096,
  frequencyScale: 'log',
  maxDecibels: 0,
  melBandCount: 256,
  mfccCoefficientCount: 20,
  mfccMelBandCount: 128,
  minDecibels: -80,
  overlapRatio: 0.75,
  scalogramHopSamples: 0,
  scalogramMaxFrequency: 20_000,
  scalogramMinFrequency: 50,
  scalogramOmega0: 6,
  scalogramRowDensity: 1,
  windowFunction: 'hann',
};

export const FFT_SIZE_OPTIONS = new Set([1024, 2048, 4096, 8192, 16384]);
export const MEL_BAND_OPTIONS = new Set([128, 256, 512]);
export const MFCC_COEFFICIENT_OPTIONS = new Set([13, 20, 32, 40]);
export const OVERLAP_OPTIONS = new Set([0.5, 0.75, 0.875, 0.9375]);
export const SCALOGRAM_HOP_OPTIONS = new Set([0, 256, 512, 1024, 2048, 4096]);
export const SCALOGRAM_OMEGA_OPTIONS = new Set([4, 5, 6, 7, 8, 10, 12]);
export const SCALOGRAM_ROW_DENSITY_OPTIONS = new Set([0.5, 0.75, 1, 1.5, 2, 3, 4]);
