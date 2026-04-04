import {
  buildLinearFrequencyTicks,
  formatFrequencyLabel,
  getFrequencyAtLinearPosition,
  getFrequencyAtLogPosition,
  getFrequencyAtMelPosition,
  getFrequencyAtMixedPosition,
  getLinearFrequencyPosition,
  getLogFrequencyPosition,
  getMelFrequencyPosition,
  getMixedFrequencyPosition,
} from './audioscope/math/spectrogramMath';
import { formatAxisLabel, getNiceTimeStep } from './audioscope/core/format';
import type {
  EngineMainToWorkerMessage,
  EngineWorkerToMainMessage,
  FrequencyTickUi,
  PlaybackClockState,
  SampleInfoPayload,
  SetViewportIntentMessage,
  SpectrogramAnalysisType,
  SpectrogramColormapDistribution,
  SpectrogramFrequencyScale,
  SpectrogramWindowFunction,
  SurfaceKind,
  TransportCommand,
  ViewportIntent,
  ViewportUiState,
  WaveformPlotMode,
} from './audioEngineProtocol';
import { resizeInteractiveWaveformSurface } from './interactive-waveform/renderer';
import {
  TILE_COLUMN_COUNT,
  quantizeCeil,
} from './sharedBuffers';
import {
  createWaveDisplayPlanner,
  loadWaveCoreRuntime,
  type WaveCoreModule,
  type WaveCoreRuntime,
  type WaveDisplayPlanner,
} from './waveCoreRuntime';
import { normalizeSpectrogramWindowFunction, WINDOW_FUNCTION_CODES } from './windowShared';
import {
  WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
  WAVEFORM_BOTTOM_PADDING_PX as WAVEFORM_BOTTOM_PADDING_PX,
  WAVEFORM_TOP_PADDING_PX as WAVEFORM_TOP_PADDING_PX,
} from './interactive-waveform/geometry';
import {
  CHROMA_BIN_COUNT,
  CQT_DEFAULT_FMIN,
  getChromaBinAtPosition,
  getChromaLabel,
} from './audio-analysis/chromaShared';

const CENTER_LINE_ALPHA = 0.14;
const DISPLAY_SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 24;
const DISPLAY_RAW_SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 1;
const LOOP_HANDLE_MIN_SECONDS = 0.05;
const LOOP_SELECTION_MIN_PIXELS = 6;
const MAX_FREQUENCY = 20000;
const MIN_FREQUENCY = 30;
const RAW_SAMPLE_MARKER_FILL = 'rgba(248, 250, 252, 0.94)';
const RAW_SAMPLE_MARKER_MIN_CSS_PIXELS_PER_SAMPLE = 7.5;
const RAW_SAMPLE_MARKER_RADIUS_CSS_PX = 1.5;
const ROW_BUCKET_SIZE = 16;
const DEFAULT_MFCC_COEFFICIENT_COUNT = 20;
const DEFAULT_MFCC_MEL_BAND_COUNT = 128;
const MFCC_COEFFICIENT_OPTIONS = [13, 20, 32, 40];
const LIBROSA_DEFAULT_MEL_BAND_COUNT = 256;
const MEL_BAND_COUNT_OPTIONS = [128, 256, 512];
const DEFAULT_SCALOGRAM_OMEGA0 = 6;
const DEFAULT_SCALOGRAM_ROW_DENSITY = 1;
const DEFAULT_SCALOGRAM_MIN_FREQUENCY = 50;
const DEFAULT_SCALOGRAM_MAX_FREQUENCY = 20000;
const DEFAULT_SCALOGRAM_HOP_SAMPLES = 1024;
const SCALOGRAM_OMEGA_OPTIONS = [4, 5, 6, 7, 8, 10, 12];
const SCALOGRAM_ROW_DENSITY_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const SCALOGRAM_HOP_SAMPLES_OPTIONS = [256, 512, 1024, 2048, 4096];
const SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 20;
const SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 28;
const SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
const SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
const SCALOGRAM_COLUMN_CHUNK_SIZE = 32;
const SCALOGRAM_ROW_BLOCK_SIZE = 32;
const SPECTROGRAM_COLUMN_CHUNK_SIZE = 32;
const SPECTROGRAM_LINEAR_TICK_COUNT = 6;
const SYMMETRIC_ENVELOPE_GAIN = 0.76;
const VISIBLE_ROW_OVERSAMPLE = 1.35;
const WAVEFORM_FOLLOW_RATIO = 0.5;
const WAVEFORM_MAX_ZOOM_PIXELS_PER_SAMPLE = 8;
const WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 0.9;
const WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 1.15;
const WAVEFORM_ZOOM_STEP_FACTOR = 1.75;
const WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR = 2;
const WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.2;
const WAVEFORM_PYRAMID_BUILD_STEP_BLOCKS = 32_768;
const MAX_TILE_CACHE_ENTRIES = 24;
const MAX_TILE_CACHE_BYTES = 96 * 1024 * 1024;
const WAVEFORM_PREVIEW_SAMPLE_TAPS = [-0.3, 0, 0.3] as const;

const ANALYSIS_TYPE_CODES: Record<SpectrogramAnalysisType, number> = {
  spectrogram: 0,
  mel: 1,
  scalogram: 2,
  mfcc: 3,
  chroma: 5,
};

const FREQUENCY_SCALE_CODES: Record<SpectrogramFrequencyScale, number> = {
  log: 0,
  linear: 1,
  mixed: 2,
};

const QUALITY_PRESETS = {
  balanced: {
    colsMultiplier: 2.5,
    lowFrequencyDecimationFactor: 2,
    rowsMultiplier: 1.5,
  },
  high: {
    colsMultiplier: 4,
    lowFrequencyDecimationFactor: 4,
    rowsMultiplier: 2.5,
  },
  max: {
    colsMultiplier: 6,
    lowFrequencyDecimationFactor: 4,
    rowsMultiplier: 4,
  },
} as const;

const FFT_SIZE_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const OVERLAP_RATIO_OPTIONS = [0.5, 0.75, 0.875, 0.9375];
const SPECTROGRAM_TICKS = [20000, 16000, 12000, 8000, 4000, 2000, 1000, 400, 100, 50, 30];
const SPECTROGRAM_DB_WINDOW_LIMITS = {
  max: 12,
  min: -120,
  minimumSpan: 6,
} as const;
const COLORMAP_DISTRIBUTION_GAMMAS: Record<SpectrogramColormapDistribution, number> = {
  balanced: 1,
  contrast: 1.18,
  soft: 0.84,
};

interface WaveformSurfaceState {
  canvas: OffscreenCanvas | null;
  color: string;
  context: OffscreenCanvasRenderingContext2D | null;
  heightCssPx: number;
  renderScale: number;
  widthCssPx: number;
}

interface WaveformRenderCacheState {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
  heightCssPx: number;
  plotMode: WaveformPlotMode | null;
  renderRange: RangeFrames | null;
  renderScale: number;
  renderWidthCssPx: number;
  sessionRevision: number;
}

interface SpectrogramSurfaceState {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
  pixelHeight: number;
  pixelWidth: number;
}

interface TileRecord {
  byteLength: number;
  canvas: OffscreenCanvas;
  columnCount: number;
  complete: boolean;
  context: OffscreenCanvasRenderingContext2D | null;
  imageData: ImageData;
  renderedColumns: number;
  rowCount: number;
  tileEndSeconds: number;
  tileIndex: number;
  tileKey: string;
  tileStartSeconds: number;
}

interface SpectrogramPlan {
  analysisType: SpectrogramAnalysisType;
  colormapDistribution: SpectrogramColormapDistribution;
  configKey: string;
  decimationFactor: number;
  dprBucket: number;
  endTileIndex: number;
  fftSize: number;
  frequencyScale: SpectrogramFrequencyScale;
  hopSamples: number;
  hopSeconds: number;
  maxDecibels: number;
  maxFrequency: number;
  melBandCount: number;
  minDecibels: number;
  minFrequency: number;
  overlapRatio: number;
  pixelHeight: number;
  pixelWidth: number;
  rowCount: number;
  scalogramOmega0: number;
  scalogramRowDensity: number;
  startTileIndex: number;
  targetColumns: number;
  tileDurationSeconds: number;
  viewEndSeconds: number;
  viewStartSeconds: number;
  windowFunction: SpectrogramWindowFunction;
  windowSeconds: number;
}

interface WaveformBufferedRenderPlan {
  renderRange: RangeFrames;
  renderWidthCssPx: number;
}

interface RangeFrames {
  endFrame: number;
  startFrame: number;
}

interface SelectionDragState {
  anchorFrame: number;
  anchorRatioX: number;
  moved: boolean;
  surface: SurfaceKind;
  type: 'selection';
}

interface LoopHandleDragState {
  baseRange: RangeFrames;
  edge: 'end' | 'start';
  surface: SurfaceKind;
  type: 'loop';
}

type DragState = LoopHandleDragState | SelectionDragState | null;

interface EngineSessionState {
  durationFrames: number;
  initialized: boolean;
  maxFrequency: number;
  minFrequency: number;
  module: WaveCoreModule | null;
  quality: 'balanced' | 'high' | 'max';
  runtimeVariant: string | null;
  sampleRate: number;
  sessionRevision: number;
  spectrogramOutputCapacity: number;
  spectrogramOutputPointer: number;
  tileCache: Map<string, TileRecord>;
  tileCacheBytes: number;
  waveformBuildPending: boolean;
  waveformBuilt: boolean;
  waveformPcmPointer: number;
  waveformSlice: Float32Array | null;
  waveformSliceCapacity: number;
  waveformSlicePointer: number;
}

interface EngineState {
  displayPlanner: WaveDisplayPlanner | null;
  dragState: DragState;
  hoverWaveformRatioX: number | null;
  lastSpectrogramPlan: SpectrogramPlan | null;
  loopRangeFrames: RangeFrames | null;
  pendingTransportCommand: TransportCommand | null;
  playbackClock: PlaybackClockState;
  renderConfigRevision: number;
  renderRevision: number;
  renderScheduled: boolean;
  renderSurfacesRevision: number;
  renderToken: number;
  selectionDraftRangeFrames: RangeFrames | null;
  session: EngineSessionState;
  spectrogramConfig: {
    analysisType: SpectrogramAnalysisType;
    colormapDistribution: SpectrogramColormapDistribution;
    fftSize: number;
    frequencyScale: SpectrogramFrequencyScale;
    maxDecibels: number;
    melBandCount: number;
    mfccCoefficientCount: number;
    mfccMelBandCount: number;
    windowFunction: SpectrogramWindowFunction;
    scalogramHopSamples: number;
    scalogramMaxFrequency: number;
    scalogramMinFrequency: number;
    scalogramOmega0: number;
    scalogramRowDensity: number;
    minDecibels: number;
    overlapRatio: number;
  };
  uiRevision: number;
  viewport: {
    followEnabled: boolean;
    plotMode: WaveformPlotMode;
    presentedEndFrame: number;
    presentedStartFrame: number;
    renderWidthPx: number;
    renderedEndFrame: number;
    renderedStartFrame: number;
    targetEndFrame: number;
    targetStartFrame: number;
  };
  waveformCache: WaveformRenderCacheState;
  waveformSurface: WaveformSurfaceState;
  spectrogramSurface: SpectrogramSurfaceState;
}

const waveformSurface: WaveformSurfaceState = {
  canvas: null,
  color: '#8ccadd',
  context: null,
  heightCssPx: 1,
  renderScale: 2,
  widthCssPx: 1,
};

const spectrogramSurface: SpectrogramSurfaceState = {
  canvas: null,
  context: null,
  pixelHeight: 1,
  pixelWidth: 1,
};

const waveformCache: WaveformRenderCacheState = {
  canvas: null,
  context: null,
  heightCssPx: 0,
  plotMode: null,
  renderRange: null,
  renderScale: 1,
  renderWidthCssPx: 0,
  sessionRevision: -1,
};

let runtimePromise: Promise<WaveCoreRuntime> | null = null;
let requestQueue = Promise.resolve();

const state: EngineState = {
  displayPlanner: null,
  dragState: null,
  hoverWaveformRatioX: null,
  lastSpectrogramPlan: null,
  loopRangeFrames: null,
  pendingTransportCommand: null,
  playbackClock: createEmptyPlaybackClock(),
  renderConfigRevision: 0,
  renderRevision: 0,
  renderScheduled: false,
  renderSurfacesRevision: 0,
  renderToken: 0,
  selectionDraftRangeFrames: null,
  session: createEmptySessionState(),
  spectrogramConfig: {
    analysisType: 'spectrogram',
    colormapDistribution: 'balanced',
    fftSize: 4096,
    frequencyScale: 'log',
    maxDecibels: 0,
    melBandCount: LIBROSA_DEFAULT_MEL_BAND_COUNT,
    mfccCoefficientCount: DEFAULT_MFCC_COEFFICIENT_COUNT,
    mfccMelBandCount: DEFAULT_MFCC_MEL_BAND_COUNT,
    windowFunction: 'hann',
    scalogramHopSamples: DEFAULT_SCALOGRAM_HOP_SAMPLES,
    scalogramMaxFrequency: DEFAULT_SCALOGRAM_MAX_FREQUENCY,
    scalogramMinFrequency: DEFAULT_SCALOGRAM_MIN_FREQUENCY,
    scalogramOmega0: DEFAULT_SCALOGRAM_OMEGA0,
    scalogramRowDensity: DEFAULT_SCALOGRAM_ROW_DENSITY,
    minDecibels: -80,
    overlapRatio: 0.75,
  },
  uiRevision: 0,
  viewport: {
    followEnabled: false,
    plotMode: 'envelope',
    presentedEndFrame: 0,
    presentedStartFrame: 0,
    renderWidthPx: 1,
    renderedEndFrame: 0,
    renderedStartFrame: 0,
    targetEndFrame: 0,
    targetStartFrame: 0,
  },
  waveformCache,
  waveformSurface,
  spectrogramSurface,
};

self.onmessage = (event: MessageEvent<EngineMainToWorkerMessage>) => {
  const message = event.data;

  if (!message?.type) {
    return;
  }

  switch (message.type) {
    case 'InitSurfaces':
      handleInitSurfaces(message);
      return;
    case 'LoadAnalysisSession':
      enqueueRequest(async () => {
        await handleLoadAnalysisSession(message);
      });
      return;
    case 'PlaybackClockTick':
      handlePlaybackClockTick(message.body);
      return;
    case 'SetViewportIntent':
      handleViewportIntent(message);
      return;
    case 'SetSpectrogramConfig':
      handleSpectrogramConfig(message.body);
      return;
    case 'RequestSampleInfo':
      handleSampleInfoRequest(message.body);
      return;
    default:
      return;
  }
};

function createEmptyPlaybackClock(): PlaybackClockState {
  return {
    currentFrameFloat: 0,
    durationFrames: 0,
    loopEndFrame: null,
    loopStartFrame: null,
    playing: false,
    sampleRate: 0,
  };
}

function createEmptySessionState(): EngineSessionState {
  return {
    durationFrames: 0,
    initialized: false,
    maxFrequency: MAX_FREQUENCY,
    minFrequency: MIN_FREQUENCY,
    module: null,
    quality: 'high',
    runtimeVariant: null,
    sampleRate: 0,
    sessionRevision: -1,
    spectrogramOutputCapacity: 0,
    spectrogramOutputPointer: 0,
    tileCache: new Map(),
    tileCacheBytes: 0,
    waveformBuildPending: false,
    waveformBuilt: false,
    waveformPcmPointer: 0,
    waveformSlice: null,
    waveformSliceCapacity: 0,
    waveformSlicePointer: 0,
  };
}

function enqueueRequest(task: () => Promise<void>): void {
  requestQueue = requestQueue
    .then(task)
    .catch((error) => {
      postError(error);
    });
}

async function getRuntime(): Promise<WaveCoreRuntime> {
  if (!runtimePromise) {
    runtimePromise = loadWaveCoreRuntime();
  }

  return runtimePromise;
}

function getDisplayPlanner(module: WaveCoreModule): WaveDisplayPlanner {
  if (!state.displayPlanner) {
    state.displayPlanner = createWaveDisplayPlanner(module);
  }

  return state.displayPlanner;
}

function invalidateWaveformCache(): void {
  state.waveformCache.plotMode = null;
  state.waveformCache.renderRange = null;
  state.waveformCache.renderWidthCssPx = 0;
  state.waveformCache.heightCssPx = 0;
  state.waveformCache.renderScale = 1;
  state.waveformCache.sessionRevision = -1;
}

function areRangeFramesEqual(left: RangeFrames | null, right: RangeFrames | null): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return left.startFrame === right.startFrame && left.endFrame === right.endFrame;
}

function handleInitSurfaces(message: EngineMainToWorkerMessage & { type: 'InitSurfaces' }): void {
  const { body } = message;

  if (body.waveformOffscreenCanvas) {
    state.waveformSurface.canvas = body.waveformOffscreenCanvas;
  }

  if (body.spectrogramOffscreenCanvas) {
    state.spectrogramSurface.canvas = body.spectrogramOffscreenCanvas;
  }

  state.waveformSurface.widthCssPx = Math.max(1, Math.round(Number(body.waveformWidthCssPx) || state.waveformSurface.widthCssPx || 1));
  state.waveformSurface.heightCssPx = Math.max(1, Math.round(Number(body.waveformHeightCssPx) || state.waveformSurface.heightCssPx || 1));
  state.waveformSurface.renderScale = Math.max(1, Number(body.waveformRenderScale) || state.waveformSurface.renderScale || 1);
  state.spectrogramSurface.pixelWidth = Math.max(1, Math.round(Number(body.spectrogramPixelWidth) || state.spectrogramSurface.pixelWidth || 1));
  state.spectrogramSurface.pixelHeight = Math.max(1, Math.round(Number(body.spectrogramPixelHeight) || state.spectrogramSurface.pixelHeight || 1));

  resizeWaveformSurface();
  resizeSpectrogramSurface();
  invalidateWaveformCache();
  state.renderSurfacesRevision += 1;
  state.viewport.renderWidthPx = state.waveformSurface.widthCssPx;
  emitUiState();
  scheduleRender();
}

async function handleLoadAnalysisSession(message: EngineMainToWorkerMessage & { type: 'LoadAnalysisSession' }): Promise<void> {
  const runtime = await getRuntime();
  const body = message.body;
  const sampleRate = Math.max(1, Math.round(Number(body.sampleRate) || 0));
  const durationFrames = Math.max(0, Math.round(Number(body.durationFrames) || 0));
  const sessionRevision = Math.max(0, Math.round(Number(body.sessionRevision) || 0));
  const quality = body.quality === 'balanced' || body.quality === 'max' ? body.quality : 'high';

  if (!(body.monoSamplesBuffer instanceof ArrayBuffer)) {
    throw new Error('LoadAnalysisSession is missing mono PCM.');
  }

  if (sampleRate <= 0 || durationFrames <= 0) {
    throw new Error('LoadAnalysisSession provided invalid audio metadata.');
  }

  disposeWasmSession(runtime.module);
  clearTileCache();
  invalidateWaveformCache();

  const durationSeconds = durationFrames / sampleRate;
  if (!runtime.module._wave_prepare_session(durationFrames, sampleRate, durationSeconds)) {
    throw new Error('Failed to allocate audio engine session.');
  }

  const pcmPointer = runtime.module._wave_get_pcm_ptr();
  if (!pcmPointer) {
    throw new Error('Audio engine PCM allocation failed.');
  }

  const monoSamples = new Float32Array(body.monoSamplesBuffer);
  if (monoSamples.length !== durationFrames) {
    throw new Error('LoadAnalysisSession PCM length did not match durationFrames.');
  }

  getHeapF32View(runtime.module, pcmPointer, durationFrames).set(monoSamples);

  state.session = {
    ...createEmptySessionState(),
    durationFrames,
    initialized: true,
    maxFrequency: Math.min(MAX_FREQUENCY, sampleRate / 2),
    minFrequency: MIN_FREQUENCY,
    module: runtime.module,
    quality,
    runtimeVariant: runtime.variant,
    sampleRate,
    sessionRevision,
    waveformBuildPending: false,
    waveformBuilt: false,
    waveformPcmPointer: pcmPointer,
  };

  state.playbackClock = {
    ...state.playbackClock,
    currentFrameFloat: 0,
    durationFrames,
    sampleRate,
  };
  state.loopRangeFrames = null;
  state.selectionDraftRangeFrames = null;
  state.dragState = null;
  state.hoverWaveformRatioX = null;
  state.pendingTransportCommand = null;
  state.renderConfigRevision += 1;
  const fullRange = createFullRange();
  setTargetRange(fullRange.startFrame, fullRange.endFrame);
  state.viewport.presentedStartFrame = 0;
  state.viewport.presentedEndFrame = 0;
  state.viewport.renderedStartFrame = 0;
  state.viewport.renderedEndFrame = 0;
  emitUiState();
  scheduleRender();
  scheduleWaveformPyramidBuild(sessionRevision);
}

function scheduleWaveformPyramidBuild(sessionRevision: number): void {
  if (
    !state.session.initialized
    || !state.session.module
    || state.session.sessionRevision !== sessionRevision
    || state.session.waveformBuilt
    || state.session.waveformBuildPending
  ) {
    return;
  }

  const beginResult = state.session.module._wave_begin_waveform_pyramid_build();
  if (!beginResult) {
    return;
  }

  state.session.waveformBuildPending = true;
  state.session.waveformBuilt = false;

  const stepBuild = () => {
    try {
      if (
        !state.session.initialized
        || !state.session.module
        || state.session.sessionRevision !== sessionRevision
      ) {
        return;
      }

      const done = state.session.module._wave_build_waveform_pyramid_step(WAVEFORM_PYRAMID_BUILD_STEP_BLOCKS);

      if (state.session.sessionRevision !== sessionRevision) {
        return;
      }

      if (done) {
        state.session.waveformBuilt = true;
        state.session.waveformBuildPending = false;
        invalidateWaveformCache();
        scheduleRender();
        return;
      }

      self.setTimeout(stepBuild, 0);
    } catch (error) {
      if (state.session.sessionRevision === sessionRevision) {
        state.session.waveformBuildPending = false;
      }
      postError(error);
    }
  };

  self.setTimeout(stepBuild, 0);
}

function handlePlaybackClockTick(clock: PlaybackClockState): void {
  state.playbackClock = {
    currentFrameFloat: clamp(Number(clock.currentFrameFloat) || 0, 0, Math.max(0, state.session.durationFrames)),
    durationFrames: Math.max(0, Math.round(Number(clock.durationFrames) || state.session.durationFrames || 0)),
    loopEndFrame: normalizeNullableFrame(clock.loopEndFrame),
    loopStartFrame: normalizeNullableFrame(clock.loopStartFrame),
    playing: clock.playing === true,
    sampleRate: Math.max(0, Math.round(Number(clock.sampleRate) || state.session.sampleRate || 0)),
  };

  state.loopRangeFrames = normalizeOptionalRange(
    state.playbackClock.loopStartFrame,
    state.playbackClock.loopEndFrame,
    state.playbackClock.durationFrames,
  );
  applyFollowSolver();
  emitUiState();
}

function handleViewportIntent(message: SetViewportIntentMessage): void {
  applyViewportIntent(message.body);
}

function getDefaultSpectrogramDbWindow(analysisType: SpectrogramAnalysisType): {
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

function normalizeSpectrogramDbWindow(
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

function normalizeMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return MEL_BAND_COUNT_OPTIONS.includes(numericValue)
    ? numericValue
    : LIBROSA_DEFAULT_MEL_BAND_COUNT;
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
  return SCALOGRAM_HOP_SAMPLES_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_HOP_SAMPLES;
}

function normalizeScalogramFrequencyRange(minValue: unknown, maxValue: unknown): {
  maxFrequency: number;
  minFrequency: number;
} {
  const ceiling = Math.max(
    DEFAULT_SCALOGRAM_MIN_FREQUENCY + 1,
    Math.min(MAX_FREQUENCY, Math.round(state.session.maxFrequency || DEFAULT_SCALOGRAM_MAX_FREQUENCY)),
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

function isChromaAnalysisType(analysisType: SpectrogramAnalysisType): boolean {
  return analysisType === 'chroma';
}

function handleSpectrogramConfig(config: {
  analysisType: SpectrogramAnalysisType;
  colormapDistribution: SpectrogramColormapDistribution;
  fftSize: number;
  frequencyScale: SpectrogramFrequencyScale;
  maxDecibels: number;
  melBandCount: number;
  mfccCoefficientCount: number;
  mfccMelBandCount: number;
  windowFunction: SpectrogramWindowFunction;
  scalogramHopSamples: number;
  scalogramMaxFrequency: number;
  scalogramMinFrequency: number;
  scalogramOmega0: number;
  scalogramRowDensity: number;
  minDecibels: number;
  overlapRatio: number;
}): void {
  const nextAnalysisType = config.analysisType === 'chroma'
    || config.analysisType === 'mel'
    || config.analysisType === 'mfcc'
    || config.analysisType === 'scalogram'
    ? config.analysisType
    : 'spectrogram';
  const nextColormapDistribution = config.colormapDistribution === 'contrast' || config.colormapDistribution === 'soft'
    ? config.colormapDistribution
    : 'balanced';
  const nextFftSize = FFT_SIZE_OPTIONS.includes(Number(config.fftSize))
    ? Number(config.fftSize)
    : 4096;
  const nextOverlapRatio = OVERLAP_RATIO_OPTIONS.includes(Number(config.overlapRatio))
    ? Number(config.overlapRatio)
    : 0.75;
  const nextFrequencyScale = nextAnalysisType === 'spectrogram'
    ? (config.frequencyScale === 'linear' || config.frequencyScale === 'mixed' ? config.frequencyScale : 'log')
    : 'log';
  const nextMelBandCount = normalizeMelBandCount(config.melBandCount);
  const nextMfccCoefficientCount = normalizeMfccCoefficientCount(config.mfccCoefficientCount);
  const nextMfccMelBandCount = normalizeMfccMelBandCount(config.mfccMelBandCount ?? config.melBandCount);
  const nextWindowFunction = normalizeSpectrogramWindowFunction(config.windowFunction);
  const nextScalogramHopSamples = normalizeScalogramHopSamples(config.scalogramHopSamples);
  const nextScalogramOmega0 = normalizeScalogramOmega0(config.scalogramOmega0);
  const nextScalogramRowDensity = normalizeScalogramRowDensity(config.scalogramRowDensity);
  const nextScalogramFrequencyRange = normalizeScalogramFrequencyRange(
    config.scalogramMinFrequency,
    config.scalogramMaxFrequency,
  );
  const nextDbWindow = normalizeSpectrogramDbWindow(
    config.minDecibels,
    config.maxDecibels,
    nextAnalysisType,
  );

  const changed =
    nextAnalysisType !== state.spectrogramConfig.analysisType
    || nextColormapDistribution !== state.spectrogramConfig.colormapDistribution
    || nextFftSize !== state.spectrogramConfig.fftSize
    || nextDbWindow.minDecibels !== state.spectrogramConfig.minDecibels
    || nextDbWindow.maxDecibels !== state.spectrogramConfig.maxDecibels
    || nextMelBandCount !== state.spectrogramConfig.melBandCount
    || nextMfccCoefficientCount !== state.spectrogramConfig.mfccCoefficientCount
    || nextMfccMelBandCount !== state.spectrogramConfig.mfccMelBandCount
    || nextWindowFunction !== state.spectrogramConfig.windowFunction
    || nextScalogramHopSamples !== state.spectrogramConfig.scalogramHopSamples
    || nextScalogramFrequencyRange.minFrequency !== state.spectrogramConfig.scalogramMinFrequency
    || nextScalogramFrequencyRange.maxFrequency !== state.spectrogramConfig.scalogramMaxFrequency
    || Math.abs(nextScalogramOmega0 - state.spectrogramConfig.scalogramOmega0) > 1e-9
    || Math.abs(nextScalogramRowDensity - state.spectrogramConfig.scalogramRowDensity) > 1e-9
    || Math.abs(nextOverlapRatio - state.spectrogramConfig.overlapRatio) > 1e-9
    || nextFrequencyScale !== state.spectrogramConfig.frequencyScale;

  if (!changed) {
    emitUiState();
    return;
  }

  state.spectrogramConfig = {
    analysisType: nextAnalysisType,
    colormapDistribution: nextColormapDistribution,
    fftSize: nextFftSize,
    frequencyScale: nextFrequencyScale,
    maxDecibels: nextDbWindow.maxDecibels,
    melBandCount: nextMelBandCount,
    mfccCoefficientCount: nextMfccCoefficientCount,
    mfccMelBandCount: nextMfccMelBandCount,
    windowFunction: nextWindowFunction,
    scalogramHopSamples: nextScalogramHopSamples,
    scalogramMaxFrequency: nextScalogramFrequencyRange.maxFrequency,
    scalogramMinFrequency: nextScalogramFrequencyRange.minFrequency,
    scalogramOmega0: nextScalogramOmega0,
    scalogramRowDensity: nextScalogramRowDensity,
    minDecibels: nextDbWindow.minDecibels,
    overlapRatio: nextOverlapRatio,
  };
  clearTileCache();
  state.lastSpectrogramPlan = null;
  state.renderConfigRevision += 1;
  emitUiState();
  scheduleRender();
}

function handleSampleInfoRequest(body: {
  pointerRatioX: number;
  pointerRatioY: number;
  requestId: number;
  surface: SurfaceKind;
}): void {
  const payload = body.surface === 'waveform'
    ? buildWaveformSampleInfo(body.pointerRatioX, body.pointerRatioY, body.requestId)
    : buildSpectrogramSampleInfo(body.pointerRatioX, body.pointerRatioY, body.requestId);

  if (!payload) {
    return;
  }

  postMessage({
    type: 'SampleInfo',
    body: payload,
  });
}

function applyViewportIntent(intent: ViewportIntent): void {
  if (!state.session.initialized && intent.kind !== 'resize' && intent.kind !== 'setFollow') {
    emitUiState();
    return;
  }

  switch (intent.kind) {
    case 'resize': {
      const waveformWidthCssPx = Math.max(1, Math.round(Number(intent.waveformWidthCssPx) || state.waveformSurface.widthCssPx || 1));
      const waveformHeightCssPx = Math.max(1, Math.round(Number(intent.waveformHeightCssPx) || state.waveformSurface.heightCssPx || 1));
      const waveformRenderScale = Math.max(1, Number(intent.waveformRenderScale) || state.waveformSurface.renderScale || 1);
      const spectrogramPixelWidth = Math.max(1, Math.round(Number(intent.spectrogramPixelWidth) || state.spectrogramSurface.pixelWidth || 1));
      const spectrogramPixelHeight = Math.max(1, Math.round(Number(intent.spectrogramPixelHeight) || state.spectrogramSurface.pixelHeight || 1));
      const changed =
        waveformWidthCssPx !== state.waveformSurface.widthCssPx
        || waveformHeightCssPx !== state.waveformSurface.heightCssPx
        || Math.abs(waveformRenderScale - state.waveformSurface.renderScale) > 1e-9
        || spectrogramPixelWidth !== state.spectrogramSurface.pixelWidth
        || spectrogramPixelHeight !== state.spectrogramSurface.pixelHeight;

      state.waveformSurface.widthCssPx = waveformWidthCssPx;
      state.waveformSurface.heightCssPx = waveformHeightCssPx;
      state.waveformSurface.renderScale = waveformRenderScale;
      state.spectrogramSurface.pixelWidth = spectrogramPixelWidth;
      state.spectrogramSurface.pixelHeight = spectrogramPixelHeight;
      resizeWaveformSurface();
      resizeSpectrogramSurface();
      invalidateWaveformCache();
      state.viewport.renderWidthPx = waveformWidthCssPx;
      clampViewportToDuration();
      if (changed) {
        state.renderSurfacesRevision += 1;
        emitUiState();
        scheduleRender();
      } else {
        emitUiState();
      }
      return;
    }
    case 'setFollow':
      state.viewport.followEnabled = intent.enabled === true;
      applyFollowSolver();
      emitUiState();
      return;
    case 'wheel':
      handleWheelIntent(intent);
      return;
    case 'zoomStep':
      handleZoomStepIntent(intent.direction);
      return;
    case 'resetZoom': {
      const fullRange = createFullRange();
      setTargetRange(fullRange.startFrame, fullRange.endFrame);
      emitUiState();
      scheduleRender();
      return;
    }
    case 'selectionStart':
      state.viewport.followEnabled = false;
      state.dragState = {
        anchorFrame: getFrameAtPresentedRatio(intent.pointerRatioX),
        anchorRatioX: clamp01(intent.pointerRatioX),
        moved: false,
        surface: intent.surface,
        type: 'selection',
      };
      state.selectionDraftRangeFrames = null;
      emitUiState();
      return;
    case 'selectionUpdate':
      updateSelectionDrag(intent.pointerRatioX);
      emitUiState();
      return;
    case 'selectionEnd':
      finishSelectionDrag(intent.pointerRatioX, intent.cancelled === true);
      emitUiState();
      return;
    case 'loopHandleStart':
      if (state.loopRangeFrames) {
        state.viewport.followEnabled = false;
        state.dragState = {
          baseRange: state.loopRangeFrames,
          edge: intent.edge,
          surface: intent.surface,
          type: 'loop',
        };
        state.selectionDraftRangeFrames = { ...state.loopRangeFrames };
      }
      emitUiState();
      return;
    case 'loopHandleUpdate':
      updateLoopHandleDrag(intent.edge, intent.pointerRatioX);
      emitUiState();
      return;
    case 'loopHandleEnd':
      finishLoopHandleDrag(intent.edge, intent.pointerRatioX, intent.cancelled === true);
      emitUiState();
      return;
    case 'clearLoop':
      state.loopRangeFrames = null;
      queueTransportCommand({
        serial: nextTransportCommandSerial(),
        type: 'clearLoop',
      });
      emitUiState();
      return;
    case 'setViewFrameRange':
      state.viewport.followEnabled = false;
      setTargetRange(intent.startFrame, intent.endFrame);
      emitUiState();
      scheduleRender();
      return;
    case 'setLoop':
      queueTransportCommand({
        frame: clampFrame(intent.frame),
        serial: nextTransportCommandSerial(),
        type: 'seek',
      });
      emitUiState();
      return;
    default:
      emitUiState();
  }
}

function handleWheelIntent(intent: Extract<ViewportIntent, { kind: 'wheel' }>): void {
  const widthPx = getSurfaceWidthPx(intent.surface);
  if (widthPx <= 0 || state.session.durationFrames <= 0) {
    emitUiState();
    return;
  }

  const deltaScale =
    intent.deltaMode === 1
      ? 16
      : intent.deltaMode === 2
        ? widthPx
        : 1;
  const deltaX = intent.deltaX * deltaScale;
  const deltaY = intent.deltaY * deltaScale;
  const horizontalMagnitude = Math.abs(deltaX);
  const verticalMagnitude = Math.abs(deltaY);
  const currentRange = getTargetRange();
  const currentSpanFrames = Math.max(1, currentRange.endFrame - currentRange.startFrame);

  if (verticalMagnitude >= horizontalMagnitude && verticalMagnitude > 0.01) {
    const nextSpanFrames = clamp(
      Math.round(currentSpanFrames * Math.pow(WAVEFORM_ZOOM_STEP_FACTOR, deltaY / 180)),
      getMinVisibleFrames(),
      Math.max(getMinVisibleFrames(), state.session.durationFrames),
    );

    const anchorRatio = state.viewport.followEnabled
      ? WAVEFORM_FOLLOW_RATIO
      : clamp01(intent.pointerRatioX);
    const anchorFrame = state.viewport.followEnabled
      ? getClampedPlaybackFrame()
      : getFrameAtPresentedRatio(intent.pointerRatioX);

    state.viewport.followEnabled = state.viewport.followEnabled && verticalMagnitude > 0.01;
    applyZoomAroundFrame(anchorFrame, nextSpanFrames, anchorRatio);
    emitUiState();
    scheduleRender();
    return;
  }

  if (horizontalMagnitude > 0.01) {
    state.viewport.followEnabled = false;
    const framesPerPixel = currentSpanFrames / Math.max(1, widthPx);
    const deltaFrames = Math.round(deltaX * framesPerPixel);
    setTargetRange(
      currentRange.startFrame + deltaFrames,
      currentRange.endFrame + deltaFrames,
    );
    emitUiState();
    scheduleRender();
    return;
  }

  emitUiState();
}

function handleZoomStepIntent(direction: 'in' | 'out'): void {
  const currentRange = getTargetRange();
  const currentSpanFrames = Math.max(1, currentRange.endFrame - currentRange.startFrame);
  const nextSpanFrames = direction === 'in'
    ? Math.max(getMinVisibleFrames(), Math.round(currentSpanFrames / WAVEFORM_ZOOM_STEP_FACTOR))
    : Math.min(state.session.durationFrames, Math.round(currentSpanFrames * WAVEFORM_ZOOM_STEP_FACTOR));
  const anchorRatio = state.viewport.followEnabled
    ? WAVEFORM_FOLLOW_RATIO
    : (state.hoverWaveformRatioX ?? 0.5);
  const anchorFrame = state.viewport.followEnabled
    ? getClampedPlaybackFrame()
    : getFrameAtPresentedRatio(anchorRatio);

  applyZoomAroundFrame(anchorFrame, nextSpanFrames, anchorRatio);
  emitUiState();
  scheduleRender();
}

function updateSelectionDrag(pointerRatioX: number): void {
  const dragState = state.dragState;
  if (!dragState || dragState.type !== 'selection') {
    return;
  }

  const endFrame = getFrameAtPresentedRatio(pointerRatioX);
  const widthPx = getSurfaceWidthPx(dragState.surface);
  const pointerDeltaPx = Math.abs(clamp01(pointerRatioX) - dragState.anchorRatioX) * Math.max(1, widthPx);
  const frameDelta = Math.abs(endFrame - dragState.anchorFrame);
  const minLoopFrames = getMinimumLoopFrames();

  if (!dragState.moved && pointerDeltaPx < LOOP_SELECTION_MIN_PIXELS && frameDelta < minLoopFrames) {
    return;
  }

  dragState.moved = true;
  state.selectionDraftRangeFrames = normalizeDraftRange(dragState.anchorFrame, endFrame);
}

function finishSelectionDrag(pointerRatioX: number, cancelled: boolean): void {
  const dragState = state.dragState;
  if (!dragState || dragState.type !== 'selection') {
    return;
  }

  const anchorFrame = dragState.anchorFrame;
  const endFrame = getFrameAtPresentedRatio(pointerRatioX);
  const committedRange = normalizeCommittedLoopRange(anchorFrame, endFrame);

  state.dragState = null;

  if (cancelled) {
    state.selectionDraftRangeFrames = null;
    return;
  }

  if (dragState.moved && committedRange) {
    state.loopRangeFrames = committedRange;
    state.selectionDraftRangeFrames = null;
    queueTransportCommand({
      endFrame: committedRange.endFrame,
      serial: nextTransportCommandSerial(),
      startFrame: committedRange.startFrame,
      type: 'setLoop',
    });
    return;
  }

  state.selectionDraftRangeFrames = null;

  if (state.loopRangeFrames && !isFrameWithinRange(anchorFrame, state.loopRangeFrames)) {
    state.loopRangeFrames = null;
    queueTransportCommand({
      frame: anchorFrame,
      serial: nextTransportCommandSerial(),
      type: 'clearLoopAndSeek',
    });
    return;
  }

  queueTransportCommand({
    frame: anchorFrame,
    serial: nextTransportCommandSerial(),
    type: 'seek',
  });
}

function updateLoopHandleDrag(edge: 'end' | 'start', pointerRatioX: number): void {
  const dragState = state.dragState;
  if (!dragState || dragState.type !== 'loop' || dragState.edge !== edge) {
    return;
  }

  state.selectionDraftRangeFrames = getAdjustedLoopRange(dragState.baseRange, edge, pointerRatioX);
}

function finishLoopHandleDrag(edge: 'end' | 'start', pointerRatioX: number, cancelled: boolean): void {
  const dragState = state.dragState;
  if (!dragState || dragState.type !== 'loop' || dragState.edge !== edge) {
    return;
  }

  const nextRange = getAdjustedLoopRange(dragState.baseRange, edge, pointerRatioX);
  state.dragState = null;
  state.selectionDraftRangeFrames = null;

  if (cancelled) {
    return;
  }

  state.loopRangeFrames = nextRange;
  queueTransportCommand({
    endFrame: nextRange.endFrame,
    serial: nextTransportCommandSerial(),
    startFrame: nextRange.startFrame,
    type: 'setLoop',
  });
}

function applyZoomAroundFrame(anchorFrame: number, requestedSpanFrames: number, anchorRatio: number): void {
  const nextSpanFrames = clamp(
    Math.round(requestedSpanFrames),
    getMinVisibleFrames(),
    Math.max(getMinVisibleFrames(), state.session.durationFrames),
  );
  const nextStartFrame = clamp(
    Math.round(anchorFrame - nextSpanFrames * clamp01(anchorRatio)),
    0,
    Math.max(0, state.session.durationFrames - nextSpanFrames),
  );
  setTargetRange(nextStartFrame, nextStartFrame + nextSpanFrames);
}

function getClampedPlaybackFrame(): number {
  return clamp(
    Number.isFinite(state.playbackClock.currentFrameFloat) ? state.playbackClock.currentFrameFloat : 0,
    0,
    Math.max(0, state.session.durationFrames),
  );
}

function getAdjustedLoopRange(baseRange: RangeFrames, edge: 'end' | 'start', pointerRatioX: number): RangeFrames {
  const nextFrame = getFrameAtPresentedRatio(pointerRatioX);
  const minLoopFrames = getMinimumLoopFrames();

  if (edge === 'start') {
    return {
      startFrame: clamp(nextFrame, 0, Math.max(0, baseRange.endFrame - minLoopFrames)),
      endFrame: baseRange.endFrame,
    };
  }

  return {
    startFrame: baseRange.startFrame,
    endFrame: clamp(nextFrame, baseRange.startFrame + minLoopFrames, state.session.durationFrames),
  };
}

function normalizeDraftRange(startFrame: number, endFrame: number): RangeFrames {
  return {
    startFrame: clamp(Math.min(startFrame, endFrame), 0, state.session.durationFrames),
    endFrame: clamp(Math.max(startFrame, endFrame), 0, state.session.durationFrames),
  };
}

function normalizeCommittedLoopRange(startFrame: number, endFrame: number): RangeFrames | null {
  const nextRange = normalizeDraftRange(startFrame, endFrame);
  return nextRange.endFrame - nextRange.startFrame >= getMinimumLoopFrames()
    ? nextRange
    : null;
}

function isFrameWithinRange(frame: number, range: RangeFrames): boolean {
  return frame >= range.startFrame && frame < range.endFrame;
}

function getMinimumLoopFrames(): number {
  const sampleRate = state.session.sampleRate;
  if (!(sampleRate > 0)) {
    return 1;
  }

  return Math.max(1, Math.round(LOOP_HANDLE_MIN_SECONDS * sampleRate));
}

function normalizeNullableFrame(value: number | null | undefined): number | null {
  return Number.isFinite(value)
    ? clamp(Math.round(Number(value)), 0, Math.max(0, state.session.durationFrames))
    : null;
}

function normalizeOptionalRange(
  startFrame: number | null | undefined,
  endFrame: number | null | undefined,
  durationFrames: number,
): RangeFrames | null {
  if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) {
    return null;
  }

  const safeStart = clamp(Math.round(Number(startFrame)), 0, Math.max(0, durationFrames));
  const safeEnd = clamp(Math.round(Number(endFrame)), safeStart + 1, Math.max(safeStart + 1, durationFrames));
  return safeEnd > safeStart ? { startFrame: safeStart, endFrame: safeEnd } : null;
}

function applyFollowSolver(): void {
  if (!state.viewport.followEnabled || isInteractionActive()) {
    clampViewportToDuration();
    return;
  }

  const currentRange = getTargetRange();
  const spanFrames = Math.max(1, currentRange.endFrame - currentRange.startFrame);
  const anchorFrame = getClampedPlaybackFrame();
  const nextStartFrame = clamp(
    Math.round(anchorFrame - spanFrames * WAVEFORM_FOLLOW_RATIO),
    0,
    Math.max(0, state.session.durationFrames - spanFrames),
  );
  const changed = setTargetRange(nextStartFrame, nextStartFrame + spanFrames);
  if (changed) {
    scheduleRender();
  }
}

function isInteractionActive(): boolean {
  return state.dragState !== null;
}

function createFullRange(): RangeFrames {
  return {
    startFrame: 0,
    endFrame: Math.max(0, state.session.durationFrames),
  };
}

function clampViewportToDuration(): void {
  const currentRange = getTargetRange();
  setTargetRange(currentRange.startFrame, currentRange.endFrame);
}

function setTargetRange(startFrame: number, endFrame: number): boolean {
  const nextRange = normalizeViewportRange(startFrame, endFrame);
  const changed =
    nextRange.startFrame !== state.viewport.targetStartFrame
    || nextRange.endFrame !== state.viewport.targetEndFrame;

  state.viewport.targetStartFrame = nextRange.startFrame;
  state.viewport.targetEndFrame = nextRange.endFrame;
  state.viewport.renderWidthPx = state.waveformSurface.widthCssPx;
  return changed;
}

function getTargetRange(): RangeFrames {
  if (state.viewport.targetEndFrame > state.viewport.targetStartFrame) {
    return {
      startFrame: state.viewport.targetStartFrame,
      endFrame: state.viewport.targetEndFrame,
    };
  }

  return normalizeViewportRange(0, state.session.durationFrames);
}

function normalizeViewportRange(startFrame: number, endFrame: number): RangeFrames {
  const durationFrames = Math.max(0, state.session.durationFrames);
  if (durationFrames <= 0) {
    return { startFrame: 0, endFrame: 0 };
  }

  const minVisibleFrames = getMinVisibleFrames();
  const safeStart = Number.isFinite(startFrame) ? Math.round(startFrame) : 0;
  const safeEnd = Number.isFinite(endFrame) ? Math.round(endFrame) : safeStart + minVisibleFrames;
  const spanFrames = clamp(
    Math.max(minVisibleFrames, safeEnd - safeStart),
    minVisibleFrames,
    Math.max(minVisibleFrames, durationFrames),
  );
  const nextStartFrame = clamp(safeStart, 0, Math.max(0, durationFrames - spanFrames));
  return {
    startFrame: nextStartFrame,
    endFrame: Math.min(durationFrames, nextStartFrame + spanFrames),
  };
}

function getMinVisibleFrames(): number {
  const widthPx = Math.max(1, state.waveformSurface.widthCssPx);
  if (state.session.durationFrames <= 0) {
    return 1;
  }

  return Math.min(
    state.session.durationFrames,
    Math.max(1, Math.round(widthPx / WAVEFORM_MAX_ZOOM_PIXELS_PER_SAMPLE)),
  );
}

function getFrameAtPresentedRatio(pointerRatioX: number): number {
  const presentedRange = getTargetRange();
  const ratio = clamp01(pointerRatioX);
  const spanFrames = Math.max(1, presentedRange.endFrame - presentedRange.startFrame);
  return clamp(
    Math.round(presentedRange.startFrame + ratio * spanFrames),
    0,
    state.session.durationFrames,
  );
}

function getPresentedRangeForInteraction(): RangeFrames {
  if (state.viewport.presentedEndFrame > state.viewport.presentedStartFrame) {
    return {
      startFrame: state.viewport.presentedStartFrame,
      endFrame: state.viewport.presentedEndFrame,
    };
  }

  return getTargetRange();
}

function getSurfaceWidthPx(surface: SurfaceKind): number {
  return surface === 'waveform'
    ? Math.max(1, state.waveformSurface.widthCssPx)
    : Math.max(1, state.spectrogramSurface.pixelWidth);
}

function resizeWaveformSurface(): void {
  if (!state.waveformSurface.canvas) {
    return;
  }

  resizeInteractiveWaveformSurface(
    state.waveformSurface.canvas,
    state.waveformSurface.widthCssPx,
    state.waveformSurface.heightCssPx,
    state.waveformSurface.renderScale,
  );
  state.waveformSurface.context = state.waveformSurface.canvas.getContext('2d');
}

function resizeSpectrogramSurface(): void {
  if (!state.spectrogramSurface.canvas) {
    return;
  }

  state.spectrogramSurface.canvas.width = Math.max(1, state.spectrogramSurface.pixelWidth);
  state.spectrogramSurface.canvas.height = Math.max(1, state.spectrogramSurface.pixelHeight);
  state.spectrogramSurface.context = state.spectrogramSurface.canvas.getContext('2d', { alpha: false });
}

function scheduleRender(): void {
  state.renderToken += 1;

  if (state.renderScheduled) {
    state.renderRevision += 1;
    return;
  }

  state.renderScheduled = true;
  state.renderRevision += 1;
  void pumpRenderLoop();
}

async function pumpRenderLoop(): Promise<void> {
  if (!state.renderScheduled) {
    return;
  }

  while (state.renderScheduled) {
    state.renderScheduled = false;

    if (!canRender()) {
      continue;
    }

    const token = state.renderToken;
    const targetRange = getTargetRange();

    try {
      const plotMode = await renderWaveform(targetRange, token);
      if (token !== state.renderToken) {
        continue;
      }

      if (canRenderSpectrogram()) {
        await renderSpectrogram(targetRange, token);
        if (token !== state.renderToken) {
          continue;
        }
      }

      state.viewport.plotMode = plotMode;
      state.viewport.presentedStartFrame = targetRange.startFrame;
      state.viewport.presentedEndFrame = targetRange.endFrame;
      state.viewport.renderedStartFrame = targetRange.startFrame;
      state.viewport.renderedEndFrame = targetRange.endFrame;
      emitUiState();
      postMessage({
        type: 'WaveformSurfaceReady',
        body: {
          presentedEndFrame: targetRange.endFrame,
          presentedStartFrame: targetRange.startFrame,
          serial: state.uiRevision,
        },
      });
      if (canRenderSpectrogram()) {
        postMessage({
          type: 'SpectrogramSurfaceReady',
          body: {
            presentedEndFrame: targetRange.endFrame,
            presentedStartFrame: targetRange.startFrame,
            serial: state.uiRevision,
          },
        });
      }
    } catch (error) {
      postError(error);
    }
  }
}

function canRender(): boolean {
  return Boolean(
    state.session.initialized
    && state.waveformSurface.canvas
    && state.waveformSurface.context
  );
}

function canRenderSpectrogram(): boolean {
  return Boolean(
    state.spectrogramSurface.canvas
    && state.spectrogramSurface.context,
  );
}

async function renderWaveform(range: RangeFrames, token: number): Promise<WaveformPlotMode> {
  const runtime = await getRuntime();
  const module = runtime.module;
  const surface = state.waveformSurface;
  const context = surface.context;
  const canvas = surface.canvas;
  if (!context || !canvas) {
    return state.viewport.plotMode;
  }

  const viewStartSeconds = framesToSeconds(range.startFrame);
  const viewEndSeconds = framesToSeconds(range.endFrame);
  const renderWidthCssPx = Math.max(1, surface.widthCssPx);
  const renderHeightCssPx = Math.max(1, surface.heightCssPx);
  const columnCount = Math.max(1, Math.round(renderWidthCssPx * surface.renderScale));
  const visibleSampleCount = Math.max(1, range.endFrame - range.startFrame);
  const samplesPerPixel = visibleSampleCount / columnCount;
  const pixelsPerSample = columnCount / visibleSampleCount;
  const sampleData = getWaveformSampleData(module);
  const plotMode = resolveWaveformPlotMode(samplesPerPixel, sampleData instanceof Float32Array);
  const samplePlotMode = plotMode !== 'envelope';
  const rawSamplePlotMode = plotMode === 'raw';

  if (!rawSamplePlotMode && !samplePlotMode) {
    if (!state.session.waveformBuilt && sampleData instanceof Float32Array) {
      invalidateWaveformCache();
      drawWaveformPreview(
        context,
        canvas,
        sampleData,
        range.startFrame,
        visibleSampleCount,
        renderHeightCssPx,
        surface.renderScale,
        surface.color,
      );
      return plotMode;
    }

    const bufferedPlan = createWaveformBufferedRenderPlan(
      module,
      range,
      viewStartSeconds,
      viewEndSeconds,
      columnCount,
    );

    if (!isWaveformCacheReusable(bufferedPlan, plotMode)) {
      const cacheSurface = ensureWaveformCacheSurface(
        bufferedPlan.renderWidthCssPx,
        renderHeightCssPx,
        surface.renderScale,
      );
      const cacheColumnCount = Math.max(1, cacheSurface.canvas.width);
      const cacheViewStartSeconds = framesToSeconds(bufferedPlan.renderRange.startFrame);
      const cacheViewEndSeconds = framesToSeconds(bufferedPlan.renderRange.endFrame);
      const slice = ensureWaveformSliceCapacity(module, cacheColumnCount * 2);

      if (!module._wave_extract_waveform_slice(
        cacheViewStartSeconds,
        cacheViewEndSeconds,
        cacheColumnCount,
        state.session.waveformSlicePointer,
        0,
      )) {
        throw new Error('Waveform slice extraction failed.');
      }

      if (token !== state.renderToken) {
        return plotMode;
      }

      drawWaveformEnvelope(
        cacheSurface.context,
        cacheSurface.canvas,
        slice,
        cacheColumnCount,
        renderHeightCssPx,
        surface.renderScale,
        surface.color,
      );
      updateWaveformCache(bufferedPlan, plotMode);
    }

    if (token !== state.renderToken) {
      return plotMode;
    }

    if (!presentWaveformCacheRange(context, canvas, range)) {
      const slice = ensureWaveformSliceCapacity(module, columnCount * 2);
      if (!module._wave_extract_waveform_slice(
        viewStartSeconds,
        viewEndSeconds,
        columnCount,
        state.session.waveformSlicePointer,
        0,
      )) {
        throw new Error('Waveform slice extraction failed.');
      }

      if (token !== state.renderToken) {
        return plotMode;
      }

      drawWaveformEnvelope(
        context,
        canvas,
        slice,
        columnCount,
        renderHeightCssPx,
        surface.renderScale,
        surface.color,
      );
    }

    return plotMode;
  }

  if (!(sampleData instanceof Float32Array)) {
    invalidateWaveformCache();
    clearWaveformSurface(context, canvas);
    return plotMode;
  }

  if (rawSamplePlotMode) {
    invalidateWaveformCache();
    drawRawSamplePlot(
      context,
      canvas,
      sampleData,
      surface.color,
      pixelsPerSample,
      range.startFrame,
      Math.max(0, visibleSampleCount - 1),
      renderHeightCssPx,
      surface.renderScale,
    );
    return plotMode;
  }

  invalidateWaveformCache();
  drawRepresentativeSamplePlot(
    context,
    canvas,
    sampleData,
    surface.color,
    pixelsPerSample,
    range.startFrame,
    visibleSampleCount,
    Math.max(0, visibleSampleCount - 1),
    renderHeightCssPx,
    surface.renderScale,
  );
  return plotMode;
}

function createWaveformBufferedRenderPlan(
  module: WaveCoreModule,
  visibleRange: RangeFrames,
  viewStartSeconds: number,
  viewEndSeconds: number,
  deviceColumnCount: number,
): WaveformBufferedRenderPlan {
  const displayWidth = Math.max(1, state.waveformSurface.widthCssPx);
  const sampleRate = Math.max(1, state.session.sampleRate);
  const durationSeconds = state.session.durationFrames / sampleRate;
  const secondsPerDeviceColumn = Math.max(
    1 / sampleRate,
    Math.max(1 / sampleRate, viewEndSeconds - viewStartSeconds) / Math.max(1, deviceColumnCount),
  );
  const preferredRange = state.waveformCache.sessionRevision === state.session.sessionRevision
    && state.waveformCache.plotMode === 'envelope'
    && state.waveformCache.heightCssPx === state.waveformSurface.heightCssPx
    && Math.abs(state.waveformCache.renderScale - state.waveformSurface.renderScale) <= 1e-9
    ? state.waveformCache.renderRange
    : null;
  const planner = getDisplayPlanner(module);
  const planned = planner.planWaveformFollowRender({
    bufferFactor: WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR,
    displayEnd: viewEndSeconds,
    displayStart: viewStartSeconds,
    displayWidth,
    duration: durationSeconds,
    epsilon: secondsPerDeviceColumn,
    marginRatio: WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO,
    preferredEnd: preferredRange ? framesToSeconds(preferredRange.endFrame) : null,
    preferredStart: preferredRange ? framesToSeconds(preferredRange.startFrame) : null,
    renderScale: state.waveformSurface.renderScale,
  });

  if (!planned) {
    return {
      renderRange: { ...visibleRange },
      renderWidthCssPx: displayWidth,
    };
  }

  const renderStartFrame = clamp(Math.floor(planned.start * sampleRate), 0, Math.max(0, state.session.durationFrames - 1));
  const renderEndFrame = clamp(
    Math.ceil(planned.end * sampleRate),
    renderStartFrame + 1,
    state.session.durationFrames,
  );

  return {
    renderRange: {
      startFrame: renderStartFrame,
      endFrame: renderEndFrame,
    },
    renderWidthCssPx: Math.max(displayWidth, Math.round(planned.width || displayWidth)),
  };
}

function ensureWaveformCacheSurface(
  widthCssPx: number,
  heightCssPx: number,
  renderScale: number,
): { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } {
  if (!state.waveformCache.canvas) {
    state.waveformCache.canvas = new OffscreenCanvas(1, 1);
  }

  resizeInteractiveWaveformSurface(
    state.waveformCache.canvas,
    widthCssPx,
    heightCssPx,
    renderScale,
  );

  if (!state.waveformCache.context) {
    const nextContext = state.waveformCache.canvas.getContext('2d');
    if (!nextContext) {
      throw new Error('Waveform cache 2D context is unavailable.');
    }
    state.waveformCache.context = nextContext;
  }

  return {
    canvas: state.waveformCache.canvas,
    context: state.waveformCache.context,
  };
}

function isWaveformCacheReusable(plan: WaveformBufferedRenderPlan, plotMode: WaveformPlotMode): boolean {
  return Boolean(
    state.waveformCache.canvas
    && state.waveformCache.context
    && state.waveformCache.sessionRevision === state.session.sessionRevision
    && state.waveformCache.plotMode === plotMode
    && state.waveformCache.heightCssPx === state.waveformSurface.heightCssPx
    && Math.abs(state.waveformCache.renderScale - state.waveformSurface.renderScale) <= 1e-9
    && state.waveformCache.renderWidthCssPx === plan.renderWidthCssPx
    && areRangeFramesEqual(state.waveformCache.renderRange, plan.renderRange)
  );
}

function updateWaveformCache(plan: WaveformBufferedRenderPlan, plotMode: WaveformPlotMode): void {
  state.waveformCache.plotMode = plotMode;
  state.waveformCache.renderRange = { ...plan.renderRange };
  state.waveformCache.renderWidthCssPx = plan.renderWidthCssPx;
  state.waveformCache.heightCssPx = state.waveformSurface.heightCssPx;
  state.waveformCache.renderScale = state.waveformSurface.renderScale;
  state.waveformCache.sessionRevision = state.session.sessionRevision;
}

function presentWaveformCacheRange(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  visibleRange: RangeFrames,
): boolean {
  const cacheCanvas = state.waveformCache.canvas;
  const cacheRange = state.waveformCache.renderRange;

  if (
    !cacheCanvas
    || !cacheRange
    || visibleRange.startFrame < cacheRange.startFrame
    || visibleRange.endFrame > cacheRange.endFrame
  ) {
    return false;
  }

  const cacheSpanFrames = Math.max(1, cacheRange.endFrame - cacheRange.startFrame);
  const sourceStartRatio = (visibleRange.startFrame - cacheRange.startFrame) / cacheSpanFrames;
  const sourceEndRatio = (visibleRange.endFrame - cacheRange.startFrame) / cacheSpanFrames;
  const sourceX = clamp(
    Math.floor(sourceStartRatio * cacheCanvas.width),
    0,
    Math.max(0, cacheCanvas.width - 1),
  );
  const sourceWidth = Math.max(
    1,
    Math.min(
      cacheCanvas.width - sourceX,
      Math.ceil((sourceEndRatio - sourceStartRatio) * cacheCanvas.width),
    ),
  );

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.imageSmoothingEnabled = true;
  context.globalCompositeOperation = 'copy';
  context.drawImage(
    cacheCanvas,
    sourceX,
    0,
    sourceWidth,
    cacheCanvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  context.restore();

  return true;
}

async function renderSpectrogram(range: RangeFrames, token: number): Promise<void> {
  const runtime = await getRuntime();
  const plan = createSpectrogramPlan(range);
  const context = state.spectrogramSurface.context;
  if (!context) {
    return;
  }

  if (!isEquivalentSpectrogramPlan(plan, state.lastSpectrogramPlan)) {
    clearTileCache();
  }

  await ensureSpectrogramPlanTiles(runtime, plan, token);
  if (token !== state.renderToken) {
    return;
  }

  drawSpectrogramBackground(
    context,
    state.spectrogramSurface.pixelWidth,
    state.spectrogramSurface.pixelHeight,
  );
  paintSpectrogramPlan(context, plan);
  state.lastSpectrogramPlan = plan;
}

function createSpectrogramPlan(range: RangeFrames): SpectrogramPlan {
  const preset = QUALITY_PRESETS[state.session.quality];
  const analysisType = state.spectrogramConfig.analysisType;
  const colormapDistribution = state.spectrogramConfig.colormapDistribution;
  const isChroma = isChromaAnalysisType(analysisType);
  const dbWindow = normalizeSpectrogramDbWindow(
    state.spectrogramConfig.minDecibels,
    state.spectrogramConfig.maxDecibels,
    analysisType,
  );
  const frequencyScale = analysisType === 'spectrogram'
    ? state.spectrogramConfig.frequencyScale
    : 'log';
  const fftSize = analysisType === 'scalogram' || isChroma ? 0 : state.spectrogramConfig.fftSize;
  const overlapRatio = analysisType === 'scalogram' || isChroma ? 0 : state.spectrogramConfig.overlapRatio;
  const effectiveMelBandCount = analysisType === 'mfcc'
    ? normalizeMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount)
    : normalizeMelBandCount(state.spectrogramConfig.melBandCount);
  const mfccCoefficientCount = normalizeMfccCoefficientCount(state.spectrogramConfig.mfccCoefficientCount);
  const scalogramFrequencyRange = normalizeScalogramFrequencyRange(
    state.spectrogramConfig.scalogramMinFrequency,
    state.spectrogramConfig.scalogramMaxFrequency,
  );
  const scalogramOmega0 = normalizeScalogramOmega0(state.spectrogramConfig.scalogramOmega0);
  const scalogramRowDensity = normalizeScalogramRowDensity(state.spectrogramConfig.scalogramRowDensity);
  const pixelWidth = Math.max(1, state.spectrogramSurface.pixelWidth);
  const pixelHeight = Math.max(1, state.spectrogramSurface.pixelHeight);
  const rowBucketSize = analysisType === 'scalogram' ? SCALOGRAM_ROW_BLOCK_SIZE : ROW_BUCKET_SIZE;
  const rowOversample = analysisType === 'scalogram' ? scalogramRowDensity : VISIBLE_ROW_OVERSAMPLE;
  const rowCount = isChroma
    ? CHROMA_BIN_COUNT
    : analysisType === 'mel'
    ? effectiveMelBandCount
    : analysisType === 'mfcc'
      ? mfccCoefficientCount
      : quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier * rowOversample), rowBucketSize);
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2),
  );
  const hopSamples = analysisType === 'scalogram' || isChroma
    ? normalizeScalogramHopSamples(state.spectrogramConfig.scalogramHopSamples)
    : Math.max(1, Math.round(fftSize * (1 - overlapRatio)));
  const hopSeconds = hopSamples / state.session.sampleRate;
  const viewStartSeconds = framesToSeconds(range.startFrame);
  const viewEndSeconds = framesToSeconds(range.endFrame);
  const viewSpanSeconds = Math.max(1 / state.session.sampleRate, viewEndSeconds - viewStartSeconds);
  const tileCount = Math.max(1, Math.ceil(targetColumns / TILE_COLUMN_COUNT));
  const tileDurationSeconds = viewSpanSeconds / tileCount;
  const startTileIndex = 0;
  const endTileIndex = tileCount - 1;
  const windowSeconds = analysisType === 'scalogram' || isChroma ? 0 : fftSize / state.session.sampleRate;
  const decimationFactor = analysisType === 'spectrogram'
    ? Math.max(1, preset.lowFrequencyDecimationFactor)
    : 1;
  const windowFunction = normalizeSpectrogramWindowFunction(state.spectrogramConfig.windowFunction);
  const configKey = [
    `type${analysisType}`,
    `dist${colormapDistribution}`,
    `scale${frequencyScale}`,
    `win${windowFunction}`,
    `fft${fftSize}`,
    `bands${analysisType === 'mel' || analysisType === 'mfcc' ? effectiveMelBandCount : 0}`,
    `coeff${analysisType === 'mfcc' ? mfccCoefficientCount : 0}`,
      `min${analysisType === 'scalogram'
      ? scalogramFrequencyRange.minFrequency
      : isChroma
        ? CQT_DEFAULT_FMIN
        : state.session.minFrequency}`,
    `max${analysisType === 'scalogram' ? scalogramFrequencyRange.maxFrequency : state.session.maxFrequency}`,
    `omega${analysisType === 'scalogram' ? scalogramOmega0 : 0}`,
    `density${analysisType === 'scalogram' ? scalogramRowDensity : 0}`,
    `db${dbWindow.minDecibels}:${dbWindow.maxDecibels}`,
    `ov${Math.round(overlapRatio * 1000)}`,
    `hop${hopSamples}`,
    `rows${rowCount}`,
  ].join('-');

  return {
    analysisType,
    colormapDistribution,
    configKey,
    decimationFactor,
    dprBucket: Math.max(2, Math.round(state.waveformSurface.renderScale)),
    endTileIndex,
    fftSize,
    frequencyScale,
    hopSamples,
    hopSeconds,
    maxDecibels: dbWindow.maxDecibels,
    maxFrequency: analysisType === 'scalogram' ? scalogramFrequencyRange.maxFrequency : state.session.maxFrequency,
    melBandCount: effectiveMelBandCount,
    minDecibels: dbWindow.minDecibels,
    minFrequency: analysisType === 'scalogram'
      ? scalogramFrequencyRange.minFrequency
      : isChroma
        ? CQT_DEFAULT_FMIN
        : state.session.minFrequency,
    overlapRatio,
    pixelHeight,
    pixelWidth,
    rowCount,
    scalogramOmega0,
    scalogramRowDensity,
    startTileIndex,
    targetColumns,
    tileDurationSeconds,
    viewEndSeconds,
    viewStartSeconds,
    windowFunction,
    windowSeconds,
  };
}

async function ensureSpectrogramPlanTiles(runtime: WaveCoreRuntime, plan: SpectrogramPlan, token: number): Promise<void> {
  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    if (token !== state.renderToken) {
      return;
    }

    const cacheKey = buildTileCacheKey(plan, tileIndex);
    const existingTile = touchTileRecord(cacheKey);
    if (existingTile?.complete) {
      continue;
    }

    const tileStartSeconds = plan.viewStartSeconds + tileIndex * plan.tileDurationSeconds;
    const tileEndSeconds = Math.min(plan.viewEndSeconds, tileStartSeconds + plan.tileDurationSeconds);
    const tileRecord = existingTile ?? createTileRecord(cacheKey, tileIndex, tileStartSeconds, tileEndSeconds, plan.rowCount);
    setTileRecord(cacheKey, tileRecord);

    const chunkColumnCount = plan.analysisType === 'scalogram'
      ? SCALOGRAM_COLUMN_CHUNK_SIZE
      : SPECTROGRAM_COLUMN_CHUNK_SIZE;
    while (tileRecord.renderedColumns < TILE_COLUMN_COUNT) {
      if (token !== state.renderToken) {
        return;
      }

      const startColumn = tileRecord.renderedColumns;
      const columnCount = Math.min(chunkColumnCount, TILE_COLUMN_COUNT - startColumn);
      renderSpectrogramTileChunk(runtime, plan, tileRecord, startColumn, columnCount);
      tileRecord.renderedColumns += columnCount;
      tileRecord.complete = tileRecord.renderedColumns >= TILE_COLUMN_COUNT;

      if (chunkColumnCount < TILE_COLUMN_COUNT) {
        await yieldToEventLoop();
      }
    }
  }
}

function renderSpectrogramTileChunk(
  runtime: WaveCoreRuntime,
  plan: SpectrogramPlan,
  tileRecord: TileRecord,
  startColumn: number,
  columnCount: number,
): void {
  const tileSpan = tileRecord.tileEndSeconds - tileRecord.tileStartSeconds;
  const chunkStart = tileRecord.tileStartSeconds + (startColumn / TILE_COLUMN_COUNT) * tileSpan;
  const chunkEnd = tileRecord.tileStartSeconds + ((startColumn + columnCount) / TILE_COLUMN_COUNT) * tileSpan;
  const byteLength = columnCount * plan.rowCount * 4;

  ensureSpectrogramOutputCapacity(runtime.module, byteLength);
  const ok = runtime.module._wave_render_spectrogram_tile_rgba(
    chunkStart,
    chunkEnd,
    columnCount,
    plan.rowCount,
    plan.melBandCount,
    plan.fftSize,
    plan.decimationFactor,
    plan.minFrequency,
    plan.maxFrequency,
    ANALYSIS_TYPE_CODES[plan.analysisType],
    FREQUENCY_SCALE_CODES[plan.frequencyScale],
    COLORMAP_DISTRIBUTION_GAMMAS[plan.colormapDistribution] ?? COLORMAP_DISTRIBUTION_GAMMAS.balanced,
    plan.minDecibels,
    plan.maxDecibels,
    plan.scalogramOmega0,
    WINDOW_FUNCTION_CODES[plan.windowFunction] ?? 0,
    state.session.spectrogramOutputPointer,
  );

  if (!ok) {
    throw new Error('Spectrogram tile render failed.');
  }

  const rgba = getHeapU8View(runtime.module, state.session.spectrogramOutputPointer, byteLength);
  drawTileChunk(tileRecord, rgba, startColumn, columnCount, plan.rowCount);
}

function createTileRecord(
  cacheKey: string,
  tileIndex: number,
  tileStartSeconds: number,
  tileEndSeconds: number,
  rowCount: number,
): TileRecord {
  const canvas = new OffscreenCanvas(TILE_COLUMN_COUNT, rowCount);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('OffscreenCanvas 2D context is unavailable.');
  }
  const imageData = context.createImageData(TILE_COLUMN_COUNT, rowCount);
  return {
    byteLength: TILE_COLUMN_COUNT * rowCount * 4,
    canvas,
    columnCount: TILE_COLUMN_COUNT,
    complete: false,
    context,
    imageData,
    renderedColumns: 0,
    rowCount,
    tileEndSeconds,
    tileIndex,
    tileKey: cacheKey,
    tileStartSeconds,
  };
}

function drawTileChunk(
  tileRecord: TileRecord,
  rgba: Uint8Array,
  columnOffset: number,
  columnCount: number,
  rowCount: number,
): void {
  const destination = tileRecord.imageData.data;
  if (columnOffset === 0 && columnCount === tileRecord.columnCount) {
    destination.set(rgba);
  } else {
    const sourceRowLength = columnCount * 4;
    const destinationRowLength = tileRecord.columnCount * 4;
    const destinationOffset = columnOffset * 4;
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const sourceStart = rowIndex * sourceRowLength;
      const sourceEnd = sourceStart + sourceRowLength;
      const destinationStart = rowIndex * destinationRowLength + destinationOffset;
      destination.set(rgba.subarray(sourceStart, sourceEnd), destinationStart);
    }
  }

  tileRecord.context?.putImageData(tileRecord.imageData, 0, 0, columnOffset, 0, columnCount, rowCount);
}

function drawSpectrogramBackground(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, '#171127');
  background.addColorStop(0.46, '#0d0b19');
  background.addColorStop(1, '#04050c');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
}

function paintSpectrogramPlan(
  context: OffscreenCanvasRenderingContext2D,
  plan: SpectrogramPlan,
): void {
  const destinationWidth = Math.max(1, state.spectrogramSurface.pixelWidth);
  const destinationHeight = Math.max(1, state.spectrogramSurface.pixelHeight);
  const span = Math.max(1e-6, plan.viewEndSeconds - plan.viewStartSeconds);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    const tile = touchTileRecord(buildTileCacheKey(plan, tileIndex));
    if (!tile) {
      continue;
    }

    const tileSpan = Math.max(1e-6, tile.tileEndSeconds - tile.tileStartSeconds);
    const overlapStart = Math.max(plan.viewStartSeconds, tile.tileStartSeconds);
    const availableColumns = tile.complete ? tile.columnCount : Math.max(0, tile.renderedColumns);
    if (availableColumns <= 0) {
      continue;
    }
    const availableTileEnd = tile.tileStartSeconds + (availableColumns / tile.columnCount) * tileSpan;
    const overlapEnd = Math.min(plan.viewEndSeconds, availableTileEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }

    const sourceStartRatio = (overlapStart - tile.tileStartSeconds) / tileSpan;
    const sourceEndRatio = (overlapEnd - tile.tileStartSeconds) / tileSpan;
    const destinationStartRatio = (overlapStart - plan.viewStartSeconds) / span;
    const destinationEndRatio = (overlapEnd - plan.viewStartSeconds) / span;
    const sourceX = clamp(
      Math.floor(sourceStartRatio * tile.columnCount),
      0,
      Math.max(0, tile.columnCount - 1),
    );
    if (sourceX >= availableColumns) {
      continue;
    }

    const sourceWidth = Math.max(
      1,
      Math.min(availableColumns - sourceX, Math.ceil((sourceEndRatio - sourceStartRatio) * tile.columnCount)),
    );
    const destinationX = Math.floor(destinationStartRatio * destinationWidth);
    const destinationWidthPx = Math.max(1, Math.ceil((destinationEndRatio - destinationStartRatio) * destinationWidth));

    context.drawImage(
      tile.canvas,
      sourceX,
      0,
      sourceWidth,
      tile.rowCount,
      destinationX,
      0,
      destinationWidthPx,
      destinationHeight,
    );
  }
}

function clearTileCache(): void {
  state.session.tileCache.clear();
  state.session.tileCacheBytes = 0;
}

function touchTileRecord(cacheKey: string): TileRecord | null {
  const tileRecord = state.session.tileCache.get(cacheKey) ?? null;
  if (!tileRecord) {
    return null;
  }
  state.session.tileCache.delete(cacheKey);
  state.session.tileCache.set(cacheKey, tileRecord);
  return tileRecord;
}

function setTileRecord(cacheKey: string, tileRecord: TileRecord): void {
  const previous = state.session.tileCache.get(cacheKey) ?? null;
  if (!previous) {
    state.session.tileCacheBytes += tileRecord.byteLength;
  } else if (previous !== tileRecord) {
    state.session.tileCacheBytes += tileRecord.byteLength - previous.byteLength;
  } else {
    state.session.tileCache.delete(cacheKey);
  }
  state.session.tileCache.set(cacheKey, tileRecord);
  pruneTileCache();
}

function pruneTileCache(): void {
  if (
    state.session.tileCache.size <= MAX_TILE_CACHE_ENTRIES
    && state.session.tileCacheBytes <= MAX_TILE_CACHE_BYTES
  ) {
    return;
  }

  for (const [cacheKey, tileRecord] of state.session.tileCache) {
    if (
      state.session.tileCache.size <= MAX_TILE_CACHE_ENTRIES
      && state.session.tileCacheBytes <= MAX_TILE_CACHE_BYTES
    ) {
      return;
    }

    state.session.tileCache.delete(cacheKey);
    state.session.tileCacheBytes = Math.max(0, state.session.tileCacheBytes - tileRecord.byteLength);
  }
}

function buildTileCacheKey(plan: SpectrogramPlan, tileIndex: number): string {
  return [
    state.session.quality,
    plan.configKey,
    `start${Math.round(plan.viewStartSeconds * 1000)}`,
    `end${Math.round(plan.viewEndSeconds * 1000)}`,
    `cols${plan.targetColumns}`,
    `tile${tileIndex}`,
    `dpr${plan.dprBucket}`,
  ].join(':');
}

function isEquivalentSpectrogramPlan(left: SpectrogramPlan | null, right: SpectrogramPlan | null): boolean {
  if (!left || !right) {
    return false;
  }

  return left.analysisType === right.analysisType
    && left.colormapDistribution === right.colormapDistribution
    && left.frequencyScale === right.frequencyScale
    && left.fftSize === right.fftSize
    && left.minDecibels === right.minDecibels
    && left.maxDecibels === right.maxDecibels
    && left.melBandCount === right.melBandCount
    && left.hopSamples === right.hopSamples
    && left.minFrequency === right.minFrequency
    && left.maxFrequency === right.maxFrequency
    && Math.abs(left.scalogramOmega0 - right.scalogramOmega0) <= 1e-9
    && Math.abs(left.scalogramRowDensity - right.scalogramRowDensity) <= 1e-9
    && Math.abs(left.overlapRatio - right.overlapRatio) <= 1e-9
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && left.rowCount === right.rowCount
    && left.targetColumns === right.targetColumns
    && Math.abs(left.viewStartSeconds - right.viewStartSeconds) <= 1e-9
    && Math.abs(left.viewEndSeconds - right.viewEndSeconds) <= 1e-9;
}

function ensureSpectrogramOutputCapacity(module: WaveCoreModule, byteLength: number): void {
  if (state.session.spectrogramOutputCapacity >= byteLength && state.session.spectrogramOutputPointer) {
    return;
  }

  if (state.session.spectrogramOutputPointer) {
    module._free(state.session.spectrogramOutputPointer);
  }

  const pointer = module._malloc(byteLength);
  if (!pointer) {
    throw new Error('Unable to allocate spectrogram output buffer.');
  }
  state.session.spectrogramOutputPointer = pointer;
  state.session.spectrogramOutputCapacity = byteLength;
}

function buildWaveformSampleInfo(pointerRatioX: number, pointerRatioY: number, requestId: number): SampleInfoPayload | null {
  const sampleRate = state.session.sampleRate;
  const sampleData = state.session.waveformPcmPointer && state.session.module
    ? getWaveformSampleData(state.session.module)
    : null;
  const range = getTargetRange();
  const spanFrames = Math.max(0, range.endFrame - range.startFrame);
  state.hoverWaveformRatioX = clamp01(pointerRatioX);

  if (!(sampleRate > 0) || !(spanFrames > 0)) {
    return {
      label: '',
      markerVisible: false,
      markerXRatio: 0,
      markerYRatio: 0,
      requestId,
      surface: 'waveform',
    };
  }

  const ratioX = clamp01(pointerRatioX);
  const frameAtPointer = clamp(
    Math.round(range.startFrame + ratioX * spanFrames),
    0,
    state.session.durationFrames,
  );
  const timeLabel = formatAxisLabel(frameAtPointer / sampleRate);

  if (!(sampleData instanceof Float32Array) || state.viewport.plotMode === 'envelope') {
    return {
      label: timeLabel,
      markerVisible: false,
      markerXRatio: ratioX,
      markerYRatio: clamp01(pointerRatioY),
      requestId,
      surface: 'waveform',
    };
  }

  const renderColumnCount = Math.max(1, Math.round(state.waveformSurface.widthCssPx * state.waveformSurface.renderScale));
  const visibleSampleCount = Math.max(1, spanFrames);
  const sampleStartFrame = range.startFrame;
  const visibleSampleSpan = Math.max(0, visibleSampleCount - 1);

  let sampleIndex = frameAtPointer;
  if (state.viewport.plotMode === 'sample') {
    const bucketSize = Math.max(1, Math.round(visibleSampleCount / renderColumnCount));
    const samplePosition = sampleStartFrame + ratioX * visibleSampleSpan;
    const bucketIndex = Math.floor(samplePosition / bucketSize);
    const representative = pickRepresentativeSamplePoint(
      sampleData,
      bucketIndex * bucketSize,
      bucketIndex * bucketSize + bucketSize,
    );
    if (representative) {
      sampleIndex = representative.sampleIndex;
    }
  }

  sampleIndex = clamp(sampleIndex, 0, Math.max(0, sampleData.length - 1));
  const sampleValue = clamp(sampleData[sampleIndex] ?? 0, -1, 1);

  return {
    label: `${timeLabel} - Sample ${formatSampleOrdinal(sampleIndex + 1)}, Value ${formatSampleValue(sampleValue)}`,
    markerVisible: true,
    markerXRatio: spanFrames <= 0 ? 0 : clamp01((sampleIndex - sampleStartFrame) / Math.max(1, visibleSampleSpan)),
    markerYRatio: getWaveformMarkerYRatio(sampleValue),
    requestId,
    surface: 'waveform',
  };
}

function buildSpectrogramSampleInfo(pointerRatioX: number, pointerRatioY: number, requestId: number): SampleInfoPayload | null {
  const sampleRate = state.session.sampleRate;
  const range = getTargetRange();
  const spanFrames = Math.max(0, range.endFrame - range.startFrame);
  if (!(sampleRate > 0) || !(spanFrames > 0)) {
    return {
      label: '',
      markerVisible: false,
      markerXRatio: 0,
      markerYRatio: 0,
      requestId,
      surface: 'spectrogram',
    };
  }

  const ratioX = clamp01(pointerRatioX);
  const frame = clamp(
    Math.round(range.startFrame + ratioX * spanFrames),
    0,
    state.session.durationFrames,
  );
  if (state.spectrogramConfig.analysisType === 'mfcc') {
    const coefficient = getMfccCoefficientAtPosition(clamp01(pointerRatioY));
    const coefficientValue = sampleMfccValueAtFrame(frame, coefficient);
    return {
      label: coefficientValue === null
        ? `${formatAxisLabel(frame / sampleRate)} • MFCC C${coefficient}`
        : `${formatAxisLabel(frame / sampleRate)} • MFCC C${coefficient} = ${formatMfccValue(coefficientValue)}`,
      markerVisible: false,
      markerXRatio: ratioX,
      markerYRatio: clamp01(pointerRatioY),
      requestId,
      surface: 'spectrogram',
    };
  }

  if (isChromaAnalysisType(state.spectrogramConfig.analysisType)) {
    const chroma = getChromaBinAtPosition(clamp01(pointerRatioY));
    return {
      label: `${formatAxisLabel(frame / sampleRate)} • ${getChromaLabel(chroma)}`,
      markerVisible: false,
      markerXRatio: ratioX,
      markerYRatio: clamp01(pointerRatioY),
      requestId,
      surface: 'spectrogram',
    };
  }

  const frequency = getSpectrogramFrequencyAtPosition(clamp01(pointerRatioY));
  return {
    label: `${formatAxisLabel(frame / sampleRate)} • ${formatFrequencyLabel(frequency)}`,
    markerVisible: false,
    markerXRatio: ratioX,
    markerYRatio: clamp01(pointerRatioY),
    requestId,
    surface: 'spectrogram',
  };
}

function getActiveMfccCoefficientCount(): number {
  return normalizeMfccCoefficientCount(state.spectrogramConfig.mfccCoefficientCount);
}

function getActiveMfccMelBandCount(): number {
  return normalizeMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount);
}

function getMfccCoefficientAtPosition(positionRatio: number): number {
  const coefficientCount = getActiveMfccCoefficientCount();
  if (coefficientCount <= 1) {
    return 0;
  }

  const normalized = 1 - clamp01(positionRatio);
  return clamp(
    Math.round(normalized * (coefficientCount - 1)),
    0,
    coefficientCount - 1,
  );
}

function sampleMfccValueAtFrame(frame: number, coefficient: number): number | null {
  const module = state.session.module;
  if (!module || !state.session.initialized || state.spectrogramConfig.analysisType !== 'mfcc') {
    return null;
  }

  const coefficientCount = getActiveMfccCoefficientCount();
  const melBandCount = getActiveMfccMelBandCount();
  const fftSize = Math.max(1, Number(state.spectrogramConfig.fftSize) || 0);
  if (coefficient < 0 || coefficient >= coefficientCount) {
    return null;
  }

  const value = module._wave_sample_mfcc_value_at_frame(
    clampFrame(frame),
    coefficient,
    coefficientCount,
    melBandCount,
    fftSize,
    state.session.minFrequency,
    state.session.maxFrequency,
    WINDOW_FUNCTION_CODES[normalizeSpectrogramWindowFunction(state.spectrogramConfig.windowFunction)] ?? 0,
  );
  return Number.isFinite(value) ? value : null;
}

function getActiveSpectrogramFrequencyRange(): {
  maxFrequency: number;
  minFrequency: number;
} {
  if (state.spectrogramConfig.analysisType === 'scalogram') {
    return normalizeScalogramFrequencyRange(
      state.spectrogramConfig.scalogramMinFrequency,
      state.spectrogramConfig.scalogramMaxFrequency,
    );
  }

  return {
    minFrequency: state.spectrogramConfig.analysisType === 'chroma'
      ? CQT_DEFAULT_FMIN
      : state.session.minFrequency,
    maxFrequency: state.session.maxFrequency,
  };
}

function getSpectrogramFrequencyAtPosition(positionRatio: number): number {
  const { minFrequency, maxFrequency } = getActiveSpectrogramFrequencyRange();
  const scaleMode = getActiveSpectrogramAxisMode();
  switch (scaleMode) {
    case 'linear':
      return getFrequencyAtLinearPosition(positionRatio, minFrequency, maxFrequency);
    case 'mixed':
      return getFrequencyAtMixedPosition(positionRatio, minFrequency, maxFrequency);
    case 'mel':
      return getFrequencyAtMelPosition(positionRatio, minFrequency, maxFrequency);
    default:
      return getFrequencyAtLogPosition(positionRatio, minFrequency, maxFrequency);
  }
}

function getActiveSpectrogramAxisMode(): SpectrogramAnalysisType | SpectrogramFrequencyScale {
  if (state.spectrogramConfig.analysisType === 'mel') {
    return 'mel';
  }

  if (state.spectrogramConfig.analysisType === 'spectrogram') {
    return state.spectrogramConfig.frequencyScale;
  }

  return 'log';
}

function buildFrequencyTicks(): FrequencyTickUi[] {
  if (state.spectrogramConfig.analysisType === 'mfcc') {
    const coefficientCount = getActiveMfccCoefficientCount();
    const lastRow = Math.max(0, coefficientCount - 1);
    const tickRows = [lastRow, Math.round(lastRow * 0.75), Math.round(lastRow * 0.5), Math.round(lastRow * 0.25), 0]
      .filter((row, index, rows) => row >= 0 && row < coefficientCount && rows.indexOf(row) === index);

    return tickRows.map((row, index) => ({
      edge: index === 0 ? 'top' : index === tickRows.length - 1 ? 'bottom' : 'middle',
      frequency: row,
      label: `C${row}`,
      positionRatio: coefficientCount <= 1 ? 1 : 1 - (row / (coefficientCount - 1)),
    }));
  }

  if (isChromaAnalysisType(state.spectrogramConfig.analysisType)) {
    return Array.from({ length: CHROMA_BIN_COUNT }, (_, row) => ({
      edge: row === CHROMA_BIN_COUNT - 1 ? 'top' : row === 0 ? 'bottom' : 'middle',
      frequency: row,
      label: getChromaLabel(row),
      positionRatio: CHROMA_BIN_COUNT <= 1 ? 1 : 1 - (row / (CHROMA_BIN_COUNT - 1)),
    }));
  }

  const { minFrequency, maxFrequency } = getActiveSpectrogramFrequencyRange();
  const axisMode = getActiveSpectrogramAxisMode();
  const frequencies = axisMode === 'linear'
    ? buildLinearFrequencyTicks(minFrequency, maxFrequency, SPECTROGRAM_LINEAR_TICK_COUNT)
    : SPECTROGRAM_TICKS.filter((tick) => tick >= minFrequency && tick <= maxFrequency);

  return frequencies.map((frequency, index) => {
    let positionRatio = 0;
    switch (axisMode) {
      case 'linear':
        positionRatio = getLinearFrequencyPosition(frequency, minFrequency, maxFrequency);
        break;
      case 'mixed':
        positionRatio = getMixedFrequencyPosition(frequency, minFrequency, maxFrequency);
        break;
      case 'mel':
        positionRatio = getMelFrequencyPosition(frequency, minFrequency, maxFrequency);
        break;
      default:
        positionRatio = getLogFrequencyPosition(frequency, minFrequency, maxFrequency);
        break;
    }

    return {
      edge: index === 0 ? 'top' : index === frequencies.length - 1 ? 'bottom' : 'middle',
      frequency,
      label: formatFrequencyLabel(frequency),
      positionRatio,
    };
  });
}

function buildWaveformAxisTicks(range: RangeFrames): ViewportUiState['waveformAxisTicks'] {
  const sampleRate = state.session.sampleRate;
  const renderWidthPx = Math.max(1, state.waveformSurface.widthCssPx);
  const spanFrames = Math.max(0, range.endFrame - range.startFrame);
  if (!(sampleRate > 0) || !(spanFrames > 0)) {
    return [];
  }

  const startSeconds = range.startFrame / sampleRate;
  const endSeconds = range.endFrame / sampleRate;
  const spanSeconds = endSeconds - startSeconds;
  const tickCount = Math.max(12, Math.min(28, Math.floor(renderWidthPx / 48)));
  const step = getNiceTimeStep(spanSeconds / tickCount);
  const ticks: ViewportUiState['waveformAxisTicks'] = [];
  const firstTick = Math.ceil(startSeconds / step) * step;

  for (let tick = firstTick; tick <= endSeconds + step * 0.25; tick += step) {
    ticks.push({
      align: 'center',
      frame: clamp(Math.round(tick * sampleRate), 0, state.session.durationFrames),
      label: formatAxisLabel(tick),
      positionRatio: (tick - startSeconds) / spanSeconds,
    });
  }

  if (ticks.length === 0 || Math.abs(ticks[0].frame - range.startFrame) > Math.max(1, step * sampleRate * 0.35)) {
    ticks.unshift({
      align: 'start',
      frame: range.startFrame,
      label: formatAxisLabel(startSeconds),
      positionRatio: 0,
    });
  }

  const lastTick = ticks[ticks.length - 1];
  if (!lastTick || Math.abs(lastTick.frame - range.endFrame) > Math.max(1, step * sampleRate * 0.35)) {
    ticks.push({
      align: 'end',
      frame: range.endFrame,
      label: formatAxisLabel(endSeconds),
      positionRatio: 1,
    });
  }

  if (ticks.length > 0) {
    ticks[0].align = 'start';
    ticks[ticks.length - 1].align = 'end';
  }

  return ticks;
}

function emitUiState(): void {
  const presentedRange = getPresentedRangeForInteraction();
  const range = presentedRange;
  const playbackFrame = getClampedPlaybackFrame();
  const spanFrames = Math.max(0, range.endFrame - range.startFrame);
  const followCursorLocked = state.viewport.followEnabled
    && !isInteractionActive()
    && range.startFrame > 0
    && range.endFrame < state.session.durationFrames;
  const cursorPercent = spanFrames > 0
    ? followCursorLocked
      ? WAVEFORM_FOLLOW_RATIO * 100
      : clamp(((playbackFrame - range.startFrame) / spanFrames) * 100, 0, 100)
    : 0;
  const cursorVisible = spanFrames > 0
    && (
      followCursorLocked
      || (playbackFrame >= range.startFrame && playbackFrame <= range.endFrame)
    );
  const selectionRange = state.selectionDraftRangeFrames ?? state.loopRangeFrames;
  const selectionUi = buildSelectionUi(selectionRange, spanFrames, range);

  state.uiRevision += 1;
  const uiState: ViewportUiState = {
    cursorPercent,
    cursorVisible,
    frequencyTicks: buildFrequencyTicks(),
    overview: {
      currentPercent: state.session.durationFrames > 0
        ? clamp((playbackFrame / state.session.durationFrames) * 100, 0, 100)
        : 0,
      currentVisible: state.session.durationFrames > 0,
      viewportLeftPercent: state.session.durationFrames > 0
        ? clamp((range.startFrame / state.session.durationFrames) * 100, 0, 100)
        : 0,
      viewportWidthPercent: state.session.durationFrames > 0
        ? clamp(((range.endFrame - range.startFrame) / state.session.durationFrames) * 100, 0, 100)
        : 0,
    },
    playback: state.playbackClock,
    presentedEndFrame: presentedRange.endFrame,
    presentedStartFrame: presentedRange.startFrame,
    selection: selectionUi,
    serial: state.uiRevision,
    spectrogramPresentedEndFrame: presentedRange.endFrame,
    spectrogramPresentedStartFrame: presentedRange.startFrame,
    transportCommand: state.pendingTransportCommand,
    viewport: {
      followEnabled: state.viewport.followEnabled,
      plotMode: state.viewport.plotMode,
      presentedEndFrame: state.viewport.presentedEndFrame,
      presentedStartFrame: state.viewport.presentedStartFrame,
      renderWidthPx: Math.max(1, state.waveformSurface.widthCssPx),
      renderedEndFrame: state.viewport.renderedEndFrame,
      renderedStartFrame: state.viewport.renderedStartFrame,
      targetEndFrame: state.viewport.targetEndFrame,
      targetStartFrame: state.viewport.targetStartFrame,
    },
    waveformAxisTicks: buildWaveformAxisTicks(range),
    waveformPresentedEndFrame: presentedRange.endFrame,
    waveformPresentedStartFrame: presentedRange.startFrame,
    zoomFactor: spanFrames > 0 ? state.session.durationFrames / spanFrames : 1,
  };

  state.pendingTransportCommand = null;
  postMessage({
    type: 'ViewportUiState',
    body: uiState,
  });
}

function buildSelectionUi(
  selectionRange: RangeFrames | null,
  spanFrames: number,
  presentedRange: RangeFrames,
): ViewportUiState['selection'] {
  const committed = state.selectionDraftRangeFrames === null && state.loopRangeFrames !== null;

  if (!selectionRange || spanFrames <= 0) {
    return {
      active: false,
      committed,
      endFrame: null,
      leftPercent: 0,
      startFrame: null,
      widthPercent: 0,
    };
  }

  const visibleStart = clamp(selectionRange.startFrame, presentedRange.startFrame, presentedRange.endFrame);
  const visibleEnd = clamp(selectionRange.endFrame, presentedRange.startFrame, presentedRange.endFrame);
  if (visibleEnd <= visibleStart) {
    return {
      active: false,
      committed,
      endFrame: selectionRange.endFrame,
      leftPercent: 0,
      startFrame: selectionRange.startFrame,
      widthPercent: 0,
    };
  }

  return {
    active: true,
    committed,
    endFrame: selectionRange.endFrame,
    leftPercent: ((visibleStart - presentedRange.startFrame) / spanFrames) * 100,
    startFrame: selectionRange.startFrame,
    widthPercent: ((visibleEnd - visibleStart) / spanFrames) * 100,
  };
}

function nextTransportCommandSerial(): number {
  return (state.pendingTransportCommand?.serial ?? state.uiRevision) + 1;
}

function queueTransportCommand(command: TransportCommand): void {
  state.pendingTransportCommand = command;
}

function getWaveformSampleData(module: WaveCoreModule): Float32Array | null {
  if (!state.session.waveformPcmPointer || state.session.durationFrames <= 0) {
    return null;
  }
  return getHeapF32View(module, state.session.waveformPcmPointer, state.session.durationFrames);
}

function ensureWaveformSliceCapacity(module: WaveCoreModule, floatCount: number): Float32Array {
  if (state.session.waveformSliceCapacity >= floatCount && state.session.waveformSlicePointer) {
    const view = getHeapF32View(module, state.session.waveformSlicePointer, floatCount);
    state.session.waveformSlice = view;
    return view;
  }

  if (state.session.waveformSlicePointer) {
    module._free(state.session.waveformSlicePointer);
  }

  const pointer = module._malloc(floatCount * Float32Array.BYTES_PER_ELEMENT);
  if (!pointer) {
    throw new Error('Failed to allocate waveform slice buffer.');
  }

  state.session.waveformSlicePointer = pointer;
  state.session.waveformSliceCapacity = floatCount;
  state.session.waveformSlice = getHeapF32View(module, pointer, floatCount);
  return state.session.waveformSlice;
}

function clearWaveformSurface(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawWaveformEnvelope(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  slice: Float32Array,
  columnCount: number,
  heightCssPx: number,
  renderScale: number,
  color: string,
): void {
  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(WAVEFORM_TOP_PADDING_PX * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((heightCssPx - WAVEFORM_BOTTOM_PADDING_PX) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.fillStyle = color;

  const drawColumns = Math.min(columnCount, deviceWidth);
  for (let x = 0; x < drawColumns; x += 1) {
    const sourceIndex = x * 2;
    const minValue = slice[sourceIndex] ?? 0;
    const maxValue = slice[sourceIndex + 1] ?? 0;
    const symmetricPeak = Math.max(Math.abs(minValue), Math.abs(maxValue)) * SYMMETRIC_ENVELOPE_GAIN;
    const top = clamp(Math.round(midY - symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    const bottom = clamp(Math.round(midY + symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
  }
}

function drawWaveformPreview(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleCount: number,
  heightCssPx: number,
  renderScale: number,
  color: string,
): void {
  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(WAVEFORM_TOP_PADDING_PX * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((heightCssPx - WAVEFORM_BOTTOM_PADDING_PX) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;
  const drawColumns = Math.max(1, Math.min(deviceWidth, Math.round(deviceWidth)));
  const samplesPerColumn = Math.max(1, visibleSampleCount / drawColumns);

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.fillStyle = color;

  for (let x = 0; x < drawColumns; x += 1) {
    const columnCenter = sampleStartFrame + ((x + 0.5) * samplesPerColumn);
    let peak = 0;
    for (const tap of WAVEFORM_PREVIEW_SAMPLE_TAPS) {
      const sampleValue = getInterpolatedSample(
        samples,
        columnCenter + (samplesPerColumn * tap),
      );
      peak = Math.max(peak, Math.abs(sampleValue));
    }
    const symmetricPeak = peak * SYMMETRIC_ENVELOPE_GAIN;
    const top = clamp(Math.round(midY - symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    const bottom = clamp(Math.round(midY + symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
  }
}

function drawRepresentativeSamplePlot(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  samples: Float32Array,
  color: string,
  pixelsPerSample: number,
  sampleStartFrame: number,
  visibleSampleCount: number,
  visibleSampleSpan: number,
  heightCssPx: number,
  renderScale: number,
): void {
  const drawColumns = Math.min(Math.max(1, canvas.width), Math.max(1, canvas.width));
  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(WAVEFORM_TOP_PADDING_PX * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((heightCssPx - WAVEFORM_BOTTOM_PADDING_PX) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;
  const bucketSize = Math.max(1, Math.round(visibleSampleCount / drawColumns));
  const plotPoints: Array<{ sampleValue: number; x: number }> = [];

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();

  appendWaveformPlotPoint(plotPoints, 0, getInterpolatedSample(samples, sampleStartFrame));

  const bucketStartIndex = Math.floor(sampleStartFrame / bucketSize);
  const bucketEndIndex = Math.ceil((sampleStartFrame + visibleSampleCount) / bucketSize);
  for (let bucketIndex = bucketStartIndex; bucketIndex < bucketEndIndex; bucketIndex += 1) {
    const samplePoint = pickRepresentativeSamplePoint(samples, bucketIndex * bucketSize, bucketIndex * bucketSize + bucketSize);
    if (!samplePoint) {
      continue;
    }
    appendWaveformPlotPoint(
      plotPoints,
      getRenderableSampleX(samplePoint.sampleIndex, sampleStartFrame, visibleSampleSpan, drawColumns),
      samplePoint.sampleValue,
    );
  }

  appendWaveformPlotPoint(
    plotPoints,
    Math.max(0, drawColumns - 1),
    getInterpolatedSample(samples, sampleStartFrame + visibleSampleSpan),
  );

  for (let pointIndex = 0; pointIndex < plotPoints.length; pointIndex += 1) {
    const plotPoint = plotPoints[pointIndex];
    const y = clamp(midY - plotPoint.sampleValue * amplitudeHeight, chartTop, chartBottom);
    if (pointIndex === 0) {
      context.moveTo(plotPoint.x, y);
    } else {
      context.lineTo(plotPoint.x, y);
    }
  }
  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, renderScale * 1.1);
    context.beginPath();
    for (const plotPoint of plotPoints) {
      const y = clamp(midY - plotPoint.sampleValue * amplitudeHeight, chartTop, chartBottom);
      context.rect(
        Math.round(plotPoint.x - pointSize * 0.5),
        Math.round(y - pointSize * 0.5),
        Math.max(1, Math.round(pointSize)),
        Math.max(1, Math.round(pointSize)),
      );
    }
    context.fill();
  }
}

function drawRawSamplePlot(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  samples: Float32Array,
  color: string,
  pixelsPerSample: number,
  sampleStartFrame: number,
  visibleSampleSpan: number,
  heightCssPx: number,
  renderScale: number,
): void {
  const drawColumns = Math.max(1, canvas.width);
  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(WAVEFORM_TOP_PADDING_PX * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((heightCssPx - WAVEFORM_BOTTOM_PADDING_PX) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartFrame));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartFrame + visibleSampleSpan));

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  const startY = clamp(midY - getInterpolatedSample(samples, sampleStartFrame) * amplitudeHeight, chartTop, chartBottom);
  context.moveTo(0, startY);

  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getRenderableSampleX(sampleIndex, sampleStartFrame, visibleSampleSpan, drawColumns);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.lineTo(x, y);
  }

  const endX = Math.max(0, drawColumns - 1);
  const endY = clamp(
    midY - getInterpolatedSample(samples, sampleStartFrame + visibleSampleSpan) * amplitudeHeight,
    chartTop,
    chartBottom,
  );
  context.lineTo(endX, endY);
  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    if (pixelsPerSample / Math.max(1, renderScale) >= RAW_SAMPLE_MARKER_MIN_CSS_PIXELS_PER_SAMPLE) {
      drawRawSampleMarkers(
        context,
        samples,
        sampleStartFrame,
        visibleSampleSpan,
        drawColumns,
        midY,
        amplitudeHeight,
        chartTop,
        chartBottom,
        renderScale,
      );
      return;
    }

    const pointSize = Math.max(1.5, renderScale * 1.1);
    context.beginPath();
    for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
      const x = getRenderableSampleX(sampleIndex, sampleStartFrame, visibleSampleSpan, drawColumns);
      const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
      const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
      context.rect(
        Math.round(x - pointSize * 0.5),
        Math.round(y - pointSize * 0.5),
        Math.max(1, Math.round(pointSize)),
        Math.max(1, Math.round(pointSize)),
      );
    }
    context.fill();
  }
}

function drawRawSampleMarkers(
  context: OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleSpan: number,
  drawColumns: number,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
  renderScale: number,
): void {
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartFrame));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartFrame + visibleSampleSpan));
  if (lastSampleIndex < firstSampleIndex) {
    return;
  }

  const radius = Math.max(1, RAW_SAMPLE_MARKER_RADIUS_CSS_PX * renderScale);
  context.save();
  context.fillStyle = RAW_SAMPLE_MARKER_FILL;
  context.beginPath();
  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getRenderableSampleX(sampleIndex, sampleStartFrame, visibleSampleSpan, drawColumns);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.moveTo(x + radius, y);
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
  context.fill();
  context.restore();
}

function resolveWaveformPlotMode(samplesPerPixel: number, hasSampleData: boolean): WaveformPlotMode {
  if (!hasSampleData) {
    return 'envelope';
  }

  if (state.viewport.plotMode === 'raw') {
    if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL) {
      return 'raw';
    }
    return samplesPerPixel <= SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (state.viewport.plotMode === 'sample') {
    if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
      return 'raw';
    }
    return samplesPerPixel <= SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
    return 'raw';
  }

  return samplesPerPixel <= SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
}

function appendWaveformPlotPoint(points: Array<{ sampleValue: number; x: number }>, x: number, sampleValue: number): void {
  const normalizedValue = clamp(sampleValue ?? 0, -1, 1);
  const previousPoint = points[points.length - 1] ?? null;
  if (previousPoint && Math.abs(previousPoint.x - x) <= 0.01) {
    if (Math.abs(normalizedValue) >= Math.abs(previousPoint.sampleValue)) {
      previousPoint.sampleValue = normalizedValue;
    }
    return;
  }
  points.push({ sampleValue: normalizedValue, x });
}

function getRenderableSampleX(samplePosition: number, sampleStartFrame: number, visibleSampleSpan: number, drawColumns: number): number {
  const maxX = Math.max(0, drawColumns - 1);
  if (maxX <= 0 || visibleSampleSpan <= 0) {
    return 0;
  }
  return clamp(((samplePosition - sampleStartFrame) / visibleSampleSpan) * maxX, 0, maxX);
}

function getInterpolatedSample(samples: Float32Array, position: number): number {
  const index = Math.floor(position);
  const nextIndex = Math.min(samples.length - 1, index + 1);
  const fraction = position - index;
  const a = clamp(samples[index] ?? 0, -1, 1);
  const b = clamp(samples[nextIndex] ?? 0, -1, 1);
  return a + (b - a) * fraction;
}

function pickRepresentativeSamplePoint(samples: Float32Array, startPosition: number, endPosition: number): { sampleIndex: number; sampleValue: number } | null {
  const maxSampleIndex = Math.max(0, samples.length - 1);
  if (maxSampleIndex < 0) {
    return null;
  }

  const safeStart = clamp(Math.floor(startPosition), 0, maxSampleIndex);
  const safeEndExclusive = clamp(Math.max(safeStart + 1, Math.ceil(endPosition)), safeStart + 1, samples.length);
  const targetCenter = clamp((startPosition + Math.max(startPosition, endPosition - 1)) * 0.5, 0, maxSampleIndex);
  let minValue = 1;
  let maxValue = -1;

  for (let sampleIndex = safeStart; sampleIndex < safeEndExclusive; sampleIndex += 1) {
    const value = clamp(samples[sampleIndex] ?? 0, -1, 1);
    minValue = Math.min(minValue, value);
    maxValue = Math.max(maxValue, value);
  }

  const targetValue = Math.abs(maxValue - minValue) <= 1e-6
    ? clamp(samples[Math.round(targetCenter)] ?? 0, -1, 1)
    : clamp((minValue + maxValue) * 0.5, -1, 1);

  let bestIndex = safeStart;
  let bestValue = clamp(samples[safeStart] ?? 0, -1, 1);
  let bestScore = Number.POSITIVE_INFINITY;
  const rangeSpan = Math.max(1, safeEndExclusive - safeStart);

  for (let sampleIndex = safeStart; sampleIndex < safeEndExclusive; sampleIndex += 1) {
    const value = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const score = Math.abs(value - targetValue) + (Math.abs(sampleIndex - targetCenter) / rangeSpan);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = sampleIndex;
      bestValue = value;
    }
  }

  return {
    sampleIndex: bestIndex,
    sampleValue: bestValue,
  };
}

function getWaveformMarkerYRatio(sampleValue: number): number {
  const heightCssPx = Math.max(1, state.waveformSurface.heightCssPx);
  const chartTopPx = WAVEFORM_TOP_PADDING_PX;
  const chartBottomPx = Math.max(chartTopPx + 1, heightCssPx - WAVEFORM_BOTTOM_PADDING_PX);
  const chartHeightPx = Math.max(1, chartBottomPx - chartTopPx);
  const midYPx = chartTopPx + chartHeightPx * 0.5;
  const yPx = clamp(
    midYPx - sampleValue * chartHeightPx * WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
    chartTopPx,
    chartBottomPx,
  );
  return clamp01(yPx / heightCssPx);
}

function formatSampleOrdinal(sampleNumber: number): string {
  return Number.isFinite(sampleNumber) && sampleNumber > 0
    ? Math.round(sampleNumber).toLocaleString()
    : '0';
}

function formatSampleValue(sampleValue: number): string {
  const normalized = Math.abs(sampleValue) < 0.00005 ? 0 : sampleValue;
  return normalized.toFixed(6).replace(/(?:\.0+|(\.\d*?[1-9]))0+$/, '$1');
}

function formatMfccValue(value: number): string {
  const normalized = Math.abs(value) < 0.00005 ? 0 : value;
  return normalized.toFixed(4).replace(/(?:\.0+|(\.\d*?[1-9]))0+$/, '$1');
}

function framesToSeconds(frame: number): number {
  return state.session.sampleRate > 0
    ? clamp(frame, 0, state.session.durationFrames) / state.session.sampleRate
    : 0;
}

function clampFrame(value: number): number {
  return clamp(Math.round(value), 0, Math.max(0, state.session.durationFrames));
}

function disposeWasmSession(module: WaveCoreModule): void {
  if (state.session.waveformSlicePointer) {
    module._free(state.session.waveformSlicePointer);
  }
  if (state.session.spectrogramOutputPointer) {
    module._free(state.session.spectrogramOutputPointer);
  }
  if (state.session.initialized) {
    module._wave_dispose_session();
  }
  state.session.waveformSlicePointer = 0;
  state.session.waveformSliceCapacity = 0;
  state.session.waveformSlice = null;
  state.session.waveformPcmPointer = 0;
  state.session.spectrogramOutputPointer = 0;
  state.session.spectrogramOutputCapacity = 0;
  state.session.waveformBuildPending = false;
  state.session.waveformBuilt = false;
  state.session.initialized = false;
  invalidateWaveformCache();
}

function getHeapF32View(module: WaveCoreModule, pointer: number, length: number): Float32Array {
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}

function getHeapU8View(module: WaveCoreModule, pointer: number, length: number): Uint8Array {
  return new Uint8Array(module.HEAPU8.buffer, pointer, length);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function postError(error: unknown): void {
  postMessage({
    type: 'Error',
    body: {
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function postMessage(message: EngineWorkerToMainMessage): void {
  self.postMessage(message);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}
