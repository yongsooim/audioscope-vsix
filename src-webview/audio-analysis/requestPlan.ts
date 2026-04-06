import { TILE_COLUMN_COUNT, quantizeCeil } from '../sharedBuffers';
import {
  normalizeSpectrogramWindowFunction,
  type SpectrogramWindowFunction,
} from '../windowShared';
import {
  CHROMA_BIN_COUNT,
  CQT_DEFAULT_FMIN,
} from './chromaShared';
import {
  DEFAULT_MFCC_COEFFICIENT_COUNT,
  DEFAULT_MFCC_MEL_BAND_COUNT,
  DEFAULT_SCALOGRAM_HOP_SAMPLES,
  DEFAULT_SCALOGRAM_OMEGA0,
  DEFAULT_SCALOGRAM_ROW_DENSITY,
  FFT_SIZE_OPTIONS,
  LIBROSA_DEFAULT_MEL_BAND_COUNT,
  MAX_DECIBELS,
  MAX_FREQUENCY,
  MEL_BAND_COUNT_OPTIONS,
  MFCC_COEFFICIENT_OPTIONS,
  MIN_DECIBELS,
  MIN_FREQUENCY,
  OVERLAP_RATIO_OPTIONS,
  QUALITY_PRESETS,
  ROW_BUCKET_SIZE,
  SCALOGRAM_HOP_SAMPLES_OPTIONS,
  SCALOGRAM_ROW_BLOCK_SIZE,
  SCALOGRAM_ROW_DENSITY_OPTIONS,
  SCALOGRAM_OMEGA_OPTIONS,
  SPECTROGRAM_DB_WINDOW_LIMITS,
  VISIBLE_ROW_OVERSAMPLE,
} from './constants';

export type QualityPreset = 'balanced' | 'high' | 'max';
export type AnalysisType = 'chroma' | 'mel' | 'mfcc' | 'scalogram' | 'spectrogram';
export type ColormapDistribution = 'balanced' | 'contrast' | 'soft';
export type FrequencyScale = 'linear' | 'log' | 'mixed';
export type WindowFunction = SpectrogramWindowFunction;
export type LayerKind = 'overview' | 'visible';

export interface SpectrogramRequest {
  analysisType?: AnalysisType;
  colormapDistribution?: ColormapDistribution;
  configVersion?: number;
  displayEnd?: number;
  displayStart?: number;
  dpr?: number;
  fftSize?: number;
  frequencyScale?: FrequencyScale;
  generation?: number;
  maxDecibels?: number;
  melBandCount?: number;
  mfccCoefficientCount?: number;
  mfccMelBandCount?: number;
  minDecibels?: number;
  overlapRatio?: number;
  windowFunction?: WindowFunction;
  scalogramHopSamples?: number;
  scalogramMaxFrequency?: number;
  scalogramMinFrequency?: number;
  scalogramOmega0?: number;
  scalogramRowDensity?: number;
  pixelHeight?: number;
  pixelWidth?: number;
  requestEnd?: number;
  requestKind?: LayerKind;
  requestStart?: number;
  viewEnd?: number;
  viewStart?: number;
}

export interface RenderRequestPlan {
  analysisType: AnalysisType;
  colormapDistribution: ColormapDistribution;
  configKey: string;
  configVersion: number;
  decimationFactor: number;
  displayEnd: number;
  displayStart: number;
  dprBucket: number;
  endTileIndex: number;
  fftSize: number;
  frequencyScale: FrequencyScale;
  generation: number;
  hopSamples: number;
  hopSeconds: number;
  maxDecibels: number;
  maxFrequency: number;
  melBandCount: number;
  mfccCoefficientCount: number;
  minDecibels: number;
  minFrequency: number;
  overlapRatio: number;
  pixelHeight: number;
  pixelWidth: number;
  requestKind: LayerKind;
  rowCount: number;
  scalogramOmega0: number;
  scalogramRowDensity: number;
  startTileIndex: number;
  targetColumns: number;
  tileDuration: number;
  viewEnd: number;
  viewStart: number;
  windowFunction: WindowFunction;
  windowSeconds: number;
}

interface RequestPlanContext {
  duration: number;
  maxFrequency: number;
  minFrequency: number;
  pixelHeight: number;
  pixelWidth: number;
  quality: QualityPreset;
  runtimeVariant: string | null;
  sampleRate: number;
}

export function normalizeQualityPreset(value: unknown): QualityPreset {
  return value === 'balanced' || value === 'max' ? value : 'high';
}

export function normalizeAnalysisType(value: unknown): AnalysisType {
  return value === 'chroma'
    || value === 'chroma_cqt'
    || value === 'mel'
    || value === 'mfcc'
    || value === 'scalogram'
    ? (value === 'chroma_cqt' ? 'chroma' : value)
    : 'spectrogram';
}

export function normalizeColormapDistribution(value: unknown): ColormapDistribution {
  return value === 'contrast' || value === 'soft' ? value : 'balanced';
}

export function getDefaultDbWindowForAnalysisType(analysisType: AnalysisType): {
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
  return { minDecibels: MIN_DECIBELS, maxDecibels: MAX_DECIBELS };
}

export function normalizeDbWindow(
  minValue: unknown,
  maxValue: unknown,
  analysisType: AnalysisType,
): {
  maxDecibels: number;
  minDecibels: number;
} {
  const defaults = getDefaultDbWindowForAnalysisType(analysisType);
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

export function normalizeFrequencyScale(value: unknown): FrequencyScale {
  return value === 'linear' || value === 'mixed' ? value : 'log';
}

export function getEffectiveFrequencyScale(analysisType: AnalysisType, value: unknown): FrequencyScale {
  return analysisType === 'spectrogram' ? normalizeFrequencyScale(value) : 'log';
}

export function isChromaAnalysisType(analysisType: AnalysisType): boolean {
  return analysisType === 'chroma';
}

export function createRequestPlan(
  context: RequestPlanContext,
  request: SpectrogramRequest | null,
): RenderRequestPlan {
  const preset = QUALITY_PRESETS[context.quality];
  const requestKind = request?.requestKind === 'overview' ? 'overview' : 'visible';
  const generation = Number.isFinite(request?.generation) ? Number(request?.generation) : 0;
  const configVersion = Number.isFinite(request?.configVersion) ? Math.max(0, Math.trunc(Number(request?.configVersion))) : 0;
  const requestedStart = Number.isFinite(request?.viewStart) ? Number(request?.viewStart) : 0;
  const requestedEnd = Number.isFinite(request?.viewEnd) ? Number(request?.viewEnd) : context.duration;
  const viewStart = clamp(requestedStart, 0, context.duration);
  const viewEnd = clamp(
    Math.max(viewStart + (1 / context.sampleRate), requestedEnd),
    viewStart + (1 / context.sampleRate),
    context.duration,
  );
  const requestedDisplayStart = Number.isFinite(request?.displayStart) ? Number(request?.displayStart) : viewStart;
  const displayStart = clamp(requestedDisplayStart, 0, context.duration);
  const requestedDisplayEnd = Number.isFinite(request?.displayEnd) ? Number(request?.displayEnd) : viewEnd;
  const displayEnd = clamp(
    Math.max(displayStart + (1 / context.sampleRate), requestedDisplayEnd),
    displayStart + (1 / context.sampleRate),
    context.duration,
  );
  const pixelWidth = Math.max(1, Math.round(Number(request?.pixelWidth) || context.pixelWidth || 1));
  const pixelHeight = Math.max(1, Math.round(Number(request?.pixelHeight) || context.pixelHeight || 1));
  const dprBucket = Math.max(2, Math.round(Number(request?.dpr) || 2));
  const analysisType = normalizeAnalysisType(request?.analysisType);
  const chromaAnalysis = isChromaAnalysisType(analysisType);
  const colormapDistribution = normalizeColormapDistribution(request?.colormapDistribution);
  const dbWindow = normalizeDbWindow(request?.minDecibels, request?.maxDecibels, analysisType);
  const frequencyScale = getEffectiveFrequencyScale(analysisType, request?.frequencyScale);
  const windowFunction = normalizeSpectrogramWindowFunction(request?.windowFunction);
  const fftSize = analysisType === 'scalogram' || analysisType === 'chroma' ? 0 : normalizeFftSize(request?.fftSize);
  const overlapRatio = analysisType === 'scalogram' || analysisType === 'chroma' ? 0 : normalizeOverlapRatio(request?.overlapRatio);
  const mfccCoefficientCount = normalizeMfccCoefficientCount(request?.mfccCoefficientCount);
  const scalogramOmega0 = normalizeScalogramOmega0(request?.scalogramOmega0);
  const scalogramRowDensity = normalizeScalogramRowDensity(request?.scalogramRowDensity);
  const scalogramFrequencyRange = normalizeScalogramFrequencyRange(
    context.maxFrequency,
    request?.scalogramMinFrequency,
    request?.scalogramMaxFrequency,
  );
  const melBandCount = analysisType === 'mfcc'
    ? normalizeMfccMelBandCount(request?.mfccMelBandCount ?? request?.melBandCount)
    : normalizeMelBandCount(request?.melBandCount);
  const rowBucketSize = analysisType === 'scalogram' ? SCALOGRAM_ROW_BLOCK_SIZE : ROW_BUCKET_SIZE;
  const rowOversample = requestKind === 'visible' && analysisType !== 'scalogram'
    ? VISIBLE_ROW_OVERSAMPLE
    : analysisType === 'scalogram'
      ? scalogramRowDensity
      : 1;
  const rowCount = chromaAnalysis
    ? CHROMA_BIN_COUNT
    : analysisType === 'mel'
    ? melBandCount
    : analysisType === 'mfcc'
      ? mfccCoefficientCount
      : quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier * rowOversample), rowBucketSize);
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2),
  );
  const hopSamples = analysisType === 'scalogram' || analysisType === 'chroma'
    ? normalizeScalogramHopSamples(request?.scalogramHopSamples)
    : Math.max(1, Math.round(fftSize * (1 - overlapRatio)));
  const secondsPerColumn = hopSamples / context.sampleRate;
  const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / context.sampleRate);
  const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
  const endTileIndex = Math.max(
    startTileIndex,
    Math.floor(Math.max(viewStart, viewEnd - (secondsPerColumn * 0.5)) / tileDuration),
  );
  const windowSeconds = analysisType === 'scalogram' || analysisType === 'chroma' ? 0 : fftSize / context.sampleRate;
  const decimationFactor = analysisType === 'spectrogram'
    ? Math.max(1, preset.lowFrequencyDecimationFactor || 1)
    : 1;
  const configKey = [
    `type${analysisType}`,
    `dist${colormapDistribution}`,
    `db${dbWindow.minDecibels}:${dbWindow.maxDecibels}`,
    `scale${frequencyScale}`,
    `win${windowFunction}`,
    `fft${fftSize}`,
    `bands${analysisType === 'mel' || analysisType === 'mfcc' ? melBandCount : 0}`,
    `coeff${analysisType === 'mfcc' ? mfccCoefficientCount : 0}`,
    `min${analysisType === 'scalogram'
      ? scalogramFrequencyRange.minFrequency
      : chromaAnalysis
        ? CQT_DEFAULT_FMIN
        : context.minFrequency}`,
    `max${analysisType === 'scalogram' ? scalogramFrequencyRange.maxFrequency : context.maxFrequency}`,
    `omega${analysisType === 'scalogram' ? scalogramOmega0 : 0}`,
    `density${analysisType === 'scalogram' ? scalogramRowDensity : 0}`,
    `ov${Math.round(overlapRatio * 1000)}`,
    `hop${hopSamples}`,
    `rows${rowCount}`,
  ].join('-');

  return {
    analysisType,
    colormapDistribution,
    configKey,
    configVersion,
    decimationFactor,
    displayEnd,
    displayStart,
    dprBucket,
    endTileIndex,
    fftSize,
    frequencyScale,
    generation,
    hopSamples,
    hopSeconds: secondsPerColumn,
    maxDecibels: dbWindow.maxDecibels,
    maxFrequency: analysisType === 'scalogram' ? scalogramFrequencyRange.maxFrequency : context.maxFrequency,
    melBandCount,
    mfccCoefficientCount,
    minDecibels: dbWindow.minDecibels,
    minFrequency: analysisType === 'scalogram'
      ? scalogramFrequencyRange.minFrequency
      : chromaAnalysis
        ? CQT_DEFAULT_FMIN
        : context.minFrequency,
    overlapRatio,
    pixelHeight,
    pixelWidth,
    requestKind,
    rowCount,
    scalogramOmega0,
    scalogramRowDensity,
    startTileIndex,
    targetColumns,
    tileDuration,
    viewEnd,
    viewStart,
    windowFunction,
    windowSeconds,
  };
}

export function buildTileCacheKey(quality: QualityPreset, plan: RenderRequestPlan, tileIndex: number): string {
  return [
    quality,
    `cfg${plan.configVersion}`,
    plan.configKey,
    `tile${tileIndex}`,
    `dpr${plan.dprBucket}`,
  ].join(':');
}

export function createLayerReadyBody(runtimeVariant: string | null, plan: RenderRequestPlan) {
  return {
    analysisType: plan.analysisType,
    colormapDistribution: plan.colormapDistribution,
    configVersion: plan.configVersion,
    decimationFactor: plan.decimationFactor,
    displayEnd: plan.displayEnd,
    displayStart: plan.displayStart,
    fftSize: plan.fftSize,
    frequencyScale: plan.frequencyScale,
    generation: plan.generation,
    hopSamples: plan.hopSamples,
    hopSeconds: plan.hopSeconds,
    maxDecibels: plan.maxDecibels,
    maxFrequency: plan.maxFrequency,
    melBandCount: plan.melBandCount,
    mfccCoefficientCount: plan.mfccCoefficientCount,
    minDecibels: plan.minDecibels,
    minFrequency: plan.minFrequency,
    overlapRatio: plan.overlapRatio,
    pixelHeight: plan.pixelHeight,
    pixelWidth: plan.pixelWidth,
    requestKind: plan.requestKind,
    scalogramHopSamples: plan.hopSamples,
    scalogramOmega0: plan.scalogramOmega0,
    scalogramRowDensity: plan.scalogramRowDensity,
    runtimeVariant,
    targetColumns: plan.targetColumns,
    targetRows: plan.rowCount,
    viewEnd: plan.viewEnd,
    viewStart: plan.viewStart,
    windowFunction: plan.windowFunction,
    windowSeconds: plan.windowSeconds,
  };
}

export function isEquivalentPlan(left: RenderRequestPlan | null, right: RenderRequestPlan | null): boolean {
  if (!left || !right) {
    return false;
  }

  return left.requestKind === right.requestKind
    && left.configVersion === right.configVersion
    && left.analysisType === right.analysisType
    && left.colormapDistribution === right.colormapDistribution
    && left.dprBucket === right.dprBucket
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && left.rowCount === right.rowCount
    && left.targetColumns === right.targetColumns
    && left.fftSize === right.fftSize
    && left.frequencyScale === right.frequencyScale
    && left.minDecibels === right.minDecibels
    && left.maxDecibels === right.maxDecibels
    && left.melBandCount === right.melBandCount
    && left.mfccCoefficientCount === right.mfccCoefficientCount
    && left.minFrequency === right.minFrequency
    && left.maxFrequency === right.maxFrequency
    && Math.abs(left.scalogramOmega0 - right.scalogramOmega0) <= 1e-6
    && Math.abs(left.scalogramRowDensity - right.scalogramRowDensity) <= 1e-6
    && left.hopSamples === right.hopSamples
    && left.windowFunction === right.windowFunction
    && Math.abs(left.overlapRatio - right.overlapRatio) <= 1e-6
    && Math.abs(left.viewStart - right.viewStart) <= 1e-6
    && Math.abs(left.viewEnd - right.viewEnd) <= 1e-6;
}

function normalizeFftSize(value: unknown): number {
  const numericValue = Number(value);
  return FFT_SIZE_OPTIONS.includes(numericValue) ? numericValue : 4096;
}

function normalizeOverlapRatio(value: unknown): number {
  const numericValue = Number(value);
  return OVERLAP_RATIO_OPTIONS.includes(numericValue) ? numericValue : 0.75;
}

function normalizeMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return MEL_BAND_COUNT_OPTIONS.includes(numericValue)
    ? numericValue
    : LIBROSA_DEFAULT_MEL_BAND_COUNT;
}

function normalizeScalogramOmega0(value: unknown): number {
  const numericValue = Number(value);
  return SCALOGRAM_OMEGA_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_OMEGA0;
}

function normalizeScalogramRowDensity(value: unknown): number {
  const numericValue = Number(value);
  return SCALOGRAM_ROW_DENSITY_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_ROW_DENSITY;
}

function normalizeScalogramHopSamples(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.max(1, Math.round(numericValue))
    : DEFAULT_SCALOGRAM_HOP_SAMPLES;
}

function normalizeScalogramFrequencyRange(
  maxSupportedFrequency: number,
  minValue: unknown,
  maxValue: unknown,
): {
  maxFrequency: number;
  minFrequency: number;
} {
  const ceiling = Math.max(
    MIN_FREQUENCY + 1,
    Math.min(MAX_FREQUENCY, Math.round(maxSupportedFrequency || MAX_FREQUENCY)),
  );
  let minFrequency = Number.isFinite(Number(minValue))
    ? Math.round(Number(minValue))
    : MIN_FREQUENCY;
  let maxFrequency = Number.isFinite(Number(maxValue))
    ? Math.round(Number(maxValue))
    : ceiling;

  minFrequency = clamp(
    minFrequency,
    MIN_FREQUENCY,
    Math.max(MIN_FREQUENCY, ceiling - 1),
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

function normalizeMfccCoefficientCount(value: unknown): number {
  const numericValue = Number(value);
  return MFCC_COEFFICIENT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_MFCC_COEFFICIENT_COUNT;
}

function normalizeMfccMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return MEL_BAND_COUNT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_MFCC_MEL_BAND_COUNT;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
