import { DISPLAY_MIN_DPR } from '../sharedBuffers';
import { createAudioTransport, type AudioTransport, type PlaybackClockSnapshot, type PlaybackSession } from '../audioTransport';
import { createAudioscopeElements } from './core/elements';
import { clamp, formatAxisLabel, formatTime } from './core/format';
import {
  createAudioscopeMediaController,
  createExternalToolStatusState,
  createLoudnessSummaryState,
  createMediaMetadataState,
  normalizeExternalToolStatus,
} from './controllers/media';
import {
  createPlaybackAnalysisData,
  createPlaybackAnalysisDataFromPlaybackSession,
  createPlaybackSessionFromPcmFallback,
} from './controllers/playbackData';
import {
  createAudioscopePlaybackRateController,
  normalizePlaybackRateSelection,
} from './controllers/playbackRate';
import { createAudioscopeLoadController } from './controllers/load';
import type {
  AnalysisRenderBackend,
  AnalysisSurfaceResetReason,
  EngineWorkerToMainMessage,
  PlaybackClockState,
  SampleInfoPayload,
  SetViewportIntentMessage,
  SpectrogramAnalysisType,
  SpectrogramColormapDistribution,
  SpectrogramFrequencyScale,
  SurfaceKind,
  TransportCommand,
  ViewportUiState,
} from '../audioEngineProtocol';

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
const SPECTROGRAM_OVERLAP_OPTIONS = [0.5, 0.75, 0.875, 0.9375];
const SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.2;
const SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR = 2.5;
const SPECTROGRAM_OVERVIEW_HEIGHT_SCALE = 0.7;
const SPECTROGRAM_OVERVIEW_WIDTH_SCALE = 0.45;
const SPECTROGRAM_RANGE_EPSILON_SECONDS = 1 / 2000;
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
    minDecibels: -80,
    overlapRatio: 0.75,
  },
  spectrogramFrame: 0,
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

function ensureKeyboardSurfaceTarget(): void {
  if (document.body.tabIndex !== -1) {
    document.body.tabIndex = -1;
  }
}

function focusKeyboardSurface(): void {
  if (document.visibilityState !== 'visible') {
    return;
  }

  ensureKeyboardSurfaceTarget();
  window.focus();

  if (document.activeElement !== document.body) {
    document.body.focus({ preventScroll: true });
  }
}

function scheduleKeyboardSurfaceFocus(): void {
  queueMicrotask(() => {
    window.requestAnimationFrame(() => {
      focusKeyboardSurface();
    });
  });
}

function initializeKeyboardSurfaceFocus(): void {
  ensureKeyboardSurfaceTarget();
  scheduleKeyboardSurfaceFocus();
  window.setTimeout(() => {
    focusKeyboardSurface();
  }, 120);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleKeyboardSurfaceFocus();
    }
  });
}

function isTextEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }

  const field = target.closest('input, textarea');

  if (field instanceof HTMLTextAreaElement) {
    return true;
  }

  if (!(field instanceof HTMLInputElement)) {
    return false;
  }

  const inputType = field.type.toLowerCase();

  return inputType === 'email'
    || inputType === 'number'
    || inputType === 'password'
    || inputType === 'search'
    || inputType === 'tel'
    || inputType === 'text'
    || inputType === 'url';
}

function preventPointerFocus(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }

  event.preventDefault();
}

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
  syncPlaybackRateControl,
} = createAudioscopePlaybackRateController({
  elements,
  scheduleKeyboardSurfaceFocus,
  state,
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
  return value === 'mel' || value === 'mfcc' || value === 'scalogram' ? value : 'spectrogram';
}

function normalizeSpectrogramColormapDistribution(value: unknown): SpectrogramColormapDistribution {
  return value === 'contrast' || value === 'soft' ? value : 'balanced';
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

function normalizeSpectrogramMfccCoefficientCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MFCC_COEFFICIENT_OPTIONS.includes(numericValue) ? numericValue : 20;
}

function normalizeSpectrogramMfccMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return SPECTROGRAM_MEL_BAND_OPTIONS.includes(numericValue) ? numericValue : 128;
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

function secondsToFrame(timeSeconds: number): number {
  const sampleRate = getSampleRate();
  return sampleRate > 0
    ? clamp(Math.round(timeSeconds * sampleRate), 0, getDurationFrames())
    : 0;
}

function createModuleWorker(
  moduleUrl: string,
  bootstrapStateKey: 'analysisWorkerBootstrapUrl' | 'decodeWorkerBootstrapUrl' | 'engineWorkerBootstrapUrl',
): Worker {
  const bootstrapSource = `import ${JSON.stringify(moduleUrl)};`;
  const bootstrapBlob = new Blob([bootstrapSource], { type: 'text/javascript' });
  const bootstrapUrl = URL.createObjectURL(bootstrapBlob);
  state[bootstrapStateKey] = bootstrapUrl;
  return new Worker(bootstrapUrl, { type: 'module' });
}

function disposeEngineWorker(): void {
  if (state.engineWorker) {
    state.engineWorker.terminate();
    state.engineWorker = null;
  }

  if (state.engineWorkerBootstrapUrl) {
    URL.revokeObjectURL(state.engineWorkerBootstrapUrl);
    state.engineWorkerBootstrapUrl = null;
  }
}

function disposeAnalysisWorker(): void {
  if (state.analysisWorker) {
    state.analysisWorker.postMessage({ type: 'disposeSession' });
    state.analysisWorker.terminate();
    state.analysisWorker = null;
  }

  state.analysisRuntimeReadyPromise = null;
  state.resolveAnalysisRuntimeReady = null;
  state.analysis = null;
  state.spectrogramSurfaceResetPromise = null;
  window.cancelAnimationFrame(state.spectrogramFrame);
  state.spectrogramFrame = 0;
  state.spectrogramRenderForcePending = false;

  if (state.analysisWorkerBootstrapUrl) {
    URL.revokeObjectURL(state.analysisWorkerBootstrapUrl);
    state.analysisWorkerBootstrapUrl = null;
  }
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
    minFrequency: 50,
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

function destroySession(): void {
  window.cancelAnimationFrame(state.playbackFrame);
  state.playbackFrame = 0;
  window.cancelAnimationFrame(state.spectrogramFrame);
  state.spectrogramFrame = 0;
  state.spectrogramRenderForcePending = false;
  state.selectionDrag = null;
  state.loopHandleDrag = null;
  state.engineUiState = null;
  state.hoverState.waveform = null;
  state.hoverState.spectrogram = null;
  state.lastAppliedTransportCommandSerial = 0;
  hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
  hideSurfaceHoverTooltip(elements.spectrogramHoverTooltip);
  hideWaveformSampleMarker();
  disposeAnalysisWorker();
  disposeEngineWorker();
  const audioTransport = state.audioTransport;
  state.audioTransport = null;
  void audioTransport?.dispose();
  state.playbackSession = null;
  state.waveformCanvas = null;
  state.spectrogramCanvas = null;
  state.engineSurfacesPosted = false;
  state.waveformViewport = createInitialWaveformViewportState();
  state.followPlayback = false;
  renderWaveformUi();
  renderSpectrogramScale();
  renderSpectrogramMeta();
}

function createPlaybackTransport(loadToken: number): AudioTransport {
  let transport: AudioTransport | null = null;

  transport = createAudioTransport({
    onStateChange: () => {
      if (state.loadToken !== loadToken || state.audioTransport !== transport) {
        return;
      }

      state.playbackTransportKind = transport.getTransportKind();
      state.playbackTransportError = transport.getLastFallbackReason();
      renderMediaMetadata();

      if (transport.isPlaying()) {
        startPlaybackLoop();
        return;
      }

      syncTransport();
    },
    stretchModuleUrl: stretchProcessorScriptUri,
    workletModuleUrl: audioTransportProcessorScriptUri,
  });

  state.playbackTransportKind = transport.getTransportKind();
  state.playbackTransportError = transport.getLastFallbackReason();
  transport.setPlaybackRate(state.playbackRate);
  return transport;
}

function getPlaybackClockState(): PlaybackClockSnapshot | null {
  return state.audioTransport?.getPlaybackClockState() ?? null;
}

function toWorkerClockState(clock: PlaybackClockSnapshot | null): PlaybackClockState {
  return clock
    ? {
      currentFrameFloat: clock.currentFrameFloat,
      durationFrames: clock.durationFrames,
      loopEndFrame: clock.loopEndFrame,
      loopStartFrame: clock.loopStartFrame,
      playing: clock.playing,
      sampleRate: clock.sampleRate,
    }
    : {
      currentFrameFloat: 0,
      durationFrames: getDurationFrames(),
      loopEndFrame: null,
      loopStartFrame: null,
      playing: false,
      sampleRate: getSampleRate(),
    };
}

function hasPlaybackTransport(): boolean {
  return Boolean(state.audioTransport)
    && (state.playbackTransportKind === 'audio-worklet-copy' || state.playbackTransportKind === 'audio-worklet-stretch')
    && getEffectiveDurationSeconds() > 0;
}

function startPlaybackLoop(): void {
  window.cancelAnimationFrame(state.playbackFrame);
  state.playbackFrame = window.requestAnimationFrame(() => {
    state.playbackFrame = 0;
    syncTransport();
  });
}

function syncTransport(): void {
  const clock = getPlaybackClockState();
  const durationSeconds = getEffectiveDurationSeconds();
  const currentTime = clock && clock.sampleRate > 0
    ? frameToSeconds(Math.round(clock.currentFrameFloat))
    : 0;

  elements.playToggle.disabled = !hasPlaybackTransport();
  elements.playToggle.textContent = state.audioTransport?.isPlaying() ? 'Pause' : 'Play';
  elements.seekBackward.disabled = !hasPlaybackTransport();
  elements.seekForward.disabled = !hasPlaybackTransport();
  elements.playbackRateSelect.disabled = !state.audioTransport;
  elements.playbackRateSelect.value = String(state.playbackRate);
  elements.timeReadout.textContent = `${formatTime(currentTime)} / ${formatTime(durationSeconds)}`;
  syncPlaybackRateControl();

  if (state.engineWorker) {
    state.engineWorker.postMessage({
      type: 'PlaybackClockTick',
      body: toWorkerClockState(clock),
    });
  }

  if (state.audioTransport?.isPlaying()) {
    startPlaybackLoop();
  }
}

function setPlaybackPositionFromFrame(frame: number): void {
  if (!state.audioTransport) {
    return;
  }

  state.audioTransport.seek(frameToSeconds(frame));
  syncTransport();
}

function seekBy(deltaSeconds: number): void {
  if (!state.audioTransport || !Number.isFinite(deltaSeconds)) {
    return;
  }
  const currentTime = state.audioTransport.getCurrentTime();
  state.audioTransport.seek(currentTime + deltaSeconds);
  syncTransport();
}

async function togglePlayback(): Promise<void> {
  if (!state.audioTransport) {
    return;
  }

  if (!state.audioTransport.isPlaying()) {
    try {
      await state.audioTransport.play();
    } catch (error) {
      state.playbackTransportError = error instanceof Error ? error.message : String(error);
      renderMediaMetadata();
    }
  } else {
    state.audioTransport.pause();
  }

  syncTransport();
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
  state.engineUiState = uiState;
  state.followPlayback = uiState.viewport.followEnabled;
  elements.waveFollow.checked = uiState.viewport.followEnabled;
  const sampleRate = uiState.playback.sampleRate || getSampleRate();

  if (sampleRate > 0) {
    state.waveformViewport.presentedRange = {
      start: uiState.presentedStartFrame / sampleRate,
      end: uiState.presentedEndFrame / sampleRate,
    };
    state.waveformViewport.targetRange = {
      start: uiState.viewport.targetStartFrame / sampleRate,
      end: uiState.viewport.targetEndFrame / sampleRate,
    };
  }

  renderWaveformUi();
  renderSpectrogramScale();
  syncPresentedSpectrogramRange(getPresentedRangeSeconds());
  scheduleSpectrogramRender();
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
  const supportsScale = analysisType === 'spectrogram';
  const supportsMelBands = analysisType === 'mel';
  const supportsMfccOptions = analysisType === 'mfcc';
  const supportsDbWindow = analysisType !== 'mfcc';
  const isScalogram = analysisType === 'scalogram';
  const dbWindow = normalizeSpectrogramDbWindow(
    state.spectrogramConfig.minDecibels,
    state.spectrogramConfig.maxDecibels,
    analysisType,
  );

  elements.spectrogramTypeSelect.value = analysisType;
  elements.spectrogramFftSelect.value = String(state.spectrogramConfig.fftSize);
  elements.spectrogramOverlapSelect.value = String(state.spectrogramConfig.overlapRatio);
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
  elements.spectrogramDistributionSelect.value = normalizeSpectrogramColormapDistribution(
    state.spectrogramConfig.colormapDistribution,
  );

  elements.spectrogramFftControl.hidden = isScalogram;
  elements.spectrogramOverlapControl.hidden = isScalogram;
  elements.spectrogramScaleControl.hidden = !supportsScale;
  elements.spectrogramMelBandsControl.hidden = !supportsMelBands;
  elements.spectrogramMfccCoefficientsControl.hidden = !supportsMfccOptions;
  elements.spectrogramMfccMelBandsControl.hidden = !supportsMfccOptions;
  elements.spectrogramDbRangeControl.hidden = !supportsDbWindow;
  elements.spectrogramFftSelect.disabled = isScalogram;
  elements.spectrogramOverlapSelect.disabled = isScalogram;
  elements.spectrogramScaleSelect.disabled = !supportsScale;
  elements.spectrogramMelBandsSelect.disabled = !supportsMelBands;
  elements.spectrogramMfccCoefficientsSelect.disabled = !supportsMfccOptions;
  elements.spectrogramMfccMelBandsSelect.disabled = !supportsMfccOptions;
  elements.spectrogramMinDbSlider.disabled = !supportsDbWindow;
  elements.spectrogramMaxDbSlider.disabled = !supportsDbWindow;
  elements.spectrogramMinDbSlider.value = String(dbWindow.minDecibels);
  elements.spectrogramMaxDbSlider.value = String(dbWindow.maxDecibels);
  const rangeStartPercent = ((dbWindow.minDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.min)
    / (SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.min)) * 100;
  const rangeEndPercent = ((dbWindow.maxDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.min)
    / (SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.min)) * 100;
  elements.spectrogramDbRangeGroup.style.setProperty('--range-start', `${rangeStartPercent.toFixed(3)}%`);
  elements.spectrogramDbRangeGroup.style.setProperty('--range-end', `${rangeEndPercent.toFixed(3)}%`);
  elements.spectrogramDbRangeValue.textContent = `Min ${dbWindow.minDecibels} / Max ${dbWindow.maxDecibels} dB`;
  setSpectrogramMetaOpen(state.spectrogramMetaOpen);
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
    minDecibels: dbWindow.minDecibels,
    overlapRatio: normalizeSpectrogramOverlapRatio(state.spectrogramConfig.overlapRatio),
  };
}

function getSpectrogramRenderPixelHeight(): number {
  const screenHeight = Number(window.screen?.height);
  const fallbackHeight = Math.max(
    1,
    window.innerHeight || elements.viewport.clientHeight || elements.spectrogram.clientHeight || 1,
  );
  const renderHeight = Number.isFinite(screenHeight) && screenHeight > 0
    ? screenHeight
    : fallbackHeight;

  return Math.max(1, Math.round(renderHeight * DISPLAY_PIXEL_RATIO));
}

function refreshSpectrogramAnalysisConfig(): void {
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

  if (state.analysis.activeVisibleRequest) {
    state.analysis.activeVisibleRequest = {
      ...state.analysis.activeVisibleRequest,
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      pixelHeight,
      pixelWidth,
    };
  }

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

function requestSampleInfo(surface: SurfaceKind, event: PointerEvent): void {
  if (!state.engineWorker) {
    return;
  }

  const target = surface === 'waveform' ? elements.waveformHitTarget : elements.spectrogramHitTarget;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }

  const requestId = state.hoverRequestIds[surface] + 1;
  state.hoverRequestIds[surface] = requestId;
  state.hoverState[surface] = {
    clientX: event.clientX,
    clientY: event.clientY,
    requestId,
  };

  state.engineWorker.postMessage({
    type: 'RequestSampleInfo',
    body: {
      pointerRatioX: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      pointerRatioY: clamp((event.clientY - rect.top) / rect.height, 0, 1),
      requestId,
      surface,
    },
  });
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

function handleViewportWheel(event: WheelEvent, surface: SurfaceKind, target: HTMLElement): void {
  if (!state.engineWorker || getDurationFrames() <= 0) {
    return;
  }
  event.preventDefault();
  const rect = target.getBoundingClientRect();
  sendViewportIntent({
    deltaMode: event.deltaMode,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    kind: 'wheel',
    pointerRatioX: rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5,
    surface,
  });
}

function getNumericStyleSize(element: HTMLElement | null | undefined, propertyName: string, fallback = 0): number {
  if (!element) {
    return fallback;
  }

  const computedValue = Number.parseFloat(window.getComputedStyle(element)[propertyName as any]);
  return Number.isFinite(computedValue) ? computedValue : fallback;
}

function getViewportSplitterSize(): number {
  return Math.max(
    1,
    elements.viewportSplitter?.offsetHeight
      || getNumericStyleSize(elements.viewportSplitter, 'minHeight', VIEWPORT_SPLITTER_FALLBACK_SIZE_PX),
  );
}

function getWavePanelChromeHeight(): number {
  return Math.max(0, elements.waveToolbar?.offsetHeight || 0) + Math.max(0, elements.waveformAxis?.offsetHeight || 0);
}

function applyViewportSplit(force = false): void {
  const splitterSize = getViewportSplitterSize();
  const wavePanelChromeHeight = getWavePanelChromeHeight();
  const availableHeight = Math.max(0, elements.viewport.clientHeight - splitterSize - wavePanelChromeHeight);

  if (availableHeight <= 0) {
    const nextTemplate = `${wavePanelChromeHeight}px ${splitterSize}px 0px`;
    if (force || elements.viewport.style.gridTemplateRows !== nextTemplate) {
      elements.viewport.style.gridTemplateRows = nextTemplate;
    }
    return;
  }

  const desiredWaveHeight = availableHeight * clamp(state.viewportSplitRatio, VIEWPORT_RATIO_MIN, VIEWPORT_RATIO_MAX);
  const waveHeight = Math.round(clamp(desiredWaveHeight, 0, availableHeight));
  const spectrogramHeight = Math.max(0, availableHeight - waveHeight);
  const nextTemplate = `${wavePanelChromeHeight + waveHeight}px ${splitterSize}px ${spectrogramHeight}px`;

  if (!force && elements.viewport.style.gridTemplateRows === nextTemplate) {
    return;
  }

  elements.viewport.style.gridTemplateRows = nextTemplate;
}

function updateViewportSplitRatioFromClientY(clientY: number): void {
  const splitterSize = getViewportSplitterSize();
  const wavePanelChromeHeight = getWavePanelChromeHeight();
  const viewportRect = elements.viewport.getBoundingClientRect();
  const availableHeight = Math.max(0, viewportRect.height - splitterSize - wavePanelChromeHeight);
  if (availableHeight <= 0) {
    return;
  }

  const proposedWaveHeight = clamp(
    clientY - viewportRect.top - wavePanelChromeHeight - splitterSize / 2,
    0,
    availableHeight,
  );
  state.viewportSplitRatio = clamp(proposedWaveHeight / availableHeight, VIEWPORT_RATIO_MIN, VIEWPORT_RATIO_MAX);
  applyViewportSplit(true);
}

function attachResizeObservers(): void {
  const resizeObserver = new ResizeObserver(() => {
    applyViewportSplit();
    const waveformSize = getWaveformViewportSize();
    const spectrogramSize = getSpectrogramCanvasTargetSize();
    const overviewWidth = Math.max(1, elements.waveformOverview.clientWidth);

    const changed =
      state.observedWaveformViewportWidth !== waveformSize.width
      || state.observedWaveformViewportHeight !== waveformSize.height
      || state.observedSpectrogramPixelWidth !== spectrogramSize.pixelWidth
      || state.observedSpectrogramPixelHeight !== spectrogramSize.pixelHeight
      || state.observedOverviewWidth !== overviewWidth;

    if (!changed) {
      return;
    }

    state.observedWaveformViewportWidth = waveformSize.width;
    state.observedWaveformViewportHeight = waveformSize.height;
    state.observedSpectrogramPixelWidth = spectrogramSize.pixelWidth;
    state.observedSpectrogramPixelHeight = spectrogramSize.pixelHeight;
    state.observedOverviewWidth = overviewWidth;

    sendViewportIntent({
      kind: 'resize',
      spectrogramPixelHeight: spectrogramSize.pixelHeight,
      spectrogramPixelWidth: spectrogramSize.pixelWidth,
      waveformHeightCssPx: waveformSize.height,
      waveformRenderScale: DISPLAY_PIXEL_RATIO,
      waveformWidthCssPx: waveformSize.width,
    });

    if (state.analysisWorker) {
      state.analysisWorker.postMessage({
        type: 'resizeCanvas',
        body: {
          pixelHeight: spectrogramSize.pixelHeight,
          pixelWidth: spectrogramSize.pixelWidth,
        },
      });
      scheduleSpectrogramRender({ force: true });
    }
  });

  resizeObserver.observe(document.body);
  resizeObserver.observe(elements.viewport);
  resizeObserver.observe(elements.waveformViewport);
  resizeObserver.observe(elements.waveformOverview);
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
  state.playbackSession = playbackSession;
  state.analysis = createSpectrogramAnalysisState(
    playbackSession.durationSeconds,
    normalizeSpectrogramQuality(payload?.spectrogramQuality),
    monoSamples.length,
    playbackSession.sourceSampleRate,
  );

  await Promise.all([
    state.waveformSurfaceReadyPromise,
    state.spectrogramSurfaceReadyPromise,
  ]);

  const [engineWorker, analysisWorker] = await Promise.all([
    ensureEngineWorker(loadToken),
    ensureAnalysisWorker(loadToken),
  ]);
  if (!engineWorker || !analysisWorker || loadToken !== state.loadToken) {
    return;
  }

  state.engineSessionRevision += 1;
  const engineMono = monoSamples.slice();
  const spectrogramMono = monoSamples.slice();
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

  await state.analysisRuntimeReadyPromise;
  if (loadToken !== state.loadToken) {
    return;
  }

  analysisWorker.postMessage({
    type: 'attachAudioSession',
    body: {
      duration: playbackSession.durationSeconds,
      quality: normalizeSpectrogramQuality(payload?.spectrogramQuality),
      sampleCount: spectrogramMono.length,
      sampleRate: playbackSession.sourceSampleRate,
      samplesBuffer: spectrogramMono.buffer,
      sessionVersion: state.engineSessionRevision,
    },
  }, [spectrogramMono.buffer]);

  await state.audioTransport?.load({
    playbackSession,
    workletModuleUrl: audioTransportProcessorScriptUri,
  });

  state.playbackTransportKind = state.audioTransport?.getTransportKind() ?? 'unavailable';
  state.playbackTransportError = state.audioTransport?.getLastFallbackReason() ?? null;
  renderMediaMetadata();
  renderWaveformUi();
  syncTransport();
  refreshSpectrogramAnalysisConfig();
  scheduleSpectrogramRender({ force: true });
  setAnalysisStatus('Playback ready');
}

const {
  acceptDecodeFallbackResult,
  disposeDecodeWorker,
  handleDecodeWorkerMessage,
  loadAudioFile,
  rejectDecodeFallbackRequest,
} = createAudioscopeLoadController({
  audioTransportProcessorScriptUri,
  createModuleWorker,
  createPlaybackAnalysisData,
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

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) {
      return;
    }

    if (event.code === 'Space' && !isTextEditableTarget(event.target)) {
      event.preventDefault();
      void togglePlayback();
      return;
    }

    if (event.target instanceof HTMLElement && event.target.closest('input, select, button, textarea, [contenteditable="true"]')) {
      return;
    }

    if (event.code === 'ArrowLeft') {
      event.preventDefault();
      seekBy(-5);
      return;
    }

    if (event.code === 'ArrowRight') {
      event.preventDefault();
      seekBy(5);
      return;
    }

    if (event.code === 'KeyF' && !event.repeat) {
      event.preventDefault();
      sendViewportIntent({
        enabled: !state.followPlayback,
        kind: 'setFollow',
      });
      return;
    }

    if (event.code === 'Minus') {
      event.preventDefault();
      sendViewportIntent({ direction: 'out', kind: 'zoomStep' });
      return;
    }

    if (event.code === 'Equal') {
      event.preventDefault();
      sendViewportIntent({ direction: 'in', kind: 'zoomStep' });
    }
  }, { capture: true });

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
  elements.spectrogramMinDbSlider.addEventListener('input', () => {
    const window = normalizeSpectrogramDbWindow(
      elements.spectrogramMinDbSlider.value,
      state.spectrogramConfig.maxDecibels,
      normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType),
    );
    state.spectrogramConfig.minDecibels = window.minDecibels;
    state.spectrogramConfig.maxDecibels = window.maxDecibels;
    refreshSpectrogramAnalysisConfig();
  });
  elements.spectrogramMaxDbSlider.addEventListener('input', () => {
    const window = normalizeSpectrogramDbWindow(
      state.spectrogramConfig.minDecibels,
      elements.spectrogramMaxDbSlider.value,
      normalizeSpectrogramAnalysisType(state.spectrogramConfig.analysisType),
    );
    state.spectrogramConfig.minDecibels = window.minDecibels;
    state.spectrogramConfig.maxDecibels = window.maxDecibels;
    refreshSpectrogramAnalysisConfig();
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
