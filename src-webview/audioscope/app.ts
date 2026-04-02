import {
  DISPLAY_MIN_DPR,
  TILE_COLUMN_COUNT,
} from '../sharedBuffers';
import type { PlaybackSession } from '../audioTransport';
import {
  createWaveDisplayPlanner,
  loadWaveCoreRuntime,
  type WaveDisplayPlanner,
} from '../waveCoreRuntime';
import { createAudioscopeElements } from './core/elements';
import { clamp, formatAxisLabel } from './core/format';
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
import { createAudioscopeBindingsController } from './controllers/bindings';
import { createAudioscopeLifecycleController } from './controllers/lifecycle';
import { createAudioscopeLoadController } from './controllers/load';
import { createAudioscopeTransportLoopController } from './controllers/transportLoop';
import { createAudioscopeViewportController } from './controllers/viewport';
import { createTimelineViewportSnapshot } from './math/timelineMath';
import {
  buildLinearFrequencyTicks as buildLinearFrequencyTicksPure,
  formatFrequencyLabel,
  getFrequencyAtLinearPosition,
  getFrequencyAtLogPosition,
  getFrequencyAtMelPosition,
  getLinearFrequencyPosition,
  getLogFrequencyPosition,
  getMelFrequencyPosition,
} from './math/spectrogramMath';
import {
  centerWaveformRangeOnTime as centerWaveformRangeOnTimePure,
  cloneTimeRange,
  createWaveformAxisSnapshot as createWaveformAxisSnapshotPure,
  expandWaveformRange as expandWaveformRangePure,
  getWaveformDisplayWindowMetrics as getWaveformDisplayWindowMetricsPure,
  isRangeBuffered as isRangeBufferedPure,
  normalizeWaveformRange as normalizeWaveformRangePure,
  quantizeWaveformCssOffset as quantizeWaveformCssOffsetPure,
  snapWaveformRenderRange as snapWaveformRenderRangePure,
} from './math/waveformMath';
import type {
  TimelineViewportSnapshot,
  TimeRange,
  WaveformAxisRenderOptions,
  WaveformAxisSnapshot,
  WaveformDisplaySnapshot,
  WaveformDisplayWindowMetrics,
  WaveformRenderRequest,
} from './core/types';

const vscode = acquireVsCodeApi();
const analysisWorkerScriptUri = document.body.dataset.workerSrc;
const decodeBrowserModuleScriptUri = document.body.dataset.decodeModuleSrc;
const decodeBrowserModuleWasmUri = document.body.dataset.decodeModuleWasmSrc;
const decodeWorkerScriptUri = document.body.dataset.decodeWorkerSrc;
const waveformWorkerScriptUri = document.body.dataset.waveformWorkerSrc;
const audioTransportProcessorScriptUri = document.body.dataset.audioTransportProcessorSrc;
const stretchProcessorScriptUri = document.body.dataset.stretchProcessorSrc;
const DISPLAY_PIXEL_RATIO = Math.max(window.devicePixelRatio || 1, DISPLAY_MIN_DPR);

const SPECTROGRAM_MIN_FREQUENCY = 20;
const SPECTROGRAM_MAX_FREQUENCY = 20000;
const SPECTROGRAM_TICKS = [20000, 16000, 12000, 8000, 4000, 2000, 1000, 400, 100, 40, 20];
const SPECTROGRAM_LINEAR_TICK_COUNT = 6;
const SPECTROGRAM_OVERVIEW_WIDTH_SCALE = 0.45;
const SPECTROGRAM_OVERVIEW_HEIGHT_SCALE = 0.7;
const SPECTROGRAM_RANGE_EPSILON_SECONDS = 1 / 2000;
const SPECTROGRAM_ROW_BUCKET_SIZE = 32;
const DEFAULT_VIEWPORT_SPLIT_RATIO = 0.5;
const VIEWPORT_SPLIT_STEP = 0.05;
const VIEWPORT_SPLITTER_FALLBACK_SIZE_PX = 12;
const VIEWPORT_RATIO_MIN = 0;
const VIEWPORT_RATIO_MAX = 1;
const EMBEDDED_MEDIA_TOOLS_GUIDANCE = 'audioscope media tools are unavailable. Rebuild or reinstall audioscope to restore metadata and decoding.';

const WAVEFORM_COLOR = '#8ccadd';
const WAVEFORM_RENDER_SCALE = DISPLAY_PIXEL_RATIO;
const WAVEFORM_ZOOM_STEP_FACTOR = 1.75;
const WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR = 2.5;
const WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.2;
const WAVEFORM_FOLLOW_LEFT_THRESHOLD_RATIO = 0.25;
const WAVEFORM_FOLLOW_RIGHT_THRESHOLD_RATIO = 0.75;
const WAVEFORM_FOLLOW_TARGET_RATIO = 0.5;
const WAVEFORM_ZOOM_ANIMATION_DURATION_MS = 140;
const WAVEFORM_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 20;
const WAVEFORM_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 28;
const WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 0.9;
const WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 1.15;
const WAVEFORM_SAMPLE_PLOT_RENDER_BUFFER_FACTOR = 1.5;
const WAVEFORM_SAMPLE_PLOT_PREFETCH_MARGIN_RATIO = 0.08;
const SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR = 2.5;
const SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.2;
const LOOP_SELECTION_MIN_SECONDS = 0.05;
const LOOP_SELECTION_MIN_PIXELS = 6;
const LOOP_HANDLE_WIDTH_PX = 8;
const LOOP_WRAP_EPSILON_SECONDS = 1 / 120;
const WAVEFORM_TOP_PADDING_PX = 10;
const WAVEFORM_BOTTOM_PADDING_PX = 10;
const WAVEFORM_AMPLITUDE_HEIGHT_RATIO = 0.38;
const WAVEFORM_SAMPLE_DETAIL_MAX_SAMPLES_PER_RENDER_PIXEL = 1;

const QUALITY_PRESETS = {
  balanced: {
    rowsMultiplier: 1.5,
    colsMultiplier: 2.5,
  },
  high: {
    rowsMultiplier: 2.5,
    colsMultiplier: 4,
  },
  max: {
    rowsMultiplier: 4,
    colsMultiplier: 6,
  },
};

const SPECTROGRAM_FFT_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const SPECTROGRAM_OVERLAP_OPTIONS = [0.5, 0.75, 0.875, 0.9375];

type WaveformViewRangeUpdateOptions = {
  animateZoom?: boolean;
};

type WaveformZoomAnimationState = {
  currentRange: TimeRange;
  fromRange: TimeRange;
  toRange: TimeRange;
};

const elements = createAudioscopeElements();

const state = {
  activeFile: null,
  loadToken: 0,
  audioTransport: null,
  playbackSession: null as PlaybackSession | null,
  waveformSamples: null,
  sourceFetchController: null,
  externalTools: createExternalToolStatusState(EMBEDDED_MEDIA_TOOLS_GUIDANCE),
  mediaMetadata: createMediaMetadataState('idle'),
  mediaMetadataDetailOpen: false,
  playbackSourceKind: 'native',
  playbackTransportKind: 'unavailable',
  playbackTransportError: null,
  playbackRate: 1,
  playbackRateMenuOpen: false,
  analysisSourceKind: 'native',
  decodeFallbackLoadToken: 0,
  decodeFallbackPromise: null,
  decodeFallbackResult: null,
  decodeFallbackError: null,
  resolveDecodeFallback: null,
  rejectDecodeFallback: null,
  decodeWorker: null,
  decodeWorkerBootstrapUrl: null,
  decodeWorkerReady: false,
  decodeWorkerPrewarmed: false,
  analysisWorker: null,
  analysisWorkerBootstrapUrl: null,
  analysisRuntimeReadyPromise: null,
  resolveAnalysisRuntimeReady: null,
  analysisStartedForLoadToken: 0,
  waveformWorker: null,
  waveformWorkerBootstrapUrl: null,
  waveformRuntimeReadyPromise: null,
  resolveWaveformRuntimeReady: null,
  waveformSurfaceReadyPromise: null,
  spectrogramSurfaceReadyPromise: null,
  waveformCanvas: null,
  waveformDisplaySnapshot: null as WaveformDisplaySnapshot | null,
  waveformViewRange: { start: 0, end: 0 },
  waveformHoverClientPoint: null,
  waveformSeekPointerId: null,
  viewportSplitRatio: DEFAULT_VIEWPORT_SPLIT_RATIO,
  viewportResizeDrag: null,
  selectionDrag: null,
  selectionDraft: null,
  loopHandleDrag: null,
  loopRange: null,
  followPlayback: false,
  spectrogramRenderConfig: {
    analysisType: 'spectrogram',
    fftSize: 4096,
    frequencyScale: 'log',
    overlapRatio: 0.75,
  },
  analysis: null,
  loudness: createLoudnessSummaryState('idle'),
  sessionVersion: 0,
  waveformRequestGeneration: 0,
  waveformPendingRequest: null,
  waveformRenderRange: { start: 0, end: 0 },
  waveformRenderWidth: 0,
  waveformRenderHeight: 0,
  waveformRenderVisibleSpan: 0,
  waveformSamplePlotMode: false,
  waveformRawSamplePlotMode: false,
  waveformAxisRenderRange: { start: 0, end: 0 },
  waveformAxisRenderWidth: 0,
  waveformZoomAnimation: null as WaveformZoomAnimationState | null,
  waveformZoomAnimationFrame: 0,
  waveformZoomAnimationToken: 0,
  waveformPendingZoomAnimation: null as { fromRange: TimeRange; toRange: TimeRange } | null,
  playbackFrame: 0,
  waveformFrame: 0,
  spectrogramFrame: 0,
  spectrogramRequestFrame: 0,
  waveformRenderForcePending: false,
  waveformRenderRequestOptions: null,
  spectrogramRenderForcePending: false,
  observedWaveformViewportWidth: 0,
  observedWaveformViewportHeight: 0,
  observedSpectrogramPixelWidth: 0,
  observedSpectrogramPixelHeight: 0,
  observedOverviewWidth: 0,
};

const {
  formatMetadataDecodeSourceLabel,
  formatPlaybackTransportLabel,
  getActiveDecodeSourceKind,
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
  applyPlaybackRateSelection,
  closePlaybackRateMenu,
  focusPlaybackRateOption,
  getPlaybackRateOptionButtons,
  initializePlaybackRateControl,
  isPlaybackRateUiTarget,
  movePlaybackRateFocus,
  openPlaybackRateMenu,
  positionPlaybackRateMenu,
  syncPlaybackRateControl,
  togglePlaybackRateMenu,
} = createAudioscopePlaybackRateController({
  elements,
  state,
});

const {
  getCurrentPlaybackTime,
  hasPlaybackTransport,
  isPlaybackActive,
  seekBy,
  setPlaybackPosition,
  startPlaybackLoop,
  syncTransport,
  togglePlayback,
} = createAudioscopeTransportLoopController({
  applyWaveformPlaybackTime,
  closePlaybackRateMenu,
  elements,
  getDisplayedWaveformRange,
  getEffectiveDuration,
  getWaveformRange,
  isSmoothFollowPlaybackActive,
  refreshWaveformHoverPresentation,
  renderMediaMetadata,
  renderTransportTimelineOverview,
  state,
  syncFollowView,
  syncPlaybackRateControl,
});

const {
  destroySession,
  disposeAnalysisWorker,
  disposeSpectrogramSurface,
  disposeWaveformRenderer,
} = createAudioscopeLifecycleController({
  cancelDeferredAnalysis,
  cancelWaveformZoomAnimation,
  embeddedMediaToolsGuidance: EMBEDDED_MEDIA_TOOLS_GUIDANCE,
  elements,
  hideSpectrogramHoverTooltip,
  hideWaveformHoverTooltip,
  renderLoudnessSummary,
  renderMediaMetadata,
  renderSpectrogramMeta,
  renderWaveformUi,
  resetSpectrogramCanvasTransform,
  setWaveformDisplaySnapshot,
  state,
  syncWaveformLegacyStateFromSnapshot,
});

const {
  applyViewportSplit,
  beginViewportSplitDrag,
  endViewportSplitDrag,
  handleSharedViewportWheel,
  handleViewportSplitterKeydown,
  resetViewportSplit,
  updateViewportSplitDrag,
} = createAudioscopeViewportController({
  defaultViewportSplitRatio: DEFAULT_VIEWPORT_SPLIT_RATIO,
  disableFollowPlayback,
  elements,
  getCurrentPlaybackTime,
  getEffectiveDuration,
  getMinVisibleDuration,
  getTimeAtViewportClientX,
  getViewportPointerRatio,
  getWaveformRange,
  splitterFallbackSizePx: VIEWPORT_SPLITTER_FALLBACK_SIZE_PX,
  state,
  updateWaveformViewRange,
  viewportRatioMax: VIEWPORT_RATIO_MAX,
  viewportRatioMin: VIEWPORT_RATIO_MIN,
  viewportSplitStep: VIEWPORT_SPLIT_STEP,
  waveformZoomStepFactor: WAVEFORM_ZOOM_STEP_FACTOR,
});

const {
  attachGlobalKeyboardShortcuts,
  attachResizeObservers,
  attachUiEvents,
  initializeKeyboardFocus,
} = createAudioscopeBindingsController({
  applyViewportSplit,
  beginSelectionDrag,
  beginViewportSplitDrag,
  bindLoopHandle,
  closePlaybackRateMenu,
  elements,
  endViewportSplitDrag,
  focusPlaybackRateOption,
  getEffectiveDuration,
  getPlaybackRateOptionButtons,
  getSpectrogramCanvasTargetSize,
  getWaveformRange,
  getWaveformViewportSize,
  handleSharedViewportWheel,
  handleViewportSplitterKeydown,
  hasPlaybackTransport,
  hideSpectrogramHoverTooltip,
  hideTimelineHoverTooltip,
  hideWaveformHoverTooltip,
  isInteractiveElementTarget,
  isPlaybackRateUiTarget,
  movePlaybackRateFocus,
  normalizePlaybackRateSelection,
  normalizeSpectrogramAnalysisType,
  normalizeSpectrogramFftSize,
  normalizeSpectrogramFrequencyScale,
  normalizeSpectrogramOverlapRatio,
  openPlaybackRateMenu,
  positionPlaybackRateMenu,
  queueVisibleSpectrogramRequest,
  refreshSpectrogramAnalysisConfig,
  releaseSelectionDrag,
  renderMediaMetadata,
  renderSpectrogramMeta,
  renderSpectrogramScale,
  renderWaveformUi,
  requestOverviewSpectrogram,
  resetSpectrogramCanvasTransform,
  resetViewportSplit,
  resetWaveformZoom,
  scheduleSpectrogramRender,
  seekBy,
  setFollowPlaybackEnabled,
  setMediaMetadataDetailOpen,
  setPlaybackPosition,
  state,
  syncTransport,
  syncWaveformView,
  togglePlayback,
  togglePlaybackRateMenu,
  updateMediaMetadataDetailPosition,
  updateSelectionDrag,
  updateSpectrogramHoverTooltip,
  updateTimelineHoverTooltip,
  updateViewportSplitDrag,
  updateWaveformHoverTooltip,
  vscode,
  zoomWaveformIn,
  zoomWaveformOut,
});

const {
  acceptDecodeFallbackResult,
  disposeDecodeWorker,
  handleDecodeWorkerMessage,
  loadAudioFile,
  prewarmDecodeWorker,
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

let waveDisplayPlanner: WaveDisplayPlanner | null = null;
let waveDisplayPlannerPromise: Promise<WaveDisplayPlanner | null> | null = null;

function getWaveDisplayPlannerIfReady() {
  return waveDisplayPlanner;
}

function prewarmWaveDisplayPlanner() {
  if (waveDisplayPlannerPromise) {
    return waveDisplayPlannerPromise;
  }

  waveDisplayPlannerPromise = loadWaveCoreRuntime()
    .then((runtime) => {
      waveDisplayPlanner = createWaveDisplayPlanner(runtime.module);
      return waveDisplayPlanner;
    })
    .catch(() => null);

  return waveDisplayPlannerPromise;
}

function ensureWaveformSampleMarkerElement() {
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

ensureWaveformSampleMarkerElement();

if (
  typeof elements.spectrogram.transferControlToOffscreen !== 'function'
  || typeof OffscreenCanvas !== 'function'
) {
  setFatalStatus('OffscreenCanvas is required for audioscope.');
} else {
  initializeKeyboardFocus();
  attachGlobalKeyboardShortcuts();
  initializePlaybackRateControl();
  state.followPlayback = elements.waveFollow.checked;
  attachUiEvents();
  applyViewportSplit(true);
  attachResizeObservers();
  void prewarmWaveDisplayPlanner();
  renderWaveformUi();
  renderSpectrogramScale();
  renderSpectrogramMeta();
  renderLoudnessSummary();
  vscode.postMessage({ type: 'ready' });
}

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message?.type === 'loadAudio') {
    state.activeFile = message.body;
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
    state.externalTools = normalizeExternalToolStatus(
      message.body?.metadata?.toolStatus ?? state.externalTools,
      EMBEDDED_MEDIA_TOOLS_GUIDANCE,
    );
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'mediaMetadataError') {
    const loadToken = Number(message.body?.loadToken) || 0;

    if (loadToken !== state.loadToken) {
      return;
    }

    state.externalTools = normalizeExternalToolStatus(
      message.body?.toolStatus ?? state.externalTools,
      EMBEDDED_MEDIA_TOOLS_GUIDANCE,
    );
    state.mediaMetadata = {
      detail: null,
      loadToken,
      message: message.body?.message || state.externalTools.guidance || 'Metadata unavailable.',
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

    state.externalTools = normalizeExternalToolStatus(
      message.body?.toolStatus ?? state.externalTools,
      EMBEDDED_MEDIA_TOOLS_GUIDANCE,
    );
    rejectDecodeFallbackRequest(loadToken, message.body?.message || state.externalTools.guidance || 'ffmpeg decode failed.');
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

function normalizeSpectrogramFftSize(value) {
  const numericValue = Number(value);
  return SPECTROGRAM_FFT_OPTIONS.includes(numericValue) ? numericValue : 4096;
}

function normalizeSpectrogramAnalysisType(value) {
  return value === 'mel' || value === 'scalogram' ? value : 'spectrogram';
}

function normalizeSpectrogramFrequencyScale(value) {
  return value === 'linear' ? 'linear' : 'log';
}

function normalizeSpectrogramOverlapRatio(value) {
  const numericValue = Number(value);
  return SPECTROGRAM_OVERLAP_OPTIONS.includes(numericValue) ? numericValue : 0.75;
}

function isInteractiveElementTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest('button, input, select, textarea, [contenteditable="true"], [role="option"], [role="listbox"]'));
}

function getEffectiveSpectrogramRenderConfig(config = state.spectrogramRenderConfig) {
  const analysisType = normalizeSpectrogramAnalysisType(config?.analysisType);
  const fftSize = normalizeSpectrogramFftSize(config?.fftSize);
  const overlapRatio = normalizeSpectrogramOverlapRatio(config?.overlapRatio);
  const frequencyScale = analysisType === 'spectrogram'
    ? normalizeSpectrogramFrequencyScale(config?.frequencyScale)
    : 'log';

  return {
    analysisType,
    fftSize,
    frequencyScale,
    overlapRatio,
  };
}

async function initializeWaveformSurface(loadToken) {
  disposeWaveformRenderer();

  const canvas = document.createElement('canvas');
  canvas.className = 'waveform-canvas';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.transform = 'translate3d(0px, 0, 0)';
  elements.waveformCanvasHost.style.width = '100%';
  elements.waveformCanvasHost.style.transform = 'translate3d(0px, 0, 0)';
  elements.waveformCanvasHost.replaceChildren(canvas);
  state.waveformCanvas = canvas;
  const { width, height } = getWaveformViewportSize();

  if (
    !waveformWorkerScriptUri
    || typeof canvas.transferControlToOffscreen !== 'function'
  ) {
    throw new Error('Waveform worker runtime is unavailable.');
  }

  const worker = await createWaveformWorker(loadToken);

  if (!worker || loadToken !== state.loadToken) {
    return;
  }

  const offscreenCanvas = canvas.transferControlToOffscreen();
  worker.postMessage({
    type: 'initCanvas',
    body: {
      color: WAVEFORM_COLOR,
      height,
      offscreenCanvas,
      renderScale: WAVEFORM_RENDER_SCALE,
      width,
    },
  }, [offscreenCanvas]);
}

function createWaveformAxisSnapshot(
  renderRange: TimeRange,
  renderWidth: number,
  viewportWidth = Math.max(1, elements.waveformAxis.clientWidth || getWaveformViewportWidth()),
  visibleSpan = Math.max(0, Number(renderRange?.end) - Number(renderRange?.start)),
): WaveformAxisSnapshot {
  return createWaveformAxisSnapshotPure(renderRange, renderWidth, viewportWidth, visibleSpan);
}

function syncWaveformLegacyStateFromSnapshot(snapshot: WaveformDisplaySnapshot | null) {
  if (!snapshot) {
    state.waveformRenderRange = { start: 0, end: 0 };
    state.waveformRenderWidth = 0;
    state.waveformRenderHeight = 0;
    state.waveformRenderVisibleSpan = 0;
    state.waveformSamplePlotMode = false;
    state.waveformRawSamplePlotMode = false;
    state.waveformAxisRenderRange = { start: 0, end: 0 };
    state.waveformAxisRenderWidth = 0;
    return;
  }

  state.waveformRenderRange = cloneTimeRange(snapshot.renderRange);
  state.waveformRenderWidth = snapshot.renderWidth;
  state.waveformRenderHeight = snapshot.renderHeight;
  state.waveformRenderVisibleSpan = snapshot.visibleSpan;
  state.waveformSamplePlotMode = snapshot.samplePlotMode;
  state.waveformRawSamplePlotMode = snapshot.rawSamplePlotMode;
  state.waveformAxisRenderRange = cloneTimeRange(snapshot.renderRange);
  state.waveformAxisRenderWidth = snapshot.renderWidth;
}

function setWaveformDisplaySnapshot(nextSnapshot: WaveformDisplaySnapshot | null) {
  state.waveformDisplaySnapshot = nextSnapshot;
  syncWaveformLegacyStateFromSnapshot(nextSnapshot);
}

function getWaveformSnapshotDisplayMetrics(
  snapshot = state.waveformDisplaySnapshot,
  desiredDisplayRange = getWaveformRange(),
) {
  if (!snapshot) {
    return null;
  }

  const metrics = getWaveformDisplayWindowMetrics(
    desiredDisplayRange,
    snapshot.renderRange,
    snapshot.renderWidth,
    snapshot.displayWidth || getWaveformViewportWidth(),
  );

  if (!metrics) {
    return null;
  }

  return metrics;
}

function updateWaveformDisplaySnapshotWindow(
  desiredDisplayRange = getWaveformRange(),
  snapshot = state.waveformDisplaySnapshot,
  metrics = getWaveformSnapshotDisplayMetrics(snapshot, desiredDisplayRange),
) {
  if (!snapshot || !metrics) {
    return null;
  }

  snapshot.displayWidth = metrics.displayWidth;
  snapshot.displayOffsetPx = metrics.displayOffsetPx;
  snapshot.displayRange = cloneTimeRange(metrics.displayRange);
  return snapshot;
}

function getDisplayedWaveformRange(
  desiredDisplayRange = getWaveformRange(),
  metrics = getWaveformSnapshotDisplayMetrics(state.waveformDisplaySnapshot, desiredDisplayRange),
) {
  return metrics?.displayRange ?? desiredDisplayRange;
}

function getWaveformGroundTruthRange(
  playbackTime = null,
  smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(playbackTime),
) {
  return cloneTimeRange(getWaveformRange(playbackTime, smoothFollowPlaybackActive));
}

function syncWaveformCanvasElementSize(width, height) {
  if (!state.waveformCanvas) {
    return;
  }

  state.waveformCanvas.style.width = `${Math.max(1, Math.round(width || 0))}px`;
  state.waveformCanvas.style.height = height > 0
    ? `${Math.max(1, Math.round(height || 0))}px`
    : '100%';
}

async function initializeSpectrogramSurface(loadToken) {
  disposeSpectrogramSurface();

  const canvas = document.createElement('canvas');
  canvas.id = 'spectrogram';
  canvas.className = 'spectrogram-canvas';
  canvas.setAttribute('aria-label', 'Spectrogram');
  elements.spectrogram.replaceWith(canvas);
  elements.spectrogram = canvas;

  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();

  if (
    !analysisWorkerScriptUri
    || typeof canvas.transferControlToOffscreen !== 'function'
  ) {
    throw new Error('Spectrogram worker runtime is unavailable.');
  }

  const worker = await createAnalysisWorker(loadToken);

  if (!worker || loadToken !== state.loadToken) {
    return;
  }

  const offscreenCanvas = canvas.transferControlToOffscreen();
  worker.postMessage({
    type: 'initCanvas',
    body: {
      offscreenCanvas,
      pixelHeight,
      pixelWidth,
    },
  }, [offscreenCanvas]);
}

function cancelDeferredAnalysis() {
  state.analysisStartedForLoadToken = 0;
}

function scheduleDeferredAnalysis(loadToken, payload, monoSamples = null) {
  if (
    loadToken !== state.loadToken
    || state.analysisStartedForLoadToken === loadToken
  ) {
    return;
  }

  cancelDeferredAnalysis();
  state.analysisStartedForLoadToken = loadToken;
  void startAnalysis(loadToken, payload, monoSamples);
}

async function startAnalysis(loadToken, payload, monoSamplesOverride = null) {
  if (!analysisWorkerScriptUri || !waveformWorkerScriptUri) {
    setLoudnessSummaryUnavailable('Analysis worker is unavailable.');
    setAnalysisStatus('Analysis worker is unavailable.', true);
    return;
  }

  try {
    const playbackSession = state.playbackSession;

    if (!playbackSession) {
      throw new Error('Decoded playback session is unavailable.');
    }

    if (loadToken !== state.loadToken) {
      return;
    }

    const [analysisWorker, waveformWorker] = await Promise.all([
      createAnalysisWorker(loadToken),
      createWaveformWorker(loadToken),
    ]);

    if (!analysisWorker || !waveformWorker || loadToken !== state.loadToken) {
      return;
    }

    setAnalysisStatus('Initializing analysis workers…');
    await Promise.all([
      state.analysisRuntimeReadyPromise,
      state.waveformRuntimeReadyPromise,
    ]);

    if (loadToken !== state.loadToken) {
      return;
    }

    const monoSamples = monoSamplesOverride instanceof Float32Array
      ? monoSamplesOverride
      : state.waveformSamples;

    if (!(monoSamples instanceof Float32Array) || monoSamples.length === 0) {
      throw new Error('Waveform samples are unavailable.');
    }

    state.waveformSamples = monoSamples;

    state.analysis = createSpectrogramAnalysisState({
      duration: playbackSession.durationSeconds,
      quality: normalizeSpectrogramQuality(payload.spectrogramQuality),
      minFrequency: SPECTROGRAM_MIN_FREQUENCY,
      maxFrequency: Math.min(SPECTROGRAM_MAX_FREQUENCY, playbackSession.sourceSampleRate / 2),
      sampleCount: monoSamples.length,
      sampleRate: playbackSession.sourceSampleRate,
    });

    state.sessionVersion += 1;
    const sessionVersion = state.sessionVersion;
    const waveformWorkerSamples = monoSamples.slice();
    const analysisWorkerSamples = monoSamples.slice();

    waveformWorker.postMessage({
      type: 'attachAudioSession',
      body: {
        duration: playbackSession.durationSeconds,
        quality: state.analysis.quality,
        sampleCount: waveformWorkerSamples.length,
        sampleRate: playbackSession.sourceSampleRate,
        samplesBuffer: waveformWorkerSamples.buffer,
        sessionVersion,
      },
    }, [waveformWorkerSamples.buffer]);
    waveformWorker.postMessage({ type: 'buildWaveformPyramid' });

    analysisWorker.postMessage({
      type: 'attachAudioSession',
      body: {
        duration: playbackSession.durationSeconds,
        quality: state.analysis.quality,
        sampleCount: analysisWorkerSamples.length,
        sampleRate: playbackSession.sourceSampleRate,
        samplesBuffer: analysisWorkerSamples.buffer,
        sessionVersion,
      },
    }, [analysisWorkerSamples.buffer]);

    await Promise.all([
      state.waveformSurfaceReadyPromise,
      state.spectrogramSurfaceReadyPromise,
    ]);

    if (loadToken !== state.loadToken) {
      return;
    }

    ensureWaveformViewRange();
    renderWaveformUi();
    renderSpectrogramScale();
    void syncWaveformView({ force: true });
    requestOverviewSpectrogram({ force: true });
    scheduleSpectrogramRender({ force: true });
  } catch (error) {
    if (loadToken !== state.loadToken) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    state.analysisStartedForLoadToken = 0;
    setLoudnessSummaryUnavailable(message);
    setAnalysisStatus(`Analysis unavailable: ${message}`, true);
  }
}

async function createAnalysisWorker(loadToken) {
  if (state.analysisWorker) {
    return state.analysisWorker;
  }

  if (loadToken !== state.loadToken) {
    return null;
  }

  const worker = createModuleWorker(analysisWorkerScriptUri, 'analysisWorkerBootstrapUrl');

  state.analysisRuntimeReadyPromise = new Promise((resolve) => {
    state.resolveAnalysisRuntimeReady = resolve;
  });
  state.analysisWorker = worker;

  worker.addEventListener('message', (event) => {
    handleAnalysisWorkerMessage(loadToken, event.data);
  });
  worker.addEventListener('error', (event) => {
    if (loadToken !== state.loadToken) {
      return;
    }

    disposeAnalysisWorker();
    setLoudnessSummaryUnavailable(event.message || 'Unknown worker error.');
    setAnalysisStatus(`Analysis failed: ${event.message || 'Unknown worker error.'}`, true);
  });
  worker.postMessage({ type: 'bootstrapRuntime' });

  return worker;
}

async function createWaveformWorker(loadToken) {
  if (state.waveformWorker) {
    return state.waveformWorker;
  }

  if (loadToken !== state.loadToken) {
    return null;
  }

  const worker = createModuleWorker(waveformWorkerScriptUri, 'waveformWorkerBootstrapUrl');
  state.waveformRuntimeReadyPromise = new Promise((resolve) => {
    state.resolveWaveformRuntimeReady = resolve;
  });
  state.waveformWorker = worker;

  worker.addEventListener('message', (event) => {
    handleWaveformWorkerMessage(loadToken, event.data);
  });
  worker.addEventListener('error', (event) => {
    if (loadToken !== state.loadToken) {
      return;
    }

    setFatalStatus(`Waveform renderer failed: ${event.message || 'Unknown worker error.'}`);
  });
  worker.postMessage({ type: 'bootstrapRuntime' });

  return worker;
}

function createModuleWorker(moduleUrl, bootstrapStateKey) {
  const bootstrapSource = `import ${JSON.stringify(moduleUrl)};`;
  const bootstrapBlob = new Blob([bootstrapSource], { type: 'text/javascript' });
  const bootstrapUrl = URL.createObjectURL(bootstrapBlob);
  state[bootstrapStateKey] = bootstrapUrl;
  return new Worker(bootstrapUrl, { type: 'module' });
}

function handleAnalysisWorkerMessage(loadToken, message) {
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
    const { body } = message;

    state.analysis.initialized = true;
    state.analysis.runtimeVariant = body.runtimeVariant;
    state.analysis.sampleRate = body.sampleRate;
    state.analysis.sampleCount = body.sampleCount;
    state.analysis.minFrequency = body.minFrequency;
    state.analysis.maxFrequency = body.maxFrequency;
    renderSpectrogramScale();
    renderSpectrogramMeta();
    requestOverviewSpectrogram({ force: true });
    scheduleSpectrogramRender({ force: true });
    return;
  }

  if (message?.type === 'loudnessSummaryReady') {
    setReadyLoudnessSummary(message.body);
    return;
  }

  if (message?.type === 'loudnessSummaryError') {
    setLoudnessSummaryUnavailable(message.body?.message ?? 'Failed to measure loudness summary.');
    return;
  }

  if (message?.type === 'overviewReady') {
    const { body } = message;

    state.analysis.overview = {
      ...state.analysis.overview,
      analysisType: body.analysisType,
      complete: true,
      configVersion: body.configVersion,
      decimationFactor: body.decimationFactor,
      fftSize: body.fftSize,
      frequencyScale: body.frequencyScale,
      hopSamples: body.hopSamples,
      hopSeconds: body.hopSeconds,
      overlapRatio: body.overlapRatio,
      pixelHeight: body.pixelHeight,
      pixelWidth: body.pixelWidth,
      ready: true,
      requestPending: false,
      runtimeVariant: body.runtimeVariant,
      targetColumns: body.targetColumns,
      targetRows: body.targetRows,
      viewEnd: body.viewEnd,
      viewStart: body.viewStart,
      windowSeconds: body.windowSeconds,
    };
    setAnalysisStatus('Overview ready');
    renderSpectrogramMeta();
    scheduleSpectrogramRender({ force: true });
    return;
  }

  if (message?.type === 'visibleReady') {
    const { body } = message;

    if (body.generation !== state.analysis.generation) {
      return;
    }

    state.analysis.activeVisibleRequest = {
      analysisType: body.analysisType,
      configVersion: body.configVersion,
      displayEnd: body.displayEnd,
      displayStart: body.displayStart,
      fftSize: body.fftSize,
      frequencyScale: body.frequencyScale,
      generation: body.generation,
      overlapRatio: body.overlapRatio,
      pixelHeight: body.pixelHeight,
      pixelWidth: body.pixelWidth,
      viewEnd: body.viewEnd,
      viewStart: body.viewStart,
    };
    state.analysis.visible = {
      ...state.analysis.visible,
      analysisType: body.analysisType,
      complete: true,
      configVersion: body.configVersion,
      decimationFactor: body.decimationFactor,
      displayEnd: body.displayEnd,
      displayStart: body.displayStart,
      fftSize: body.fftSize,
      frequencyScale: body.frequencyScale,
      generation: body.generation,
      hopSamples: body.hopSamples,
      hopSeconds: body.hopSeconds,
      overlapRatio: body.overlapRatio,
      pixelHeight: body.pixelHeight,
      pixelWidth: body.pixelWidth,
      ready: true,
      requestPending: false,
      runtimeVariant: body.runtimeVariant,
      targetColumns: body.targetColumns,
      targetRows: body.targetRows,
      viewEnd: body.viewEnd,
      viewStart: body.viewStart,
      windowSeconds: body.windowSeconds,
    };
    resetSpectrogramCanvasTransform();
    setAnalysisStatus('Ready');
    renderSpectrogramMeta();
    return;
  }

  if (message?.type === 'error') {
    disposeAnalysisWorker();
    setLoudnessSummaryUnavailable(message.body.message);
    setAnalysisStatus(`Analysis failed: ${message.body.message}`, true);
  }
}

function handleWaveformWorkerMessage(loadToken, message) {
  if (loadToken !== state.loadToken) {
    return;
  }

  if (message?.type === 'runtimeReady') {
    state.resolveWaveformRuntimeReady?.();
    state.resolveWaveformRuntimeReady = null;
    return;
  }

  if (message?.type === 'analysisInitialized') {
    return;
  }

  if (message?.type === 'waveformPyramidReady') {
    if (state.waveformDisplaySnapshot) {
      void syncWaveformView();
    } else {
      void syncWaveformView({ force: true });
    }
    return;
  }

  if (message?.type === 'waveformPresented') {
    handleWaveformPresented(message.body);
    return;
  }

  if (message?.type === 'error') {
    setFatalStatus(`Waveform renderer failed: ${message.body.message}`);
  }
}

function scheduleSpectrogramRender({ force = false } = {}) {
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

function createSpectrogramLayerState(kind) {
  return {
    analysisType: 'spectrogram',
    configVersion: 0,
    displayEnd: 0,
    displayStart: 0,
    kind,
    generation: kind === 'overview' ? 0 : -1,
    viewStart: 0,
    viewEnd: 0,
    pixelWidth: 0,
    pixelHeight: 0,
    dpr: DISPLAY_PIXEL_RATIO,
    requestPending: false,
    ready: false,
    complete: false,
    completedTiles: 0,
    totalTiles: 0,
    targetRows: 0,
    targetColumns: 0,
    fftSize: 0,
    frequencyScale: 'log',
    hopSamples: 0,
    hopSeconds: 0,
    overlapRatio: 0,
    windowSeconds: 0,
    decimationFactor: 1,
    runtimeVariant: null,
  };
}

function createSpectrogramAnalysisState({ duration, quality, minFrequency, maxFrequency, sampleCount, sampleRate }) {
  return {
    configVersion: 0,
    duration,
    generation: 0,
    initialized: false,
    maxFrequency,
    minFrequency,
    quality,
    runtimeVariant: null,
    sampleCount,
    sampleRate,
    activeVisibleRequest: null,
    overview: createSpectrogramLayerState('overview'),
    visible: createSpectrogramLayerState('visible'),
  };
}

function normalizeSpectrogramQuality(value) {
  return value === 'balanced' || value === 'max' ? value : 'high';
}

// Keep spectrogram rasters tall enough for any in-window vertical resize, then let CSS scale them.
function getSpectrogramRenderPixelHeight() {
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

function getSpectrogramCanvasTargetSize() {
  const clientWidth = Math.max(1, elements.spectrogram.clientWidth);
  const clientHeight = Math.max(1, elements.spectrogram.clientHeight);

  return {
    clientHeight,
    clientWidth,
    pixelHeight: getSpectrogramRenderPixelHeight(),
    pixelWidth: Math.max(1, Math.round(clientWidth * DISPLAY_PIXEL_RATIO)),
  };
}

function getOverviewSpectrogramRequestSize() {
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();

  return {
    pixelHeight: clamp(Math.round(pixelHeight * SPECTROGRAM_OVERVIEW_HEIGHT_SCALE), 160, 1440),
    pixelWidth: clamp(Math.round(pixelWidth * SPECTROGRAM_OVERVIEW_WIDTH_SCALE), 320, 4096),
  };
}

function requestOverviewSpectrogram({ force = false } = {}) {
  if (!state.analysisWorker || !state.analysis?.initialized) {
    return;
  }

  const { pixelHeight, pixelWidth } = getOverviewSpectrogramRequestSize();
  const renderConfig = getEffectiveSpectrogramRenderConfig();
  const configVersion = state.analysis.configVersion ?? 0;

  if (
    !force
    && (state.analysis.overview.requestPending || state.analysis.overview.ready)
    && state.analysis.overview.analysisType === renderConfig.analysisType
    && state.analysis.overview.frequencyScale === renderConfig.frequencyScale
    && state.analysis.overview.fftSize === renderConfig.fftSize
    && Math.abs((state.analysis.overview.overlapRatio ?? 0) - renderConfig.overlapRatio) <= 1e-6
    && Math.abs((state.analysis.overview.pixelWidth ?? 0) - pixelWidth) <= 1
    && Math.abs((state.analysis.overview.pixelHeight ?? 0) - pixelHeight) <= 1
  ) {
    return;
  }

  state.analysis.overview = {
    ...createSpectrogramLayerState('overview'),
    analysisType: renderConfig.analysisType,
    configVersion,
    dpr: DISPLAY_PIXEL_RATIO,
    fftSize: renderConfig.fftSize,
    frequencyScale: renderConfig.frequencyScale,
    overlapRatio: renderConfig.overlapRatio,
    pixelHeight,
    pixelWidth,
    requestPending: true,
    viewEnd: state.analysis.duration,
    viewStart: 0,
  };

  setAnalysisStatus('Queued');
  state.analysisWorker.postMessage({
    type: 'renderOverview',
    body: {
      analysisType: renderConfig.analysisType,
      configVersion,
      dpr: DISPLAY_PIXEL_RATIO,
      fftSize: renderConfig.fftSize,
      frequencyScale: renderConfig.frequencyScale,
      overlapRatio: renderConfig.overlapRatio,
      pixelHeight,
      pixelWidth,
    },
  });
}

function isCompatibleVisibleRequest(activeRequest, size, renderConfig = getEffectiveSpectrogramRenderConfig()) {
  if (!activeRequest) {
    return false;
  }

  return (activeRequest.configVersion ?? 0) === (state.analysis?.configVersion ?? 0)
    && activeRequest.analysisType === renderConfig.analysisType
    && activeRequest.fftSize === renderConfig.fftSize
    && activeRequest.frequencyScale === renderConfig.frequencyScale
    && Math.abs((activeRequest.overlapRatio ?? 0) - renderConfig.overlapRatio) <= 1e-6
    && Math.abs((activeRequest.pixelWidth ?? 0) - size.pixelWidth) <= 1
    && Math.abs((activeRequest.pixelHeight ?? 0) - size.pixelHeight) <= 1;
}

function updateSpectrogramDisplayState(displayRange, pixelWidth, pixelHeight) {
  if (!state.analysis) {
    return;
  }

  const nextDisplayStart = displayRange.start;
  const nextDisplayEnd = displayRange.end;

  if (state.analysis.activeVisibleRequest) {
    state.analysis.activeVisibleRequest = {
      ...state.analysis.activeVisibleRequest,
      displayEnd: nextDisplayEnd,
      displayStart: nextDisplayStart,
      pixelHeight,
      pixelWidth,
    };
  }

  state.analysis.visible = {
    ...state.analysis.visible,
    displayEnd: nextDisplayEnd,
    displayStart: nextDisplayStart,
    pixelHeight,
    pixelWidth,
  };
}

function syncSpectrogramDisplayRange(displayRange, pixelWidth, pixelHeight) {
  if (!state.analysisWorker || !state.analysis?.initialized || !(displayRange.end > displayRange.start)) {
    return;
  }

  updateSpectrogramDisplayState(displayRange, pixelWidth, pixelHeight);
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

function syncSpectrogramView({ force = false } = {}) {
  if (!state.analysisWorker || !state.analysis?.initialized) {
    return;
  }

  const { displayRange, pixelHeight, pixelWidth, requestRange } = getVisibleSpectrogramRequestMetrics();
  const renderConfig = getEffectiveSpectrogramRenderConfig();

  if (displayRange.end <= displayRange.start) {
    return;
  }

  resetSpectrogramCanvasTransform();
  syncSpectrogramDisplayRange(displayRange, pixelWidth, pixelHeight);

  if (
    !force
    && isCompatibleVisibleRequest(state.analysis.activeVisibleRequest, { pixelHeight, pixelWidth }, renderConfig)
    && hasBufferedVisibleSpectrogramCoverage(displayRange)
  ) {
    return;
  }

  const previousGeneration = state.analysis.generation;
  const generation = previousGeneration + 1;
  const configVersion = state.analysis.configVersion ?? 0;

  state.analysis.generation = generation;
  state.analysis.activeVisibleRequest = {
    analysisType: renderConfig.analysisType,
    configVersion,
    displayEnd: displayRange.end,
    displayStart: displayRange.start,
    fftSize: renderConfig.fftSize,
    frequencyScale: renderConfig.frequencyScale,
    generation,
    overlapRatio: renderConfig.overlapRatio,
    pixelHeight,
    pixelWidth,
    viewEnd: requestRange.end,
    viewStart: requestRange.start,
  };
  state.analysis.visible = {
    ...createSpectrogramLayerState('visible'),
    analysisType: renderConfig.analysisType,
    configVersion,
    dpr: DISPLAY_PIXEL_RATIO,
    displayEnd: displayRange.end,
    displayStart: displayRange.start,
    fftSize: renderConfig.fftSize,
    frequencyScale: renderConfig.frequencyScale,
    generation,
    overlapRatio: renderConfig.overlapRatio,
    pixelHeight,
    pixelWidth,
    requestPending: true,
    viewEnd: requestRange.end,
    viewStart: requestRange.start,
  };

  if (previousGeneration > 0) {
    state.analysisWorker.postMessage({
      type: 'cancelGeneration',
      body: { generation: previousGeneration },
    });
  }

  setAnalysisStatus('Refining visible range');
  state.analysisWorker.postMessage({
    type: 'renderVisibleRange',
    body: {
      analysisType: renderConfig.analysisType,
      configVersion,
      displayEnd: displayRange.end,
      displayStart: displayRange.start,
      dpr: DISPLAY_PIXEL_RATIO,
      fftSize: renderConfig.fftSize,
      frequencyScale: renderConfig.frequencyScale,
      generation,
      overlapRatio: renderConfig.overlapRatio,
      pixelHeight,
      pixelWidth,
      requestEnd: requestRange.end,
      requestStart: requestRange.start,
    },
  });
}

function queueVisibleSpectrogramRequest({ force = false } = {}) {
  scheduleSpectrogramRender({ force });
}

function isSameVisibleRequest(activeRequest, range, size) {
  return isCompatibleVisibleRequest(activeRequest, size)
    && Math.abs(activeRequest.viewStart - range.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(activeRequest.viewEnd - range.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
}

function handleWaveformPresented(body) {
  if (body.generation !== state.waveformRequestGeneration) {
    return;
  }

  const pendingRequest = state.waveformPendingRequest?.generation === body.generation
    ? state.waveformPendingRequest
    : null;
  const { width: fallbackWidth, height: fallbackHeight } = getWaveformViewportSize();
  const responseWidth = Number.isFinite(Number(body.width)) && Number(body.width) > 0
    ? Math.max(1, Math.round(Number(body.width)))
    : null;
  const responseHeight = Number.isFinite(Number(body.height)) && Number(body.height) > 0
    ? Math.max(1, Math.round(Number(body.height)))
    : null;
  const width = pendingRequest?.width ?? responseWidth ?? fallbackWidth;
  const height = pendingRequest?.height ?? responseHeight ?? fallbackHeight;
  state.waveformPendingRequest = null;
  const desiredDisplayRange = getWaveformRange();
  const nextSnapshot: WaveformDisplaySnapshot = {
    axisTicks: createWaveformAxisSnapshot(
      { end: body.viewEnd, start: body.viewStart },
      width,
      getWaveformViewportWidth(),
      pendingRequest?.visibleSpan ?? Math.max(0, body.viewEnd - body.viewStart),
    ).ticks,
    columnCount: Math.max(1, Math.round(Number(body.columnCount) || width * WAVEFORM_RENDER_SCALE || 1)),
    displayOffsetPx: 0,
    displayRange: cloneTimeRange(pendingRequest?.displayRange ?? desiredDisplayRange),
    displayWidth: getWaveformViewportWidth(),
    rawSamplePlotMode: Boolean(body.rawSamplePlotMode),
    renderHeight: height,
    renderRange: {
      end: body.viewEnd,
      start: body.viewStart,
    },
    renderWidth: width,
    samplePlotMode: Boolean(body.samplePlotMode),
    visibleSpan: pendingRequest?.visibleSpan ?? Math.max(0, body.viewEnd - body.viewStart),
  };
  const displayMetrics = getWaveformSnapshotDisplayMetrics(nextSnapshot, desiredDisplayRange);
  updateWaveformDisplaySnapshotWindow(desiredDisplayRange, nextSnapshot, displayMetrics);

  if (!doesWaveformRenderCandidatePhysicallyCoverDisplay(
    {
      end: nextSnapshot.renderRange.end,
      height: nextSnapshot.renderHeight,
      start: nextSnapshot.renderRange.start,
      visibleSpan: nextSnapshot.visibleSpan,
      width: nextSnapshot.renderWidth,
    },
    desiredDisplayRange,
    {
      displaySpan: Math.max(0, desiredDisplayRange.end - desiredDisplayRange.start),
      height: height,
      renderWidth: getWaveformRenderRequestMetrics(desiredDisplayRange).renderWidth,
    },
  )) {
    if (!hasWaveformRenderCoverage(desiredDisplayRange)) {
      void syncWaveformView({ force: true });
    }
    return;
  }

  setWaveformDisplaySnapshot(nextSnapshot);
  const activeZoomAnimation = state.waveformZoomAnimation;
  const pendingZoomAnimation = state.waveformPendingZoomAnimation;
  const animationRange = activeZoomAnimation?.currentRange ?? null;
  const shouldStartPendingZoomAnimation = Boolean(
    pendingZoomAnimation
    && isSameWaveformRange(pendingZoomAnimation.toRange, desiredDisplayRange)
    && doesWaveformSnapshotPhysicallyCoverDisplay(pendingZoomAnimation.toRange, nextSnapshot),
  );
  const renderedDisplayRange = animationRange ?? pendingZoomAnimation?.fromRange ?? desiredDisplayRange;
  const renderedDisplayMetrics = getWaveformSnapshotDisplayMetrics(nextSnapshot, renderedDisplayRange);

  renderWaveformAxis({
    displayMetrics: renderedDisplayMetrics,
    displayRange: renderedDisplayMetrics?.displayRange ?? renderedDisplayRange,
  });

  if (shouldStartPendingZoomAnimation && pendingZoomAnimation) {
    startWaveformZoomAnimation(pendingZoomAnimation.fromRange, pendingZoomAnimation.toRange);
    return;
  }

  applyWaveformCanvasTransform(renderedDisplayRange, renderedDisplayMetrics);
  applyWaveformAxisTransform(renderedDisplayRange, renderedDisplayMetrics);
  refreshWaveformHoverPresentation({
    displayMetrics: renderedDisplayMetrics,
    displayRange: renderedDisplayMetrics?.displayRange ?? renderedDisplayRange,
  });
}

function renderSpectrogramScale() {
  const minFrequency = state.analysis?.minFrequency ?? SPECTROGRAM_MIN_FREQUENCY;
  const maxFrequency = state.analysis?.maxFrequency ?? SPECTROGRAM_MAX_FREQUENCY;
  const visibleTicks = getVisibleSpectrogramTicks(minFrequency, maxFrequency);

  elements.spectrogramAxis.replaceChildren();
  elements.spectrogramGuides.replaceChildren();

  visibleTicks.forEach((tick, index) => {
    const position = getSpectrogramFrequencyPosition(tick, minFrequency, maxFrequency);
    const axisTick = document.createElement('div');
    axisTick.className = 'spectrogram-tick';
    if (index === 0) {
      axisTick.classList.add('spectrogram-tick-edge-top');
    } else if (index === visibleTicks.length - 1) {
      axisTick.classList.add('spectrogram-tick-edge-bottom');
    }
    axisTick.style.top = `${position * 100}%`;

    const label = document.createElement('span');
    label.className = 'spectrogram-tick-label';
    label.textContent = formatFrequencyLabel(tick);
    axisTick.append(label);

    const guide = document.createElement('div');
    guide.className = 'spectrogram-guide';
    guide.style.top = `${position * 100}%`;

    elements.spectrogramAxis.append(axisTick);
    elements.spectrogramGuides.append(guide);
  });
}

function getActiveSpectrogramMetaLayer() {
  return state.spectrogramRenderConfig;
}

function renderSpectrogramMeta() {
  if (
    !elements.spectrogramMeta
    || !elements.spectrogramTypeSelect
    || !elements.spectrogramFftSelect
    || !elements.spectrogramOverlapSelect
    || !elements.spectrogramScaleSelect
  ) {
    return;
  }

  const layer = getEffectiveSpectrogramRenderConfig(getActiveSpectrogramMetaLayer());
  const isScalogram = layer.analysisType === 'scalogram';
  const supportsScale = layer.analysisType === 'spectrogram';

  elements.spectrogramTypeSelect.value = layer.analysisType;
  elements.spectrogramFftSelect.value = String(layer.fftSize);
  elements.spectrogramOverlapSelect.value = String(layer.overlapRatio);
  elements.spectrogramScaleSelect.value = layer.frequencyScale;

  elements.spectrogramFftSelect.disabled = isScalogram;
  elements.spectrogramOverlapSelect.disabled = isScalogram;
  elements.spectrogramScaleSelect.disabled = !supportsScale;
}

function refreshSpectrogramAnalysisConfig() {
  if (!state.analysis) {
    return;
  }

  state.analysis.configVersion = (state.analysis.configVersion ?? 0) + 1;
  state.analysis.activeVisibleRequest = null;
  state.analysis.overview = createSpectrogramLayerState('overview');
  state.analysis.visible = createSpectrogramLayerState('visible');

  if (state.analysisWorker && state.analysis.generation > 0) {
    state.analysisWorker.postMessage({
      type: 'cancelGeneration',
      body: { generation: state.analysis.generation },
    });
  }

  renderSpectrogramScale();
  renderSpectrogramMeta();
  requestOverviewSpectrogram({ force: true });
  scheduleSpectrogramRender({ force: true });
}

function ensureWaveformViewRange() {
  const duration = getEffectiveDuration();

  cancelWaveformZoomAnimation();

  if (duration <= 0) {
    state.waveformViewRange = { start: 0, end: 0 };
    return;
  }

  if (state.waveformViewRange.end <= state.waveformViewRange.start) {
    state.waveformViewRange = { start: 0, end: duration };
    return;
  }

  state.waveformViewRange = normalizeWaveformRange(state.waveformViewRange, duration);
}

function getViewportPointerMetrics(targetElement, clientX) {
  const rect = targetElement.getBoundingClientRect();

  return {
    offsetX: clamp(clientX - rect.left, 0, rect.width),
    width: rect.width,
  };
}

function getViewportPointerMetricsFromEvent(targetElement, event) {
  if (!Number.isFinite(event.clientX)) {
    return { offsetX: 0, width: 0 };
  }

  return getViewportPointerMetrics(targetElement, event.clientX);
}

function getViewportPointerRatio(clientX, targetElement) {
  const { offsetX, width } = getViewportPointerMetrics(targetElement, clientX);

  if (width <= 0) {
    return 0.5;
  }

  return clamp(offsetX / width, 0, 1);
}

function getWaveformPointerMetrics(clientX) {
  return getViewportPointerMetrics(elements.waveformHitTarget ?? elements.waveformViewport, clientX);
}

function getWaveformPointerMetricsFromEvent(event) {
  return getViewportPointerMetricsFromEvent(elements.waveformHitTarget ?? elements.waveformViewport, event);
}

function getTimeAtViewportClientX(clientX, targetElement, range = getDisplayedWaveformRange()) {
  const span = Math.max(0, range.end - range.start);
  const { offsetX, width } = getViewportPointerMetrics(targetElement, clientX);

  if (span <= 0 || width <= 0) {
    return 0;
  }

  const ratio = offsetX / width;
  return clamp(range.start + ratio * span, 0, getEffectiveDuration());
}

function getTimeAtViewportPointerEvent(event, targetElement, range = getDisplayedWaveformRange()) {
  const span = Math.max(0, range.end - range.start);
  const { offsetX, width } = getViewportPointerMetricsFromEvent(targetElement, event);

  if (span <= 0 || width <= 0) {
    return 0;
  }

  const ratio = offsetX / width;
  return clamp(range.start + ratio * span, 0, getEffectiveDuration());
}

function getTimeAtWaveformClientX(clientX, range = getDisplayedWaveformRange()) {
  return getTimeAtViewportClientX(clientX, elements.waveformHitTarget ?? elements.waveformViewport, range);
}

function getTimeAtWaveformPointerEvent(event, range = getDisplayedWaveformRange()) {
  return getTimeAtViewportPointerEvent(event, elements.waveformHitTarget ?? elements.waveformViewport, range);
}

function normalizeLoopRange(startTime, endTime) {
  const duration = getEffectiveDuration();

  if (duration <= 0) {
    return null;
  }

  const start = clamp(Math.min(startTime, endTime), 0, duration);
  const end = clamp(Math.max(startTime, endTime), 0, duration);

  if (end - start < LOOP_SELECTION_MIN_SECONDS) {
    return null;
  }

  return { start, end };
}

function shouldWrapLoop(loopRange, currentTime) {
  if (!loopRange || loopRange.end <= loopRange.start) {
    return false;
  }

  return currentTime >= (loopRange.end - LOOP_WRAP_EPSILON_SECONDS);
}

function isTimeWithinLoopRange(loopRange, timeSeconds) {
  if (!loopRange || loopRange.end <= loopRange.start || !Number.isFinite(timeSeconds)) {
    return false;
  }

  return timeSeconds >= loopRange.start && timeSeconds <= loopRange.end;
}

function getAdjustedLoopRange(baseRange, edge, clientX, targetElement = elements.waveformHitTarget ?? elements.waveformViewport) {
  const duration = getEffectiveDuration();
  const nextTime = getTimeAtViewportClientX(clientX, targetElement);

  if (edge === 'start') {
    return {
      start: clamp(nextTime, 0, Math.max(0, baseRange.end - LOOP_SELECTION_MIN_SECONDS)),
      end: baseRange.end,
    };
  }

  return {
    start: baseRange.start,
    end: clamp(nextTime, baseRange.start + LOOP_SELECTION_MIN_SECONDS, duration),
  };
}

function syncWaveformSelection(range = getDisplayedWaveformRange()) {
  const activeSelection = state.selectionDraft ?? state.loopRange;
  const span = Math.max(0, range.end - range.start);
  const viewportWidth = getWaveformViewportWidth();
  const spectrogramWidth = Math.max(0, elements.spectrogram.clientWidth);

  elements.waveformSelection.style.display = 'none';
  elements.waveformSelection.style.left = '0%';
  elements.waveformSelection.style.width = '0%';
  elements.spectrogramSelection.style.display = 'none';
  elements.spectrogramSelection.style.left = '0%';
  elements.spectrogramSelection.style.width = '0%';
  elements.waveformLoopStart.style.display = 'none';
  elements.waveformLoopEnd.style.display = 'none';
  elements.spectrogramLoopStart.style.display = 'none';
  elements.spectrogramLoopEnd.style.display = 'none';

  if (!activeSelection || span <= 0) {
    return;
  }

  if (activeSelection.end <= range.start || activeSelection.start >= range.end) {
    return;
  }

  const visibleSelection = {
    start: clamp(activeSelection.start, range.start, range.end),
    end: clamp(activeSelection.end, range.start, range.end),
  };
  const leftPercent = ((visibleSelection.start - range.start) / span) * 100;
  const widthPercent = Math.max(0, ((visibleSelection.end - visibleSelection.start) / span) * 100);

  if (viewportWidth > 0) {
    elements.waveformSelection.style.display = 'block';
    elements.waveformSelection.style.left = `${leftPercent}%`;
    elements.waveformSelection.style.width = `${widthPercent}%`;
  }

  if (spectrogramWidth > 0) {
    elements.spectrogramSelection.style.display = 'block';
    elements.spectrogramSelection.style.left = `${leftPercent}%`;
    elements.spectrogramSelection.style.width = `${widthPercent}%`;
  }

  if (!state.loopRange) {
    return;
  }

  if (viewportWidth > 0) {
    const startPx = ((visibleSelection.start - range.start) / span) * viewportWidth;
    const endPx = ((visibleSelection.end - range.start) / span) * viewportWidth;

    elements.waveformLoopStart.style.display = 'block';
    elements.waveformLoopStart.style.left = `${Math.max(0, startPx - LOOP_HANDLE_WIDTH_PX / 2)}px`;
    elements.waveformLoopEnd.style.display = 'block';
    elements.waveformLoopEnd.style.left = `${Math.max(0, endPx - LOOP_HANDLE_WIDTH_PX / 2)}px`;
  }

  if (spectrogramWidth > 0) {
    const startPx = ((visibleSelection.start - range.start) / span) * spectrogramWidth;
    const endPx = ((visibleSelection.end - range.start) / span) * spectrogramWidth;

    elements.spectrogramLoopStart.style.display = 'block';
    elements.spectrogramLoopStart.style.left = `${Math.max(0, startPx - LOOP_HANDLE_WIDTH_PX / 2)}px`;
    elements.spectrogramLoopEnd.style.display = 'block';
    elements.spectrogramLoopEnd.style.left = `${Math.max(0, endPx - LOOP_HANDLE_WIDTH_PX / 2)}px`;
  }
}

function renderWaveformUi(
  {
    displayRange = null,
    syncSpectrogram = true,
  }: {
    displayRange?: TimeRange | null;
    syncSpectrogram?: boolean;
  } = {},
) {
  const duration = getEffectiveDuration();
  const currentTime = getCurrentPlaybackTime();
  const range = cloneTimeRange(displayRange ?? getWaveformGroundTruthRange(currentTime));
  const span = Math.max(0, range.end - range.start);
  const zoomFactor = duration > 0 && span > 0 ? duration / span : 1;
  const loopLabelRange = state.selectionDraft ?? state.loopRange;
  const hasCommittedLoopRange = Boolean(state.loopRange);
  const loopGroup = elements.waveLoopLabel.parentElement;

  elements.waveZoomReset.textContent = 'Reset';
  if (elements.waveZoomChip) {
    elements.waveZoomChip.textContent = `Zoom ${zoomFactor.toFixed(1)}x`;
  }
  elements.waveFollow.checked = state.followPlayback;
  if (loopGroup instanceof HTMLElement) {
    loopGroup.hidden = false;
  }
  elements.waveLoopLabel.textContent = loopLabelRange
    ? `Loop ${formatAxisLabel(loopLabelRange.start)} - ${formatAxisLabel(loopLabelRange.end)}`
    : 'Drag to set loop';
  elements.waveClearLoop.disabled = !hasCommittedLoopRange;
  elements.waveClearLoop.tabIndex = 0;
  elements.waveClearLoop.setAttribute('aria-hidden', 'false');

  updateWaveformDisplayFromSnapshot(range, {
    currentTime,
    syncHover: true,
    syncSelection: true,
  });
  renderTransportTimelineOverview({
    currentTime,
    displayRange: range,
    duration,
    isPlayable: hasPlaybackTransport() && duration > 0,
  });
  if (syncSpectrogram) {
    scheduleSpectrogramRender();
  }
}

function renderWaveformAxis(options: WaveformAxisRenderOptions = {}) {
  elements.waveformAxis.replaceChildren();
  const snapshot = state.waveformDisplaySnapshot;

  if (!snapshot) {
    state.waveformAxisRenderRange = { start: 0, end: 0 };
    state.waveformAxisRenderWidth = 0;
    return;
  }

  const renderRange = options.renderRange ?? snapshot.renderRange;
  const renderWidth = Math.max(1, Math.round(options.renderWidth ?? snapshot.renderWidth));
  const viewportWidth = Math.max(1, elements.waveformAxis.clientWidth || getWaveformViewportWidth());
  const axisSnapshot = (
    !options.renderRange
    && !options.renderWidth
    && snapshot.axisTicks.length > 0
  )
    ? {
      renderRange: cloneTimeRange(snapshot.renderRange),
      renderWidth: snapshot.renderWidth,
      ticks: snapshot.axisTicks,
      viewportWidth,
    }
    : createWaveformAxisSnapshot(renderRange, renderWidth, viewportWidth, snapshot.visibleSpan);

  state.waveformAxisRenderRange = cloneTimeRange(axisSnapshot.renderRange);
  state.waveformAxisRenderWidth = axisSnapshot.renderWidth;

  const axisContent = document.createElement('div');
  axisContent.className = 'waveform-axis-content';
  axisContent.style.width = `${axisSnapshot.renderWidth}px`;

  axisSnapshot.ticks.forEach((tick) => {
    const transform =
      tick.align === 'start'
        ? 'translateX(0)'
        : tick.align === 'end'
          ? 'translateX(-100%)'
          : 'translateX(-50%)';

    const tickElement = document.createElement('div');
    tickElement.className = 'waveform-axis-tick';
    tickElement.style.left = `${tick.positionRatio * 100}%`;
    tickElement.style.transform = transform;

    const mark = document.createElement('div');
    mark.className = 'waveform-axis-mark';

    const label = document.createElement('div');
    label.className = 'waveform-axis-label';
    label.textContent = tick.label;

    const bottomMark = document.createElement('div');
    bottomMark.className = 'waveform-axis-mark';

    tickElement.append(mark, label, bottomMark);
    axisContent.append(tickElement);
  });

  elements.waveformAxis.append(axisContent);
  applyWaveformAxisTransform(
    options.displayRange ?? snapshot.displayRange ?? getWaveformRange(),
    options.displayMetrics ?? null,
  );
}

function applyTransportTimelineSnapshot(snapshot: TimelineViewportSnapshot) {
  const viewportStartPercent = snapshot.viewportStartRatio * 100;
  const viewportWidthPercent = Math.max(0, snapshot.viewportEndRatio - snapshot.viewportStartRatio) * 100;
  const currentPercent = snapshot.currentRatio * 100;

  elements.timeline.disabled = !snapshot.isPlayable;
  elements.timeline.value = String(snapshot.currentRatio);
  elements.timeline.style.setProperty('--seek-progress', `${currentPercent.toFixed(4)}%`);

  elements.waveformOverviewThumb.style.left = `${viewportStartPercent.toFixed(6)}%`;
  elements.waveformOverviewThumb.style.width = `${viewportWidthPercent.toFixed(6)}%`;
  elements.waveformOverviewThumb.style.transform = 'none';

  if (!snapshot.isPlayable || snapshot.duration <= 0) {
    elements.timelineCurrentMarker.hidden = true;
    elements.timelineCurrentMarker.style.left = '0%';
    return;
  }

  elements.timelineCurrentMarker.hidden = false;
  elements.timelineCurrentMarker.style.left = `${currentPercent.toFixed(6)}%`;
}

function renderTransportTimelineOverview(
  {
    currentTime = getCurrentPlaybackTime(),
    displayRange = getWaveformGroundTruthRange(currentTime),
    duration = getEffectiveDuration(),
    isPlayable = hasPlaybackTransport() && duration > 0,
  }: {
    currentTime?: number;
    displayRange?: TimeRange;
    duration?: number;
    isPlayable?: boolean;
  } = {},
) {
  const snapshot = createTimelineViewportSnapshot(
    duration,
    currentTime,
    displayRange,
    isPlayable,
  );
  applyTransportTimelineSnapshot(snapshot);
  return snapshot;
}

function applyWaveformPlaybackTime(timeSeconds, range = getWaveformGroundTruthRange(timeSeconds)) {
  const span = Math.max(0, range.end - range.start);

  if (span <= 0 || !Number.isFinite(timeSeconds)) {
    elements.waveformProgress.style.width = '0%';
    elements.waveformCursor.style.display = 'none';
    elements.waveformCursor.style.left = '0%';
    elements.spectrogramProgress.style.width = '0%';
    elements.spectrogramCursor.style.display = 'none';
    elements.spectrogramCursor.style.left = '0%';
    return;
  }

  const progressPercent = clamp(((timeSeconds - range.start) / span) * 100, 0, 100);
  const isCursorVisible = timeSeconds >= range.start && timeSeconds <= range.end;

  elements.waveformProgress.style.width = `${progressPercent}%`;
  elements.waveformCursor.style.left = `${progressPercent}%`;
  elements.waveformCursor.style.display = isCursorVisible ? 'block' : 'none';
  elements.spectrogramProgress.style.width = `${progressPercent}%`;
  elements.spectrogramCursor.style.left = `${progressPercent}%`;
  elements.spectrogramCursor.style.display = isCursorVisible ? 'block' : 'none';
}

function updateWaveformDisplayFromSnapshot(
  desiredDisplayRange = getWaveformRange(),
  {
    currentTime = getCurrentPlaybackTime(),
    smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(currentTime),
    syncHover = false,
    syncSelection = false,
    updateStoredRange = false,
  } = {},
) {
  if (updateStoredRange) {
    commitWaveformDisplayRange(desiredDisplayRange);
  }

  const displayMetrics = getWaveformSnapshotDisplayMetrics(state.waveformDisplaySnapshot, desiredDisplayRange);
  updateWaveformDisplaySnapshotWindow(desiredDisplayRange, state.waveformDisplaySnapshot, displayMetrics);
  const displayedRange = getDisplayedWaveformRange(desiredDisplayRange, displayMetrics);
  applyWaveformCanvasTransform(desiredDisplayRange, displayMetrics);
  applyWaveformAxisTransform(desiredDisplayRange, displayMetrics);

  if (syncSelection) {
    syncWaveformSelection(displayedRange);
  }

  applyWaveformPlaybackTime(currentTime, desiredDisplayRange);

  if (syncHover) {
    refreshWaveformHoverPresentation({
      displayMetrics,
      displayRange: displayedRange,
    });
  }

  return displayedRange;
}

function isSameWaveformRange(left: TimeRange | null | undefined, right: TimeRange | null | undefined) {
  return Boolean(left && right)
    && Math.abs((left?.start ?? 0) - (right?.start ?? 0)) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs((left?.end ?? 0) - (right?.end ?? 0)) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
}

function easeOutWaveformZoom(progress: number) {
  const clampedProgress = clamp(progress, 0, 1);
  return 1 - ((1 - clampedProgress) ** 3);
}

function interpolateWaveformRange(fromRange: TimeRange, toRange: TimeRange, progress: number): TimeRange {
  const easedProgress = easeOutWaveformZoom(progress);

  return {
    start: fromRange.start + ((toRange.start - fromRange.start) * easedProgress),
    end: fromRange.end + ((toRange.end - fromRange.end) * easedProgress),
  };
}

function doesWaveformSnapshotPhysicallyCoverDisplay(
  displayRange: TimeRange,
  snapshot: WaveformDisplaySnapshot | null = state.waveformDisplaySnapshot,
) {
  if (
    !snapshot
    || !(snapshot.renderRange.end > snapshot.renderRange.start)
    || snapshot.renderWidth <= 0
  ) {
    return false;
  }

  return snapshot.renderRange.start <= (displayRange.start + SPECTROGRAM_RANGE_EPSILON_SECONDS)
    && snapshot.renderRange.end >= (displayRange.end - SPECTROGRAM_RANGE_EPSILON_SECONDS);
}

function cancelWaveformZoomAnimation({ clearPending = true } = {}) {
  state.waveformZoomAnimationToken += 1;

  if (state.waveformZoomAnimationFrame) {
    window.cancelAnimationFrame(state.waveformZoomAnimationFrame);
    state.waveformZoomAnimationFrame = 0;
  }

  state.waveformZoomAnimation = null;

  if (clearPending) {
    state.waveformPendingZoomAnimation = null;
  }
}

function startWaveformZoomAnimation(fromRange: TimeRange, toRange: TimeRange) {
  cancelWaveformZoomAnimation({ clearPending: false });
  state.waveformPendingZoomAnimation = null;

  if (isSameWaveformRange(fromRange, toRange)) {
    renderWaveformUi({ syncSpectrogram: false });
    return;
  }

  state.waveformZoomAnimationToken += 1;
  const animationToken = state.waveformZoomAnimationToken;
  const startedAt = performance.now();

  const renderFrame = (range: TimeRange) => {
    state.waveformZoomAnimation = {
      currentRange: cloneTimeRange(range),
      fromRange: cloneTimeRange(fromRange),
      toRange: cloneTimeRange(toRange),
    };
    renderWaveformUi({
      displayRange: range,
      syncSpectrogram: false,
    });
  };

  renderFrame(fromRange);

  const step = (now: number) => {
    if (state.waveformZoomAnimationToken !== animationToken) {
      return;
    }

    const progress = WAVEFORM_ZOOM_ANIMATION_DURATION_MS <= 0
      ? 1
      : clamp((now - startedAt) / WAVEFORM_ZOOM_ANIMATION_DURATION_MS, 0, 1);
    const nextRange = interpolateWaveformRange(fromRange, toRange, progress);

    renderFrame(nextRange);

    if (progress >= 1) {
      state.waveformZoomAnimationFrame = 0;
      state.waveformZoomAnimation = null;
      renderWaveformUi({ syncSpectrogram: false });
      return;
    }

    state.waveformZoomAnimationFrame = window.requestAnimationFrame(step);
  };

  state.waveformZoomAnimationFrame = window.requestAnimationFrame(step);
}

function syncFollowView(
  timeSeconds,
  range = getWaveformRange(timeSeconds),
  smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(timeSeconds),
) {
  if (
    !state.followPlayback ||
    !Number.isFinite(timeSeconds) ||
    timeSeconds < 0 ||
    isFollowPlaybackInteractionActive()
  ) {
    return;
  }

  if (!isPlaybackActive()) {
    const duration = getEffectiveDuration();
    const centeredRange = centerWaveformRangeOnTime(getStoredWaveformRange(duration), timeSeconds, duration);
    updateWaveformDisplayFromSnapshot(centeredRange, {
      currentTime: timeSeconds,
      smoothFollowPlaybackActive: false,
      syncHover: true,
      syncSelection: true,
      updateStoredRange: true,
    });
    applyWaveformPlaybackTime(timeSeconds, centeredRange);

    if (!hasWaveformRenderCoverage(centeredRange, false)) {
      void syncWaveformView({
        currentTime: timeSeconds,
        displayRange: centeredRange,
        smoothFollowPlaybackActive: false,
      });
    }

    scheduleSpectrogramRender();
    return;
  }

  if (smoothFollowPlaybackActive) {
    updateWaveformDisplayFromSnapshot(range, {
      currentTime: timeSeconds,
      smoothFollowPlaybackActive,
      syncHover: true,
      syncSelection: true,
      updateStoredRange: true,
    });

    if (!hasWaveformRenderCoverage(range, smoothFollowPlaybackActive)) {
      void syncWaveformView({
        currentTime: timeSeconds,
        displayRange: range,
        smoothFollowPlaybackActive,
      });
    }
    scheduleSpectrogramRender();
    return;
  }

  const duration = getEffectiveDuration();
  const span = Math.max(0, range.end - range.start);

  if (duration <= 0 || span <= 0) {
    return;
  }

  const leftThresholdTime = range.start + span * WAVEFORM_FOLLOW_LEFT_THRESHOLD_RATIO;
  const rightThresholdTime = range.start + span * WAVEFORM_FOLLOW_RIGHT_THRESHOLD_RATIO;

  if (timeSeconds >= leftThresholdTime && timeSeconds <= rightThresholdTime) {
    return;
  }

  const nextStart = clamp(
    timeSeconds - span * WAVEFORM_FOLLOW_TARGET_RATIO,
    0,
    Math.max(0, duration - span),
  );

  if (Math.abs(nextStart - range.start) < 0.001) {
    return;
  }

  cancelWaveformZoomAnimation();
  state.waveformViewRange = {
    start: nextStart,
    end: nextStart + span,
  };
  renderWaveformUi();
  queueVisibleSpectrogramRequest();
  void syncWaveformView({
    currentTime: timeSeconds,
    displayRange: getWaveformRange(timeSeconds, false),
    smoothFollowPlaybackActive: false,
  });
}

async function syncWaveformView(
  {
    currentTime = getCurrentPlaybackTime(),
    displayRange = getWaveformRange(currentTime),
    force = false,
    smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(currentTime),
  } = {},
) {
  state.waveformRenderForcePending = state.waveformRenderForcePending || force;
  state.waveformRenderRequestOptions = {
    currentTime,
    displayRange: cloneTimeRange(displayRange),
    smoothFollowPlaybackActive,
  };

  if (state.waveformFrame) {
    return;
  }

  state.waveformFrame = window.requestAnimationFrame(() => {
    state.waveformFrame = 0;
    const nextRequest = state.waveformRenderRequestOptions;
    const nextForce = state.waveformRenderForcePending;
    state.waveformRenderRequestOptions = null;
    state.waveformRenderForcePending = false;

    if (!nextRequest) {
      return;
    }

    void requestWaveformViewRender({
      currentTime: nextRequest.currentTime,
      displayRange: nextRequest.displayRange,
      force: nextForce,
      smoothFollowPlaybackActive: nextRequest.smoothFollowPlaybackActive,
    });
  });
}

async function requestWaveformViewRender(
  {
    currentTime = getCurrentPlaybackTime(),
    displayRange = getWaveformRange(currentTime),
    force = false,
    smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(currentTime),
  } = {},
) {
  const duration = getEffectiveDuration();
  const { estimatedPlotMode, height, renderRange, renderWidth } = getWaveformRenderRequestMetrics(
    displayRange,
    smoothFollowPlaybackActive,
  );
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  const coverageMetrics = {
    displaySpan: visibleSpan,
    height,
    renderWidth,
  };

  if (!state.waveformCanvas || !state.waveformWorker || duration <= 0 || displayRange.end <= displayRange.start) {
    return;
  }

  if (!force && hasWaveformRenderCoverage(displayRange, smoothFollowPlaybackActive)) {
    updateWaveformDisplayFromSnapshot(displayRange, {
      currentTime,
      smoothFollowPlaybackActive,
      syncHover: true,
    });
    return;
  }

  if (!force && smoothFollowPlaybackActive && shouldDeferWaveformFollowRenderRequest(displayRange, coverageMetrics)) {
    updateWaveformDisplayFromSnapshot(displayRange, {
      currentTime,
      smoothFollowPlaybackActive,
      syncHover: true,
    });
    return;
  }

  state.waveformRequestGeneration += 1;
  state.waveformPendingRequest = {
    displayRange: cloneTimeRange(displayRange),
    end: renderRange.end,
    generation: state.waveformRequestGeneration,
    height,
    rawSamplePlotMode: estimatedPlotMode === 'raw',
    samplePlotMode: estimatedPlotMode !== 'envelope',
    start: renderRange.start,
    visibleSpan,
    width: renderWidth,
  };
  state.waveformWorker.postMessage({
    type: 'renderWaveformView',
    body: {
      color: WAVEFORM_COLOR,
      generation: state.waveformRequestGeneration,
      height,
      renderScale: WAVEFORM_RENDER_SCALE,
      viewEnd: renderRange.end,
      viewStart: renderRange.start,
      visibleSpan,
      width: renderWidth,
    },
  });
}

function updateWaveformViewRange(updater, { animateZoom = false }: WaveformViewRangeUpdateOptions = {}) {
  const duration = getEffectiveDuration();

  if (duration <= 0) {
    return;
  }

  const current = getWaveformRange();
  const rawNext = updater(current);
  const nextRange = normalizeWaveformRange(rawNext, duration);

  if (
    Math.abs(nextRange.start - current.start) <= 1e-9
    && Math.abs(nextRange.end - current.end) <= 1e-9
  ) {
    return;
  }

  state.waveformViewRange = nextRange;

  if (animateZoom) {
    const zoomAnimation = {
      fromRange: cloneTimeRange(current),
      toRange: cloneTimeRange(nextRange),
    };

    if (doesWaveformSnapshotPhysicallyCoverDisplay(nextRange)) {
      startWaveformZoomAnimation(zoomAnimation.fromRange, zoomAnimation.toRange);
    } else {
      cancelWaveformZoomAnimation({ clearPending: false });
      state.waveformPendingZoomAnimation = zoomAnimation;
      renderWaveformUi({
        displayRange: current,
        syncSpectrogram: false,
      });
    }
  } else {
    cancelWaveformZoomAnimation();
    renderWaveformUi();
  }
  queueVisibleSpectrogramRequest();
  void syncWaveformView();
}

function zoomAroundTime(anchorTime, requestedSpan) {
  const duration = getEffectiveDuration();
  const range = getWaveformRange();
  const span = range.end - range.start;

  if (duration <= 0 || span <= 0) {
    return;
  }

  const nextSpan = clamp(
    requestedSpan,
    getMinVisibleDuration(duration),
    Math.max(getMinVisibleDuration(duration), duration),
  );

  if (Math.abs(nextSpan - span) <= 1e-9) {
    return;
  }

  const ratio = span > 0 ? clamp((anchorTime - range.start) / span, 0, 1) : 0.5;
  const nextStart = anchorTime - nextSpan * ratio;

  updateWaveformViewRange(() => ({
    start: nextStart,
    end: nextStart + nextSpan,
  }), { animateZoom: true });
}

function zoomWaveformIn() {
  const range = getWaveformRange();
  const span = range.end - range.start;

  if (span <= 0) {
    return;
  }

  zoomAroundTime(range.start + span * 0.5, span / WAVEFORM_ZOOM_STEP_FACTOR);
}

function zoomWaveformOut() {
  const range = getWaveformRange();
  const span = range.end - range.start;

  if (span <= 0) {
    return;
  }

  zoomAroundTime(range.start + span * 0.5, span * WAVEFORM_ZOOM_STEP_FACTOR);
}

function resetWaveformZoom() {
  const duration = getEffectiveDuration();

  if (duration <= 0) {
    return;
  }

  updateWaveformViewRange(() => ({ start: 0, end: duration }), { animateZoom: true });
}

function disableFollowPlayback() {
  if (!state.followPlayback) {
    return;
  }

  setFollowPlaybackEnabled(false);
}

function setFollowPlaybackEnabled(enabled) {
  const nextEnabled = Boolean(enabled);

  if (state.followPlayback === nextEnabled && elements.waveFollow.checked === nextEnabled) {
    return;
  }

  state.followPlayback = nextEnabled;
  elements.waveFollow.checked = nextEnabled;
  syncTransport();
}

function updateTimelineHoverTooltip(event) {
  const duration = getEffectiveDuration();
  const rect = elements.waveformOverview.getBoundingClientRect();

  if (!Number.isFinite(duration) || duration <= 0 || rect.width <= 0) {
    hideTimelineHoverTooltip();
    return;
  }

  const offsetX = clamp(event.clientX - rect.left, 0, rect.width);
  const ratio = offsetX / rect.width;
  const timeSeconds = clamp(ratio * duration, 0, duration);
  const tooltipX = clamp(offsetX, 18, Math.max(18, rect.width - 18));

  elements.timelineHoverTooltip.textContent = formatAxisLabel(timeSeconds);
  elements.timelineHoverTooltip.style.left = `${tooltipX}px`;
  elements.timelineHoverTooltip.classList.add('visible');
}

function hideTimelineHoverTooltip() {
  elements.timelineHoverTooltip.classList.remove('visible');
}

function hideSurfaceHoverTooltip(tooltipElement) {
  if (!tooltipElement) {
    return;
  }

  tooltipElement.classList.remove('visible');
  tooltipElement.setAttribute('aria-hidden', 'true');
}

function updateSurfaceHoverTooltip(tooltipElement, targetElement, event, label) {
  if (!tooltipElement || !targetElement || !label) {
    hideSurfaceHoverTooltip(tooltipElement);
    return;
  }

  const rect = targetElement.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    hideSurfaceHoverTooltip(tooltipElement);
    return;
  }

  const localX = clamp(event.clientX - rect.left, 0, rect.width);
  const localY = clamp(event.clientY - rect.top, 0, rect.height);

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

function hideWaveformSampleMarker() {
  if (!elements.waveformSampleMarker) {
    return;
  }

  elements.waveformSampleMarker.style.display = 'none';
  elements.waveformSampleMarker.style.left = '0px';
  elements.waveformSampleMarker.style.top = '0px';
}

function showWaveformSampleMarker(sampleInfo) {
  if (!elements.waveformSampleMarker || !sampleInfo?.showMarker) {
    hideWaveformSampleMarker();
    return;
  }

  elements.waveformSampleMarker.style.display = 'block';
  elements.waveformSampleMarker.style.left = `${sampleInfo.markerX}px`;
  elements.waveformSampleMarker.style.top = `${sampleInfo.markerY}px`;
}

function getWaveformCanvasDisplayMetrics(
  targetElement,
  desiredDisplayRange = getWaveformRange(),
  displayMetrics = getWaveformSnapshotDisplayMetrics(state.waveformDisplaySnapshot, desiredDisplayRange),
) {
  if (!targetElement) {
    return null;
  }

  const rect = targetElement.getBoundingClientRect();
  const viewportWidth = rect.width;
  const viewportHeight = rect.height;

  if (!(viewportWidth > 0) || !(viewportHeight > 0) || !(desiredDisplayRange.end > desiredDisplayRange.start)) {
    return null;
  }

  const snapshot = updateWaveformDisplaySnapshotWindow(
    desiredDisplayRange,
    state.waveformDisplaySnapshot,
    displayMetrics,
  );
  const renderRange = snapshot?.renderRange ?? desiredDisplayRange;
  const renderWidth = snapshot ? Math.max(1, snapshot.renderWidth) : viewportWidth;
  const renderSpan = Math.max(0, renderRange.end - renderRange.start);
  const renderColumnCount = snapshot?.columnCount ?? Math.max(1, Math.round(renderWidth * Math.max(1, WAVEFORM_RENDER_SCALE)));
  const renderDeviceHeight = Math.max(1, Math.round(viewportHeight * Math.max(1, WAVEFORM_RENDER_SCALE)));
  const sourceOffsetPx = snapshot?.displayOffsetPx ?? 0;

  if (!(renderSpan > 0) || !(renderWidth > 0)) {
    return null;
  }

  return {
    rect,
    renderColumnCount,
    renderDeviceHeight,
    renderRange,
    renderSpan,
    renderWidth,
    sourceOffsetPx,
    viewportWidth,
  };
}

function getWaveformMarkerY(sampleValue, rectHeight, renderDeviceHeight = Math.max(1, Math.round(rectHeight * Math.max(1, WAVEFORM_RENDER_SCALE)))) {
  const deviceHeight = Math.max(1, Math.round(renderDeviceHeight));
  const chartTopDevice = Math.round(WAVEFORM_TOP_PADDING_PX * Math.max(1, WAVEFORM_RENDER_SCALE));
  const chartBottomDevice = Math.max(
    chartTopDevice + 1,
    Math.round((rectHeight - WAVEFORM_BOTTOM_PADDING_PX) * Math.max(1, WAVEFORM_RENDER_SCALE)),
  );
  const chartHeightDevice = Math.max(1, chartBottomDevice - chartTopDevice);
  const midYDevice = chartTopDevice + (chartHeightDevice * 0.5);
  const yDevice = clamp(
    midYDevice - (sampleValue * chartHeightDevice * WAVEFORM_AMPLITUDE_HEIGHT_RATIO),
    chartTopDevice,
    chartBottomDevice,
  );

  return clamp(yDevice * (rectHeight / deviceHeight), 0, rectHeight);
}

function pickRepresentativeWaveformSample(samples, startPosition, endPosition) {
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
    index: bestIndex,
    value: bestValue,
  };
}

function getWaveformRenderableMaxX(renderWidth, renderColumnCount) {
  return renderColumnCount <= 1
    ? 0
    : ((renderColumnCount - 1) * renderWidth) / renderColumnCount;
}

function getWaveformSampleBucketSize(visibleSampleCount, renderColumnCount) {
  if (!(visibleSampleCount > 0) || !(renderColumnCount > 0)) {
    return 1;
  }

  return Math.max(1, Math.round(visibleSampleCount / renderColumnCount));
}

function getWaveformSamplePositionAtRenderOffset(
  renderOffsetX,
  renderWidth,
  renderColumnCount,
  sampleStartPosition,
  visibleSampleSpan,
) {
  const maxRenderableX = getWaveformRenderableMaxX(renderWidth, renderColumnCount);

  if (maxRenderableX <= 0 || visibleSampleSpan <= 0) {
    return sampleStartPosition;
  }

  return sampleStartPosition + ((clamp(renderOffsetX, 0, maxRenderableX) / maxRenderableX) * visibleSampleSpan);
}

function getWaveformMarkerXForSampleIndex(
  sampleIndex,
  sampleStartPosition,
  visibleSampleSpan,
  renderWidth,
  renderColumnCount,
  sourceOffsetPx,
  viewportWidth,
) {
  const maxRenderableX = getWaveformRenderableMaxX(renderWidth, renderColumnCount);

  return clamp(
    visibleSampleSpan <= 0
      ? 0
      : (((sampleIndex - sampleStartPosition) / visibleSampleSpan) * maxRenderableX) - sourceOffsetPx,
    0,
    viewportWidth,
  );
}

function getWaveformSampleInfoAtClientX(
  clientX,
  {
    displayMetrics = null,
    displayRange = getDisplayedWaveformRange(),
  }: {
    displayMetrics?: WaveformDisplayWindowMetrics | null;
    displayRange?: TimeRange;
  } = {},
) {
  const samples = state.waveformSamples;
  const sampleRate = Number(state.analysis?.sampleRate);
  const targetElement = elements.waveformHitTarget ?? elements.waveformViewport;
  const snapshot = state.waveformDisplaySnapshot;
  const span = Math.max(0, displayRange.end - displayRange.start);

  if (
    !snapshot?.samplePlotMode
    || !samples
    || samples.length === 0
    || !Number.isFinite(sampleRate)
    || sampleRate <= 0
    || !targetElement
    || span <= 0
  ) {
    return null;
  }

  const { offsetX, width } = getWaveformPointerMetrics(clientX);
  const renderMetrics = getWaveformCanvasDisplayMetrics(targetElement, displayRange, displayMetrics);
  const rect = targetElement.getBoundingClientRect();

  if (width <= 0 || rect.height <= 0 || !renderMetrics) {
    return null;
  }

  const visibleSampleCount = Math.max(1, renderMetrics.renderSpan * sampleRate);
  const sampleStartPosition = renderMetrics.renderRange.start * sampleRate;
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const visibleSampleSpan = Math.max(0, visibleSampleCount - 1);
  const renderWidth = Math.max(1, renderMetrics.renderWidth);
  const renderColumnCount = Math.max(1, renderMetrics.renderColumnCount);
  const renderOffsetX = clamp(renderMetrics.sourceOffsetPx + offsetX, 0, renderWidth);

  if (snapshot.rawSamplePlotMode) {
    const samplePosition = getWaveformSamplePositionAtRenderOffset(
      renderOffsetX,
      renderWidth,
      renderColumnCount,
      sampleStartPosition,
      visibleSampleSpan,
    );
    const sampleIndex = clamp(Math.round(samplePosition), 0, maxSampleIndex);
    const sampleValue = samples[sampleIndex] ?? 0;

    return {
      markerX: getWaveformMarkerXForSampleIndex(
        sampleIndex,
        sampleStartPosition,
        visibleSampleSpan,
        renderWidth,
        renderColumnCount,
        renderMetrics.sourceOffsetPx,
        renderMetrics.viewportWidth,
      ),
      markerY: getWaveformMarkerY(sampleValue, rect.height, renderMetrics.renderDeviceHeight),
      sampleIndex,
      sampleNumber: sampleIndex + 1,
      sampleTimeSeconds: sampleIndex / sampleRate,
      sampleValue,
      showMarker: true,
    };
  }

  const sampleBucketSize = getWaveformSampleBucketSize(visibleSampleCount, renderColumnCount);
  const samplePosition = getWaveformSamplePositionAtRenderOffset(
    renderOffsetX,
    renderWidth,
    renderColumnCount,
    sampleStartPosition,
    visibleSampleSpan,
  );
  const bucketIndex = Math.floor(samplePosition / sampleBucketSize);
  const bucketStartPosition = bucketIndex * sampleBucketSize;
  const bucketEndPosition = bucketStartPosition + sampleBucketSize;
  const representativeSample = pickRepresentativeWaveformSample(samples, bucketStartPosition, bucketEndPosition);

  if (!representativeSample) {
    return null;
  }

  return {
    markerX: getWaveformMarkerXForSampleIndex(
      representativeSample.index,
      sampleStartPosition,
      visibleSampleSpan,
      renderWidth,
      renderColumnCount,
      renderMetrics.sourceOffsetPx,
      renderMetrics.viewportWidth,
    ),
    markerY: getWaveformMarkerY(representativeSample.value, rect.height, renderMetrics.renderDeviceHeight),
    sampleIndex: representativeSample.index,
    sampleNumber: representativeSample.index + 1,
    sampleTimeSeconds: representativeSample.index / sampleRate,
    sampleValue: representativeSample.value,
    showMarker: true,
  };
}

function formatWaveformSampleOrdinal(sampleNumber) {
  return Number.isFinite(sampleNumber) && sampleNumber > 0
    ? Math.round(sampleNumber).toLocaleString()
    : '0';
}

function formatWaveformSampleValue(sampleValue) {
  const normalized = Math.abs(sampleValue) < 0.00005 ? 0 : sampleValue;
  return normalized.toFixed(6).replace(/(?:\.0+|(\.\d*?[1-9]))0+$/, '$1');
}

function refreshWaveformHoverPresentation(
  {
    displayMetrics = null,
    displayRange = getDisplayedWaveformRange(),
  }: {
    displayMetrics?: WaveformDisplayWindowMetrics | null;
    displayRange?: TimeRange;
  } = {},
) {
  const duration = getEffectiveDuration();
  const point = state.waveformHoverClientPoint;

  if (!point || !hasPlaybackTransport() || duration <= 0) {
    hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
    hideWaveformSampleMarker();
    return;
  }

  const sampleInfo = getWaveformSampleInfoAtClientX(point.clientX, {
    displayMetrics,
    displayRange,
  });
  const sampleDetail = sampleInfo?.showMarker ? sampleInfo : null;
  const timeLabel = sampleDetail && Number.isFinite(sampleDetail.sampleTimeSeconds)
    ? formatAxisLabel(sampleDetail.sampleTimeSeconds)
    : formatAxisLabel(getTimeAtWaveformClientX(point.clientX, displayRange));
  const label = sampleDetail
    ? `${timeLabel} - Sample ${formatWaveformSampleOrdinal(sampleDetail.sampleNumber)}, Value ${formatWaveformSampleValue(sampleDetail.sampleValue)}`
    : timeLabel;

  updateSurfaceHoverTooltip(
    elements.waveformHoverTooltip,
    elements.waveformViewport ?? elements.waveformHitTarget,
    point,
    label,
  );
  showWaveformSampleMarker(sampleDetail);
}

function updateWaveformHoverTooltip(event) {
  if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
    hideWaveformHoverTooltip();
    return;
  }

  state.waveformHoverClientPoint = {
    clientX: event.clientX,
    clientY: event.clientY,
  };
  refreshWaveformHoverPresentation();
}

function hideWaveformHoverTooltip() {
  state.waveformHoverClientPoint = null;
  hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
  hideWaveformSampleMarker();
}

function getFrequencyAtSpectrogramPointerEvent(event) {
  const targetElement = elements.spectrogramHitTarget ?? elements.spectrogram;

  if (!targetElement) {
    return SPECTROGRAM_MIN_FREQUENCY;
  }

  const rect = targetElement.getBoundingClientRect();

  if (rect.height <= 0) {
    return SPECTROGRAM_MIN_FREQUENCY;
  }

  const minFrequency = state.analysis?.minFrequency ?? SPECTROGRAM_MIN_FREQUENCY;
  const maxFrequency = state.analysis?.maxFrequency ?? SPECTROGRAM_MAX_FREQUENCY;
  const position = clamp((event.clientY - rect.top) / rect.height, 0, 1);

  return getFrequencyAtSpectrogramPosition(position, minFrequency, maxFrequency);
}

function updateSpectrogramHoverTooltip(event) {
  const duration = getEffectiveDuration();

  if (!hasPlaybackTransport() || duration <= 0) {
    hideSurfaceHoverTooltip(elements.spectrogramHoverTooltip);
    return;
  }

  const timeLabel = formatAxisLabel(getTimeAtViewportPointerEvent(event, elements.spectrogramHitTarget));
  const frequencyLabel = formatFrequencyLabel(getFrequencyAtSpectrogramPointerEvent(event));

  updateSurfaceHoverTooltip(
    elements.spectrogramHoverTooltip,
    elements.spectrogramHitTarget,
    event,
    `${timeLabel} • ${frequencyLabel}`,
  );
}

function hideSpectrogramHoverTooltip() {
  hideSurfaceHoverTooltip(elements.spectrogramHoverTooltip);
}

function updateLoopHandleHoverTooltip(event, targetElement) {
  if (targetElement === elements.waveformHitTarget) {
    updateWaveformHoverTooltip(event);
    return;
  }

  if (targetElement === elements.spectrogramHitTarget) {
    updateSpectrogramHoverTooltip(event);
  }
}

function hideLoopHandleHoverTooltip(targetElement) {
  if (targetElement === elements.waveformHitTarget) {
    hideWaveformHoverTooltip();
    return;
  }

  if (targetElement === elements.spectrogramHitTarget) {
    hideSpectrogramHoverTooltip();
  }
}

function seekWaveformTo(timeSeconds) {
  setPlaybackPosition(timeSeconds);
}

function seekWaveformAtClientX(clientX) {
  seekWaveformTo(getTimeAtWaveformClientX(clientX));
}

function beginSelectionDrag(event, targetElement) {
  disableFollowPlayback();
  event.preventDefault();
  targetElement.setPointerCapture(event.pointerId);
  state.selectionDrag = {
    pointerId: event.pointerId,
    anchorTime: getTimeAtViewportPointerEvent(event, targetElement),
    anchorX: event.clientX,
    moved: false,
    targetElement,
  };
  state.selectionDraft = null;
  syncWaveformSelection();
}

function updateSelectionDrag(event, targetElement) {
  if (state.loopHandleDrag) {
    return;
  }

  const selectionDrag = state.selectionDrag;

  if (!selectionDrag || selectionDrag.pointerId !== event.pointerId || selectionDrag.targetElement !== targetElement) {
    return;
  }

  const endTime = getTimeAtViewportPointerEvent(event, targetElement);
  const pointerDelta = Math.abs(event.clientX - selectionDrag.anchorX);
  const nextSelection = normalizeLoopRange(selectionDrag.anchorTime, endTime);

  if (!selectionDrag.moved) {
    const timeDelta = Math.abs(endTime - selectionDrag.anchorTime);

    if (pointerDelta < LOOP_SELECTION_MIN_PIXELS && timeDelta < LOOP_SELECTION_MIN_SECONDS) {
      return;
    }

    selectionDrag.moved = true;
  }

  state.selectionDraft = nextSelection ?? {
    start: Math.min(selectionDrag.anchorTime, endTime),
    end: Math.max(selectionDrag.anchorTime, endTime),
  };
  syncWaveformSelection();
}

function releaseSelectionDrag(event, targetElement, cancelled = false) {
  const selectionDrag = state.selectionDrag;

  if (!selectionDrag || selectionDrag.pointerId !== event.pointerId || selectionDrag.targetElement !== targetElement) {
    return;
  }

  if (selectionDrag.targetElement.hasPointerCapture?.(event.pointerId)) {
    selectionDrag.targetElement.releasePointerCapture(event.pointerId);
  }

  state.selectionDrag = null;

  if (cancelled) {
    state.selectionDraft = null;
    syncWaveformSelection();
    return;
  }

  const endTime = getTimeAtViewportPointerEvent(event, targetElement);
  const nextSelection = normalizeLoopRange(selectionDrag.anchorTime, endTime);
  state.selectionDraft = null;

  if (selectionDrag.moved && nextSelection) {
    state.loopRange = nextSelection;
    state.audioTransport?.setLoop(nextSelection);
    renderWaveformUi();
    syncTransport();
    return;
  }

  if (!isTimeWithinLoopRange(state.loopRange, selectionDrag.anchorTime)) {
    state.loopRange = null;
    state.audioTransport?.setLoop(null);
  }

  seekWaveformTo(selectionDrag.anchorTime);
  renderWaveformUi();
  syncTransport();
}

function startLoopHandleDrag(event, edge, handleElement, targetElement) {
  if (!state.loopRange) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  handleElement.setPointerCapture(event.pointerId);
  state.loopHandleDrag = {
    pointerId: event.pointerId,
    edge,
    baseRange: { ...state.loopRange },
    handleElement,
    targetElement,
  };
  state.selectionDraft = { ...state.loopRange };
  syncWaveformSelection();
}

function moveLoopHandleDrag(event) {
  const dragState = state.loopHandleDrag;

  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }

  event.stopPropagation();
  state.selectionDraft = getAdjustedLoopRange(dragState.baseRange, dragState.edge, event.clientX, dragState.targetElement);
  syncWaveformSelection();
}

function releaseLoopHandleDrag(event, cancelled = false) {
  const dragState = state.loopHandleDrag;

  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }

  event.stopPropagation();

  if (dragState.handleElement.hasPointerCapture?.(event.pointerId)) {
    dragState.handleElement.releasePointerCapture(event.pointerId);
  }

  const nextRange = getAdjustedLoopRange(dragState.baseRange, dragState.edge, event.clientX, dragState.targetElement);
  state.loopHandleDrag = null;
  state.selectionDraft = null;

  if (!cancelled) {
    state.loopRange = nextRange;
    state.audioTransport?.setLoop(nextRange);
  }

  renderWaveformUi();
  syncTransport();
}

function bindLoopHandle(handleElement, edge, targetElement) {
  handleElement.addEventListener('pointerdown', (event) => {
    startLoopHandleDrag(event, edge, handleElement, targetElement);
  });
  handleElement.addEventListener('pointermove', (event) => {
    updateLoopHandleHoverTooltip(event, targetElement);
    moveLoopHandleDrag(event);
  });
  handleElement.addEventListener('pointerleave', () => {
    if (state.loopHandleDrag?.handleElement !== handleElement) {
      hideLoopHandleHoverTooltip(targetElement);
    }
  });
  handleElement.addEventListener('pointerup', (event) => {
    releaseLoopHandleDrag(event);
  });
  handleElement.addEventListener('pointercancel', (event) => {
    hideLoopHandleHoverTooltip(targetElement);
    releaseLoopHandleDrag(event, true);
  });
}

async function decodeAudioData(arrayBuffer) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextConstructor) {
    throw new Error('Web Audio API is unavailable in this webview.');
  }

  const context = new AudioContextConstructor();

  try {
    return await context.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    if (typeof context.close === 'function') {
      await context.close().catch(() => {});
    }
  }
}

async function initializeDecodedPlayback(loadToken, payload, decodedAudio) {
  await initializePlaybackFromPreparedData(loadToken, payload, createPlaybackAnalysisData(decodedAudio));
}

async function initializePlaybackFromPreparedData(loadToken, payload, preparedPlaybackData) {
  const { monoSamples, playbackSession } = preparedPlaybackData;
  state.playbackSession = playbackSession;
  state.waveformSamples = monoSamples;

  scheduleDeferredAnalysis(loadToken, payload, monoSamples);

  await state.audioTransport?.load({
    playbackSession,
    workletModuleUrl: audioTransportProcessorScriptUri,
  });

  state.playbackTransportKind = state.audioTransport?.getTransportKind?.() ?? state.playbackTransportKind;
  state.playbackTransportError =
    state.audioTransport?.getLastFallbackReason?.() ?? state.playbackTransportError;

  if (loadToken !== state.loadToken) {
    return;
  }

  ensureWaveformViewRange();
  renderWaveformUi();
  syncTransport();
  if (state.playbackTransportKind === 'unavailable' && state.playbackTransportError) {
    setAnalysisStatus(`Playback unavailable: ${state.playbackTransportError}`, true);
  } else {
    setAnalysisStatus('Playback ready');
  }
}

function getWaveformViewportSize() {
  return {
    width: Math.max(1, elements.waveformViewport.clientWidth),
    height: Math.max(1, elements.waveformViewport.clientHeight),
  };
}

function getWaveformViewportWidth() {
  return Math.max(1, elements.waveformViewport.clientWidth);
}

function getWaveformRange(
  playbackTime = null,
  smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(playbackTime),
) {
  const duration = getEffectiveDuration();
  const storedRange = getStoredWaveformRange(duration);

  if (!smoothFollowPlaybackActive) {
    return storedRange;
  }

  const timeSeconds = clamp(
    Number.isFinite(playbackTime) ? Number(playbackTime) : getCurrentPlaybackTime(),
    0,
    duration,
  );

  return centerWaveformRangeOnTime(storedRange, timeSeconds, duration);
}

function getStoredWaveformRange(duration = getEffectiveDuration()) {
  const current = {
    start: Number.isFinite(state.waveformViewRange.start) ? state.waveformViewRange.start : 0,
    end: Number.isFinite(state.waveformViewRange.end) ? state.waveformViewRange.end : 0,
  };

  if (!Number.isFinite(duration) || duration <= 0) {
    return { start: 0, end: 0 };
  }

  if (!(current.end > current.start)) {
    return { start: 0, end: duration };
  }

  return normalizeWaveformRange(current, duration);
}

function commitWaveformDisplayRange(range, duration = getEffectiveDuration()) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }

  cancelWaveformZoomAnimation();
  state.waveformViewRange = normalizeWaveformRange(range, duration);
}

function centerWaveformRangeOnTime(range, timeSeconds, duration = getEffectiveDuration()) {
  return centerWaveformRangeOnTimePure(range, timeSeconds, duration, getMinVisibleDuration(duration));
}

function expandWaveformRange(range, duration, factor) {
  return expandWaveformRangePure(range, duration, factor, getMinVisibleDuration(duration));
}

function getWaveformFollowRenderPlan(displayRange, duration, displayWidth) {
  const planner = getWaveDisplayPlannerIfReady();

  if (!planner) {
    return null;
  }

  const preferredCandidate = getCommittedWaveformRenderCandidate() ?? getPendingWaveformRenderCandidate();

  return planner.planWaveformFollowRender({
    bufferFactor: WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR,
    displayEnd: displayRange.end,
    displayStart: displayRange.start,
    displayWidth,
    duration,
    epsilon: SPECTROGRAM_RANGE_EPSILON_SECONDS,
    marginRatio: WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO,
    preferredEnd: preferredCandidate?.end ?? null,
    preferredStart: preferredCandidate?.start ?? null,
    renderScale: WAVEFORM_RENDER_SCALE,
  });
}

function getStableFollowWaveformRenderRange(displayRange, duration, renderWidth) {
  const expandedRange = expandWaveformRange(displayRange, duration, WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR);
  const renderSpan = Math.max(0, expandedRange.end - expandedRange.start);
  const preferredCandidate = getCommittedWaveformRenderCandidate() ?? getPendingWaveformRenderCandidate();

  if (
    !preferredCandidate
    || !(preferredCandidate.end > preferredCandidate.start)
    || renderSpan <= 0
    || duration <= 0
    || renderWidth <= 0
  ) {
    return snapWaveformRenderRange(displayRange, expandedRange, duration, renderWidth);
  }

  const preferredSpan = preferredCandidate.end - preferredCandidate.start;
  const spanTolerance = Math.max(SPECTROGRAM_RANGE_EPSILON_SECONDS, renderSpan * 0.001);

  if (Math.abs(preferredSpan - renderSpan) > spanTolerance) {
    return snapWaveformRenderRange(displayRange, expandedRange, duration, renderWidth);
  }

  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  const maxStart = Math.max(0, duration - renderSpan);
  const availablePadding = Math.max(0, (renderSpan - visibleSpan) * 0.5);
  const requestedPadding = Math.max(0, renderSpan * WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO);
  const effectivePadding = Math.min(availablePadding, requestedPadding);
  const lowerBound = clamp(displayRange.end - renderSpan + effectivePadding, 0, maxStart);
  const upperBound = clamp(displayRange.start - effectivePadding, lowerBound, maxStart);
  const columnCount = Math.max(1, Math.round(renderWidth * WAVEFORM_RENDER_SCALE));
  const secondsPerColumn = renderSpan / columnCount;
  const unclampedStart = clamp(preferredCandidate.start, lowerBound, upperBound);
  const snappedStart = Number.isFinite(secondsPerColumn) && secondsPerColumn > 0
    ? Math.round(unclampedStart / secondsPerColumn) * secondsPerColumn
    : unclampedStart;
  const nextStart = clamp(snappedStart, lowerBound, upperBound);

  return {
    start: nextStart,
    end: nextStart + renderSpan,
  };
}

function getWaveformSamplesPerPixel(
  displayRange = getWaveformRange(),
  renderWidth = getWaveformViewportWidth(),
) {
  const sampleRate = Number(state.analysis?.sampleRate);
  const span = Math.max(0, displayRange.end - displayRange.start);
  const columnCount = Math.max(1, Math.round(renderWidth * WAVEFORM_RENDER_SCALE));

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || span <= 0 || columnCount <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, span * sampleRate) / columnCount;
}

function estimateWaveformPlotMode(
  displayRange = getWaveformRange(),
  renderWidth = getWaveformViewportWidth(),
) {
  const samplesPerPixel = getWaveformSamplesPerPixel(displayRange, renderWidth);
  const stickyRaw = Boolean(
    state.waveformRawSamplePlotMode
    || state.waveformPendingRequest?.rawSamplePlotMode,
  );
  const stickySample = Boolean(
    stickyRaw
    || state.waveformSamplePlotMode
    || state.waveformPendingRequest?.samplePlotMode,
  );

  if (!Number.isFinite(samplesPerPixel)) {
    return 'envelope';
  }

  if (stickyRaw) {
    if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL) {
      return 'raw';
    }

    return samplesPerPixel <= WAVEFORM_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (stickySample) {
    if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
      return 'raw';
    }

    return samplesPerPixel <= WAVEFORM_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
    return 'raw';
  }

  return samplesPerPixel <= WAVEFORM_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
}

function snapWaveformRenderRange(displayRange, candidateRange, duration, renderWidth) {
  return snapWaveformRenderRangePure(displayRange, candidateRange, duration, renderWidth, WAVEFORM_RENDER_SCALE);
}

function quantizeWaveformCssOffset(offsetPx) {
  return quantizeWaveformCssOffsetPure(offsetPx, WAVEFORM_RENDER_SCALE);
}

function isFollowPlaybackInteractionActive() {
  return state.waveformSeekPointerId !== null || Boolean(state.selectionDrag) || Boolean(state.loopHandleDrag);
}

function isSmoothFollowPlaybackActive(currentTime = Number.NaN, isPlaying = isPlaybackActive()) {
  const effectiveCurrentTime = Number.isFinite(currentTime) ? Number(currentTime) : getCurrentPlaybackTime();
  return Boolean(
    state.followPlayback
      && isPlaying
      && Number.isFinite(effectiveCurrentTime)
      && !isFollowPlaybackInteractionActive()
  );
}

function isRangeBuffered(targetRange, bufferRange, marginRatio = 0) {
  return isRangeBufferedPure(targetRange, bufferRange, marginRatio, SPECTROGRAM_RANGE_EPSILON_SECONDS);
}

function getWaveformRenderRequestMetrics(
  displayRange = getWaveformRange(),
  smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(),
) {
  const duration = getEffectiveDuration();
  const { height, width } = getWaveformViewportSize();
  const displayWidth = Math.max(1, width);
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  const estimatedPlotMode = estimateWaveformPlotMode(displayRange, displayWidth);
  let renderRange = displayRange;
  let renderWidth = displayWidth;

  if (duration > 0 && visibleSpan > 0 && smoothFollowPlaybackActive) {
    const plannedRender = getWaveformFollowRenderPlan(displayRange, duration, displayWidth);

    if (plannedRender) {
      renderRange = {
        end: plannedRender.end,
        start: plannedRender.start,
      };
      renderWidth = plannedRender.width;
    } else {
      const expandedRange = expandWaveformRange(displayRange, duration, WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR);
      renderWidth = Math.max(
        displayWidth,
        Math.ceil(displayWidth * ((expandedRange.end - expandedRange.start) / visibleSpan)),
      );
      renderRange = getStableFollowWaveformRenderRange(displayRange, duration, renderWidth);
    }
  } else if (duration > 0 && visibleSpan > 0 && estimatedPlotMode === 'raw') {
    const expandedRange = expandWaveformRange(
      displayRange,
      duration,
      WAVEFORM_SAMPLE_PLOT_RENDER_BUFFER_FACTOR,
    );
    renderWidth = Math.max(
      displayWidth,
      Math.ceil(displayWidth * ((expandedRange.end - expandedRange.start) / visibleSpan)),
    );
    renderRange = snapWaveformRenderRange(displayRange, expandedRange, duration, renderWidth);
  }

  return {
    displayRange,
    displayWidth,
    estimatedPlotMode,
    height,
    renderRange,
    renderWidth: Math.max(1, renderWidth),
  };
}

function getWaveformDisplayWindowMetrics(
  displayRange = getWaveformRange(),
  renderRange = state.waveformRenderRange,
  renderWidth = state.waveformRenderWidth,
  viewportWidth = getWaveformViewportWidth(),
) {
  return getWaveformDisplayWindowMetricsPure(
    displayRange,
    renderRange,
    renderWidth,
    viewportWidth,
    WAVEFORM_RENDER_SCALE,
  );
}

function isWaveformDisplaySpanCompatible(candidateVisibleSpan, displaySpan) {
  if (!Number.isFinite(candidateVisibleSpan) || !Number.isFinite(displaySpan) || displaySpan <= 0) {
    return false;
  }

  const tolerance = Math.max(SPECTROGRAM_RANGE_EPSILON_SECONDS, displaySpan * 0.001);
  return Math.abs(candidateVisibleSpan - displaySpan) <= tolerance;
}

function getCommittedWaveformRenderCandidate() {
  const snapshot = state.waveformDisplaySnapshot;

  if (!snapshot || !(snapshot.renderRange.end > snapshot.renderRange.start) || snapshot.renderWidth <= 0) {
    return null;
  }

  return {
    end: snapshot.renderRange.end,
    height: snapshot.renderHeight,
    rawSamplePlotMode: snapshot.rawSamplePlotMode,
    samplePlotMode: snapshot.samplePlotMode,
    start: snapshot.renderRange.start,
    visibleSpan: snapshot.visibleSpan,
    width: snapshot.renderWidth,
  };
}

function getPendingWaveformRenderCandidate() {
  return state.waveformPendingRequest ?? null;
}

function doesWaveformRenderCandidateMatchDisplay(candidate, displayRange, { height, renderWidth, displaySpan }) {
  if (
    !candidate
    || Math.abs((candidate.height ?? height) - height) > 1
    || (candidate.width ?? 0) < (renderWidth - 1)
    || !isWaveformDisplaySpanCompatible(candidate.visibleSpan, displaySpan)
  ) {
    return false;
  }

  return true;
}

function doesWaveformRenderCandidatePhysicallyCoverDisplay(candidate, displayRange, metrics) {
  if (!doesWaveformRenderCandidateMatchDisplay(candidate, displayRange, metrics)) {
    return false;
  }

  return candidate.start <= (displayRange.start + SPECTROGRAM_RANGE_EPSILON_SECONDS)
    && candidate.end >= (displayRange.end - SPECTROGRAM_RANGE_EPSILON_SECONDS);
}

function shouldDeferWaveformFollowRenderRequest(displayRange, metrics) {
  const committedCandidate = getCommittedWaveformRenderCandidate();
  const pendingCandidate = getPendingWaveformRenderCandidate();

  return doesWaveformRenderCandidatePhysicallyCoverDisplay(committedCandidate, displayRange, metrics)
    && doesWaveformRenderCandidatePhysicallyCoverDisplay(pendingCandidate, displayRange, metrics);
}

function doesWaveformRenderCandidateCoverDisplay(
  candidate,
  displayRange,
  metrics,
  smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(),
) {
  if (!doesWaveformRenderCandidateMatchDisplay(candidate, displayRange, metrics)) {
    return false;
  }

  if (smoothFollowPlaybackActive || candidate.rawSamplePlotMode === true) {
    return isRangeBuffered(
      displayRange,
      candidate,
      smoothFollowPlaybackActive
        ? WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO
        : WAVEFORM_SAMPLE_PLOT_PREFETCH_MARGIN_RATIO,
    );
  }

  return Math.abs(candidate.start - displayRange.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(candidate.end - displayRange.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
}

function hasWaveformRenderCoverage(
  displayRange = getWaveformRange(),
  smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(),
) {
  const { height, renderWidth } = getWaveformRenderRequestMetrics(displayRange, smoothFollowPlaybackActive);
  const displaySpan = Math.max(0, displayRange.end - displayRange.start);
  const committedCandidate = getCommittedWaveformRenderCandidate();
  const pendingCandidate = getPendingWaveformRenderCandidate();
  const metrics = { height, renderWidth, displaySpan };

  if (doesWaveformRenderCandidateCoverDisplay(committedCandidate, displayRange, metrics, smoothFollowPlaybackActive)) {
    return true;
  }

  return doesWaveformRenderCandidatePhysicallyCoverDisplay(committedCandidate, displayRange, metrics)
    && doesWaveformRenderCandidateCoverDisplay(pendingCandidate, displayRange, metrics, smoothFollowPlaybackActive);
}

function applyWaveformCanvasTransform(
  displayRange = getWaveformRange(),
  displayMetrics = getWaveformSnapshotDisplayMetrics(state.waveformDisplaySnapshot, displayRange),
) {
  const canvas = state.waveformCanvas;
  const snapshot = updateWaveformDisplaySnapshotWindow(displayRange, state.waveformDisplaySnapshot, displayMetrics);

  elements.waveformCanvasHost.style.width = '100%';
  elements.waveformCanvasHost.style.transform = 'translate3d(0px, 0, 0)';
  if (canvas) {
    syncWaveformCanvasElementSize(snapshot?.renderWidth ?? getWaveformViewportWidth(), 0);
    canvas.style.transform = 'translate3d(0px, 0, 0)';
  }

  if (!canvas) {
    return;
  }

  const displayWindow = displayMetrics ?? getWaveformSnapshotDisplayMetrics(snapshot, displayRange);

  if (!displayWindow) {
    return;
  }

  const translateX = quantizeWaveformCssOffset(-displayWindow.displayOffsetPx);
  canvas.style.transform = `translate3d(${translateX}px, 0, 0)`;
}

function applyWaveformAxisTransform(
  displayRange = getWaveformRange(),
  displayMetrics = getWaveformSnapshotDisplayMetrics(state.waveformDisplaySnapshot, displayRange),
) {
  const axisContent = elements.waveformAxis.firstElementChild;
  const snapshot = updateWaveformDisplaySnapshotWindow(displayRange, state.waveformDisplaySnapshot, displayMetrics);

  if (!(axisContent instanceof HTMLElement)) {
    return;
  }

  if (!snapshot || !(snapshot.displayRange.end > snapshot.displayRange.start) || snapshot.renderWidth <= 0) {
    axisContent.style.transform = 'translate3d(0px, 0, 0)';
    return;
  }

  const translateX = quantizeWaveformCssOffset(-snapshot.displayOffsetPx);
  axisContent.style.transform = `translate3d(${translateX}px, 0, 0)`;
}

function resetSpectrogramCanvasTransform() {
  elements.spectrogram.style.width = '100%';
  elements.spectrogram.style.transform = 'translate3d(0px, 0, 0)';
}

function getSpectrogramFollowRenderPlan(displayRange, duration, pixelWidth) {
  const planner = getWaveDisplayPlannerIfReady();

  if (!planner) {
    return null;
  }

  return planner.planSpectrogramFollowRender({
    bufferFactor: SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR,
    displayEnd: displayRange.end,
    displayStart: displayRange.start,
    duration,
    pixelWidth,
  });
}

function getVisibleSpectrogramRequestMetrics(displayRange = getWaveformRange()) {
  const duration = getEffectiveDuration();
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  let requestRange = displayRange;
  let requestPixelWidth = pixelWidth;

  if (duration > 0 && visibleSpan > 0 && isSmoothFollowPlaybackActive()) {
    const plannedRequest = getSpectrogramFollowRenderPlan(displayRange, duration, pixelWidth);

    if (plannedRequest) {
      requestRange = {
        end: plannedRequest.end,
        start: plannedRequest.start,
      };
      requestPixelWidth = plannedRequest.pixelWidth;
    } else {
      requestRange = expandWaveformRange(displayRange, duration, SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR);
      requestPixelWidth = Math.max(
        pixelWidth,
        Math.ceil(pixelWidth * ((requestRange.end - requestRange.start) / visibleSpan)),
      );
    }
  }

  return {
    displayRange,
    pixelHeight,
    pixelWidth: Math.max(1, requestPixelWidth),
    requestRange,
  };
}

function hasBufferedVisibleSpectrogramCoverage(displayRange = getWaveformRange()) {
  if (!state.analysis?.activeVisibleRequest) {
    return false;
  }

  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  const activeRequest = state.analysis.activeVisibleRequest;

  if (!isCompatibleVisibleRequest(activeRequest, { pixelHeight, pixelWidth })) {
    return false;
  }

  if (isSmoothFollowPlaybackActive()) {
    return isRangeBuffered(displayRange, activeRequest, SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO);
  }

  return isSameVisibleRequest(activeRequest, displayRange, { pixelHeight, pixelWidth });
}

function normalizeWaveformRange(range, duration) {
  return normalizeWaveformRangePure(range, duration, getMinVisibleDuration(duration));
}

function getMinVisibleDuration(duration) {
  if (duration <= 0) {
    return 0.001;
  }

  const sampleRate = Number(state.analysis?.sampleRate);
  const viewportColumns = Math.max(1, Math.round(getWaveformViewportWidth()));

  if (Number.isFinite(sampleRate) && sampleRate > 0) {
    return Math.min(
      duration,
      Math.max(1 / sampleRate, viewportColumns / sampleRate),
    );
  }

  return Math.min(duration, 0.001);
}

function getEffectiveDuration() {
  const transportDuration = Number(state.audioTransport?.getDuration());

  if (Number.isFinite(transportDuration) && transportDuration > 0) {
    return transportDuration;
  }

  const analysisDuration = state.analysis?.duration;

  if (Number.isFinite(analysisDuration) && analysisDuration > 0) {
    return analysisDuration;
  }

  return 0;
}

function setAnalysisStatus(message, isError = false) {
  elements.analysisStatus.textContent = message;
  elements.analysisStatus.classList.toggle('error', isError);
}

function setFatalStatus(message) {
  elements.status.hidden = false;
  elements.status.textContent = message;
  elements.status.classList.add('error');
}

function clearFatalStatus() {
  elements.status.hidden = true;
  elements.status.textContent = '';
  elements.status.classList.remove('error');
}

function getActiveSpectrogramAxisMode() {
  const { analysisType, frequencyScale } = getEffectiveSpectrogramRenderConfig();

  if (analysisType === 'mel') {
    return 'mel';
  }

  if (analysisType === 'spectrogram' && frequencyScale === 'linear') {
    return 'linear';
  }

  return 'log';
}

function getVisibleSpectrogramTicks(minFrequency, maxFrequency) {
  if (getActiveSpectrogramAxisMode() === 'linear') {
    return buildLinearFrequencyTicks(minFrequency, maxFrequency);
  }

  return SPECTROGRAM_TICKS.filter((tick) => tick >= minFrequency && tick <= maxFrequency);
}

function buildLinearFrequencyTicks(minFrequency, maxFrequency) {
  return buildLinearFrequencyTicksPure(minFrequency, maxFrequency, SPECTROGRAM_LINEAR_TICK_COUNT);
}

function getSpectrogramFrequencyPosition(frequency, minFrequency, maxFrequency) {
  switch (getActiveSpectrogramAxisMode()) {
    case 'linear':
      return getLinearFrequencyPosition(frequency, minFrequency, maxFrequency);
    case 'mel':
      return getMelFrequencyPosition(frequency, minFrequency, maxFrequency);
    default:
      return getLogFrequencyPosition(frequency, minFrequency, maxFrequency);
  }
}

function getFrequencyAtSpectrogramPosition(position, minFrequency, maxFrequency) {
  switch (getActiveSpectrogramAxisMode()) {
    case 'linear':
      return getFrequencyAtLinearPosition(position, minFrequency, maxFrequency);
    case 'mel':
      return getFrequencyAtMelPosition(position, minFrequency, maxFrequency);
    default:
      return getFrequencyAtLogPosition(position, minFrequency, maxFrequency);
  }
}
