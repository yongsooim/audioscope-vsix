import { DISPLAY_MIN_DPR } from './sharedBuffers';
import type { AudioTransport, PlaybackSession } from './transport/audioTransport';
import { createAudioscopeElements } from './audioscope/core/elements';
import { clamp, formatAxisLabel } from './audioscope/core/format';
import { createAudioscopeFocusController } from './audioscope/controllers/focus';
import { createAudioscopeLifecycleController } from './audioscope/controllers/lifecycle';
import {
  createAudioscopeMediaController,
  createExternalToolStatusState,
  createLoudnessSummaryState,
  createMediaMetadataState,
  normalizeExternalToolStatus,
} from './audioscope/controllers/media';
import {
  createPlaybackAnalysisData,
  createPlaybackAnalysisDataFromPlaybackSession,
  createPlaybackSessionFromPcmFallback,
} from './audioscope/controllers/playbackData';
import {
  createAudioscopePlaybackRateController,
  normalizePlaybackRateSelection,
} from './audioscope/controllers/playbackRate';
import { createAudioscopeTransportLoopController } from './audioscope/controllers/transportLoop';
import { createAudioscopeViewportController } from './audioscope/controllers/viewport';
import {
  createAudioscopeLoadController,
  type AudioscopeWorkerBootstrapStateKey,
} from './audioscope/controllers/load';
import type {
  AnalysisRenderBackend,
  AnalysisSurfaceResetReason,
  EngineWorkerToMainMessage,
  SampleInfoPayload,
  SetViewportIntentMessage,
  SpectrogramAnalysisType,
  SpectrogramColormapDistribution,
  SpectrogramFrequencyScale,
  SpectrogramWindowFunction,
  SurfaceKind,
  TransportCommand,
  ViewportUiState,
} from './audioEngineProtocol';
import { normalizeSpectrogramWindowFunction } from './windowShared';

const vscode = acquireVsCodeApi();
const engineWorkerScriptUri = document.body.dataset.engineWorkerSrc || '';
const analysisWorkerScriptUri = document.body.dataset.analysisWorkerSrc || '';
const decodeBrowserModuleScriptUri = document.body.dataset.decodeModuleSrc;
const decodeBrowserModuleWasmUri = document.body.dataset.decodeModuleWasmSrc;
const decodeWorkerScriptUri = document.body.dataset.decodeWorkerSrc;
const audioTransportProcessorScriptUri = document.body.dataset.audioTransportProcessorSrc;
const stretchProcessorScriptUri = document.body.dataset.stretchProcessorSrc;

const DISPLAY_PIXEL_RATIO = Math.max(window.devicePixelRatio || 1, DISPLAY_MIN_DPR);
const DEFAULT_VIEWPORT_SPLIT_RATIO = 0.5;
const VIEWPORT_SPLIT_STEP = 0.05;
const VIEWPORT_SPLITTER_FALLBACK_SIZE_PX = 12;
const VIEWPORT_RATIO_MAX = 1;
const VIEWPORT_RATIO_MIN = 0;
const LOOP_HANDLE_WIDTH_PX = 8;
const EMBEDDED_MEDIA_TOOLS_GUIDANCE = 'audioscope media tools are unavailable. Rebuild or reinstall audioscope to restore metadata and decoding.';
const SPECTROGRAM_FFT_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const SPECTROGRAM_MEL_BAND_OPTIONS = [128, 256, 512];
const SPECTROGRAM_MFCC_COEFFICIENT_OPTIONS = [13, 20, 32, 40];
const SPECTROGRAM_SCALOGRAM_HOP_OPTIONS = [0, 256, 512, 1024, 2048, 4096];
const SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS = [4, 5, 6, 7, 8, 10, 12];
const SPECTROGRAM_SCALOGRAM_ROW_DENSITY_OPTIONS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const SPECTROGRAM_OVERLAP_OPTIONS = [0.5, 0.75, 0.875, 0.9375];
const SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.2;
const SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR = 2.5;
const SPECTROGRAM_RANGE_EPSILON_SECONDS = 1 / 2000;
const DEFAULT_SCALOGRAM_OMEGA0 = 6;
const DEFAULT_SCALOGRAM_ROW_DENSITY = 1;
const DEFAULT_SCALOGRAM_MIN_FREQUENCY = 20;
const DEFAULT_SCALOGRAM_MAX_FREQUENCY = 20000;
const DEFAULT_SCALOGRAM_HOP_SAMPLES = 0;
const DEFAULT_SPECTROGRAM_FFT_SIZE = 4096;
const DEFAULT_SPECTROGRAM_OVERLAP_RATIO = 0.75;
const DEFAULT_SPECTROGRAM_WINDOW_FUNCTION: SpectrogramWindowFunction = 'hann';
const DEFAULT_SPECTROGRAM_FREQUENCY_SCALE: SpectrogramFrequencyScale = 'log';
const DEFAULT_SPECTROGRAM_COLORMAP_DISTRIBUTION: SpectrogramColormapDistribution = 'balanced';
const DEFAULT_MEL_BAND_COUNT = 256;
const DEFAULT_MFCC_COEFFICIENT_COUNT = 20;
const DEFAULT_MFCC_MEL_BAND_COUNT = 128;
const SPECTROGRAM_CONFIG_APPLY_DELAY_MS = 16;
const SCALOGRAM_HOP_SAMPLES_BY_QUALITY = {
  balanced: 2048,
  high: 1024,
  max: 512,
} as const;
const SPECTROGRAM_DB_WINDOW_LIMITS = {
  max: 12,
  min: -120,
  minimumSpan: 6,
} as const;

const elements = createAudioscopeElements();

function createInitialWaveformViewportState() {
  return {
    presentedRange: { end: 0, start: 0 },
    targetRange: { end: 0, start: 0 },
  };
}

function areTimeRangesEqual(left: TimeRange | null | undefined, right: TimeRange | null | undefined): boolean {
  return Boolean(left && right && left.start === right.start && left.end === right.end);
}

type HoverContext = {
  clientX: number;
  clientY: number;
  requestId: number;
};

type TimeRange = {
  end: number;
  start: number;
};

type SpectrogramVisibleRequest = {
  analysisType: SpectrogramAnalysisType;
  colormapDistribution: SpectrogramColormapDistribution;
  configVersion: number;
  displayEnd: number;
  displayStart: number;
  fftSize: number;
  frequencyScale: SpectrogramFrequencyScale;
  generation: number;
  maxDecibels: number;
  melBandCount: number;
  mfccCoefficientCount: number;
  windowFunction: SpectrogramWindowFunction;
  scalogramHopSamples: number;
  scalogramMaxFrequency: number;
  scalogramMinFrequency: number;
  scalogramOmega0: number;
  scalogramRowDensity: number;
  minDecibels: number;
  overlapRatio: number;
  pixelHeight: number;
  pixelWidth: number;
  viewEnd: number;
  viewStart: number;
};

type SpectrogramAnalysisState = {
  activeVisibleRequest: SpectrogramVisibleRequest | null;
  configVersion: number;
  duration: number;
  fallbackReason: string | null;
  generation: number;
  initialized: boolean;
  maxFrequency: number;
  minFrequency: number;
  quality: 'balanced' | 'high' | 'max';
  renderBackend: AnalysisRenderBackend;
  runtimeVariant: string | null;
  sampleCount: number;
  sampleRate: number;
};

type AnalysisWorkerToMainMessage =
  | {
      body: {
        fallbackReason?: string | null;
        maxFrequency?: number;
        minFrequency?: number;
        quality?: 'balanced' | 'high' | 'max';
        renderBackend?: AnalysisRenderBackend;
        runtimeVariant?: string | null;
        sampleCount?: number;
        sampleRate?: number;
      };
      type: 'analysisInitialized';
    }
  | {
      body: Record<string, unknown>;
      type: 'runtimeReady';
    }
  | {
      body: {
        reason?: AnalysisSurfaceResetReason;
      };
      type: 'analysisSurfaceResetRequested';
    }
  | {
      body: Record<string, unknown>;
      type: 'visibleReady';
    }
  | {
      body: {
        message?: string;
      };
      type: 'error';
    };

const state = {
  activeFile: null,
  analysis: null as SpectrogramAnalysisState | null,
  analysisSourceKind: 'native',
  analysisRuntimeReadyPromise: null as Promise<void> | null,
  analysisWorker: null as Worker | null,
  analysisWorkerBootstrapUrl: null as string | null,
  audioTransport: null as AudioTransport | null,
  decodeFallbackError: null,
  decodeFallbackLoadToken: 0,
  decodeFallbackPromise: null,
  decodeFallbackRequest: null as {
    hostRequested: boolean;
    loadToken: number;
    payload: any;
    reason: string;
  } | null,
  decodeFallbackResult: null,
  decodeWorker: null as Worker | null,
  decodeWorkerBootstrapUrl: null as string | null,
  decodeWorkerPrewarmed: false,
  decodeWorkerReady: false,
  engineSessionRevision: 0,
  engineUiState: null as ViewportUiState | null,
  engineSurfacesPosted: false,
  engineWorker: null as Worker | null,
  engineWorkerBootstrapUrl: null as string | null,
  externalTools: createExternalToolStatusState(EMBEDDED_MEDIA_TOOLS_GUIDANCE),
  followPlayback: false,
  hoverRequestIds: {
    spectrogram: 0,
    waveform: 0,
  },
  hoverState: {
    spectrogram: null as HoverContext | null,
    waveform: null as HoverContext | null,
  },
  lastAppliedTransportCommandSerial: 0,
  loadToken: 0,
  loudness: createLoudnessSummaryState('idle'),
  mediaMetadata: createMediaMetadataState('idle'),
  mediaMetadataDetailOpen: false,
  observedOverviewWidth: 0,
  observedSpectrogramPixelHeight: 0,
  observedSpectrogramPixelWidth: 0,
  observedWaveformViewportHeight: 0,
  observedWaveformViewportWidth: 0,
  lastSyncedSpectrogramDisplay: null as {
    end: number;
    pixelHeight: number;
    pixelWidth: number;
    start: number;
  } | null,
  renderedFrequencyTicks: null as ViewportUiState['frequencyTicks'] | null,
  renderedWaveformAxisTicks: null as ViewportUiState['waveformAxisTicks'] | null,
  renderedWaveformAxisWidthPx: 0,
  playbackFrame: 0,
  playbackRate: 1,
  playbackRateMenuOpen: false,
  playbackSession: null as PlaybackSession | null,
  playbackSourceKind: 'native',
  playbackTransportError: null as string | null,
  playbackTransportKind: 'unavailable',
  rejectDecodeFallback: null,
  resolveAnalysisRuntimeReady: null as (() => void) | null,
  resolveDecodeFallback: null,
  selectionDrag: null as { pointerId: number; target: HTMLElement } | null,
  loopHandleDrag: null as { edge: 'end' | 'start'; handle: HTMLElement; pointerId: number; target: HTMLElement } | null,
  sourceFetchController: null as AbortController | null,
  spectrogramCanvas: null as HTMLCanvasElement | null,
  spectrogramConfig: {
    analysisType: 'spectrogram' as SpectrogramAnalysisType,
    colormapDistribution: 'balanced' as SpectrogramColormapDistribution,
    fftSize: 4096,
    frequencyScale: 'log' as SpectrogramFrequencyScale,
    maxDecibels: 0,
    melBandCount: 256,
    mfccCoefficientCount: 20,
    mfccMelBandCount: 128,
    windowFunction: 'hann' as SpectrogramWindowFunction,
    scalogramHopSamples: DEFAULT_SCALOGRAM_HOP_SAMPLES,
    scalogramMaxFrequency: DEFAULT_SCALOGRAM_MAX_FREQUENCY,
    scalogramMinFrequency: DEFAULT_SCALOGRAM_MIN_FREQUENCY,
    scalogramOmega0: DEFAULT_SCALOGRAM_OMEGA0,
    scalogramRowDensity: DEFAULT_SCALOGRAM_ROW_DENSITY,
    minDecibels: -80,
    overlapRatio: 0.75,
  },
  spectrogramConfigApplyTimer: null as number | null,
  spectrogramConfigPersistPending: false,
  spectrogramFrame: 0,
  spectrogramDefaultsPersistTimer: null as number | null,
  spectrogramMetaOpen: false,
  spectrogramRenderForcePending: false,
  spectrogramSurfaceResetPromise: null as Promise<void> | null,
  spectrogramSurfaceReadyPromise: null as Promise<void> | null,
  viewportResizeDrag: null as { pointerId: number } | null,
  viewportSplitRatio: DEFAULT_VIEWPORT_SPLIT_RATIO,
  waveformCanvas: null as HTMLCanvasElement | null,
  waveformSurfaceReadyPromise: null as Promise<void> | null,
  waveformViewport: createInitialWaveformViewportState(),
};

const {
  initializeKeyboardSurfaceFocus,
  isTextEditableTarget,
  preventPointerFocus,
  scheduleKeyboardSurfaceFocus,
} = createAudioscopeFocusController();

const {
  renderLoudnessSummary,
  renderMediaMetadata,
  setLoudnessSummaryUnavailable,
  setMediaMetadataDetailOpen,
  setPendingLoudnessSummary,
  setReadyLoudnessSummary,
  syncMediaMetadataDetailVisibility,
  updateMediaMetadataDetailPosition,
} = createAudioscopeMediaController({
  embeddedMediaToolsGuidance: EMBEDDED_MEDIA_TOOLS_GUIDANCE,
  elements,
  state,
});

const {
  closePlaybackRateMenu,
  focusPlaybackRateOption,
  getPlaybackRateOptionButtons,
  initializePlaybackRateControl,
  isPlaybackRateUiTarget,
  movePlaybackRateFocus,
  openPlaybackRateMenu,
  positionPlaybackRateMenu,
  stepPlaybackRateSelection,
  syncPlaybackRateControl,
} = createAudioscopePlaybackRateController({
  elements,
  scheduleKeyboardSurfaceFocus,
  state,
});

const {
  destroySession,
  disposeAnalysisWorker,
} = createAudioscopeLifecycleController({
  createInitialWaveformViewportState,
  elements,
  hideSurfaceHoverTooltip,
  hideWaveformSampleMarker,
  renderSpectrogramMeta,
  renderSpectrogramScale,
  renderWaveformUi,
  state,
});

const {
  hasPlaybackTransport,
  seekBy,
  setPlaybackPositionFromFrame,
  startPlaybackLoop,
  syncTransport,
  togglePlayback,
} = createAudioscopeTransportLoopController({
  elements,
  frameToSeconds,
  getDurationFrames,
  getEffectiveDurationSeconds,
  getSampleRate,
  renderMediaMetadata,
  state,
  syncPlaybackRateControl,
});

const {
  applyViewportSplit,
  attachResizeObservers,
  handleViewportWheel,
  updateViewportSplitRatioFromClientY,
} = createAudioscopeViewportController({
  defaultViewportSplitRatio: DEFAULT_VIEWPORT_SPLIT_RATIO,
  displayPixelRatio: DISPLAY_PIXEL_RATIO,
  elements,
  getDurationFrames,
  refreshHoveredSampleInfos,
  getSpectrogramCanvasTargetSize,
  getWaveformViewportSize,
  scheduleSpectrogramRender,
  sendViewportIntent,
  splitterFallbackSizePx: VIEWPORT_SPLITTER_FALLBACK_SIZE_PX,
  state,
  viewportRatioMax: VIEWPORT_RATIO_MAX,
  viewportRatioMin: VIEWPORT_RATIO_MIN,
});

function setAnalysisStatus(message: string, isError = false): void {
  elements.analysisStatus.textContent = message;
  elements.analysisStatus.classList.toggle('error', isError);
}

function setFatalStatus(message: string): void {
  elements.status.hidden = false;
  elements.status.textContent = message;
  elements.status.classList.add('error');
}

function clearFatalStatus(): void {
  elements.status.hidden = true;
  elements.status.textContent = '';
  elements.status.classList.remove('error');
}

function normalizeSpectrogramAnalysisType(value: unknown): SpectrogramAnalysisType {
  return value === 'chroma'
    || value === 'chroma_cqt'
    || value === 'mel'
    || value === 'mfcc'
    || value === 'scalogram'
    ? (value === 'chroma_cqt' ? 'chroma' : value)
    : 'spectrogram';
}

function normalizeSpectrogramColormapDistribution(value: unknown): SpectrogramColormapDistribution {
  return value === 'contrast' || value === 'soft' ? value : 'balanced';
}

function getSpectrogramAnalysisTypeLabel(analysisType: SpectrogramAnalysisType): string {
  switch (analysisType) {
    case 'mel':
      return 'Mel-Spectrogram';
    case 'mfcc':
      return 'MFCC';
    case 'scalogram':
      return 'Scalogram';
    case 'chroma':
      return 'Chroma';
    default:
      return 'Spectrogram';
  }
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

function normalizeSpectrogramFftSize(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_FFT_OPTIONS.includes(numericValue) ? numericValue : 4096;
}

function normalizeSpectrogramMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MEL_BAND_OPTIONS.includes(numericValue) ? numericValue : 256;
}

function getSpectrogramFrequencyCeiling(): number {
  const analysisMaxFrequency = Number(state.analysis?.maxFrequency);
  const fallbackCeiling = DEFAULT_SCALOGRAM_MAX_FREQUENCY;
  if (!Number.isFinite(analysisMaxFrequency) || analysisMaxFrequency <= DEFAULT_SCALOGRAM_MIN_FREQUENCY + 1) {
    return fallbackCeiling;
  }

  return Math.max(
    DEFAULT_SCALOGRAM_MIN_FREQUENCY + 1,
    Math.min(DEFAULT_SCALOGRAM_MAX_FREQUENCY, Math.round(analysisMaxFrequency)),
  );
}

function normalizeSpectrogramMfccCoefficientCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MFCC_COEFFICIENT_OPTIONS.includes(numericValue) ? numericValue : 20;
}

function normalizeSpectrogramMfccMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MEL_BAND_OPTIONS.includes(numericValue) ? numericValue : 128;
}

function normalizeSpectrogramScalogramOmega0(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_OMEGA0;
}

function getSpectrogramScalogramOmegaSliderIndex(value: unknown): number {
  const normalizedValue = normalizeSpectrogramScalogramOmega0(value);
  const optionIndex = SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.indexOf(normalizedValue);
  return optionIndex >= 0 ? optionIndex : SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.indexOf(DEFAULT_SCALOGRAM_OMEGA0);
}

function getSpectrogramScalogramOmega0FromSlider(value: unknown): number {
  const optionIndex = clamp(
    Math.round(Number(value) || 0),
    0,
    SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS.length - 1,
  );
  return SPECTROGRAM_SCALOGRAM_OMEGA_OPTIONS[optionIndex] ?? DEFAULT_SCALOGRAM_OMEGA0;
}

function normalizeSpectrogramScalogramRowDensity(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_SCALOGRAM_ROW_DENSITY_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_ROW_DENSITY;
}

function normalizeSpectrogramScalogramHopSetting(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_SCALOGRAM_HOP_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_HOP_SAMPLES;
}

function getEffectiveScalogramHopSamples(value: unknown): number {
  const normalizedValue = normalizeSpectrogramScalogramHopSetting(value);
  if (normalizedValue > 0) {
    return normalizedValue;
  }

  const quality = state.analysis?.quality === 'balanced' || state.analysis?.quality === 'max'
    ? state.analysis.quality
    : 'high';
  return SCALOGRAM_HOP_SAMPLES_BY_QUALITY[quality] ?? SCALOGRAM_HOP_SAMPLES_BY_QUALITY.high;
}

function normalizeSpectrogramScalogramFrequencyRange(minValue: unknown, maxValue: unknown): {
  maxFrequency: number;
  minFrequency: number;
} {
  const ceiling = getSpectrogramFrequencyCeiling();
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

function normalizeSpectrogramFrequencyScale(value: unknown): SpectrogramFrequencyScale {
  return value === 'linear' || value === 'mixed' ? value : 'log';
}

function normalizeSpectrogramOverlapRatio(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_OVERLAP_OPTIONS.includes(numericValue) ? numericValue : 0.75;
}

function getEffectiveDurationSeconds(): number {
  const duration = Number(state.audioTransport?.getDuration());
  return Number.isFinite(duration) && duration > 0
    ? duration
    : (state.playbackSession?.durationSeconds ?? 0);
}

function getDurationFrames(): number {
  return state.playbackSession?.sourceLength ?? 0;
}

function getSampleRate(): number {
  return state.playbackSession?.sourceSampleRate ?? 0;
}

function frameToSeconds(frame: number): number {
  const sampleRate = getSampleRate();
  return sampleRate > 0 ? clamp(frame, 0, getDurationFrames()) / sampleRate : 0;
}

function createModuleWorker(
  moduleUrl: string,
  bootstrapStateKey: AudioscopeWorkerBootstrapStateKey,
): Worker {
  const bootstrapSource = `import ${JSON.stringify(moduleUrl)};`;
  const bootstrapBlob = new Blob([bootstrapSource], { type: 'text/javascript' });
  const bootstrapUrl = URL.createObjectURL(bootstrapBlob);
  state[bootstrapStateKey] = bootstrapUrl;
  return new Worker(bootstrapUrl, { type: 'module' });
}

function createSpectrogramAnalysisState(
  duration: number,
  quality: 'balanced' | 'high' | 'max',
  sampleCount: number,
  sampleRate: number,
): SpectrogramAnalysisState {
  return {
    activeVisibleRequest: null,
    configVersion: 0,
    duration,
    fallbackReason: null,
    generation: 0,
    initialized: false,
    maxFrequency: Math.min(20000, sampleRate / 2),
    minFrequency: 20,
    quality,
    renderBackend: '2d-wasm',
    runtimeVariant: null,
    sampleCount,
    sampleRate,
  };
}

function normalizeSpectrogramQuality(value: unknown): 'balanced' | 'high' | 'max' {
  return value === 'balanced' || value === 'max' ? value : 'high';
}

async function ensureEngineWorker(loadToken: number): Promise<Worker | null> {
  if (state.engineWorker) {
    return state.engineWorker;
  }

  if (!engineWorkerScriptUri || loadToken !== state.loadToken) {
    return null;
  }

  const worker = createModuleWorker(engineWorkerScriptUri, 'engineWorkerBootstrapUrl');
  state.engineWorker = worker;
  worker.addEventListener('message', (event: MessageEvent<EngineWorkerToMainMessage>) => {
    handleEngineWorkerMessage(event.data);
  });
  worker.addEventListener('error', (event) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    setFatalStatus(`Audio engine worker failed: ${event.message || 'Unknown worker error.'}`);
  });
  worker.postMessage({ type: 'bootstrapRuntime' });
  postInitSurfaces();
  return worker;
}

async function ensureAnalysisWorker(loadToken: number): Promise<Worker | null> {
  if (state.analysisWorker) {
    return state.analysisWorker;
  }

  if (!analysisWorkerScriptUri || loadToken !== state.loadToken) {
    return null;
  }

  const worker = createModuleWorker(analysisWorkerScriptUri, 'analysisWorkerBootstrapUrl');
  state.analysisRuntimeReadyPromise = new Promise((resolve) => {
    state.resolveAnalysisRuntimeReady = resolve;
  });
  state.analysisWorker = worker;
  worker.addEventListener('message', (event: MessageEvent<AnalysisWorkerToMainMessage>) => {
    handleAnalysisWorkerMessage(loadToken, event.data);
  });
  worker.addEventListener('error', (event) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    disposeAnalysisWorker();
    setAnalysisStatus(`Spectrogram failed: ${event.message || 'Unknown worker error.'}`, true);
  });
  worker.postMessage({ type: 'bootstrapRuntime' });
  return worker;
}

function postInitSurfaces(): void {
  if (state.engineSurfacesPosted || !state.engineWorker || !state.waveformCanvas) {
    return;
  }

  const waveformCanvas = state.waveformCanvas;
  const waveformOffscreenCanvas = waveformCanvas.transferControlToOffscreen();
  const waveformSize = getWaveformViewportSize();
  const spectrogramSize = getSpectrogramCanvasTargetSize();
  state.engineSurfacesPosted = true;

  state.engineWorker.postMessage({
    type: 'InitSurfaces',
    body: {
      spectrogramPixelHeight: spectrogramSize.pixelHeight,
      spectrogramPixelWidth: spectrogramSize.pixelWidth,
      waveformHeightCssPx: waveformSize.height,
      waveformOffscreenCanvas,
      waveformRenderScale: DISPLAY_PIXEL_RATIO,
      waveformWidthCssPx: waveformSize.width,
    },
  }, [waveformOffscreenCanvas]);
}

async function initializeWaveformSurface(loadToken: number): Promise<void> {
  elements.waveformCanvasHost.replaceChildren();

  const canvas = document.createElement('canvas');
  canvas.className = 'waveform-canvas';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  elements.waveformCanvasHost.replaceChildren(canvas);
  state.waveformCanvas = canvas;
  state.engineSurfacesPosted = false;

  await ensureEngineWorker(loadToken);
  if (loadToken !== state.loadToken) {
    return;
  }
  postInitSurfaces();
}

async function initializeSpectrogramSurface(loadToken: number): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.id = 'spectrogram';
  canvas.className = 'spectrogram-canvas';
  canvas.setAttribute('aria-label', 'Spectrogram');
  elements.spectrogram.replaceWith(canvas);
  elements.spectrogram = canvas;
  state.spectrogramCanvas = canvas;
  state.spectrogramSurfaceReadyPromise = Promise.resolve();

  const worker = await ensureAnalysisWorker(loadToken);
  if (loadToken !== state.loadToken) {
    return;
  }

  if (!worker || typeof canvas.transferControlToOffscreen !== 'function') {
    throw new Error('Spectrogram worker runtime is unavailable.');
  }

  const offscreenCanvas = canvas.transferControlToOffscreen();
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  worker.postMessage({
    type: 'initCanvas',
    body: {
      offscreenCanvas,
      pixelHeight,
      pixelWidth,
    },
  }, [offscreenCanvas]);
}

async function resetSpectrogramSurface(loadToken: number, reason: AnalysisSurfaceResetReason): Promise<void> {
  if (state.spectrogramSurfaceResetPromise) {
    return state.spectrogramSurfaceResetPromise;
  }

  setAnalysisStatus(
    reason === 'device-lost'
      ? 'Spectrogram surface resetting after WebGPU device loss...'
      : 'Spectrogram surface resetting...',
  );

  state.spectrogramSurfaceResetPromise = (async () => {
    await initializeSpectrogramSurface(loadToken);
  })()
    .finally(() => {
      state.spectrogramSurfaceResetPromise = null;
    });

  return state.spectrogramSurfaceResetPromise;
}

function applyTransportCommand(command: TransportCommand | null): void {
  if (!command || command.serial <= state.lastAppliedTransportCommandSerial) {
    return;
  }

  state.lastAppliedTransportCommandSerial = command.serial;

  switch (command.type) {
    case 'seek':
      setPlaybackPositionFromFrame(command.frame);
      return;
    case 'clearLoopAndSeek':
      state.audioTransport?.setLoop(null);
      setPlaybackPositionFromFrame(command.frame);
      return;
    case 'setLoop':
      state.audioTransport?.setLoop({
        end: frameToSeconds(command.endFrame),
        start: frameToSeconds(command.startFrame),
      });
      syncTransport();
      return;
    case 'clearLoop':
      state.audioTransport?.setLoop(null);
      syncTransport();
      return;
    default:
      return;
  }
}

function applyViewportUiState(uiState: ViewportUiState): void {
  const previousPresentedRange = state.waveformViewport.presentedRange;
  state.engineUiState = uiState;
  state.followPlayback = uiState.viewport.followEnabled;
  elements.waveFollow.checked = uiState.viewport.followEnabled;
  const sampleRate = uiState.playback.sampleRate || getSampleRate();
  let nextPresentedRange: TimeRange | null = null;

  if (sampleRate > 0) {
    nextPresentedRange = {
      start: uiState.presentedStartFrame / sampleRate,
      end: uiState.presentedEndFrame / sampleRate,
    };
    state.waveformViewport.presentedRange = nextPresentedRange;
    state.waveformViewport.targetRange = {
      start: uiState.viewport.targetStartFrame / sampleRate,
      end: uiState.viewport.targetEndFrame / sampleRate,
    };
  }

  renderWaveformUi();
  renderSpectrogramScale();
  if (nextPresentedRange && !areTimeRangesEqual(previousPresentedRange, nextPresentedRange)) {
    syncPresentedSpectrogramRange(nextPresentedRange);
    scheduleSpectrogramRender();
    refreshHoveredSampleInfos();
  }
  applyTransportCommand(uiState.transportCommand);
}

function areFrequencyTicksEqual(
  previousTicks: ViewportUiState['frequencyTicks'] | null,
  nextTicks: ViewportUiState['frequencyTicks'],
): boolean {
  if (previousTicks === nextTicks) {
    return true;
  }

  if (!previousTicks || previousTicks.length !== nextTicks.length) {
    return false;
  }

  for (let index = 0; index < nextTicks.length; index += 1) {
    const previousTick = previousTicks[index];
    const nextTick = nextTicks[index];

    if (
      !previousTick
      || previousTick.edge !== nextTick.edge
      || previousTick.frequency !== nextTick.frequency
      || previousTick.label !== nextTick.label
      || Math.abs(previousTick.positionRatio - nextTick.positionRatio) > 1e-9
    ) {
      return false;
    }
  }

  return true;
}

function areWaveformAxisTicksEqual(
  previousTicks: ViewportUiState['waveformAxisTicks'] | null,
  nextTicks: ViewportUiState['waveformAxisTicks'],
): boolean {
  if (previousTicks === nextTicks) {
    return true;
  }

  if (!previousTicks || previousTicks.length !== nextTicks.length) {
    return false;
  }

  for (let index = 0; index < nextTicks.length; index += 1) {
    const previousTick = previousTicks[index];
    const nextTick = nextTicks[index];

    if (
      !previousTick
      || previousTick.align !== nextTick.align
      || previousTick.frame !== nextTick.frame
      || previousTick.label !== nextTick.label
      || Math.abs(previousTick.positionRatio - nextTick.positionRatio) > 1e-9
    ) {
      return false;
    }
  }

  return true;
}

function renderWaveformAxis(): void {
  const uiState = state.engineUiState;
  const waveformAxisTicks = uiState?.waveformAxisTicks ?? [];

  if (!uiState || waveformAxisTicks.length === 0) {
    if (!state.renderedWaveformAxisTicks && state.renderedWaveformAxisWidthPx === 0) {
      return;
    }

    elements.waveformAxis.replaceChildren();
    state.renderedWaveformAxisTicks = null;
    state.renderedWaveformAxisWidthPx = 0;
    return;
  }

  const renderWidthPx = Math.max(1, uiState.viewport.renderWidthPx);
  if (
    state.renderedWaveformAxisWidthPx === renderWidthPx
    && areWaveformAxisTicksEqual(state.renderedWaveformAxisTicks, waveformAxisTicks)
  ) {
    return;
  }

  const axisContent = document.createElement('div');
  axisContent.className = 'waveform-axis-content';
  axisContent.style.width = `${renderWidthPx}px`;

  for (const tick of waveformAxisTicks) {
    const tickElement = document.createElement('div');
    tickElement.className = 'waveform-axis-tick';
    tickElement.style.left = `${tick.positionRatio * 100}%`;
    tickElement.style.transform = tick.align === 'start'
      ? 'translateX(0)'
      : tick.align === 'end'
        ? 'translateX(-100%)'
        : 'translateX(-50%)';

    const topMark = document.createElement('div');
    topMark.className = 'waveform-axis-mark';
    const label = document.createElement('div');
    label.className = 'waveform-axis-label';
    label.textContent = tick.label;
    const bottomMark = document.createElement('div');
    bottomMark.className = 'waveform-axis-mark';
    tickElement.append(topMark, label, bottomMark);
    axisContent.append(tickElement);
  }

  elements.waveformAxis.replaceChildren(axisContent);
  state.renderedWaveformAxisTicks = waveformAxisTicks;
  state.renderedWaveformAxisWidthPx = renderWidthPx;
}

function renderSelectionAndLoop(uiState: ViewportUiState | null): void {
  const selection = uiState?.selection;
  const active = Boolean(selection?.active);

  for (const element of [elements.waveformSelection, elements.spectrogramSelection]) {
    element.style.display = active ? 'block' : 'none';
    element.style.left = active ? `${selection?.leftPercent ?? 0}%` : '0%';
    element.style.width = active ? `${selection?.widthPercent ?? 0}%` : '0%';
  }

  const showLoopHandles = active && selection?.committed === true;
  const startPercent = selection?.leftPercent ?? 0;
  const endPercent = (selection?.leftPercent ?? 0) + (selection?.widthPercent ?? 0);

  positionLoopHandle(elements.waveformLoopStart, elements.waveformViewport.clientWidth, startPercent, showLoopHandles);
  positionLoopHandle(elements.waveformLoopEnd, elements.waveformViewport.clientWidth, endPercent, showLoopHandles);
  positionLoopHandle(elements.spectrogramLoopStart, elements.spectrogramHitTarget.clientWidth, startPercent, showLoopHandles);
  positionLoopHandle(elements.spectrogramLoopEnd, elements.spectrogramHitTarget.clientWidth, endPercent, showLoopHandles);
}

function positionLoopHandle(element: HTMLElement, widthPx: number, percent: number, visible: boolean): void {
  element.style.display = visible ? 'block' : 'none';
  if (!visible) {
    element.style.left = '0px';
    return;
  }

  const x = (clamp(percent, 0, 100) / 100) * Math.max(0, widthPx);
  element.style.left = `${Math.max(0, x - LOOP_HANDLE_WIDTH_PX / 2)}px`;
}

function renderTransportOverview(uiState: ViewportUiState | null): void {
  if (!uiState) {
    elements.timeline.value = '0';
    elements.timeline.style.setProperty('--seek-progress', '0%');
    elements.waveformOverviewThumb.style.left = '0%';
    elements.waveformOverviewThumb.style.width = '0%';
    elements.timelineCurrentMarker.hidden = true;
    elements.timelineCurrentMarker.style.left = '0%';
    return;
  }

  const currentPercent = uiState.overview.currentPercent;
  elements.timeline.disabled = !hasPlaybackTransport();
  elements.timeline.value = String(currentPercent / 100);
  elements.timeline.style.setProperty('--seek-progress', `${currentPercent.toFixed(4)}%`);
  elements.waveformOverviewThumb.style.left = `${uiState.overview.viewportLeftPercent.toFixed(6)}%`;
  elements.waveformOverviewThumb.style.width = `${uiState.overview.viewportWidthPercent.toFixed(6)}%`;

  if (!uiState.overview.currentVisible) {
    elements.timelineCurrentMarker.hidden = true;
    elements.timelineCurrentMarker.style.left = '0%';
    return;
  }

  elements.timelineCurrentMarker.hidden = false;
  elements.timelineCurrentMarker.style.left = `${currentPercent.toFixed(6)}%`;
}

function renderPlaybackIndicators(uiState: ViewportUiState | null): void {
  const cursorVisible = uiState?.cursorVisible === true;
  const cursorPercent = uiState?.cursorPercent ?? 0;
  elements.waveformProgress.style.width = `${cursorPercent}%`;
  elements.waveformCursor.style.left = `${cursorPercent}%`;
  elements.waveformCursor.style.display = cursorVisible ? 'block' : 'none';
  elements.spectrogramProgress.style.width = `${cursorPercent}%`;
  elements.spectrogramCursor.style.left = `${cursorPercent}%`;
  elements.spectrogramCursor.style.display = cursorVisible ? 'block' : 'none';
  renderTransportOverview(uiState);
}

function renderWaveformUi(): void {
  const uiState = state.engineUiState;
  elements.waveZoomReset.textContent = 'Reset';
  elements.waveZoomChip.textContent = uiState ? `Zoom ${uiState.zoomFactor.toFixed(1)}x` : 'Zoom 1.0x';
  elements.waveFollow.checked = state.followPlayback;

  const selection = uiState?.selection;
  const sampleRate = uiState?.playback.sampleRate || getSampleRate();
  const selectionLabel = selection && sampleRate > 0 && selection.startFrame !== null && selection.endFrame !== null
    ? `Loop ${formatAxisLabel(selection.startFrame / sampleRate)} - ${formatAxisLabel(selection.endFrame / sampleRate)}`
    : 'Drag to set loop';

  elements.waveLoopLabel.textContent = selectionLabel;
  elements.waveClearLoop.disabled = !(selection?.committed);
  renderWaveformAxis();
  renderSelectionAndLoop(uiState);
  renderPlaybackIndicators(uiState);
}

function renderSpectrogramScale(): void {
  const frequencyTicks = state.engineUiState?.frequencyTicks ?? [];

  if (frequencyTicks.length === 0) {
    if (!state.renderedFrequencyTicks) {
      return;
    }

    elements.spectrogramAxis.replaceChildren();
    elements.spectrogramGuides.replaceChildren();
    state.renderedFrequencyTicks = null;
    return;
  }

  if (areFrequencyTicksEqual(state.renderedFrequencyTicks, frequencyTicks)) {
    return;
  }

  const axisFragment = document.createDocumentFragment();
  const guideFragment = document.createDocumentFragment();

  for (const tick of frequencyTicks) {
    const axisTick = document.createElement('div');
    axisTick.className = 'spectrogram-tick';
    if (tick.edge === 'top') {
      axisTick.classList.add('spectrogram-tick-edge-top');
    } else if (tick.edge === 'bottom') {
      axisTick.classList.add('spectrogram-tick-edge-bottom');
    }
    axisTick.style.top = `${tick.positionRatio * 100}%`;

    const label = document.createElement('span');
    label.className = 'spectrogram-tick-label';
    label.textContent = tick.label;
    axisTick.append(label);

    const guide = document.createElement('div');
    guide.className = 'spectrogram-guide';
    guide.style.top = `${tick.positionRatio * 100}%`;

    axisFragment.append(axisTick);
    guideFragment.append(guide);
  }

  elements.spectrogramAxis.replaceChildren(axisFragment);
  elements.spectrogramGuides.replaceChildren(guideFragment);
  state.renderedFrequencyTicks = frequencyTicks;
}

function renderSpectrogramMeta(): void {
  const analysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
  const isChroma = analysisType === 'chroma';
  const supportsScale = analysisType === 'spectrogram';
  const supportsMelBands = analysisType === 'mel';
  const supportsMfccOptions = analysisType === 'mfcc';
  const supportsScalogramOptions = analysisType === 'scalogram';
  const supportsWindowControl = analysisType !== 'scalogram';
  const supportsHopControl = supportsScalogramOptions || isChroma;
  const supportsDbWindow = analysisType !== 'mfcc' && !isChroma;
  const isScalogram = analysisType === 'scalogram';
  const dbWindow = normalizeSpectrogramDbWindow(
    state.spectrogramConfig.minDecibels,
    state.spectrogramConfig.maxDecibels,
    analysisType,
  );
  elements.spectrogramTypeSelect.value = analysisType;
  elements.spectrogramFftSelect.value = String(state.spectrogramConfig.fftSize);
  elements.spectrogramOverlapSelect.value = String(state.spectrogramConfig.overlapRatio);
  elements.spectrogramWindowSelect.value = normalizeSpectrogramWindowFunction(state.spectrogramConfig.windowFunction);
  elements.spectrogramScaleSelect.value = normalizeSpectrogramFrequencyScale(state.spectrogramConfig.frequencyScale);
  elements.spectrogramMelBandsSelect.value = String(
    normalizeSpectrogramMelBandCount(state.spectrogramConfig.melBandCount),
  );
  elements.spectrogramMfccCoefficientsSelect.value = String(
    normalizeSpectrogramMfccCoefficientCount(state.spectrogramConfig.mfccCoefficientCount),
  );
  elements.spectrogramMfccMelBandsSelect.value = String(
    normalizeSpectrogramMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount),
  );
  elements.spectrogramScalogramOmegaSlider.value = String(
    getSpectrogramScalogramOmegaSliderIndex(state.spectrogramConfig.scalogramOmega0),
  );
  elements.spectrogramScalogramOmegaValue.textContent = String(
    normalizeSpectrogramScalogramOmega0(state.spectrogramConfig.scalogramOmega0),
  );
  elements.spectrogramScalogramHopSelect.value = String(
    normalizeSpectrogramScalogramHopSetting(state.spectrogramConfig.scalogramHopSamples),
  );
  elements.spectrogramDistributionSelect.value = normalizeSpectrogramColormapDistribution(
    state.spectrogramConfig.colormapDistribution,
  );
  const analysisTypeLabel = getSpectrogramAnalysisTypeLabel(analysisType);
  elements.spectrogramResetTypeButton.setAttribute('aria-label', `Reset ${analysisTypeLabel} settings to defaults`);
  elements.spectrogramResetTypeButton.title = `Reset ${analysisTypeLabel} settings to defaults`;

  elements.spectrogramFftControl.hidden = isScalogram;
  elements.spectrogramOverlapControl.hidden = isScalogram || isChroma;
  elements.spectrogramWindowControl.hidden = !supportsWindowControl;
  elements.spectrogramScaleControl.hidden = !supportsScale;
  elements.spectrogramMelBandsControl.hidden = !supportsMelBands;
  elements.spectrogramMfccCoefficientsControl.hidden = !supportsMfccOptions;
  elements.spectrogramMfccMelBandsControl.hidden = !supportsMfccOptions;
  elements.spectrogramScalogramOmegaControl.hidden = !supportsScalogramOptions;
  elements.spectrogramScalogramHopControl.hidden = !supportsHopControl;
  elements.spectrogramDbRangeControl.hidden = !supportsDbWindow;
  elements.spectrogramFftSelect.disabled = isScalogram || isChroma;
  elements.spectrogramOverlapSelect.disabled = isScalogram || isChroma;
  elements.spectrogramWindowSelect.disabled = !supportsWindowControl;
  elements.spectrogramScaleSelect.disabled = !supportsScale;
  elements.spectrogramMelBandsSelect.disabled = !supportsMelBands;
  elements.spectrogramMfccCoefficientsSelect.disabled = !supportsMfccOptions;
  elements.spectrogramMfccMelBandsSelect.disabled = !supportsMfccOptions;
  elements.spectrogramScalogramOmegaSlider.disabled = !supportsScalogramOptions;
  elements.spectrogramScalogramHopSelect.disabled = !supportsHopControl;
  elements.spectrogramMinDbSlider.disabled = !supportsDbWindow;
  elements.spectrogramMaxDbSlider.disabled = !supportsDbWindow;
  renderSpectrogramDbWindowUi(dbWindow);
  setSpectrogramMetaOpen(state.spectrogramMetaOpen);
}

function renderSpectrogramDbWindowUi(dbWindow: { maxDecibels: number; minDecibels: number }): void {
  elements.spectrogramMinDbSlider.value = String(dbWindow.minDecibels);
  elements.spectrogramMaxDbSlider.value = String(dbWindow.maxDecibels);
  const rangeStartPercent = ((dbWindow.minDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.min)
    / (SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.min)) * 100;
  const rangeEndPercent = ((dbWindow.maxDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.min)
    / (SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.min)) * 100;
  elements.spectrogramDbRangeGroup.style.setProperty('--range-start', `${rangeStartPercent.toFixed(3)}%`);
  elements.spectrogramDbRangeGroup.style.setProperty('--range-end', `${rangeEndPercent.toFixed(3)}%`);
  elements.spectrogramDbRangeValue.textContent = `Min ${dbWindow.minDecibels} / Max ${dbWindow.maxDecibels} dB`;
}

function setSpectrogramMetaOpen(open: boolean): void {
  state.spectrogramMetaOpen = open;
  elements.spectrogramMeta.dataset.open = open ? 'true' : 'false';
  elements.spectrogramMetaControls.hidden = !open;
  elements.spectrogramMetaToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  elements.spectrogramMetaToggle.setAttribute(
    'aria-label',
    open ? 'Hide spectrogram settings' : 'Show spectrogram settings',
  );
}

function getEffectiveSpectrogramRenderConfig() {
  const analysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
  const dbWindow = normalizeSpectrogramDbWindow(
    state.spectrogramConfig.minDecibels,
    state.spectrogramConfig.maxDecibels,
    analysisType,
  );
  const scalogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
    state.spectrogramConfig.scalogramMinFrequency,
    state.spectrogramConfig.scalogramMaxFrequency,
  );
  return {
    analysisType,
    colormapDistribution: normalizeSpectrogramColormapDistribution(state.spectrogramConfig.colormapDistribution),
    fftSize: normalizeSpectrogramFftSize(state.spectrogramConfig.fftSize),
    frequencyScale: analysisType === 'spectrogram'
      ? normalizeSpectrogramFrequencyScale(state.spectrogramConfig.frequencyScale)
      : 'log' as SpectrogramFrequencyScale,
    maxDecibels: dbWindow.maxDecibels,
    melBandCount: analysisType === 'mfcc'
      ? normalizeSpectrogramMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount)
      : normalizeSpectrogramMelBandCount(state.spectrogramConfig.melBandCount),
    mfccCoefficientCount: normalizeSpectrogramMfccCoefficientCount(state.spectrogramConfig.mfccCoefficientCount),
    mfccMelBandCount: normalizeSpectrogramMfccMelBandCount(state.spectrogramConfig.mfccMelBandCount),
    windowFunction: normalizeSpectrogramWindowFunction(state.spectrogramConfig.windowFunction),
    scalogramHopSamples: getEffectiveScalogramHopSamples(state.spectrogramConfig.scalogramHopSamples),
    scalogramMaxFrequency: scalogramFrequencyRange.maxFrequency,
    scalogramMinFrequency: scalogramFrequencyRange.minFrequency,
    scalogramOmega0: normalizeSpectrogramScalogramOmega0(state.spectrogramConfig.scalogramOmega0),
    scalogramRowDensity: normalizeSpectrogramScalogramRowDensity(state.spectrogramConfig.scalogramRowDensity),
    minDecibels: dbWindow.minDecibels,
    overlapRatio: normalizeSpectrogramOverlapRatio(state.spectrogramConfig.overlapRatio),
  };
}

function applyPersistedSpectrogramDefaults(defaults: any): void {
  state.spectrogramConfig.analysisType = normalizeSpectrogramAnalysisType(defaults?.analysisType);
  state.spectrogramConfig.colormapDistribution = normalizeSpectrogramColormapDistribution(defaults?.colormapDistribution);
  state.spectrogramConfig.fftSize = normalizeSpectrogramFftSize(defaults?.fftSize);
  state.spectrogramConfig.frequencyScale = normalizeSpectrogramFrequencyScale(defaults?.frequencyScale);
  state.spectrogramConfig.maxDecibels = Number.isFinite(Number(defaults?.maxDecibels))
    ? Math.round(Number(defaults.maxDecibels))
    : state.spectrogramConfig.maxDecibels;
  state.spectrogramConfig.melBandCount = normalizeSpectrogramMelBandCount(defaults?.melBandCount);
  state.spectrogramConfig.mfccCoefficientCount = normalizeSpectrogramMfccCoefficientCount(defaults?.mfccCoefficientCount);
  state.spectrogramConfig.mfccMelBandCount = normalizeSpectrogramMfccMelBandCount(defaults?.mfccMelBandCount);
  state.spectrogramConfig.minDecibels = Number.isFinite(Number(defaults?.minDecibels))
    ? Math.round(Number(defaults.minDecibels))
    : state.spectrogramConfig.minDecibels;
  state.spectrogramConfig.overlapRatio = normalizeSpectrogramOverlapRatio(defaults?.overlapRatio);
  state.spectrogramConfig.scalogramHopSamples = normalizeSpectrogramScalogramHopSetting(defaults?.scalogramHopSamples);
  const scalogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
    defaults?.scalogramMinFrequency,
    defaults?.scalogramMaxFrequency,
  );
  state.spectrogramConfig.scalogramMinFrequency = scalogramFrequencyRange.minFrequency;
  state.spectrogramConfig.scalogramMaxFrequency = scalogramFrequencyRange.maxFrequency;
  state.spectrogramConfig.scalogramOmega0 = normalizeSpectrogramScalogramOmega0(defaults?.scalogramOmega0);
  state.spectrogramConfig.scalogramRowDensity = normalizeSpectrogramScalogramRowDensity(defaults?.scalogramRowDensity);
  state.spectrogramConfig.windowFunction = normalizeSpectrogramWindowFunction(defaults?.windowFunction);
}

function resetCurrentSpectrogramTypeToDefaults(): void {
  const analysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
  const dbWindow = getDefaultSpectrogramDbWindow(analysisType);

  state.spectrogramConfig.colormapDistribution = DEFAULT_SPECTROGRAM_COLORMAP_DISTRIBUTION;

  switch (analysisType) {
    case 'spectrogram':
      state.spectrogramConfig.fftSize = DEFAULT_SPECTROGRAM_FFT_SIZE;
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.frequencyScale = DEFAULT_SPECTROGRAM_FREQUENCY_SCALE;
      state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
      state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
      break;
    case 'mel':
      state.spectrogramConfig.fftSize = DEFAULT_SPECTROGRAM_FFT_SIZE;
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.melBandCount = DEFAULT_MEL_BAND_COUNT;
      state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
      state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
      break;
    case 'mfcc':
      state.spectrogramConfig.fftSize = DEFAULT_SPECTROGRAM_FFT_SIZE;
      state.spectrogramConfig.overlapRatio = DEFAULT_SPECTROGRAM_OVERLAP_RATIO;
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.mfccCoefficientCount = DEFAULT_MFCC_COEFFICIENT_COUNT;
      state.spectrogramConfig.mfccMelBandCount = DEFAULT_MFCC_MEL_BAND_COUNT;
      break;
    case 'scalogram':
      state.spectrogramConfig.scalogramHopSamples = DEFAULT_SCALOGRAM_HOP_SAMPLES;
      state.spectrogramConfig.scalogramMinFrequency = DEFAULT_SCALOGRAM_MIN_FREQUENCY;
      state.spectrogramConfig.scalogramMaxFrequency = DEFAULT_SCALOGRAM_MAX_FREQUENCY;
      state.spectrogramConfig.scalogramOmega0 = DEFAULT_SCALOGRAM_OMEGA0;
      state.spectrogramConfig.scalogramRowDensity = DEFAULT_SCALOGRAM_ROW_DENSITY;
      state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
      state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
      break;
    case 'chroma':
      state.spectrogramConfig.windowFunction = DEFAULT_SPECTROGRAM_WINDOW_FUNCTION;
      state.spectrogramConfig.scalogramHopSamples = DEFAULT_SCALOGRAM_HOP_SAMPLES;
      break;
  }

  refreshSpectrogramAnalysisConfig();
  scheduleKeyboardSurfaceFocus();
}

function schedulePersistSpectrogramDefaults(): void {
  if (state.spectrogramDefaultsPersistTimer) {
    window.clearTimeout(state.spectrogramDefaultsPersistTimer);
  }

  state.spectrogramDefaultsPersistTimer = window.setTimeout(() => {
    state.spectrogramDefaultsPersistTimer = null;
    vscode.postMessage({
      type: 'persistSpectrogramDefaults',
      body: getEffectiveSpectrogramRenderConfig(),
    });
  }, 160);
}

function cancelActiveSpectrogramRender(): void {
  if (!state.analysisWorker || !state.analysis) {
    return;
  }

  const generation = state.analysis.generation;
  if (generation <= 0) {
    return;
  }

  state.analysisWorker.postMessage({
    type: 'cancelGeneration',
    body: { generation },
  });
}

function scheduleSpectrogramConfigRefresh({ persist = true } = {}): void {
  state.spectrogramConfigPersistPending = state.spectrogramConfigPersistPending || persist;
  cancelActiveSpectrogramRender();

  if (state.spectrogramConfigApplyTimer) {
    return;
  }

  state.spectrogramConfigApplyTimer = window.setTimeout(() => {
    const shouldPersist = state.spectrogramConfigPersistPending;
    state.spectrogramConfigApplyTimer = null;
    state.spectrogramConfigPersistPending = false;
    refreshSpectrogramAnalysisConfig({ persist: shouldPersist });
  }, SPECTROGRAM_CONFIG_APPLY_DELAY_MS);
}

function getSpectrogramRenderPixelHeight(): number {
  const renderHeight = Math.max(
    1,
    elements.spectrogramStage.clientHeight,
    elements.spectrogram.clientHeight,
    elements.spectrogramPanel.clientHeight,
    elements.viewport.clientHeight,
    window.innerHeight,
    1,
  );

  return Math.max(1, Math.round(renderHeight * DISPLAY_PIXEL_RATIO));
}

function refreshSpectrogramAnalysisConfig({ persist = true } = {}): void {
  if (state.spectrogramConfigApplyTimer) {
    window.clearTimeout(state.spectrogramConfigApplyTimer);
    state.spectrogramConfigApplyTimer = null;
  }
  const shouldPersist = persist || state.spectrogramConfigPersistPending;
  state.spectrogramConfigPersistPending = false;
  const renderConfig = getEffectiveSpectrogramRenderConfig();

  if (state.engineWorker) {
    state.engineWorker.postMessage({
      type: 'SetSpectrogramConfig',
      body: renderConfig,
    });
  }

  if (state.analysis) {
    state.analysis.configVersion += 1;
    state.analysis.activeVisibleRequest = null;
  }

  renderSpectrogramMeta();
  scheduleSpectrogramRender({ force: true });
  if (shouldPersist) {
    schedulePersistSpectrogramDefaults();
  }
}

function getPresentedRangeSeconds(): TimeRange | null {
  const uiState = state.engineUiState;
  const sampleRate = uiState?.playback.sampleRate || getSampleRate();
  if (!uiState || !(sampleRate > 0)) {
    return null;
  }

  const start = uiState.presentedStartFrame / sampleRate;
  const end = uiState.presentedEndFrame / sampleRate;
  return end > start ? { start, end } : null;
}

function expandRange(range: TimeRange, duration: number, factor: number): TimeRange {
  const span = Math.max(0, range.end - range.start);
  if (!(duration > 0) || !(span > 0)) {
    return range;
  }

  const nextSpan = clamp(span * Math.max(1, factor), span, Math.max(span, duration));
  const extraSpan = nextSpan - span;
  const nextStart = clamp(range.start - extraSpan * 0.5, 0, Math.max(0, duration - nextSpan));
  return { start: nextStart, end: nextStart + nextSpan };
}

function isSmoothFollowPlaybackActive(): boolean {
  return Boolean(
    state.followPlayback
      && state.audioTransport?.isPlaying() === true
      && !state.selectionDrag
      && !state.loopHandleDrag,
  );
}

function getVisibleSpectrogramRequestMetrics(displayRange: TimeRange) {
  const duration = getEffectiveDurationSeconds();
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  let requestRange = displayRange;
  let requestPixelWidth = pixelWidth;

  if (duration > 0 && visibleSpan > 0 && isSmoothFollowPlaybackActive()) {
    requestRange = expandRange(displayRange, duration, SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR);
    requestPixelWidth = Math.max(
      pixelWidth,
      Math.ceil(pixelWidth * ((requestRange.end - requestRange.start) / visibleSpan)),
    );
  }

  return {
    displayRange,
    pixelHeight,
    pixelWidth,
    requestPixelWidth: Math.max(1, requestPixelWidth),
    requestRange,
  };
}

function isRangeBuffered(targetRange: TimeRange, bufferRange: TimeRange, marginRatio = 0): boolean {
  if (!(targetRange.end > targetRange.start) || !(bufferRange.end > bufferRange.start)) {
    return false;
  }

  const targetSpan = targetRange.end - targetRange.start;
  const bufferSpan = bufferRange.end - bufferRange.start;
  const availablePadding = Math.max(0, (bufferSpan - targetSpan) * 0.5);
  const requestedPadding = Math.max(0, bufferSpan * Math.max(0, marginRatio));
  const effectivePadding = Math.min(availablePadding, requestedPadding);

  return targetRange.start >= (bufferRange.start + effectivePadding - SPECTROGRAM_RANGE_EPSILON_SECONDS)
    && targetRange.end <= (bufferRange.end - effectivePadding + SPECTROGRAM_RANGE_EPSILON_SECONDS);
}

function isCompatibleVisibleRequest(
  activeRequest: SpectrogramVisibleRequest | null,
  size: { pixelHeight: number; pixelWidth: number },
) {
  if (!activeRequest || !state.analysis) {
    return false;
  }

  const renderConfig = getEffectiveSpectrogramRenderConfig();
  return activeRequest.configVersion === state.analysis.configVersion
    && activeRequest.analysisType === renderConfig.analysisType
    && activeRequest.colormapDistribution === renderConfig.colormapDistribution
    && activeRequest.fftSize === renderConfig.fftSize
    && activeRequest.frequencyScale === renderConfig.frequencyScale
    && activeRequest.maxDecibels === renderConfig.maxDecibels
    && activeRequest.melBandCount === renderConfig.melBandCount
    && (renderConfig.analysisType !== 'mfcc' || activeRequest.mfccCoefficientCount === renderConfig.mfccCoefficientCount)
    && activeRequest.windowFunction === renderConfig.windowFunction
    && ((renderConfig.analysisType !== 'chroma' && renderConfig.analysisType !== 'scalogram')
      || activeRequest.scalogramHopSamples === renderConfig.scalogramHopSamples)
    && (renderConfig.analysisType !== 'scalogram' || (
      activeRequest.scalogramMinFrequency === renderConfig.scalogramMinFrequency
      && activeRequest.scalogramMaxFrequency === renderConfig.scalogramMaxFrequency
      && Math.abs(activeRequest.scalogramOmega0 - renderConfig.scalogramOmega0) <= 1e-6
      && Math.abs(activeRequest.scalogramRowDensity - renderConfig.scalogramRowDensity) <= 1e-6
    ))
    && activeRequest.minDecibels === renderConfig.minDecibels
    && Math.abs(activeRequest.overlapRatio - renderConfig.overlapRatio) <= 1e-6
    && Math.abs(activeRequest.pixelWidth - size.pixelWidth) <= 1
    && Math.abs(activeRequest.pixelHeight - size.pixelHeight) <= 1;
}

function hasBufferedVisibleSpectrogramCoverage(displayRange: TimeRange): boolean {
  const activeRequest = state.analysis?.activeVisibleRequest ?? null;
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();

  if (!isCompatibleVisibleRequest(activeRequest, { pixelHeight, pixelWidth })) {
    return false;
  }

  if (isSmoothFollowPlaybackActive()) {
    return isRangeBuffered(displayRange, {
      start: activeRequest!.viewStart,
      end: activeRequest!.viewEnd,
    }, SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO);
  }

  return Math.abs(activeRequest!.viewStart - displayRange.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(activeRequest!.viewEnd - displayRange.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
}

function syncSpectrogramDisplayRange(displayRange: TimeRange, pixelWidth: number, pixelHeight: number): void {
  if (!state.analysisWorker || !state.analysis?.initialized) {
    return;
  }

  const previousDisplay = state.lastSyncedSpectrogramDisplay;
  if (
    previousDisplay
    && previousDisplay.start === displayRange.start
    && previousDisplay.end === displayRange.end
    && previousDisplay.pixelWidth === pixelWidth
    && previousDisplay.pixelHeight === pixelHeight
  ) {
    return;
  }

  if (state.analysis.activeVisibleRequest) {
    state.analysis.activeVisibleRequest.displayEnd = displayRange.end;
    state.analysis.activeVisibleRequest.displayStart = displayRange.start;
    state.analysis.activeVisibleRequest.pixelHeight = pixelHeight;
    state.analysis.activeVisibleRequest.pixelWidth = pixelWidth;
  }

  state.lastSyncedSpectrogramDisplay = {
    end: displayRange.end,
    pixelHeight,
    pixelWidth,
    start: displayRange.start,
  };

  state.analysisWorker.postMessage({
    type: 'updateVisibleDisplayRange',
    body: {
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      pixelHeight,
      pixelWidth,
    },
  });
}

function syncPresentedSpectrogramRange(displayRange: TimeRange | null): void {
  if (!displayRange) {
    return;
  }
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  syncSpectrogramDisplayRange(displayRange, pixelWidth, pixelHeight);
}

function scheduleSpectrogramRender({ force = false } = {}): void {
  state.spectrogramRenderForcePending = state.spectrogramRenderForcePending || force;
  if (state.spectrogramFrame) {
    return;
  }

  state.spectrogramFrame = window.requestAnimationFrame(() => {
    state.spectrogramFrame = 0;
    const nextForce = state.spectrogramRenderForcePending;
    state.spectrogramRenderForcePending = false;
    syncSpectrogramView({ force: nextForce });
  });
}

function syncSpectrogramView({ force = false } = {}): void {
  if (!state.analysisWorker || !state.analysis?.initialized) {
    return;
  }

  const displayRange = getPresentedRangeSeconds();
  if (!displayRange || !(displayRange.end > displayRange.start)) {
    return;
  }

  const { pixelHeight, pixelWidth, requestPixelWidth, requestRange } = getVisibleSpectrogramRequestMetrics(displayRange);
  syncSpectrogramDisplayRange(displayRange, pixelWidth, pixelHeight);

  if (!force && hasBufferedVisibleSpectrogramCoverage(displayRange)) {
    return;
  }

  const renderConfig = getEffectiveSpectrogramRenderConfig();
  const previousGeneration = state.analysis.generation;
  const generation = previousGeneration + 1;
  state.analysis.generation = generation;
    state.analysis.activeVisibleRequest = {
      analysisType: renderConfig.analysisType,
      colormapDistribution: renderConfig.colormapDistribution,
      configVersion: state.analysis.configVersion,
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      fftSize: renderConfig.fftSize,
      frequencyScale: renderConfig.frequencyScale,
      generation,
      maxDecibels: renderConfig.maxDecibels,
      melBandCount: renderConfig.melBandCount,
      mfccCoefficientCount: renderConfig.mfccCoefficientCount,
      windowFunction: renderConfig.windowFunction,
      scalogramHopSamples: renderConfig.scalogramHopSamples,
      scalogramMaxFrequency: renderConfig.scalogramMaxFrequency,
      scalogramMinFrequency: renderConfig.scalogramMinFrequency,
      scalogramOmega0: renderConfig.scalogramOmega0,
      scalogramRowDensity: renderConfig.scalogramRowDensity,
      minDecibels: renderConfig.minDecibels,
      overlapRatio: renderConfig.overlapRatio,
      pixelHeight,
    pixelWidth,
    viewEnd: requestRange.end,
    viewStart: requestRange.start,
  };

  if (previousGeneration > 0) {
    state.analysisWorker.postMessage({
      type: 'cancelGeneration',
      body: { generation: previousGeneration },
    });
  }

  state.analysisWorker.postMessage({
    type: 'renderVisibleRange',
    body: {
      analysisType: renderConfig.analysisType,
      colormapDistribution: renderConfig.colormapDistribution,
      configVersion: state.analysis.configVersion,
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      dpr: DISPLAY_PIXEL_RATIO,
      fftSize: renderConfig.fftSize,
      frequencyScale: renderConfig.frequencyScale,
      generation,
      maxDecibels: renderConfig.maxDecibels,
      melBandCount: renderConfig.melBandCount,
      mfccCoefficientCount: renderConfig.mfccCoefficientCount,
      mfccMelBandCount: renderConfig.mfccMelBandCount,
      windowFunction: renderConfig.windowFunction,
      scalogramHopSamples: renderConfig.scalogramHopSamples,
      scalogramMaxFrequency: renderConfig.scalogramMaxFrequency,
      scalogramMinFrequency: renderConfig.scalogramMinFrequency,
      scalogramOmega0: renderConfig.scalogramOmega0,
      scalogramRowDensity: renderConfig.scalogramRowDensity,
      minDecibels: renderConfig.minDecibels,
      overlapRatio: renderConfig.overlapRatio,
      pixelHeight,
      pixelWidth: requestPixelWidth,
      requestEnd: requestRange.end,
      requestStart: requestRange.start,
    },
  });
}

function hideSurfaceHoverTooltip(tooltipElement: HTMLElement): void {
  tooltipElement.classList.remove('visible');
  tooltipElement.setAttribute('aria-hidden', 'true');
}

function updateSurfaceHoverTooltip(tooltipElement: HTMLElement, targetElement: HTMLElement, point: HoverContext, label: string): void {
  const rect = targetElement.getBoundingClientRect();
  if (!label || rect.width <= 0 || rect.height <= 0) {
    hideSurfaceHoverTooltip(tooltipElement);
    return;
  }

  const localX = clamp(point.clientX - rect.left, 0, rect.width);
  const localY = clamp(point.clientY - rect.top, 0, rect.height);
  tooltipElement.textContent = label;
  tooltipElement.classList.add('visible');
  tooltipElement.setAttribute('aria-hidden', 'false');

  const tooltipWidth = tooltipElement.offsetWidth || 0;
  const tooltipHeight = tooltipElement.offsetHeight || 0;
  const maxLeft = Math.max(12, rect.width - tooltipWidth - 12);
  const maxTop = Math.max(12, rect.height - tooltipHeight - 12);
  tooltipElement.style.left = `${clamp(localX + 14, 12, maxLeft)}px`;
  tooltipElement.style.top = `${clamp(localY - tooltipHeight - 14, 12, maxTop)}px`;
}

function ensureWaveformSampleMarkerElement(): void {
  if (elements.waveformSampleMarker || !elements.waveformViewport) {
    return;
  }

  const marker = document.createElement('div');
  marker.id = 'waveform-sample-marker';
  marker.className = 'waveform-sample-marker';
  marker.setAttribute('aria-hidden', 'true');
  elements.waveformViewport.append(marker);
  elements.waveformSampleMarker = marker;
}

function hideWaveformSampleMarker(): void {
  if (!elements.waveformSampleMarker) {
    return;
  }
  elements.waveformSampleMarker.style.display = 'none';
  elements.waveformSampleMarker.style.left = '0px';
  elements.waveformSampleMarker.style.top = '0px';
}

function applySampleInfo(payload: SampleInfoPayload): void {
  const hover = state.hoverState[payload.surface];
  if (!hover || hover.requestId !== payload.requestId) {
    return;
  }

  if (payload.surface === 'waveform') {
    updateSurfaceHoverTooltip(
      elements.waveformHoverTooltip,
      elements.waveformViewport,
      hover,
      payload.label,
    );

    if (elements.waveformSampleMarker && payload.markerVisible) {
      elements.waveformSampleMarker.style.display = 'block';
      elements.waveformSampleMarker.style.left = `${payload.markerXRatio * elements.waveformViewport.clientWidth}px`;
      elements.waveformSampleMarker.style.top = `${payload.markerYRatio * elements.waveformViewport.clientHeight}px`;
    } else {
      hideWaveformSampleMarker();
    }
    return;
  }

  updateSurfaceHoverTooltip(
    elements.spectrogramHoverTooltip,
    elements.spectrogramHitTarget,
    hover,
    payload.label,
  );
}

function requestSampleInfoAtClientPoint(surface: SurfaceKind, clientX: number, clientY: number): void {
  if (!state.engineWorker) {
    return;
  }

  const target = getHoverTarget(surface);
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    hideHoverForSurface(surface);
    return;
  }

  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    hideHoverForSurface(surface);
    return;
  }

  const requestId = state.hoverRequestIds[surface] + 1;
  state.hoverRequestIds[surface] = requestId;
  state.hoverState[surface] = {
    clientX,
    clientY,
    requestId,
  };

  state.engineWorker.postMessage({
    type: 'RequestSampleInfo',
    body: {
      pointerRatioX: clamp((clientX - rect.left) / rect.width, 0, 1),
      pointerRatioY: clamp((clientY - rect.top) / rect.height, 0, 1),
      requestId,
      surface,
    },
  });
}

function requestSampleInfo(surface: SurfaceKind, event: PointerEvent): void {
  requestSampleInfoAtClientPoint(surface, event.clientX, event.clientY);
}

function refreshHoveredSampleInfo(surface: SurfaceKind): void {
  const hover = state.hoverState[surface];
  if (!hover) {
    return;
  }

  requestSampleInfoAtClientPoint(surface, hover.clientX, hover.clientY);
}

function refreshHoveredSampleInfos(): void {
  refreshHoveredSampleInfo('waveform');
  refreshHoveredSampleInfo('spectrogram');
}

function hideWaveformHoverTooltip(): void {
  state.hoverState.waveform = null;
  hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
  hideWaveformSampleMarker();
}

function hideSpectrogramHoverTooltip(): void {
  state.hoverState.spectrogram = null;
  hideSurfaceHoverTooltip(elements.spectrogramHoverTooltip);
}

function updateTimelineHoverTooltip(event: PointerEvent): void {
  const durationFrames = getDurationFrames();
  const sampleRate = getSampleRate();
  const rect = elements.waveformOverview.getBoundingClientRect();
  if (!(durationFrames > 0) || !(sampleRate > 0) || rect.width <= 0) {
    hideTimelineHoverTooltip();
    return;
  }

  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const frame = Math.round(ratio * durationFrames);
  const tooltipX = clamp(event.clientX - rect.left, 18, Math.max(18, rect.width - 18));
  elements.timelineHoverTooltip.textContent = formatAxisLabel(frame / sampleRate);
  elements.timelineHoverTooltip.style.left = `${tooltipX}px`;
  elements.timelineHoverTooltip.classList.add('visible');
}

function hideTimelineHoverTooltip(): void {
  elements.timelineHoverTooltip.classList.remove('visible');
}

function getWaveformViewportSize(): { height: number; width: number } {
  return {
    height: Math.max(1, elements.waveformViewport.clientHeight),
    width: Math.max(1, elements.waveformViewport.clientWidth),
  };
}

function getSpectrogramCanvasTargetSize(): { pixelHeight: number; pixelWidth: number } {
  return {
    pixelHeight: getSpectrogramRenderPixelHeight(),
    pixelWidth: Math.max(1, Math.round(elements.spectrogram.clientWidth * DISPLAY_PIXEL_RATIO)),
  };
}

function sendViewportIntent(body: SetViewportIntentMessage['body']): void {
  if (!state.engineWorker) {
    return;
  }

  state.engineWorker.postMessage({
    type: 'SetViewportIntent',
    body,
  });
}

function pointerRatioForEvent(target: HTMLElement, event: PointerEvent): number {
  const rect = target.getBoundingClientRect();
  return rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5;
}

function beginSelectionDrag(event: PointerEvent, target: HTMLElement, surface: SurfaceKind): void {
  if (!hasPlaybackTransport() || getDurationFrames() <= 0) {
    return;
  }
  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }
  event.preventDefault();
  target.setPointerCapture(event.pointerId);
  state.selectionDrag = { pointerId: event.pointerId, target };
  sendViewportIntent({
    kind: 'selectionStart',
    pointerRatioX: pointerRatioForEvent(target, event),
    surface,
  });
}

function updateSelectionDrag(event: PointerEvent, target: HTMLElement, surface: SurfaceKind): void {
  if (!state.selectionDrag || state.selectionDrag.pointerId !== event.pointerId || state.selectionDrag.target !== target) {
    return;
  }
  sendViewportIntent({
    kind: 'selectionUpdate',
    pointerRatioX: pointerRatioForEvent(target, event),
    surface,
  });
}

function releaseSelectionDrag(event: PointerEvent, target: HTMLElement, surface: SurfaceKind, cancelled = false): void {
  if (!state.selectionDrag || state.selectionDrag.pointerId !== event.pointerId || state.selectionDrag.target !== target) {
    return;
  }

  if (target.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }

  state.selectionDrag = null;
  sendViewportIntent({
    cancelled,
    kind: 'selectionEnd',
    pointerRatioX: pointerRatioForEvent(target, event),
    surface,
  });
}

function bindLoopHandle(handle: HTMLElement, edge: 'end' | 'start', target: HTMLElement, surface: SurfaceKind): void {
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    state.loopHandleDrag = { edge, handle, pointerId: event.pointerId, target };
    sendViewportIntent({
      edge,
      kind: 'loopHandleStart',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });

  handle.addEventListener('pointermove', (event) => {
    if (!state.loopHandleDrag || state.loopHandleDrag.pointerId !== event.pointerId || state.loopHandleDrag.handle !== handle) {
      return;
    }
    sendViewportIntent({
      edge,
      kind: 'loopHandleUpdate',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });

  handle.addEventListener('pointerup', (event) => {
    if (!state.loopHandleDrag || state.loopHandleDrag.pointerId !== event.pointerId || state.loopHandleDrag.handle !== handle) {
      return;
    }
    if (handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    state.loopHandleDrag = null;
    sendViewportIntent({
      edge,
      kind: 'loopHandleEnd',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });

  handle.addEventListener('pointercancel', (event) => {
    if (!state.loopHandleDrag || state.loopHandleDrag.pointerId !== event.pointerId || state.loopHandleDrag.handle !== handle) {
      return;
    }
    state.loopHandleDrag = null;
    sendViewportIntent({
      cancelled: true,
      edge,
      kind: 'loopHandleEnd',
      pointerRatioX: pointerRatioForEvent(target, event),
      surface,
    });
  });
}

function handleAnalysisWorkerMessage(loadToken: number, message: AnalysisWorkerToMainMessage): void {
  if (loadToken !== state.loadToken) {
    return;
  }

  if (message?.type === 'runtimeReady') {
    state.resolveAnalysisRuntimeReady?.();
    state.resolveAnalysisRuntimeReady = null;
    return;
  }

  if (!state.analysis) {
    return;
  }

  if (message?.type === 'analysisInitialized') {
    state.lastSyncedSpectrogramDisplay = null;
    state.analysis.initialized = true;
    state.analysis.fallbackReason = typeof message.body?.fallbackReason === 'string'
      ? message.body.fallbackReason
      : null;
    state.analysis.renderBackend = message.body?.renderBackend === 'webgpu-native'
      ? 'webgpu-native'
      : '2d-wasm';
    state.analysis.runtimeVariant = message.body?.runtimeVariant ?? null;
    state.analysis.sampleRate = Number(message.body?.sampleRate) || state.analysis.sampleRate;
    state.analysis.sampleCount = Number(message.body?.sampleCount) || state.analysis.sampleCount;
    state.analysis.minFrequency = Number(message.body?.minFrequency) || state.analysis.minFrequency;
    state.analysis.maxFrequency = Number(message.body?.maxFrequency) || state.analysis.maxFrequency;
    scheduleSpectrogramRender({ force: true });
    return;
  }

  if (message?.type === 'analysisSurfaceResetRequested') {
    const reason = message.body?.reason === 'device-lost' ? 'device-lost' : 'surface-invalid';
    void resetSpectrogramSurface(loadToken, reason)
      .then(() => {
        if (loadToken !== state.loadToken || !state.analysis) {
          return;
        }

        scheduleSpectrogramRender({ force: true });
      })
      .catch((error) => {
        if (loadToken !== state.loadToken) {
          return;
        }

        setAnalysisStatus(
          `Spectrogram failed to recover surface: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      });
    return;
  }

  if (message?.type === 'visibleReady') {
    const body = message.body ?? {};
    if (Number(body.generation) !== state.analysis.generation) {
      return;
    }
    const scalogramFrequencyRange = normalizeSpectrogramScalogramFrequencyRange(
      body.scalogramMinFrequency,
      body.scalogramMaxFrequency,
    );

    state.analysis.activeVisibleRequest = {
      analysisType: normalizeSpectrogramAnalysisType(body.analysisType),
      colormapDistribution: normalizeSpectrogramColormapDistribution(body.colormapDistribution),
      configVersion: Number(body.configVersion) || 0,
      displayEnd: Number(body.displayEnd) || 0,
      displayStart: Number(body.displayStart) || 0,
      fftSize: Number(body.fftSize) || 0,
      frequencyScale: body.frequencyScale === 'linear' || body.frequencyScale === 'mixed' ? body.frequencyScale : 'log',
      generation: Number(body.generation) || 0,
      maxDecibels: Math.round(Number(body.maxDecibels) || 0),
      melBandCount: normalizeSpectrogramMelBandCount(body.melBandCount),
      mfccCoefficientCount: normalizeSpectrogramMfccCoefficientCount(body.mfccCoefficientCount),
      windowFunction: normalizeSpectrogramWindowFunction(body.windowFunction),
      scalogramHopSamples: Math.max(1, Math.round(Number(body.scalogramHopSamples) || 0)),
      scalogramMaxFrequency: scalogramFrequencyRange.maxFrequency,
      scalogramMinFrequency: scalogramFrequencyRange.minFrequency,
      scalogramOmega0: normalizeSpectrogramScalogramOmega0(body.scalogramOmega0),
      scalogramRowDensity: normalizeSpectrogramScalogramRowDensity(body.scalogramRowDensity),
      minDecibels: Math.round(Number(body.minDecibels) || 0),
      overlapRatio: Number(body.overlapRatio) || 0,
      pixelHeight: Number(body.pixelHeight) || 0,
      pixelWidth: Number(body.pixelWidth) || 0,
      viewEnd: Number(body.viewEnd) || 0,
      viewStart: Number(body.viewStart) || 0,
    };
    setAnalysisStatus('Ready');
    return;
  }

  if (message?.type === 'error') {
    setAnalysisStatus(`Spectrogram failed: ${message.body?.message || 'Unknown worker error.'}`, true);
  }
}

function handleEngineWorkerMessage(message: EngineWorkerToMainMessage): void {
  switch (message.type) {
    case 'PlaybackProgress':
      applyPlaybackProgress(message.body);
      return;
    case 'ViewportUiState':
      applyViewportUiState(message.body);
      return;
    case 'SampleInfo':
      applySampleInfo(message.body);
      return;
    case 'Error':
      setFatalStatus(`Audio engine failed: ${message.body.message}`);
      return;
    default:
      return;
  }
}

function applyPlaybackProgress(body: {
  cursorPercent: number;
  cursorVisible: boolean;
  overviewCurrentPercent: number;
  overviewCurrentVisible: boolean;
  playback: ViewportUiState['playback'];
}): void {
  const uiState = state.engineUiState;
  if (!uiState) {
    return;
  }

  uiState.cursorPercent = body.cursorPercent;
  uiState.cursorVisible = body.cursorVisible;
  uiState.overview.currentPercent = body.overviewCurrentPercent;
  uiState.overview.currentVisible = body.overviewCurrentVisible;
  uiState.playback = body.playback;
  renderPlaybackIndicators(uiState);
}

function getHoverTarget(surface: SurfaceKind): HTMLElement {
  return surface === 'waveform' ? elements.waveformHitTarget : elements.spectrogramHitTarget;
}

function hideHoverForSurface(surface: SurfaceKind): void {
  if (surface === 'waveform') {
    hideWaveformHoverTooltip();
    return;
  }

  hideSpectrogramHoverTooltip();
}

async function decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('Web Audio API is unavailable in this webview.');
  }
  const context = new AudioContextConstructor();
  try {
    return await context.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await context.close().catch(() => {});
  }
}

async function initializeDecodedPlayback(loadToken: number, payload: any, decodedAudio: AudioBuffer): Promise<void> {
  await initializePlaybackFromPreparedData(loadToken, payload, createPlaybackAnalysisData(decodedAudio));
}

async function initializePlaybackFromPreparedData(
  loadToken: number,
  payload: any,
  preparedPlaybackData: { monoSamples: Float32Array; playbackSession: PlaybackSession },
): Promise<void> {
  const { monoSamples, playbackSession } = preparedPlaybackData;
  const audioTransport = state.audioTransport;
  state.playbackSession = playbackSession;
  state.lastSyncedSpectrogramDisplay = null;
  state.analysis = createSpectrogramAnalysisState(
    playbackSession.durationSeconds,
    normalizeSpectrogramQuality(payload?.spectrogramQuality),
    monoSamples.length,
    playbackSession.sourceSampleRate,
  );

  await state.waveformSurfaceReadyPromise;

  const engineWorker = await ensureEngineWorker(loadToken);
  if (
    !audioTransport
    || !engineWorker
    || loadToken !== state.loadToken
    || state.audioTransport !== audioTransport
  ) {
    return;
  }

  state.engineSessionRevision += 1;
  const engineMono = monoSamples.slice();
  engineWorker.postMessage({
    type: 'LoadAnalysisSession',
    body: {
      durationFrames: playbackSession.sourceLength,
      monoSamplesBuffer: engineMono.buffer,
      quality: payload?.spectrogramQuality === 'balanced' || payload?.spectrogramQuality === 'max'
        ? payload.spectrogramQuality
        : 'high',
      sampleRate: playbackSession.sourceSampleRate,
      sessionRevision: state.engineSessionRevision,
    },
  }, [engineMono.buffer]);

  const analysisSessionPromise = (async () => {
    await state.spectrogramSurfaceReadyPromise;
    const analysisWorker = await ensureAnalysisWorker(loadToken);
    if (
      !analysisWorker
      || loadToken !== state.loadToken
      || state.audioTransport !== audioTransport
    ) {
      return;
    }

    await state.analysisRuntimeReadyPromise;
    if (
      loadToken !== state.loadToken
      || state.audioTransport !== audioTransport
    ) {
      return;
    }

    analysisWorker.postMessage({
      type: 'attachAudioSession',
      body: {
        duration: playbackSession.durationSeconds,
        quality: normalizeSpectrogramQuality(payload?.spectrogramQuality),
        sampleCount: monoSamples.length,
        sampleRate: playbackSession.sourceSampleRate,
        samplesBuffer: monoSamples.buffer,
        sessionVersion: state.engineSessionRevision,
      },
    }, [monoSamples.buffer]);
  })();

  await audioTransport.load({
    playbackSession,
    workletModuleUrl: audioTransportProcessorScriptUri,
  });

  if (loadToken !== state.loadToken || state.audioTransport !== audioTransport) {
    return;
  }

  state.playbackTransportKind = audioTransport.getTransportKind() ?? 'unavailable';
  state.playbackTransportError = audioTransport.getLastFallbackReason() ?? null;
  renderMediaMetadata();
  renderWaveformUi();
  syncTransport();
  refreshSpectrogramAnalysisConfig({ persist: false });
  setAnalysisStatus('Playback ready');

  void analysisSessionPromise;
}

const {
  acceptDecodeFallbackResult,
  loadAudioFile,
  rejectDecodeFallbackRequest,
} = createAudioscopeLoadController({
  audioTransportProcessorScriptUri,
  createModuleWorker,
  createPlaybackAnalysisDataFromPlaybackSession,
  createPlaybackSessionFromPcmFallback,
  createMediaMetadataState,
  decodeAudioData,
  decodeBrowserModuleScriptUri,
  decodeBrowserModuleWasmUri,
  decodeWorkerScriptUri,
  destroySession,
  embeddedMediaToolsGuidance: EMBEDDED_MEDIA_TOOLS_GUIDANCE,
  initializeDecodedPlayback,
  initializePlaybackFromPreparedData,
  initializeSpectrogramSurface,
  initializeWaveformSurface,
  normalizeExternalToolStatus,
  renderMediaMetadata,
  renderSpectrogramScale,
  renderWaveformUi,
  setAnalysisStatus,
  setFatalStatus,
  setLoudnessSummaryUnavailable,
  setPendingLoudnessSummary,
  clearFatalStatus,
  startPlaybackLoop,
  state,
  stretchProcessorScriptUri,
  syncTransport,
  vscode,
});

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message?.type === 'loadAudio') {
    if (message.body && typeof message.body === 'object') {
      const { audioBytes: _audioBytes, ...activeFile } = message.body;
      state.activeFile = activeFile;
    } else {
      state.activeFile = message.body;
    }
    applyPersistedSpectrogramDefaults(message.body?.spectrogramDefaults);
    renderSpectrogramMeta();
    state.externalTools = normalizeExternalToolStatus(message.body?.externalTools, EMBEDDED_MEDIA_TOOLS_GUIDANCE);
    void loadAudioFile(message.body);
    return;
  }

  if (message?.type === 'externalToolStatus') {
    state.externalTools = normalizeExternalToolStatus(message.body, EMBEDDED_MEDIA_TOOLS_GUIDANCE);
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'mediaMetadataReady') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    state.mediaMetadata = {
      detail: message.body?.metadata ?? null,
      loadToken,
      message: '',
      status: 'ready',
      summary: message.body?.metadata?.summary ?? null,
    };
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'mediaMetadataError') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    state.mediaMetadata = {
      detail: null,
      loadToken,
      message: message.body?.message || 'Metadata unavailable.',
      status: 'error',
      summary: null,
    };
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'decodeFallbackReady') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    acceptDecodeFallbackResult(loadToken, message.body);
    return;
  }

  if (message?.type === 'decodeFallbackError') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    rejectDecodeFallbackRequest(loadToken, message.body?.message || 'ffmpeg decode failed.');
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'loudnessSummaryReady') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    setReadyLoudnessSummary(message.body);
    return;
  }

  if (message?.type === 'loudnessSummaryError') {
    const loadToken = Number(message.body?.loadToken) || 0;
    if (loadToken !== state.loadToken) {
      return;
    }
    setLoudnessSummaryUnavailable(message.body?.message ?? 'Failed to measure loudness summary.');
    return;
  }
});

function attachUiEvents(): void {
  ensureWaveformSampleMarkerElement();
  const waveFollowToggle = elements.waveFollow.closest<HTMLElement>('.wave-follow-toggle');
  const nonFocusableClickControls = [
    elements.mediaMetadataSummary,
    elements.seekBackward,
    elements.playToggle,
    elements.seekForward,
    elements.playbackRateButton,
    elements.waveZoomOut,
    elements.waveZoomReset,
    elements.waveZoomIn,
    elements.waveFollow,
    waveFollowToggle,
    elements.waveClearLoop,
    elements.spectrogramMetaToggle,
    elements.spectrogramResetTypeButton,
  ];

  for (const control of nonFocusableClickControls) {
    control?.addEventListener('pointerdown', preventPointerFocus);
  }

  elements.mediaMetadataPanel.addEventListener('mouseenter', () => setMediaMetadataDetailOpen(true));
  elements.mediaMetadataPanel.addEventListener('mouseleave', () => setMediaMetadataDetailOpen(false));
  elements.mediaMetadataPanel.addEventListener('focusin', () => setMediaMetadataDetailOpen(true));
  elements.mediaMetadataPanel.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && elements.mediaMetadataPanel.contains(event.relatedTarget)) {
      return;
    }
    setMediaMetadataDetailOpen(false);
  });
  elements.mediaMetadataDetail.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const link = target.closest('[data-external-url]');
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }
    const url = link.dataset.externalUrl;
    if (!url) {
      return;
    }
    event.preventDefault();
    vscode.postMessage({
      type: 'openExternal',
      body: { url },
    });
  });

  elements.waveToolbar.addEventListener('scroll', () => {
    updateMediaMetadataDetailPosition();
  }, { passive: true });

  window.addEventListener('resize', () => {
    updateMediaMetadataDetailPosition();
    closePlaybackRateMenu();
    positionPlaybackRateMenu();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!isPlaybackRateUiTarget(event.target)) {
      closePlaybackRateMenu();
    }
  }, true);

  document.addEventListener('focusin', (event) => {
    if (!isPlaybackRateUiTarget(event.target)) {
      closePlaybackRateMenu();
    }
  });

  const handleGlobalShortcut = (event: KeyboardEvent, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  const handleGlobalShortcutKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) {
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || isTextEditableTarget(event.target)) {
      return;
    }

    if (event.code === 'Space') {
      handleGlobalShortcut(event, () => {
        void togglePlayback();
      });
      return;
    }

    if (event.code === 'ArrowLeft') {
      handleGlobalShortcut(event, () => {
        seekBy(-5);
      });
      return;
    }

    if (event.code === 'ArrowRight') {
      handleGlobalShortcut(event, () => {
        seekBy(5);
      });
      return;
    }

    if (event.code === 'ArrowUp') {
      handleGlobalShortcut(event, () => {
        stepPlaybackRateSelection(1);
      });
      return;
    }

    if (event.code === 'ArrowDown') {
      handleGlobalShortcut(event, () => {
        stepPlaybackRateSelection(-1);
      });
      return;
    }

    if (event.code === 'KeyF' && !event.repeat) {
      handleGlobalShortcut(event, () => {
        sendViewportIntent({
          enabled: !state.followPlayback,
          kind: 'setFollow',
        });
      });
      return;
    }

    if (event.code === 'Minus') {
      handleGlobalShortcut(event, () => {
        sendViewportIntent({ direction: 'out', kind: 'zoomStep' });
      });
      return;
    }

    if (event.code === 'Equal') {
      handleGlobalShortcut(event, () => {
        sendViewportIntent({ direction: 'in', kind: 'zoomStep' });
      });
    }
  };

  window.addEventListener('keydown', handleGlobalShortcutKeydown, { capture: true });

  elements.spectrogramTypeSelect.addEventListener('change', () => {
    const previousAnalysisType = normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType);
    const previousDefaults = getDefaultSpectrogramDbWindow(previousAnalysisType);
    const previousWindow = normalizeSpectrogramDbWindow(
      state.spectrogramConfig.minDecibels,
      state.spectrogramConfig.maxDecibels,
      previousAnalysisType,
    );
    const nextAnalysisType = normalizeSpectrogramAnalysisType(elements.spectrogramTypeSelect.value);
    state.spectrogramConfig.analysisType = nextAnalysisType;

    if (
      previousWindow.minDecibels === previousDefaults.minDecibels
      && previousWindow.maxDecibels === previousDefaults.maxDecibels
    ) {
      const nextDefaults = getDefaultSpectrogramDbWindow(nextAnalysisType);
      state.spectrogramConfig.minDecibels = nextDefaults.minDecibels;
      state.spectrogramConfig.maxDecibels = nextDefaults.maxDecibels;
    }

    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramFftSelect.addEventListener('change', () => {
    state.spectrogramConfig.fftSize = normalizeSpectrogramFftSize(elements.spectrogramFftSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramOverlapSelect.addEventListener('change', () => {
    state.spectrogramConfig.overlapRatio = normalizeSpectrogramOverlapRatio(elements.spectrogramOverlapSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramWindowSelect.addEventListener('change', () => {
    state.spectrogramConfig.windowFunction = normalizeSpectrogramWindowFunction(elements.spectrogramWindowSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramResetTypeButton.addEventListener('click', () => {
    resetCurrentSpectrogramTypeToDefaults();
  });
  elements.spectrogramMelBandsSelect.addEventListener('change', () => {
    state.spectrogramConfig.melBandCount = normalizeSpectrogramMelBandCount(elements.spectrogramMelBandsSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramMfccCoefficientsSelect.addEventListener('change', () => {
    state.spectrogramConfig.mfccCoefficientCount = normalizeSpectrogramMfccCoefficientCount(
      elements.spectrogramMfccCoefficientsSelect.value,
    );
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramMfccMelBandsSelect.addEventListener('change', () => {
    state.spectrogramConfig.mfccMelBandCount = normalizeSpectrogramMfccMelBandCount(
      elements.spectrogramMfccMelBandsSelect.value,
    );
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramScalogramOmegaSlider.addEventListener('input', () => {
    elements.spectrogramScalogramOmegaValue.textContent = String(
      getSpectrogramScalogramOmega0FromSlider(elements.spectrogramScalogramOmegaSlider.value),
    );
  });
  elements.spectrogramScalogramOmegaSlider.addEventListener('change', () => {
    state.spectrogramConfig.scalogramOmega0 = getSpectrogramScalogramOmega0FromSlider(
      elements.spectrogramScalogramOmegaSlider.value,
    );
    elements.spectrogramScalogramOmegaValue.textContent = String(state.spectrogramConfig.scalogramOmega0);
    scheduleSpectrogramConfigRefresh();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramScalogramHopSelect.addEventListener('change', () => {
    state.spectrogramConfig.scalogramHopSamples = normalizeSpectrogramScalogramHopSetting(
      elements.spectrogramScalogramHopSelect.value,
    );
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramScaleSelect.addEventListener('change', () => {
    state.spectrogramConfig.frequencyScale = normalizeSpectrogramFrequencyScale(elements.spectrogramScaleSelect.value);
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramDistributionSelect.addEventListener('change', () => {
    state.spectrogramConfig.colormapDistribution = normalizeSpectrogramColormapDistribution(
      elements.spectrogramDistributionSelect.value,
    );
    refreshSpectrogramAnalysisConfig();
    scheduleKeyboardSurfaceFocus();
  });
  elements.spectrogramMeta.addEventListener('dragstart', (event) => {
    event.preventDefault();
  });
  elements.spectrogramMinDbSlider.addEventListener('input', () => {
    const dbWindow = normalizeSpectrogramDbWindow(
      elements.spectrogramMinDbSlider.value,
      state.spectrogramConfig.maxDecibels,
      normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType),
    );
    state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
    state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
    renderSpectrogramDbWindowUi(dbWindow);
    scheduleSpectrogramConfigRefresh();
  });
  elements.spectrogramMaxDbSlider.addEventListener('input', () => {
    const dbWindow = normalizeSpectrogramDbWindow(
      state.spectrogramConfig.minDecibels,
      elements.spectrogramMaxDbSlider.value,
      normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType),
    );
    state.spectrogramConfig.minDecibels = dbWindow.minDecibels;
    state.spectrogramConfig.maxDecibels = dbWindow.maxDecibels;
    renderSpectrogramDbWindowUi(dbWindow);
    scheduleSpectrogramConfigRefresh();
  });
  elements.spectrogramMetaToggle.addEventListener('click', () => {
    setSpectrogramMetaOpen(!state.spectrogramMetaOpen);
    if (!state.spectrogramMetaOpen) {
      scheduleKeyboardSurfaceFocus();
    }
  });

  elements.seekBackward.addEventListener('click', () => seekBy(-5));
  elements.seekForward.addEventListener('click', () => seekBy(5));
  elements.playToggle.addEventListener('click', () => { void togglePlayback(); });
  elements.playbackRateButton.addEventListener('click', () => {
    if (state.playbackRateMenuOpen) {
      closePlaybackRateMenu();
      scheduleKeyboardSurfaceFocus();
      return;
    }

    openPlaybackRateMenu({ focusSelected: false });
  });
  elements.playbackRateButton.addEventListener('keydown', (event) => {
    if (event.code === 'ArrowDown' || event.code === 'Enter' || event.code === 'Space') {
      event.preventDefault();
      openPlaybackRateMenu();
      return;
    }
    if (event.code === 'ArrowUp') {
      event.preventDefault();
      openPlaybackRateMenu();
      const buttons = getPlaybackRateOptionButtons();
      focusPlaybackRateOption(Math.max(0, buttons.length - 1));
      return;
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      closePlaybackRateMenu();
    }
  });
  elements.playbackRateMenu.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      closePlaybackRateMenu({ restoreFocus: true });
      return;
    }
    if (event.code === 'ArrowDown') {
      event.preventDefault();
      movePlaybackRateFocus(1);
      return;
    }
    if (event.code === 'ArrowUp') {
      event.preventDefault();
      movePlaybackRateFocus(-1);
    }
  });
  elements.playbackRateSelect.addEventListener('change', () => {
    state.playbackRate = normalizePlaybackRateSelection(elements.playbackRateSelect.value);
    state.audioTransport?.setPlaybackRate(state.playbackRate);
    renderMediaMetadata();
    syncTransport();
    scheduleKeyboardSurfaceFocus();
  });

  elements.timeline.addEventListener('input', () => {
    if (!state.audioTransport || getDurationFrames() <= 0) {
      return;
    }
    setPlaybackPositionFromFrame(Math.round(Number(elements.timeline.value) * getDurationFrames()));
  });
  elements.timeline.addEventListener('pointerup', () => {
    scheduleKeyboardSurfaceFocus();
  });

  elements.waveformOverview.addEventListener('pointermove', updateTimelineHoverTooltip);
  elements.waveformOverview.addEventListener('pointerleave', hideTimelineHoverTooltip);
  elements.waveformOverview.addEventListener('pointercancel', hideTimelineHoverTooltip);

  elements.waveZoomOut.addEventListener('click', () => sendViewportIntent({ direction: 'out', kind: 'zoomStep' }));
  elements.waveZoomReset.addEventListener('click', () => sendViewportIntent({ kind: 'resetZoom' }));
  elements.waveZoomIn.addEventListener('click', () => sendViewportIntent({ direction: 'in', kind: 'zoomStep' }));
  elements.waveFollow.addEventListener('change', () => {
    sendViewportIntent({
      enabled: elements.waveFollow.checked,
      kind: 'setFollow',
    });
  });
  elements.waveClearLoop.addEventListener('click', () => {
    sendViewportIntent({ kind: 'clearLoop' });
  });

  elements.waveformViewport.addEventListener('wheel', (event) => handleViewportWheel(event, 'waveform', elements.waveformViewport), { passive: false });
  elements.spectrogramHitTarget.addEventListener('wheel', (event) => handleViewportWheel(event, 'spectrogram', elements.spectrogramHitTarget), { passive: false });

  elements.waveformHitTarget.addEventListener('pointerdown', (event) => beginSelectionDrag(event, elements.waveformHitTarget, 'waveform'));
  elements.waveformHitTarget.addEventListener('pointermove', (event) => {
    requestSampleInfo('waveform', event);
    updateSelectionDrag(event, elements.waveformHitTarget, 'waveform');
  });
  elements.waveformHitTarget.addEventListener('pointerleave', hideWaveformHoverTooltip);
  elements.waveformHitTarget.addEventListener('pointerup', (event) => releaseSelectionDrag(event, elements.waveformHitTarget, 'waveform'));
  elements.waveformHitTarget.addEventListener('pointercancel', (event) => {
    hideWaveformHoverTooltip();
    releaseSelectionDrag(event, elements.waveformHitTarget, 'waveform', true);
  });

  elements.spectrogramHitTarget.addEventListener('pointerdown', (event) => beginSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram'));
  elements.spectrogramHitTarget.addEventListener('pointermove', (event) => {
    requestSampleInfo('spectrogram', event);
    updateSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram');
  });
  elements.spectrogramHitTarget.addEventListener('pointerleave', hideSpectrogramHoverTooltip);
  elements.spectrogramHitTarget.addEventListener('pointerup', (event) => releaseSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram'));
  elements.spectrogramHitTarget.addEventListener('pointercancel', (event) => {
    hideSpectrogramHoverTooltip();
    releaseSelectionDrag(event, elements.spectrogramHitTarget, 'spectrogram', true);
  });
  elements.spectrogramHitTarget.addEventListener('dblclick', () => { void togglePlayback(); });

  bindLoopHandle(elements.waveformLoopStart, 'start', elements.waveformHitTarget, 'waveform');
  bindLoopHandle(elements.waveformLoopEnd, 'end', elements.waveformHitTarget, 'waveform');
  bindLoopHandle(elements.spectrogramLoopStart, 'start', elements.spectrogramHitTarget, 'spectrogram');
  bindLoopHandle(elements.spectrogramLoopEnd, 'end', elements.spectrogramHitTarget, 'spectrogram');

  elements.viewportSplitter.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    elements.viewportSplitter.setPointerCapture(event.pointerId);
    state.viewportResizeDrag = { pointerId: event.pointerId };
    updateViewportSplitRatioFromClientY(event.clientY);
  });
  elements.viewportSplitter.addEventListener('pointermove', (event) => {
    if (!state.viewportResizeDrag || state.viewportResizeDrag.pointerId !== event.pointerId) {
      return;
    }
    updateViewportSplitRatioFromClientY(event.clientY);
  });
  elements.viewportSplitter.addEventListener('pointerup', (event) => {
    if (!state.viewportResizeDrag || state.viewportResizeDrag.pointerId !== event.pointerId) {
      return;
    }
    if (elements.viewportSplitter.hasPointerCapture?.(event.pointerId)) {
      elements.viewportSplitter.releasePointerCapture(event.pointerId);
    }
    state.viewportResizeDrag = null;
    updateViewportSplitRatioFromClientY(event.clientY);
  });
  elements.viewportSplitter.addEventListener('pointercancel', (event) => {
    if (!state.viewportResizeDrag || state.viewportResizeDrag.pointerId !== event.pointerId) {
      return;
    }
    state.viewportResizeDrag = null;
  });
  elements.viewportSplitter.addEventListener('dblclick', () => {
    state.viewportSplitRatio = DEFAULT_VIEWPORT_SPLIT_RATIO;
    applyViewportSplit(true);
  });
  elements.viewportSplitter.addEventListener('keydown', (event) => {
    let nextRatio: number | null = null;
    if (event.key === 'ArrowUp') {
      nextRatio = state.viewportSplitRatio - VIEWPORT_SPLIT_STEP;
    } else if (event.key === 'ArrowDown') {
      nextRatio = state.viewportSplitRatio + VIEWPORT_SPLIT_STEP;
    } else if (event.key === 'Home') {
      nextRatio = VIEWPORT_RATIO_MIN;
    } else if (event.key === 'End') {
      nextRatio = VIEWPORT_RATIO_MAX;
    } else if (event.key === 'Enter' || event.key === ' ') {
      nextRatio = DEFAULT_VIEWPORT_SPLIT_RATIO;
    }

    if (nextRatio === null) {
      return;
    }
    event.preventDefault();
    state.viewportSplitRatio = clamp(nextRatio, VIEWPORT_RATIO_MIN, VIEWPORT_RATIO_MAX);
    applyViewportSplit(true);
  });
}

if (
  typeof OffscreenCanvas !== 'function'
  || typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function'
) {
  setFatalStatus('OffscreenCanvas is required for audioscope.');
} else {
  initializePlaybackRateControl();
  initializeKeyboardSurfaceFocus();
  attachUiEvents();
  attachResizeObservers();
  applyViewportSplit(true);
  renderWaveformUi();
  renderSpectrogramMeta();
  renderSpectrogramScale();
  renderLoudnessSummary();
  renderMediaMetadata();
  syncMediaMetadataDetailVisibility();
  vscode.postMessage({ type: 'ready' });
}
