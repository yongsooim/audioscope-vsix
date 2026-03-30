import {
  DISPLAY_MIN_DPR,
  TILE_COLUMN_COUNT,
} from './sharedBuffers';
import { createAudioTransport } from './audioTransport';

const vscode = acquireVsCodeApi();
const analysisWorkerScriptUri = document.body.dataset.workerSrc;
const waveformWorkerScriptUri = document.body.dataset.waveformWorkerSrc;
const audioTransportProcessorScriptUri = document.body.dataset.audioTransportProcessorSrc;
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
const VIEWPORT_MIN_SPECTROGRAM_HEIGHT_PX = 140;
const VIEWPORT_RATIO_MIN = 0.15;
const VIEWPORT_RATIO_MAX = 0.85;

const WAVEFORM_COLOR = '#8ccadd';
const WAVEFORM_RENDER_SCALE = DISPLAY_PIXEL_RATIO;
const WAVEFORM_ZOOM_STEP_FACTOR = 1.75;
const WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR = 2.25;
const WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.18;
const WAVEFORM_FOLLOW_LEFT_THRESHOLD_RATIO = 0.25;
const WAVEFORM_FOLLOW_RIGHT_THRESHOLD_RATIO = 0.75;
const WAVEFORM_FOLLOW_TARGET_RATIO = 0.5;
const SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR = 2.25;
const SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO = 0.18;
const LOOP_SELECTION_MIN_SECONDS = 0.05;
const LOOP_SELECTION_MIN_PIXELS = 6;
const LOOP_HANDLE_WIDTH_PX = 12;
const LOOP_WRAP_EPSILON_SECONDS = 1 / 120;
const ANALYSIS_IDLE_TIMEOUT_MS = 1500;
const ANALYSIS_FALLBACK_DELAY_MS = 240;
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

const elements = {
  viewport: document.getElementById('wave-scope-viewport'),
  wavePanel: document.getElementById('wave-panel'),
  waveToolbar: document.getElementById('wave-toolbar'),
  mediaMetadataPanel: document.getElementById('media-metadata-panel'),
  mediaMetadataSummary: document.getElementById('media-metadata-summary'),
  mediaMetadataDetail: document.getElementById('media-metadata-detail'),
  waveToolbarInfo: document.getElementById('wave-toolbar-info'),
  waveformViewport: document.getElementById('waveform-viewport'),
  waveformCanvasHost: document.getElementById('waveform-canvas-host'),
  waveformHitTarget: document.getElementById('waveform-hit-target'),
  waveformHoverTooltip: document.getElementById('waveform-hover-tooltip'),
  waveformSampleMarker: document.getElementById('waveform-sample-marker'),
  waveformSelection: document.getElementById('waveform-selection'),
  waveformProgress: document.getElementById('waveform-progress'),
  waveformCursor: document.getElementById('waveform-cursor'),
  waveformLoopStart: document.getElementById('waveform-loop-start'),
  waveformLoopEnd: document.getElementById('waveform-loop-end'),
  waveformAxis: document.getElementById('waveform-axis'),
  waveformOverview: document.getElementById('waveform-overview'),
  waveformOverviewThumb: document.getElementById('waveform-overview-thumb'),
  waveHint: document.getElementById('wave-hint'),
  waveLoopLabel: document.getElementById('wave-loop-label'),
  waveZoomChip: document.getElementById('wave-zoom-chip'),
  waveClearLoop: document.getElementById('wave-clear-loop'),
  waveZoomOut: document.getElementById('wave-zoom-out'),
  waveZoomReset: document.getElementById('wave-zoom-reset'),
  waveZoomIn: document.getElementById('wave-zoom-in'),
  waveFollow: document.getElementById('wave-follow'),
  viewportSplitter: document.getElementById('viewport-splitter'),
  spectrogramPanel: document.getElementById('spectrogram-panel'),
  spectrogramStage: document.getElementById('spectrogram-stage'),
  spectrogram: document.getElementById('spectrogram'),
  spectrogramSelection: document.getElementById('spectrogram-selection'),
  spectrogramProgress: document.getElementById('spectrogram-progress'),
  spectrogramCursor: document.getElementById('spectrogram-cursor'),
  spectrogramLoopStart: document.getElementById('spectrogram-loop-start'),
  spectrogramLoopEnd: document.getElementById('spectrogram-loop-end'),
  spectrogramMeta: document.getElementById('spectrogram-meta'),
  spectrogramTypeSelect: document.getElementById('spectrogram-type-select'),
  spectrogramFftSelect: document.getElementById('spectrogram-fft-select'),
  spectrogramOverlapSelect: document.getElementById('spectrogram-overlap-select'),
  spectrogramScaleSelect: document.getElementById('spectrogram-scale-select'),
  spectrogramHoverTooltip: document.getElementById('spectrogram-hover-tooltip'),
  spectrogramAxis: document.getElementById('spectrogram-axis'),
  spectrogramGuides: document.getElementById('spectrogram-guides'),
  spectrogramHitTarget: document.getElementById('spectrogram-hit-target'),
  seekBackward: document.getElementById('seek-backward'),
  playToggle: document.getElementById('play-toggle'),
  seekForward: document.getElementById('seek-forward'),
  timeline: document.getElementById('timeline'),
  timelineHoverTooltip: document.getElementById('timeline-hover-tooltip'),
  timeReadout: document.getElementById('time-readout'),
  loudnessSummary: document.getElementById('loudness-summary'),
  loudnessIntegrated: document.getElementById('loudness-integrated'),
  loudnessRange: document.getElementById('loudness-range'),
  loudnessSamplePeak: document.getElementById('loudness-sample-peak'),
  loudnessTruePeak: document.getElementById('loudness-true-peak'),
  analysisStatus: document.getElementById('analysis-status'),
  status: document.getElementById('status'),
};

const state = {
  activeFile: null,
  loadToken: 0,
  audioTransport: null,
  decodedAudioBuffer: null,
  sourceArrayBuffer: null,
  sourceMimeType: null,
  waveformSamples: null,
  sourceFetchController: null,
  externalTools: createExternalToolStatusState(),
  mediaMetadata: createMediaMetadataState('idle'),
  mediaMetadataDetailOpen: false,
  playbackSourceKind: 'native',
  playbackTransportKind: 'unavailable',
  playbackTransportError: null,
  analysisSourceKind: 'native',
  decodeFallbackLoadToken: 0,
  decodeFallbackPromise: null,
  decodeFallbackResult: null,
  decodeFallbackError: null,
  resolveDecodeFallback: null,
  rejectDecodeFallback: null,
  analysisWorker: null,
  analysisWorkerBootstrapUrl: null,
  analysisRuntimeReadyPromise: null,
  resolveAnalysisRuntimeReady: null,
  analysisIdleCallbackId: null,
  analysisTimeoutId: null,
  analysisStartedForLoadToken: 0,
  analysisQueuedForLoadToken: 0,
  waveformWorker: null,
  waveformWorkerBootstrapUrl: null,
  waveformRuntimeReadyPromise: null,
  resolveWaveformRuntimeReady: null,
  waveformSurfaceReadyPromise: null,
  spectrogramSurfaceReadyPromise: null,
  waveformCanvas: null,
  waveformViewRange: { start: 0, end: 0 },
  waveformHoverClientPoint: null,
  waveformSeekPointerId: null,
  viewportSplitRatio: DEFAULT_VIEWPORT_SPLIT_RATIO,
  viewportResizeDrag: null,
  selectionDrag: null,
  selectionDraft: null,
  loopHandleDrag: null,
  loopRange: null,
  followPlayback: true,
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
  playbackFrame: 0,
  spectrogramFrame: 0,
  spectrogramRequestFrame: 0,
  waveformPyramidFrame: 0,
  observedWaveformViewportWidth: 0,
  observedWaveformViewportHeight: 0,
  observedSpectrogramPixelWidth: 0,
  observedSpectrogramPixelHeight: 0,
  observedOverviewWidth: 0,
};

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
  typeof elements.spectrogram?.transferControlToOffscreen !== 'function'
  || typeof OffscreenCanvas !== 'function'
) {
  setFatalStatus('OffscreenCanvas is required for Wave Scope.');
} else {
  initializeKeyboardFocus();
  state.followPlayback = elements.waveFollow.checked;
  attachUiEvents();
  applyViewportSplit(true);
  attachResizeObservers();
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
    state.externalTools = normalizeExternalToolStatus(message.body?.externalTools);
    void loadAudioFile(message.body);
    return;
  }

  if (message?.type === 'externalToolStatus') {
    state.externalTools = normalizeExternalToolStatus(message.body);
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
    state.externalTools = normalizeExternalToolStatus(message.body?.metadata?.toolStatus ?? state.externalTools);
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'mediaMetadataError') {
    const loadToken = Number(message.body?.loadToken) || 0;

    if (loadToken !== state.loadToken) {
      return;
    }

    state.externalTools = normalizeExternalToolStatus(message.body?.toolStatus ?? state.externalTools);
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

    const audioBuffer = message.body?.audioBuffer;

    if (!(audioBuffer instanceof ArrayBuffer)) {
      state.rejectDecodeFallback?.(new Error('ffmpeg fallback did not return audio bytes.'));
      state.decodeFallbackPromise = null;
      state.decodeFallbackResult = null;
      state.resolveDecodeFallback = null;
      state.rejectDecodeFallback = null;
      return;
    }

    state.decodeFallbackError = null;
    state.decodeFallbackResult = {
      audioBuffer,
      byteLength: Number(message.body?.byteLength) || audioBuffer.byteLength,
      mimeType: typeof message.body?.mimeType === 'string' && message.body.mimeType.length > 0
        ? message.body.mimeType
        : 'audio/wav',
      source: message.body?.source === 'ffmpeg' ? 'ffmpeg' : 'ffmpeg',
    };
    state.resolveDecodeFallback?.(state.decodeFallbackResult);
    state.decodeFallbackPromise = null;
    state.resolveDecodeFallback = null;
    state.rejectDecodeFallback = null;
    renderMediaMetadata();
    return;
  }

  if (message?.type === 'decodeFallbackError') {
    const loadToken = Number(message.body?.loadToken) || 0;

    if (loadToken !== state.loadToken) {
      return;
    }

    state.externalTools = normalizeExternalToolStatus(message.body?.toolStatus ?? state.externalTools);
    state.decodeFallbackResult = null;
    state.decodeFallbackError = {
      loadToken,
      message: message.body?.message || state.externalTools.guidance || 'ffmpeg decode fallback failed.',
    };
    state.rejectDecodeFallback?.(new Error(state.decodeFallbackError.message));
    state.decodeFallbackPromise = null;
    state.resolveDecodeFallback = null;
    state.rejectDecodeFallback = null;
    renderMediaMetadata();
    return;
  }

});

function initializeKeyboardFocus() {
  document.body.tabIndex = -1;

  const focusKeyboardSurface = () => {
    if (document.visibilityState !== 'visible') {
      return;
    }

    window.focus();

    if (document.activeElement !== document.body) {
      document.body.focus({ preventScroll: true });
    }
  };

  queueMicrotask(focusKeyboardSurface);
  window.requestAnimationFrame(focusKeyboardSurface);
  window.setTimeout(focusKeyboardSurface, 120);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      window.requestAnimationFrame(focusKeyboardSurface);
    }
  });
}

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

function createExternalToolStatusState() {
  return {
    canDecodeFallback: false,
    canReadMetadata: false,
    ffmpegAvailable: false,
    ffmpegCommand: 'ffmpeg',
    ffmpegPath: null,
    ffmpegVersion: null,
    ffprobeAvailable: false,
    ffprobeCommand: 'ffprobe',
    ffprobePath: null,
    ffprobeVersion: null,
    fileBacked: false,
    guidance: 'Install ffmpeg CLI to view metadata and decode unsupported audio files.',
  };
}

function normalizeExternalToolStatus(status) {
  const base = createExternalToolStatusState();

  if (!status || typeof status !== 'object') {
    return base;
  }

  return {
    ...base,
    canDecodeFallback: Boolean(status.canDecodeFallback),
    canReadMetadata: Boolean(status.canReadMetadata),
    ffmpegAvailable: Boolean(status.ffmpegAvailable),
    ffmpegCommand: typeof status.ffmpegCommand === 'string' && status.ffmpegCommand.trim().length > 0
      ? status.ffmpegCommand
      : base.ffmpegCommand,
    ffmpegPath: typeof status.ffmpegPath === 'string' && status.ffmpegPath.trim().length > 0
      ? status.ffmpegPath
      : null,
    ffmpegVersion: typeof status.ffmpegVersion === 'string' && status.ffmpegVersion.trim().length > 0
      ? status.ffmpegVersion
      : null,
    ffprobeAvailable: Boolean(status.ffprobeAvailable),
    ffprobeCommand: typeof status.ffprobeCommand === 'string' && status.ffprobeCommand.trim().length > 0
      ? status.ffprobeCommand
      : base.ffprobeCommand,
    ffprobePath: typeof status.ffprobePath === 'string' && status.ffprobePath.trim().length > 0
      ? status.ffprobePath
      : null,
    ffprobeVersion: typeof status.ffprobeVersion === 'string' && status.ffprobeVersion.trim().length > 0
      ? status.ffprobeVersion
      : null,
    fileBacked: Boolean(status.fileBacked),
    guidance: typeof status.guidance === 'string' && status.guidance.trim().length > 0
      ? status.guidance
      : base.guidance,
  };
}

function formatExternalToolVersion(available, version, command) {
  if (!available) {
    return `Unavailable (${command || 'tool'})`;
  }

  if (typeof version === 'string' && version.trim().length > 0) {
    return version;
  }

  return command || 'Available';
}

function createMediaMetadataState(status = 'idle') {
  return {
    status,
    summary: null,
    detail: null,
    message: '',
    loadToken: 0,
  };
}

function createLoudnessSummaryState(status = 'idle') {
  return {
    status,
    integratedLufs: null,
    loudnessRangeLu: null,
    samplePeakDbfs: null,
    truePeakDbtp: null,
    source: null,
    channelMode: null,
    message: '',
  };
}

function setPendingLoudnessSummary() {
  state.loudness = createLoudnessSummaryState('pending');
  renderLoudnessSummary();
}

function setReadyLoudnessSummary(summary) {
  state.loudness = {
    status: 'ready',
    integratedLufs: Number(summary?.integratedLufs),
    loudnessRangeLu: Number(summary?.loudnessRangeLu),
    samplePeakDbfs: Number(summary?.samplePeakDbfs),
    truePeakDbtp: Number(summary?.truePeakDbtp),
    source: summary?.source ?? 'libebur128',
    channelMode: summary?.channelMode ?? 'mono-downmix',
    message: '',
  };
  renderLoudnessSummary();
}

function setLoudnessSummaryUnavailable(message = 'Loudness summary unavailable.') {
  state.loudness = {
    ...createLoudnessSummaryState('error'),
    message,
  };
  renderLoudnessSummary();
}

function normalizeLoudnessDisplayValue(value) {
  if (!Number.isFinite(value)) {
    return value;
  }

  return Math.abs(value) < 0.05 ? 0 : value;
}

function formatLoudnessValue(status, value, unit) {
  if (status === 'error') {
    return 'Unavailable';
  }

  if (status !== 'ready') {
    return '--';
  }

  if (value === Number.NEGATIVE_INFINITY) {
    return '-∞';
  }

  if (!Number.isFinite(value)) {
    return '--';
  }

  return `${normalizeLoudnessDisplayValue(value).toFixed(1)} ${unit}`;
}

function getActiveDecodeSourceKind() {
  return state.playbackSourceKind === 'ffmpeg-fallback' || state.analysisSourceKind === 'ffmpeg-fallback'
    ? 'ffmpeg-fallback'
    : 'native';
}

function formatMetadataDecodeSourceLabel() {
  return getActiveDecodeSourceKind() === 'ffmpeg-fallback'
    ? 'ffmpeg fallback'
    : 'native browser decode';
}

function formatPlaybackTransportLabel() {
  return state.playbackTransportKind === 'audio-worklet-copy'
    ? 'AudioWorklet (copied buffers)'
    : 'Playback unavailable';
}

function formatMetadataSummarySegments(summary) {
  if (!summary || !Array.isArray(summary.segments)) {
    return [];
  }

  return summary.segments.filter((segment) => typeof segment === 'string' && segment.trim().length > 0);
}

function formatMetadataSummaryText() {
  const metadata = state.mediaMetadata;
  const summarySegments = formatMetadataSummarySegments(metadata?.summary);

  if (!state.activeFile) {
    return 'Open an audio file to inspect metadata.';
  }

  if (summarySegments.length > 0) {
    return summarySegments.join(' • ');
  }

  if (metadata?.status === 'pending') {
    return 'Loading metadata with ffprobe…';
  }

  if (metadata?.message) {
    return metadata.message;
  }

  if (!state.externalTools.canReadMetadata) {
    return state.externalTools.guidance || 'Install ffmpeg CLI to view metadata.';
  }

  return 'Metadata unavailable.';
}

function appendMetadataDetailSection(container, title) {
  const section = document.createElement('section');
  section.className = 'media-metadata-section';

  if (title) {
    const heading = document.createElement('h3');
    heading.className = 'media-metadata-section-title';
    heading.textContent = title;
    section.append(heading);
  }

  container.append(section);
  return section;
}

function appendMetadataDetailRow(container, label, value) {
  if (!value) {
    return;
  }

  const row = document.createElement('div');
  row.className = 'media-metadata-row-detail';

  const labelElement = document.createElement('span');
  labelElement.className = 'media-metadata-row-label';
  labelElement.textContent = label;

  const valueElement = document.createElement('span');
  valueElement.className = 'media-metadata-row-value';
  valueElement.textContent = value;

  row.append(labelElement, valueElement);
  container.append(row);
}

function formatMetadataStreamSummary(stream) {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const parts = [
    stream.codecLongName || stream.codecName || null,
    stream.sampleRateText || null,
    Number.isFinite(stream.channels) && stream.channels > 0
      ? stream.channelLayout
        ? `${stream.channelLayout} (${stream.channels} ch)`
        : stream.channels === 1
          ? 'Mono'
          : stream.channels === 2
            ? 'Stereo'
            : `${stream.channels} ch`
      : null,
    stream.sampleFormat || null,
    stream.bitRateText || null,
    stream.durationText || null,
  ].filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const prefix = stream.codecType
    ? `${stream.codecType}${Number.isFinite(stream.index) ? ` #${stream.index}` : ''}`
    : Number.isFinite(stream.index)
      ? `stream #${stream.index}`
      : 'stream';

  return `${prefix}: ${parts.join(' • ')}`;
}

function formatMetadataTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return [];
  }

  return tags
    .filter((tag) => typeof tag?.key === 'string' && typeof tag?.value === 'string')
    .map((tag) => `${tag.key}: ${tag.value}`);
}

function formatMetadataChapters(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return [];
  }

  return chapters.map((chapter, index) => {
    const range = [chapter?.startText, chapter?.endText].filter(Boolean).join(' - ');
    const title = chapter?.title || `Chapter ${index + 1}`;
    return range ? `${title} (${range})` : title;
  });
}

function appendMetadataListSection(container, title, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const section = appendMetadataDetailSection(container, title);
  const list = document.createElement('div');
  list.className = 'media-metadata-list';

  items.forEach((item) => {
    const line = document.createElement('div');
    line.className = 'media-metadata-list-item';
    line.textContent = item;
    list.append(line);
  });

  section.append(list);
}

function renderMediaMetadata() {
  if (!elements.mediaMetadataPanel || !elements.mediaMetadataSummary || !elements.mediaMetadataDetail) {
    return;
  }

  const metadata = state.mediaMetadata ?? createMediaMetadataState('idle');
  const summaryText = formatMetadataSummaryText();
  const playbackTransportLabel = formatPlaybackTransportLabel();
  const playbackTransportError = state.playbackTransportError || null;
  const detailRoot = elements.mediaMetadataDetail;

  elements.mediaMetadataPanel.dataset.state = metadata.status;
  elements.mediaMetadataPanel.dataset.sourceKind = getActiveDecodeSourceKind();
  elements.mediaMetadataSummary.textContent = summaryText;
  elements.mediaMetadataSummary.title = [
    summaryText,
    `Playback: ${playbackTransportLabel}`,
    playbackTransportError ? `Playback status: ${playbackTransportError}` : null,
  ].filter(Boolean).join('\n');

  detailRoot.replaceChildren();

  const overviewSection = appendMetadataDetailSection(detailRoot, 'Overview');
  const detail = metadata.detail;
  const detailSummary = detail?.summary ?? null;

  appendMetadataDetailRow(overviewSection, 'Format', detail?.formatLongName || detail?.formatName || detailSummary?.containerText || null);
  appendMetadataDetailRow(overviewSection, 'Codec', detailSummary?.codecText || null);
  appendMetadataDetailRow(overviewSection, 'Sample Rate', detailSummary?.sampleRateText || null);
  appendMetadataDetailRow(overviewSection, 'Channels', detailSummary?.channelText || null);
  appendMetadataDetailRow(overviewSection, 'Bitrate', detailSummary?.bitrateText || null);
  appendMetadataDetailRow(overviewSection, 'Duration', detailSummary?.durationText || null);
  appendMetadataDetailRow(overviewSection, 'Size', detailSummary?.sizeText || null);

  appendMetadataListSection(detailRoot, 'Tags', formatMetadataTags(detail?.tags));
  appendMetadataListSection(detailRoot, 'Chapters', formatMetadataChapters(detail?.chapters));

  const loudnessSection = appendMetadataDetailSection(detailRoot, 'Loudness');
  const loudness = state.loudness ?? createLoudnessSummaryState('idle');
  appendMetadataDetailRow(loudnessSection, 'Source', loudness.status === 'ready' ? `${loudness.source} • ${loudness.channelMode}` : null);
  appendMetadataDetailRow(loudnessSection, 'Integrated', formatLoudnessValue(loudness.status, loudness.integratedLufs, 'LUFS'));
  appendMetadataDetailRow(loudnessSection, 'Range', formatLoudnessValue(loudness.status, loudness.loudnessRangeLu, 'LU'));
  appendMetadataDetailRow(loudnessSection, 'Sample Peak', formatLoudnessValue(loudness.status, loudness.samplePeakDbfs, 'dBFS'));
  appendMetadataDetailRow(loudnessSection, 'True Peak', formatLoudnessValue(loudness.status, loudness.truePeakDbtp, 'dBTP'));
  appendMetadataDetailRow(loudnessSection, 'Note', loudness.status === 'error' ? loudness.message : null);

  const toolSection = appendMetadataDetailSection(detailRoot, 'Tools');
  appendMetadataDetailRow(toolSection, 'Decode', formatMetadataDecodeSourceLabel());
  appendMetadataDetailRow(toolSection, 'Playback', playbackTransportLabel);
  appendMetadataDetailRow(toolSection, 'Playback Status', playbackTransportError);
  appendMetadataDetailRow(toolSection, 'Probe', detail?.probeSource === 'ffprobe' ? 'ffprobe' : 'Unavailable');
  appendMetadataDetailRow(
    toolSection,
    'ffmpeg',
    formatExternalToolVersion(
      state.externalTools.ffmpegAvailable,
      state.externalTools.ffmpegVersion,
      state.externalTools.ffmpegCommand,
    ),
  );
  appendMetadataDetailRow(
    toolSection,
    'ffprobe',
    formatExternalToolVersion(
      state.externalTools.ffprobeAvailable,
      state.externalTools.ffprobeVersion,
      state.externalTools.ffprobeCommand,
    ),
  );
  appendMetadataDetailRow(
    toolSection,
    'Status',
    state.decodeFallbackError?.message || detail?.guidance || metadata.message || state.externalTools.guidance || null,
  );

  syncMediaMetadataDetailVisibility();
}

function syncMediaMetadataDetailVisibility() {
  if (!elements.mediaMetadataPanel || !elements.mediaMetadataDetail) {
    return;
  }

  const hasDetailContent = elements.mediaMetadataDetail.childElementCount > 0;
  const shouldShowDetail = hasDetailContent && state.mediaMetadataDetailOpen;

  elements.mediaMetadataPanel.dataset.detailOpen = shouldShowDetail ? 'true' : 'false';
  elements.mediaMetadataDetail.hidden = !shouldShowDetail;
  elements.mediaMetadataDetail.setAttribute('aria-hidden', shouldShowDetail ? 'false' : 'true');

  if (shouldShowDetail) {
    updateMediaMetadataDetailPosition();
  }
}

function setMediaMetadataDetailOpen(nextOpen) {
  const normalizedOpen = Boolean(nextOpen);

  if (state.mediaMetadataDetailOpen === normalizedOpen) {
    syncMediaMetadataDetailVisibility();
    return;
  }

  state.mediaMetadataDetailOpen = normalizedOpen;
  syncMediaMetadataDetailVisibility();
}

function updateMediaMetadataDetailPosition() {
  if (
    !elements.mediaMetadataSummary
    || !elements.mediaMetadataDetail
    || elements.mediaMetadataDetail.hidden
  ) {
    return;
  }

  const summaryRect = elements.mediaMetadataSummary.getBoundingClientRect();
  const detailRect = elements.mediaMetadataDetail.getBoundingClientRect();
  const detailWidth = detailRect.width || elements.mediaMetadataDetail.offsetWidth || 280;
  const detailHeight = detailRect.height || elements.mediaMetadataDetail.offsetHeight || 0;
  const maxLeft = Math.max(12, window.innerWidth - detailWidth - 12);
  const maxTop = Math.max(12, window.innerHeight - detailHeight - 12);
  const left = clamp(summaryRect.left, 12, maxLeft);
  const top = clamp(summaryRect.bottom + 2, 12, maxTop);

  elements.mediaMetadataDetail.style.left = `${left}px`;
  elements.mediaMetadataDetail.style.top = `${top}px`;
}

function renderLoudnessSummary() {
  if (
    !elements.loudnessSummary
    || !elements.loudnessIntegrated
    || !elements.loudnessRange
    || !elements.loudnessSamplePeak
    || !elements.loudnessTruePeak
  ) {
    return;
  }

  const loudness = state.loudness ?? createLoudnessSummaryState('idle');
  elements.loudnessSummary.dataset.state = loudness.status;
  elements.loudnessSummary.title = loudness.message
    || (
      loudness.status === 'ready'
        ? `${loudness.source} • ${loudness.channelMode}`
        : ''
    );
  elements.loudnessIntegrated.textContent = formatLoudnessValue(loudness.status, loudness.integratedLufs, 'LUFS');
  elements.loudnessRange.textContent = formatLoudnessValue(loudness.status, loudness.loudnessRangeLu, 'LU');
  elements.loudnessSamplePeak.textContent = formatLoudnessValue(loudness.status, loudness.samplePeakDbfs, 'dBFS');
  elements.loudnessTruePeak.textContent = formatLoudnessValue(loudness.status, loudness.truePeakDbtp, 'dBTP');
  renderMediaMetadata();
}

window.addEventListener('keydown', (event) => {
  if (!hasPlaybackTransport() || event.defaultPrevented) {
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    void togglePlayback();
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

  if (event.code === 'Minus') {
    event.preventDefault();
    zoomWaveformOut();
    return;
  }

  if (event.code === 'Equal') {
    event.preventDefault();
    zoomWaveformIn();
  }
});

async function loadAudioFile(payload) {
  const loadToken = state.loadToken + 1;
  state.loadToken = loadToken;

  destroySession();
  state.externalTools = normalizeExternalToolStatus(payload?.externalTools);
  state.mediaMetadata = {
    ...createMediaMetadataState('pending'),
    loadToken,
    message: state.externalTools.canReadMetadata
      ? 'Loading metadata with ffprobe…'
      : state.externalTools.guidance || 'Install ffmpeg CLI to view metadata.',
  };
  state.playbackSourceKind = 'native';
  state.analysisSourceKind = 'native';
  renderMediaMetadata();
  setPendingLoudnessSummary();
  clearFatalStatus();
  setAnalysisStatus('Preparing playback…');
  state.audioTransport = createPlaybackTransport(loadToken);
  state.decodedAudioBuffer = null;
  state.waveformViewRange = { start: 0, end: 0 };

  state.waveformSurfaceReadyPromise = initializeWaveformSurface(loadToken);
  state.spectrogramSurfaceReadyPromise = initializeSpectrogramSurface(loadToken);
  syncTransport();
  renderWaveformUi();
  renderSpectrogramScale();
  requestMediaMetadata(loadToken, payload);
  void loadDecodedAudioSource(loadToken, payload);
}

function createPlaybackTransport(loadToken) {
  let transport = null;

  transport = createAudioTransport({
    onStateChange: () => {
      if (loadToken !== state.loadToken || state.audioTransport !== transport) {
        return;
      }

      const nextPlaybackTransportKind = transport.getTransportKind?.() ?? state.playbackTransportKind;
      const nextPlaybackTransportError = transport.getLastFallbackReason?.() ?? null;
      const transportKindChanged = nextPlaybackTransportKind !== state.playbackTransportKind;
      const transportErrorChanged =
        nextPlaybackTransportError !== state.playbackTransportError;
      state.playbackTransportKind = nextPlaybackTransportKind;
      state.playbackTransportError = nextPlaybackTransportError;

      if (transportKindChanged || transportErrorChanged) {
        renderMediaMetadata();
      }

      syncTransport();
    },
    workletModuleUrl: audioTransportProcessorScriptUri,
  });

  state.playbackTransportKind = transport.getTransportKind?.() ?? 'unavailable';
  state.playbackTransportError = transport.getLastFallbackReason?.() ?? null;
  return transport;
}

function guessAudioMimeType(resourcePath) {
  const extension = resourcePath.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'wav':
    case 'wave':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'm4a':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'opus':
      return 'audio/ogg';
    case 'aif':
    case 'aiff':
      return 'audio/aiff';
    default:
      return 'application/octet-stream';
  }
}

function resolvePlayableAudioMimeType(payload, responseContentType) {
  const normalizedContentType = responseContentType?.split(';', 1)[0]?.trim().toLowerCase() || '';

  if (
    normalizedContentType
    && normalizedContentType !== 'application/octet-stream'
    && normalizedContentType !== 'binary/octet-stream'
  ) {
    return normalizedContentType;
  }

  if (typeof payload?.fileExtension === 'string' && payload.fileExtension.length > 0) {
    return guessAudioMimeType(`file.${payload.fileExtension}`);
  }

  return guessAudioMimeType(payload?.sourceUri || payload?.documentUri || '');
}

function requestMediaMetadata(loadToken, payload) {
  if (loadToken !== state.loadToken) {
    return;
  }

  if (!payload?.fileBacked) {
    state.mediaMetadata = {
      ...createMediaMetadataState('error'),
      loadToken,
      message: 'Metadata is only available for local filesystem files.',
    };
    renderMediaMetadata();
    return;
  }

  vscode.postMessage({
    type: 'requestMediaMetadata',
    body: { loadToken },
  });
}

function setAnalysisSourceBuffer(arrayBuffer, mimeType, sourceKind) {
  state.sourceArrayBuffer = arrayBuffer;
  state.sourceMimeType = mimeType || state.sourceMimeType || 'application/octet-stream';
  state.analysisSourceKind = sourceKind;
  renderMediaMetadata();
}

function requestDecodeFallback(loadToken, payload, reason) {
  if (loadToken !== state.loadToken) {
    return Promise.reject(new Error('Decode fallback request is stale.'));
  }

  if (state.decodeFallbackResult && state.decodeFallbackLoadToken === loadToken) {
    return Promise.resolve(state.decodeFallbackResult);
  }

  if (state.decodeFallbackPromise && state.decodeFallbackLoadToken === loadToken) {
    return state.decodeFallbackPromise;
  }

  if (state.decodeFallbackError?.loadToken === loadToken) {
    return Promise.reject(new Error(state.decodeFallbackError.message));
  }

  if (!state.externalTools.canDecodeFallback) {
    return Promise.reject(new Error(state.externalTools.guidance || 'Install ffmpeg CLI to decode this audio file.'));
  }

  state.decodeFallbackLoadToken = loadToken;
  state.decodeFallbackError = null;
  state.decodeFallbackPromise = new Promise((resolve, reject) => {
    state.resolveDecodeFallback = resolve;
    state.rejectDecodeFallback = reject;
  });
  renderMediaMetadata();

  vscode.postMessage({
    type: 'requestDecodeFallback',
    body: {
      loadToken,
      reason,
      sourceUri: payload?.documentUri ?? payload?.sourceUri ?? '',
    },
  });

  return state.decodeFallbackPromise;
}

async function loadDecodedAudioSource(loadToken, payload) {
  const controller = new AbortController();
  state.sourceFetchController = controller;

  try {
    setAnalysisStatus('Loading audio…');

    const response = await fetch(payload.sourceUri, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let audioData = await response.arrayBuffer();
    let mimeType = resolvePlayableAudioMimeType(payload, response.headers.get('content-type'));
    let sourceKind = 'native';

    if (loadToken !== state.loadToken) {
      return;
    }

    setAnalysisSourceBuffer(audioData, mimeType, sourceKind);
    state.playbackSourceKind = sourceKind;
    renderMediaMetadata();

    setAnalysisStatus('Decoding audio…');

    let decodedAudio;

    try {
      decodedAudio = await decodeAudioData(audioData);
    } catch (nativeDecodeError) {
      if (loadToken !== state.loadToken) {
        return;
      }

      setAnalysisStatus('Requesting ffmpeg decode fallback…');
      const fallback = await requestDecodeFallback(loadToken, payload, 'analysis-decode-error');

      if (loadToken !== state.loadToken) {
        return;
      }

      audioData = fallback.audioBuffer;
      mimeType = fallback.mimeType;
      sourceKind = 'ffmpeg-fallback';
      setAnalysisSourceBuffer(audioData, mimeType, sourceKind);
      state.playbackSourceKind = sourceKind;
      renderMediaMetadata();
      setAnalysisStatus('Decoding audio…');
      decodedAudio = await decodeAudioData(audioData);
    }

    if (loadToken !== state.loadToken) {
      return;
    }

    state.decodedAudioBuffer = decodedAudio;
    state.playbackSourceKind = sourceKind;
    state.analysisSourceKind = sourceKind;
    renderMediaMetadata();

    const playbackSession = createPlaybackSession(decodedAudio);
    await state.audioTransport?.load({
      audioBuffer: decodedAudio,
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
    scheduleDeferredAnalysis(loadToken, payload);
  } catch (error) {
    if (loadToken !== state.loadToken || controller.signal.aborted) {
      return;
    }

    if (state.playbackSourceKind !== 'ffmpeg-fallback' && state.externalTools.canDecodeFallback) {
      try {
        setAnalysisStatus('Requesting ffmpeg decode fallback…');
        const fallback = await requestDecodeFallback(loadToken, payload, 'fetch-error');

        if (loadToken !== state.loadToken) {
          return;
        }

        state.playbackSourceKind = 'ffmpeg-fallback';
        setAnalysisSourceBuffer(fallback.audioBuffer, fallback.mimeType, 'ffmpeg-fallback');
        state.playbackSourceKind = 'ffmpeg-fallback';
        renderMediaMetadata();
        setAnalysisStatus('Decoding audio…');

        const decodedAudio = await decodeAudioData(fallback.audioBuffer);

        if (loadToken !== state.loadToken) {
          return;
        }

        state.decodedAudioBuffer = decodedAudio;
        state.playbackSourceKind = 'ffmpeg-fallback';
        state.analysisSourceKind = 'ffmpeg-fallback';
        renderMediaMetadata();
        const playbackSession = createPlaybackSession(decodedAudio);
        await state.audioTransport?.load({
          audioBuffer: decodedAudio,
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
        scheduleDeferredAnalysis(loadToken, payload);
        return;
      } catch (fallbackError) {
        if (loadToken !== state.loadToken) {
          return;
        }

        error = fallbackError;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    setLoudnessSummaryUnavailable(message);
    setFatalStatus(`Unable to load this audio file: ${message}`);
  } finally {
    if (state.sourceFetchController === controller) {
      state.sourceFetchController = null;
    }
  }
}

async function initializeWaveformSurface(loadToken) {
  disposeWaveformRenderer();

  const canvas = document.createElement('canvas');
  canvas.className = 'waveform-canvas';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
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
  if (state.analysisIdleCallbackId !== null && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(state.analysisIdleCallbackId);
  }

  if (state.analysisTimeoutId !== null) {
    window.clearTimeout(state.analysisTimeoutId);
  }

  state.analysisIdleCallbackId = null;
  state.analysisTimeoutId = null;
  state.analysisQueuedForLoadToken = 0;
}

function cancelPendingWaveformPyramidBuild() {
  if (state.waveformPyramidFrame) {
    window.cancelAnimationFrame(state.waveformPyramidFrame);
    state.waveformPyramidFrame = 0;
  }
}

function scheduleWaveformPyramidBuild(loadToken, worker, sessionVersion) {
  cancelPendingWaveformPyramidBuild();
  state.waveformPyramidFrame = window.requestAnimationFrame(() => {
    state.waveformPyramidFrame = 0;

    if (
      loadToken !== state.loadToken
      || !state.waveformWorker
      || state.waveformWorker !== worker
      || sessionVersion !== state.sessionVersion
    ) {
      return;
    }

    worker.postMessage({ type: 'buildWaveformPyramid' });
  });
}

function scheduleDeferredAnalysis(loadToken, payload) {
  if (
    loadToken !== state.loadToken
    || state.analysisStartedForLoadToken === loadToken
    || state.analysisQueuedForLoadToken === loadToken
  ) {
    return;
  }

  cancelDeferredAnalysis();
  state.analysisQueuedForLoadToken = loadToken;
  setAnalysisStatus('Queued');

  const startDeferredAnalysis = () => {
    if (loadToken !== state.loadToken || state.analysisStartedForLoadToken === loadToken) {
      return;
    }

    state.analysisIdleCallbackId = null;
    state.analysisTimeoutId = null;
    state.analysisQueuedForLoadToken = 0;
    state.analysisStartedForLoadToken = loadToken;
    void startAnalysis(loadToken, payload);
  };

  if (typeof window.requestIdleCallback === 'function') {
    state.analysisIdleCallbackId = window.requestIdleCallback(startDeferredAnalysis, {
      timeout: ANALYSIS_IDLE_TIMEOUT_MS,
    });
    return;
  }

  state.analysisTimeoutId = window.setTimeout(startDeferredAnalysis, ANALYSIS_FALLBACK_DELAY_MS);
}

async function startAnalysis(loadToken, payload) {
  if (!analysisWorkerScriptUri || !waveformWorkerScriptUri) {
    setLoudnessSummaryUnavailable('Analysis worker is unavailable.');
    setAnalysisStatus('Analysis worker is unavailable.', true);
    return;
  }

  try {
    const decodedAudio = state.decodedAudioBuffer;

    if (!(decodedAudio instanceof AudioBuffer)) {
      throw new Error('Decoded playback buffer is unavailable.');
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

    const monoSamples = downmixToMono(decodedAudio);

    if (loadToken !== state.loadToken) {
      return;
    }

    state.waveformSamples = monoSamples;

    state.analysis = createSpectrogramAnalysisState({
      duration: decodedAudio.duration,
      quality: normalizeSpectrogramQuality(payload.spectrogramQuality),
      minFrequency: SPECTROGRAM_MIN_FREQUENCY,
      maxFrequency: Math.min(SPECTROGRAM_MAX_FREQUENCY, decodedAudio.sampleRate / 2),
      sampleCount: monoSamples.length,
      sampleRate: decodedAudio.sampleRate,
    });

    ensureWaveformViewRange();
    renderWaveformUi();
    renderSpectrogramScale();
    scheduleSpectrogramRender();

    await Promise.all([
      state.waveformSurfaceReadyPromise,
      state.spectrogramSurfaceReadyPromise,
    ]);

    if (loadToken !== state.loadToken) {
      return;
    }

    state.sessionVersion += 1;
    const sessionVersion = state.sessionVersion;
    setAnalysisStatus('Queued');
    const waveformWorkerSamples = monoSamples.slice();
    const analysisWorkerSamples = monoSamples.slice();

    waveformWorker.postMessage({
      type: 'attachAudioSession',
      body: {
        duration: decodedAudio.duration,
        quality: state.analysis.quality,
        sampleCount: waveformWorkerSamples.length,
        sampleRate: decodedAudio.sampleRate,
        samplesBuffer: waveformWorkerSamples.buffer,
        sessionVersion,
      },
    }, [waveformWorkerSamples.buffer]);
    void syncWaveformView({ force: true });
    scheduleWaveformPyramidBuild(loadToken, waveformWorker, sessionVersion);

    analysisWorker.postMessage({
      type: 'attachAudioSession',
      body: {
        duration: decodedAudio.duration,
        quality: state.analysis.quality,
        sampleCount: analysisWorkerSamples.length,
        sampleRate: decodedAudio.sampleRate,
        samplesBuffer: analysisWorkerSamples.buffer,
        sessionVersion,
      },
    }, [analysisWorkerSamples.buffer]);

    state.decodedAudioBuffer = null;
    requestOverviewSpectrogram({ force: true });
    scheduleSpectrogramRender({ force: true });
  } catch (error) {
    if (loadToken !== state.loadToken) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
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
    void syncWaveformView({ force: true });
    return;
  }

  if (message?.type === 'waveformReady') {
    handleWaveformReady(message.body);
    return;
  }

  if (message?.type === 'error') {
    setFatalStatus(`Waveform renderer failed: ${message.body.message}`);
  }
}

function scheduleSpectrogramRender({ force = false } = {}) {
  if (state.spectrogramFrame) {
    return;
  }

  state.spectrogramFrame = window.requestAnimationFrame(() => {
    state.spectrogramFrame = 0;

    if (!state.analysisWorker || !state.analysis?.initialized) {
      return;
    }

    const { displayRange, pixelHeight, pixelWidth, requestRange } = getVisibleSpectrogramRequestMetrics();
    const renderConfig = getEffectiveSpectrogramRenderConfig();

    if (displayRange.end <= displayRange.start) {
      return;
    }

    resetSpectrogramCanvasTransform();

    const previousGeneration = state.analysis.generation;
    const configVersion = state.analysis.configVersion ?? 0;
    const needsNewGeneration = force || !isSameVisibleRequest(
      state.analysis.activeVisibleRequest,
      requestRange,
      { pixelHeight, pixelWidth },
    );
    const generation = needsNewGeneration ? previousGeneration + 1 : previousGeneration;

    if (needsNewGeneration) {
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
    }

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

function getSpectrogramCanvasTargetSize() {
  const clientWidth = Math.max(1, elements.spectrogram.clientWidth);
  const clientHeight = Math.max(1, elements.spectrogram.clientHeight);

  return {
    clientHeight,
    clientWidth,
    pixelHeight: Math.max(1, Math.round(clientHeight * DISPLAY_PIXEL_RATIO)),
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

function queueVisibleSpectrogramRequest({ force = false } = {}) {
  scheduleSpectrogramRender({ force });
}

function isSameVisibleRequest(activeRequest, range, size) {
  if (!activeRequest) {
    return false;
  }

  const renderConfig = getEffectiveSpectrogramRenderConfig();

  return Math.abs(activeRequest.viewStart - range.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(activeRequest.viewEnd - range.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && (activeRequest.configVersion ?? 0) === (state.analysis?.configVersion ?? 0)
    && activeRequest.analysisType === renderConfig.analysisType
    && activeRequest.fftSize === renderConfig.fftSize
    && activeRequest.frequencyScale === renderConfig.frequencyScale
    && Math.abs((activeRequest.overlapRatio ?? 0) - renderConfig.overlapRatio) <= 1e-6
    && Math.abs(activeRequest.pixelWidth - size.pixelWidth) <= 1
    && Math.abs(activeRequest.pixelHeight - size.pixelHeight) <= 1;
}

function handleWaveformReady(body) {
  if (!state.waveformWorker) {
    return;
  }

  if (body.generation !== state.waveformRequestGeneration) {
    state.waveformWorker.postMessage({
      type: 'discardWaveformRender',
      body: { generation: body.generation },
    });
    return;
  }

  const pendingRequest = state.waveformPendingRequest?.generation === body.generation
    ? state.waveformPendingRequest
    : null;
  const { width: fallbackWidth, height: fallbackHeight } = getWaveformViewportSize();
  const width = pendingRequest?.width ?? fallbackWidth;
  const height = pendingRequest?.height ?? fallbackHeight;

  state.waveformRenderRange = {
    end: body.viewEnd,
    start: body.viewStart,
  };
  state.waveformRenderWidth = width;
  state.waveformRenderHeight = height;
  state.waveformRenderVisibleSpan = pendingRequest?.visibleSpan ?? Math.max(0, body.viewEnd - body.viewStart);
  state.waveformSamplePlotMode = Boolean(body.samplePlotMode);
  state.waveformRawSamplePlotMode = Boolean(body.rawSamplePlotMode);
  state.waveformPendingRequest = null;
  applyWaveformCanvasTransform();

  if (isSmoothFollowPlaybackActive()) {
    renderWaveformAxis({
      displayRange: getWaveformRange(),
      renderRange: state.waveformRenderRange,
      renderWidth: state.waveformRenderWidth,
    });
  }

  state.waveformWorker.postMessage({
    type: 'commitWaveformRender',
    body: { generation: body.generation },
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

function getTimeAtViewportClientX(clientX, targetElement) {
  const range = getWaveformRange();
  const span = Math.max(0, range.end - range.start);
  const { offsetX, width } = getViewportPointerMetrics(targetElement, clientX);

  if (span <= 0 || width <= 0) {
    return 0;
  }

  const ratio = offsetX / width;
  return clamp(range.start + ratio * span, 0, getEffectiveDuration());
}

function getTimeAtViewportPointerEvent(event, targetElement) {
  const range = getWaveformRange();
  const span = Math.max(0, range.end - range.start);
  const { offsetX, width } = getViewportPointerMetricsFromEvent(targetElement, event);

  if (span <= 0 || width <= 0) {
    return 0;
  }

  const ratio = offsetX / width;
  return clamp(range.start + ratio * span, 0, getEffectiveDuration());
}

function getTimeAtWaveformClientX(clientX) {
  return getTimeAtViewportClientX(clientX, elements.waveformHitTarget ?? elements.waveformViewport);
}

function getTimeAtWaveformPointerEvent(event) {
  return getTimeAtViewportPointerEvent(event, elements.waveformHitTarget ?? elements.waveformViewport);
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

function hasPlaybackTransport() {
  return Boolean(state.audioTransport)
    && state.playbackTransportKind === 'audio-worklet-copy'
    && getEffectiveDuration() > 0;
}

function isPlaybackActive() {
  return state.audioTransport?.isPlaying() === true;
}

function getCurrentPlaybackTime() {
  const duration = getEffectiveDuration();
  const currentTime = Number(state.audioTransport?.getCurrentTime());
  return clamp(currentTime, 0, duration || 0);
}

function setPlaybackPosition(timeSeconds, { sync = true } = {}) {
  if (!state.audioTransport) {
    return;
  }

  const duration = getEffectiveDuration();

  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(timeSeconds)) {
    return;
  }

  const nextTime = clamp(timeSeconds, 0, duration);
  state.audioTransport.seek(nextTime);

  if (sync) {
    syncTransport();
  }
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

function syncWaveformSelection() {
  const activeSelection = state.selectionDraft ?? state.loopRange;
  const range = getWaveformRange();
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

function renderWaveformUi() {
  const duration = getEffectiveDuration();
  const range = getWaveformRange();
  const span = Math.max(0, range.end - range.start);
  const zoomFactor = duration > 0 && span > 0 ? duration / span : 1;
  const loopLabelRange = state.selectionDraft ?? state.loopRange;

  elements.waveZoomReset.textContent = 'Reset';
  if (elements.waveZoomChip) {
    elements.waveZoomChip.textContent = `Zoom ${zoomFactor.toFixed(1)}x`;
  }
  elements.waveFollow.checked = state.followPlayback;
  const hintText = duration > 0
    ? 'Seek, drag loop, or wheel to zoom and pan.'
    : 'Preparing playback and analysis.';
  elements.waveHint.textContent =
    hintText;
  if (elements.waveToolbar) {
    elements.waveToolbar.title = hintText;
  }
  if (elements.waveToolbarInfo) {
    elements.waveToolbarInfo.title = hintText;
  }
  elements.waveLoopLabel.textContent = loopLabelRange
    ? `Loop ${formatAxisLabel(loopLabelRange.start)} - ${formatAxisLabel(loopLabelRange.end)}`
    : 'Drag to set loop';
  elements.waveClearLoop.hidden = !state.loopRange;

  renderWaveformAxis();
  applyWaveformOverviewThumb();
  syncWaveformSelection();
  applyWaveformPlaybackTime(getCurrentPlaybackTime());
  applyWaveformCanvasTransform(range);
  refreshWaveformHoverPresentation();
  scheduleSpectrogramRender();
}

function renderWaveformAxis(options = {}) {
  const { displayRange, renderRange, renderWidth, viewportWidth } = getWaveformAxisRenderMetrics(options);
  const span = renderRange.end - renderRange.start;

  elements.waveformAxis.replaceChildren();

  if (span <= 0 || viewportWidth <= 0) {
    state.waveformAxisRenderRange = { start: 0, end: 0 };
    state.waveformAxisRenderWidth = 0;
    return;
  }

  state.waveformAxisRenderRange = renderRange;
  state.waveformAxisRenderWidth = renderWidth;

  const axisContent = document.createElement('div');
  axisContent.className = 'waveform-axis-content';
  axisContent.style.width = `${renderWidth}px`;

  const tickCount = Math.max(12, Math.min(28, Math.floor(viewportWidth / 48)));
  const step = getNiceTimeStep(span / tickCount);
  const ticks = [];
  const firstTick = Math.ceil(renderRange.start / step) * step;

  for (let tick = firstTick; tick <= renderRange.end + step * 0.25; tick += step) {
    ticks.push(Number(tick.toFixed(6)));
  }

  if (ticks.length === 0 || Math.abs(ticks[0] - renderRange.start) > step * 0.35) {
    ticks.unshift(renderRange.start);
  }

  const lastTick = ticks[ticks.length - 1];
  if (Math.abs(lastTick - renderRange.end) > step * 0.35) {
    ticks.push(renderRange.end);
  }

  ticks.forEach((tick, index) => {
    const position = ((tick - renderRange.start) / span) * 100;
    const align = index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'center';
    const transform =
      align === 'start'
        ? 'translateX(0)'
        : align === 'end'
          ? 'translateX(-100%)'
          : 'translateX(-50%)';

    const tickElement = document.createElement('div');
    tickElement.className = 'waveform-axis-tick';
    tickElement.style.left = `${position}%`;
    tickElement.style.transform = transform;

    const mark = document.createElement('div');
    mark.className = 'waveform-axis-mark';

    const label = document.createElement('div');
    label.className = 'waveform-axis-label';
    label.textContent = formatAxisLabel(tick);

    tickElement.append(mark, label);
    axisContent.append(tickElement);
  });

  elements.waveformAxis.append(axisContent);
  applyWaveformAxisTransform(displayRange);
}

function applyWaveformOverviewThumb(range = getWaveformRange()) {
  const duration = getEffectiveDuration();
  const span = Math.max(0, range.end - range.start);
  const trackWidth = Math.max(1, elements.waveformOverview.clientWidth);

  if (duration <= 0 || span <= 0) {
    elements.waveformOverviewThumb.style.width = `${trackWidth}px`;
    elements.waveformOverviewThumb.style.transform = 'translate3d(0px, 0, 0)';
    return;
  }

  const normalizedSpan = clamp(span / duration, 0, 1);
  const widthPx = normalizedSpan >= 0.9999
    ? trackWidth
    : Math.min(trackWidth, Math.max(16, normalizedSpan * trackWidth));
  const maxLeftPx = Math.max(0, trackWidth - widthPx);
  const scrollableDuration = Math.max(0, duration - span);
  const normalizedStart = scrollableDuration > 0
    ? clamp(range.start / scrollableDuration, 0, 1)
    : 0;
  const leftPx = clamp(normalizedStart * maxLeftPx, 0, maxLeftPx);

  elements.waveformOverviewThumb.style.width = `${widthPx}px`;
  elements.waveformOverviewThumb.style.transform = `translate3d(${leftPx}px, 0, 0)`;
}

function applyWaveformPlaybackTime(timeSeconds, range = getWaveformRange(timeSeconds)) {
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

function syncFollowView(timeSeconds, range = getWaveformRange(timeSeconds)) {
  if (
    !state.followPlayback ||
    !Number.isFinite(timeSeconds) ||
    timeSeconds < 0 ||
    isFollowPlaybackInteractionActive()
  ) {
    return;
  }

  if (isSmoothFollowPlaybackActive()) {
    commitWaveformDisplayRange(range);
    applyWaveformOverviewThumb(range);
    syncWaveformSelection();
    applyWaveformCanvasTransform(range);
    applyWaveformAxisTransform(range);

    if (hasCommittedWaveformRenderCoverage(range) && !hasWaveformAxisRenderCoverage(range)) {
      renderWaveformAxis({
        displayRange: range,
        renderRange: state.waveformRenderRange,
        renderWidth: state.waveformRenderWidth,
      });
    }

    if (!hasWaveformRenderCoverage(range)) {
      void syncWaveformView();
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

  state.waveformViewRange = {
    start: nextStart,
    end: nextStart + span,
  };
  renderWaveformUi();
  queueVisibleSpectrogramRequest();
  void syncWaveformView();
}

async function syncWaveformView({ force = false } = {}) {
  const duration = getEffectiveDuration();
  const { displayRange, height, renderRange, renderWidth } = getWaveformRenderRequestMetrics();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);

  if (!state.waveformCanvas || !state.waveformWorker || duration <= 0 || displayRange.end <= displayRange.start) {
    return;
  }

  if (!force && hasWaveformRenderCoverage(displayRange)) {
    applyWaveformCanvasTransform(displayRange);
    return;
  }

  state.waveformRequestGeneration += 1;
  state.waveformPendingRequest = {
    end: renderRange.end,
    generation: state.waveformRequestGeneration,
    height,
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

function updateWaveformViewRange(updater) {
  const duration = getEffectiveDuration();

  if (duration <= 0) {
    return;
  }

  const current = getWaveformRange();
  const rawNext = updater(current);
  state.waveformViewRange = normalizeWaveformRange(rawNext, duration);
  renderWaveformUi();
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
  }));
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

  state.waveformViewRange = { start: 0, end: duration };
  renderWaveformUi();
  queueVisibleSpectrogramRequest();
  void syncWaveformView();
}

function disableFollowPlayback() {
  if (!state.followPlayback) {
    return;
  }

  state.followPlayback = false;
  elements.waveFollow.checked = false;
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

function getWaveformMarkerY(sampleValue, rectHeight) {
  const chartTop = WAVEFORM_TOP_PADDING_PX;
  const chartBottom = Math.max(chartTop + 1, rectHeight - WAVEFORM_BOTTOM_PADDING_PX);
  const chartHeight = Math.max(1, chartBottom - chartTop);

  return clamp(
    chartTop + (chartHeight * 0.5) - (sampleValue * chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO),
    chartTop,
    chartBottom,
  );
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

function getWaveformSampleInfoAtClientX(clientX) {
  const samples = state.waveformSamples;
  const sampleRate = Number(state.analysis?.sampleRate);
  const targetElement = elements.waveformHitTarget ?? elements.waveformViewport;
  const range = getWaveformRange();
  const span = Math.max(0, range.end - range.start);

  if (
    !state.waveformSamplePlotMode
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
  const rect = targetElement.getBoundingClientRect();

  if (width <= 0 || rect.height <= 0) {
    return null;
  }

  const visibleSampleCount = Math.max(1, span * sampleRate);
  const sampleStartPosition = range.start * sampleRate;
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const visibleSampleSpan = Math.max(0, visibleSampleCount - 1);

  if (state.waveformRawSamplePlotMode) {
    const samplePosition = sampleStartPosition + ((offsetX / width) * visibleSampleSpan);
    const sampleIndex = clamp(Math.round(samplePosition), 0, maxSampleIndex);
    const sampleValue = samples[sampleIndex] ?? 0;

    return {
      markerX: clamp(
        visibleSampleSpan <= 0
          ? 0
          : ((sampleIndex - sampleStartPosition) / visibleSampleSpan) * width,
        0,
        width,
      ),
      markerY: getWaveformMarkerY(sampleValue, rect.height),
      sampleIndex,
      sampleNumber: sampleIndex + 1,
      sampleValue,
      showMarker: true,
    };
  }

  const columnCount = Math.max(1, Math.round(width * Math.max(1, WAVEFORM_RENDER_SCALE)));
  const columnIndex = clamp(
    Math.round((offsetX / width) * Math.max(0, columnCount - 1)),
    0,
    Math.max(0, columnCount - 1),
  );
  const columnStartPosition = sampleStartPosition + (columnIndex / columnCount) * visibleSampleCount;
  const columnEndPosition = sampleStartPosition + ((columnIndex + 1) / columnCount) * visibleSampleCount;
  const representativeSample = pickRepresentativeWaveformSample(samples, columnStartPosition, columnEndPosition);

  if (!representativeSample) {
    return null;
  }

  return {
    markerX: clamp(
      columnCount <= 1
        ? 0
        : (columnIndex / Math.max(1, columnCount - 1)) * width,
      0,
      width,
    ),
    markerY: getWaveformMarkerY(representativeSample.value, rect.height),
    sampleIndex: representativeSample.index,
    sampleNumber: representativeSample.index + 1,
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

function refreshWaveformHoverPresentation() {
  const duration = getEffectiveDuration();
  const point = state.waveformHoverClientPoint;

  if (!point || !hasPlaybackTransport() || duration <= 0) {
    hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
    hideWaveformSampleMarker();
    return;
  }

  const sampleInfo = getWaveformSampleInfoAtClientX(point.clientX);
  const sampleDetail = sampleInfo?.showMarker ? sampleInfo : null;
  const timeLabel = formatAxisLabel(getTimeAtWaveformClientX(point.clientX));
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
  handleElement.addEventListener('pointermove', moveLoopHandleDrag);
  handleElement.addEventListener('pointerup', (event) => {
    releaseLoopHandleDrag(event);
  });
  handleElement.addEventListener('pointercancel', (event) => {
    releaseLoopHandleDrag(event, true);
  });
}

function normalizeViewportSplitRatio(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_VIEWPORT_SPLIT_RATIO;
  }

  return clamp(value, VIEWPORT_RATIO_MIN, VIEWPORT_RATIO_MAX);
}

function getNumericStyleSize(element, propertyName, fallback = 0) {
  if (!element) {
    return fallback;
  }

  const computedValue = Number.parseFloat(window.getComputedStyle(element)[propertyName]);
  return Number.isFinite(computedValue) ? computedValue : fallback;
}

function getViewportSplitterSize() {
  return Math.max(
    1,
    elements.viewportSplitter?.offsetHeight
      || getNumericStyleSize(elements.viewportSplitter, 'minHeight', VIEWPORT_SPLITTER_FALLBACK_SIZE_PX),
  );
}

function getWavePanelMinimumHeight() {
  const waveformViewportMinHeight = getNumericStyleSize(elements.waveformViewport, 'minHeight', 168);

  return Math.max(
    waveformViewportMinHeight,
    (elements.waveToolbar?.offsetHeight || 0)
      + (elements.waveformAxis?.offsetHeight || 0)
      + waveformViewportMinHeight,
  );
}

function getSpectrogramPanelMinimumHeight() {
  return Math.max(
    VIEWPORT_MIN_SPECTROGRAM_HEIGHT_PX,
    getNumericStyleSize(elements.spectrogramStage, 'minHeight', VIEWPORT_MIN_SPECTROGRAM_HEIGHT_PX),
  );
}

function resolveViewportPanelHeights(availableHeight, ratio = state.viewportSplitRatio) {
  const safeAvailableHeight = Math.max(0, availableHeight);

  if (safeAvailableHeight <= 0) {
    return { waveHeight: 0, spectrogramHeight: 0 };
  }

  const desiredWaveHeight = safeAvailableHeight * normalizeViewportSplitRatio(ratio);
  const minimumWaveHeight = Math.min(getWavePanelMinimumHeight(), safeAvailableHeight);
  const minimumSpectrogramHeight = Math.min(getSpectrogramPanelMinimumHeight(), safeAvailableHeight);

  if ((minimumWaveHeight + minimumSpectrogramHeight) >= safeAvailableHeight) {
    const waveHeight = Math.round(clamp(desiredWaveHeight, 0, safeAvailableHeight));

    return {
      waveHeight,
      spectrogramHeight: Math.max(0, safeAvailableHeight - waveHeight),
    };
  }

  const waveHeight = Math.round(clamp(
    desiredWaveHeight,
    minimumWaveHeight,
    safeAvailableHeight - minimumSpectrogramHeight,
  ));

  return {
    waveHeight,
    spectrogramHeight: Math.max(0, safeAvailableHeight - waveHeight),
  };
}

function updateViewportSplitterAccessibility(waveHeight, availableHeight) {
  if (!elements.viewportSplitter) {
    return;
  }

  const wavePercentage = availableHeight > 0
    ? Math.round((waveHeight / availableHeight) * 100)
    : Math.round(state.viewportSplitRatio * 100);
  const spectrogramPercentage = Math.max(0, 100 - wavePercentage);

  elements.viewportSplitter.setAttribute('aria-valuenow', String(wavePercentage));
  elements.viewportSplitter.setAttribute(
    'aria-valuetext',
    `Waveform ${wavePercentage}%, spectrogram ${spectrogramPercentage}%`,
  );
}

function applyViewportSplit(force = false) {
  if (!elements.viewport || !elements.viewportSplitter) {
    return;
  }

  const splitterSize = getViewportSplitterSize();
  const availableHeight = Math.max(0, elements.viewport.clientHeight - splitterSize);

  if (availableHeight <= 0) {
    updateViewportSplitterAccessibility(0, 0);
    return;
  }

  const { waveHeight, spectrogramHeight } = resolveViewportPanelHeights(availableHeight);
  const nextTemplate = `${waveHeight}px ${splitterSize}px ${spectrogramHeight}px`;

  if (!force && elements.viewport.style.gridTemplateRows === nextTemplate) {
    updateViewportSplitterAccessibility(waveHeight, availableHeight);
    return;
  }

  elements.viewport.style.gridTemplateRows = nextTemplate;
  updateViewportSplitterAccessibility(waveHeight, availableHeight);
}

function setViewportSplitRatio(ratio, force = false) {
  const nextRatio = normalizeViewportSplitRatio(ratio);
  const ratioChanged = Math.abs(state.viewportSplitRatio - nextRatio) > 0.001;

  state.viewportSplitRatio = nextRatio;

  if (ratioChanged || force) {
    applyViewportSplit(force);
  }
}

function updateViewportSplitRatioFromClientY(clientY) {
  if (!elements.viewport) {
    return;
  }

  const splitterSize = getViewportSplitterSize();
  const viewportRect = elements.viewport.getBoundingClientRect();
  const availableHeight = Math.max(0, viewportRect.height - splitterSize);

  if (availableHeight <= 0) {
    return;
  }

  const proposedWaveHeight = clamp(clientY - viewportRect.top - (splitterSize / 2), 0, availableHeight);
  const { waveHeight } = resolveViewportPanelHeights(availableHeight, proposedWaveHeight / availableHeight);
  setViewportSplitRatio(waveHeight / availableHeight, true);
}

function beginViewportSplitDrag(event) {
  if (!elements.viewportSplitter) {
    return;
  }

  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }

  event.preventDefault();
  elements.viewportSplitter.dataset.dragging = 'true';
  elements.viewportSplitter.setPointerCapture(event.pointerId);
  state.viewportResizeDrag = { pointerId: event.pointerId };
  updateViewportSplitRatioFromClientY(event.clientY);
}

function updateViewportSplitDrag(event) {
  const dragState = state.viewportResizeDrag;

  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  updateViewportSplitRatioFromClientY(event.clientY);
}

function endViewportSplitDrag(event, cancelled = false) {
  const dragState = state.viewportResizeDrag;

  if (!dragState || dragState.pointerId !== event.pointerId || !elements.viewportSplitter) {
    return;
  }

  if (elements.viewportSplitter.hasPointerCapture?.(event.pointerId)) {
    elements.viewportSplitter.releasePointerCapture(event.pointerId);
  }

  delete elements.viewportSplitter.dataset.dragging;
  state.viewportResizeDrag = null;

  if (!cancelled) {
    updateViewportSplitRatioFromClientY(event.clientY);
  }
}

function resetViewportSplit() {
  setViewportSplitRatio(DEFAULT_VIEWPORT_SPLIT_RATIO, true);
}

function handleViewportSplitterKeydown(event) {
  let nextRatio = null;

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
  setViewportSplitRatio(nextRatio, true);
}

function handleSharedViewportWheel(event, targetElement) {
  const duration = getEffectiveDuration();
  const range = getWaveformRange();
  const span = range.end - range.start;
  const rect = targetElement.getBoundingClientRect();
  const width = rect.width;

  if (duration <= 0 || span <= 0 || width <= 0) {
    return;
  }

  event.preventDefault();

  const deltaScale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? width
        : 1;
  const deltaX = event.deltaX * deltaScale;
  const deltaY = event.deltaY * deltaScale;
  const horizontalMagnitude = Math.abs(deltaX);
  const verticalMagnitude = Math.abs(deltaY);
  const intent = verticalMagnitude >= horizontalMagnitude ? 'zoom' : 'pan';
  const shouldPreserveFollowZoom = state.followPlayback && intent === 'zoom' && verticalMagnitude > 0.01;
  const pointerRatio = getViewportPointerRatio(event.clientX, targetElement);
  const currentPlaybackTime = getCurrentPlaybackTime();
  const anchorTime = shouldPreserveFollowZoom && Number.isFinite(currentPlaybackTime)
    ? clamp(currentPlaybackTime, 0, duration)
    : getTimeAtViewportClientX(event.clientX, targetElement);

  if (intent === 'pan' && horizontalMagnitude > 0.01) {
    disableFollowPlayback();
  }

  updateWaveformViewRange((current) => {
    const currentSpan = Math.max(getMinVisibleDuration(duration), current.end - current.start);
    let nextSpan = currentSpan;
    let nextStart = current.start;

    if (intent === 'zoom' && verticalMagnitude > 0.01) {
      const zoomScale = Math.pow(WAVEFORM_ZOOM_STEP_FACTOR, deltaY / 180);
      nextSpan = clamp(
        nextSpan * zoomScale,
        getMinVisibleDuration(duration),
        Math.max(getMinVisibleDuration(duration), duration),
      );

      if (Math.abs(nextSpan - currentSpan) <= 1e-9) {
        return current;
      }

      const anchorRatio = shouldPreserveFollowZoom
        ? clamp((anchorTime - current.start) / currentSpan, 0, 1)
        : pointerRatio;

      nextStart = anchorTime - nextSpan * anchorRatio;
    }

    if (intent === 'pan' && horizontalMagnitude > 0.01) {
      const secondsPerPixel = nextSpan / Math.max(1, width);
      nextStart += deltaX * secondsPerPixel;
    }

    return {
      start: nextStart,
      end: nextStart + nextSpan,
    };
  });
}

function attachUiEvents() {
  elements.mediaMetadataPanel?.addEventListener('mouseenter', () => {
    setMediaMetadataDetailOpen(true);
  });
  elements.mediaMetadataPanel?.addEventListener('mouseleave', () => {
    setMediaMetadataDetailOpen(false);
  });
  elements.mediaMetadataPanel?.addEventListener('focusin', () => {
    setMediaMetadataDetailOpen(true);
  });
  elements.mediaMetadataPanel?.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && elements.mediaMetadataPanel?.contains(event.relatedTarget)) {
      return;
    }

    setMediaMetadataDetailOpen(false);
  });
  elements.waveToolbar?.addEventListener('scroll', () => {
    updateMediaMetadataDetailPosition();
  }, { passive: true });
  window.addEventListener('resize', () => {
    updateMediaMetadataDetailPosition();
  });

  elements.viewportSplitter?.addEventListener('pointerdown', (event) => {
    beginViewportSplitDrag(event);
  });
  elements.viewportSplitter?.addEventListener('pointermove', (event) => {
    updateViewportSplitDrag(event);
  });
  elements.viewportSplitter?.addEventListener('pointerup', (event) => {
    endViewportSplitDrag(event);
  });
  elements.viewportSplitter?.addEventListener('pointercancel', (event) => {
    endViewportSplitDrag(event, true);
  });
  elements.viewportSplitter?.addEventListener('dblclick', () => {
    resetViewportSplit();
  });
  elements.viewportSplitter?.addEventListener('keydown', (event) => {
    handleViewportSplitterKeydown(event);
  });

  elements.spectrogramTypeSelect?.addEventListener('change', () => {
    state.spectrogramRenderConfig.analysisType = normalizeSpectrogramAnalysisType(elements.spectrogramTypeSelect.value);
    renderSpectrogramScale();
    renderSpectrogramMeta();
    refreshSpectrogramAnalysisConfig();
  });

  elements.spectrogramFftSelect?.addEventListener('change', () => {
    state.spectrogramRenderConfig.fftSize = normalizeSpectrogramFftSize(elements.spectrogramFftSelect.value);
    renderSpectrogramMeta();
    refreshSpectrogramAnalysisConfig();
  });

  elements.spectrogramOverlapSelect?.addEventListener('change', () => {
    state.spectrogramRenderConfig.overlapRatio = normalizeSpectrogramOverlapRatio(elements.spectrogramOverlapSelect.value);
    renderSpectrogramMeta();
    refreshSpectrogramAnalysisConfig();
  });

  elements.spectrogramScaleSelect?.addEventListener('change', () => {
    state.spectrogramRenderConfig.frequencyScale = normalizeSpectrogramFrequencyScale(elements.spectrogramScaleSelect.value);
    renderSpectrogramScale();
    renderSpectrogramMeta();
    refreshSpectrogramAnalysisConfig();
  });

  elements.seekBackward.addEventListener('click', () => {
    seekBy(-5);
  });
  elements.playToggle.addEventListener('click', () => {
    void togglePlayback();
  });
  elements.seekForward.addEventListener('click', () => {
    seekBy(5);
  });
  elements.timeline.addEventListener('input', (event) => {
    if (!hasPlaybackTransport()) {
      return;
    }

    const progress = Number(event.target.value);
    const duration = getEffectiveDuration();

    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    setPlaybackPosition(progress * duration);
  });
  elements.waveformOverview.addEventListener('pointermove', (event) => {
    updateTimelineHoverTooltip(event);
  });
  elements.waveformOverview.addEventListener('pointerleave', () => {
    hideTimelineHoverTooltip();
  });
  elements.waveformOverview.addEventListener('pointercancel', () => {
    hideTimelineHoverTooltip();
  });

  elements.waveZoomOut.addEventListener('click', () => {
    zoomWaveformOut();
  });
  elements.waveZoomReset.addEventListener('click', () => {
    resetWaveformZoom();
  });
  elements.waveZoomIn.addEventListener('click', () => {
    zoomWaveformIn();
  });
  elements.waveFollow.addEventListener('change', (event) => {
    state.followPlayback = event.target.checked;
    syncTransport();
  });
  elements.waveClearLoop.addEventListener('click', () => {
    state.loopRange = null;
    state.selectionDraft = null;
    state.audioTransport?.setLoop(null);
    renderWaveformUi();
    syncTransport();
  });

  elements.waveformViewport.addEventListener('wheel', (event) => {
    handleSharedViewportWheel(event, elements.waveformViewport);
  }, { passive: false });

  elements.waveformHitTarget.addEventListener('pointerdown', (event) => {
    const duration = getEffectiveDuration();
    const range = getWaveformRange();

    if (!hasPlaybackTransport() || duration <= 0 || range.end <= range.start) {
      return;
    }

    beginSelectionDrag(event, elements.waveformHitTarget);
  });

  elements.waveformHitTarget.addEventListener('pointermove', (event) => {
    updateWaveformHoverTooltip(event);
    updateSelectionDrag(event, elements.waveformHitTarget);
  });
  elements.waveformHitTarget.addEventListener('pointerleave', () => {
    hideWaveformHoverTooltip();
  });

  const releaseWaveformPointer = (event) => {
    releaseSelectionDrag(event, elements.waveformHitTarget);
  };

  elements.waveformHitTarget.addEventListener('pointerup', releaseWaveformPointer);
  elements.waveformHitTarget.addEventListener('pointercancel', (event) => {
    hideWaveformHoverTooltip();
    releaseSelectionDrag(event, elements.waveformHitTarget, true);
  });

  bindLoopHandle(elements.waveformLoopStart, 'start', elements.waveformHitTarget);
  bindLoopHandle(elements.waveformLoopEnd, 'end', elements.waveformHitTarget);
  bindLoopHandle(elements.spectrogramLoopStart, 'start', elements.spectrogramHitTarget);
  bindLoopHandle(elements.spectrogramLoopEnd, 'end', elements.spectrogramHitTarget);

  elements.spectrogramHitTarget.addEventListener('pointerdown', (event) => {
    const duration = getEffectiveDuration();
    const range = getWaveformRange();

    if (!hasPlaybackTransport() || duration <= 0 || range.end <= range.start) {
      return;
    }

    beginSelectionDrag(event, elements.spectrogramHitTarget);
  });

  elements.spectrogramHitTarget.addEventListener('pointermove', (event) => {
    updateSpectrogramHoverTooltip(event);
    updateSelectionDrag(event, elements.spectrogramHitTarget);
  });
  elements.spectrogramHitTarget.addEventListener('pointerleave', () => {
    hideSpectrogramHoverTooltip();
  });

  elements.spectrogramHitTarget.addEventListener('pointerup', (event) => {
    releaseSelectionDrag(event, elements.spectrogramHitTarget);
  });

  elements.spectrogramHitTarget.addEventListener('pointercancel', (event) => {
    hideSpectrogramHoverTooltip();
    releaseSelectionDrag(event, elements.spectrogramHitTarget, true);
  });

  elements.spectrogramHitTarget.addEventListener('wheel', (event) => {
    handleSharedViewportWheel(event, elements.spectrogramHitTarget);
  }, { passive: false });

  elements.spectrogramHitTarget.addEventListener('dblclick', () => {
    void togglePlayback();
  });
}

function attachResizeObservers() {
  const resizeObserver = new ResizeObserver(() => {
    applyViewportSplit();
    const { height, width } = getWaveformViewportSize();
    const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
    const overviewWidth = Math.max(1, elements.waveformOverview.clientWidth);
    const waveformViewportResized =
      state.observedWaveformViewportWidth !== width
      || state.observedWaveformViewportHeight !== height;
    const dimensionsUnchanged =
      !waveformViewportResized
      && state.observedSpectrogramPixelWidth === pixelWidth
      && state.observedSpectrogramPixelHeight === pixelHeight
      && state.observedOverviewWidth === overviewWidth;

    if (dimensionsUnchanged) {
      return;
    }

    state.observedWaveformViewportWidth = width;
    state.observedWaveformViewportHeight = height;
    state.observedSpectrogramPixelWidth = pixelWidth;
    state.observedSpectrogramPixelHeight = pixelHeight;
    state.observedOverviewWidth = overviewWidth;

    if (state.waveformWorker) {
      const pendingWaveformWidth = Number(state.waveformPendingRequest?.width);
      const committedWaveformWidth = Number(state.waveformRenderWidth);
      const activeWaveformWidth = Math.max(
        1,
        Math.round(
          (Number.isFinite(pendingWaveformWidth) && pendingWaveformWidth > 0)
            ? pendingWaveformWidth
            : (Number.isFinite(committedWaveformWidth) && committedWaveformWidth > 0)
              ? committedWaveformWidth
              : width,
        ),
      );

      state.waveformWorker.postMessage({
        type: 'resizeCanvas',
        body: {
          color: WAVEFORM_COLOR,
          height,
          renderScale: WAVEFORM_RENDER_SCALE,
          width: activeWaveformWidth,
        },
      });
    }

    if (state.analysisWorker) {
      state.analysisWorker.postMessage({
        type: 'resizeCanvas',
        body: {
          pixelHeight,
          pixelWidth,
        },
      });
    }

    renderWaveformUi();
    void syncWaveformView({ force: waveformViewportResized });
    renderSpectrogramScale();
    resetSpectrogramCanvasTransform();
    requestOverviewSpectrogram({ force: true });
    queueVisibleSpectrogramRequest({ force: true });
    scheduleSpectrogramRender({ force: true });
  });

  resizeObserver.observe(document.body);
  resizeObserver.observe(elements.viewport);
  resizeObserver.observe(elements.waveformViewport);
  resizeObserver.observe(elements.waveformOverview);
}

function destroySession() {
  window.cancelAnimationFrame(state.playbackFrame);
  window.cancelAnimationFrame(state.spectrogramFrame);
  window.cancelAnimationFrame(state.spectrogramRequestFrame);
  state.playbackFrame = 0;
  state.spectrogramFrame = 0;
  state.spectrogramRequestFrame = 0;

  cancelDeferredAnalysis();
  cancelPendingWaveformPyramidBuild();

  if (state.sourceFetchController) {
    state.sourceFetchController.abort();
    state.sourceFetchController = null;
  }

  state.rejectDecodeFallback?.(new Error('Decode fallback request was cancelled.'));

  disposeAnalysisWorker();
  disposeWaveformRenderer();
  disposeSpectrogramSurface();

  const audioTransport = state.audioTransport;
  state.audioTransport = null;
  void audioTransport?.dispose();

  state.waveformRequestGeneration = 0;
  state.waveformPendingRequest = null;
  state.waveformRenderRange = { start: 0, end: 0 };
  state.waveformRenderWidth = 0;
  state.waveformRenderHeight = 0;
  state.waveformRenderVisibleSpan = 0;
  state.waveformSamplePlotMode = false;
  state.waveformRawSamplePlotMode = false;
  state.waveformAxisRenderRange = { start: 0, end: 0 };
  state.waveformAxisRenderWidth = 0;
  state.decodedAudioBuffer = null;
  state.sourceArrayBuffer = null;
  state.sourceMimeType = null;
  state.waveformSamples = null;
  state.externalTools = createExternalToolStatusState();
  state.mediaMetadata = createMediaMetadataState('idle');
  state.mediaMetadataDetailOpen = false;
  state.playbackSourceKind = 'native';
  state.playbackTransportKind = 'unavailable';
  state.playbackTransportError = null;
  state.analysisSourceKind = 'native';
  state.decodeFallbackLoadToken = 0;
  state.decodeFallbackPromise = null;
  state.decodeFallbackResult = null;
  state.decodeFallbackError = null;
  state.resolveDecodeFallback = null;
  state.rejectDecodeFallback = null;
  state.waveformViewRange = { start: 0, end: 0 };
  state.waveformHoverClientPoint = null;
  state.waveformSeekPointerId = null;
  state.selectionDrag = null;
  state.selectionDraft = null;
  state.loopHandleDrag = null;
  state.loopRange = null;
  state.analysisStartedForLoadToken = 0;
  state.analysisQueuedForLoadToken = 0;
  state.sessionVersion = 0;
  state.analysis = null;
  state.loudness = createLoudnessSummaryState('idle');
  state.waveformSurfaceReadyPromise = null;
  state.spectrogramSurfaceReadyPromise = null;
  hideWaveformHoverTooltip();
  hideSpectrogramHoverTooltip();
  renderWaveformUi();
  renderSpectrogramMeta();
  renderLoudnessSummary();
  renderMediaMetadata();
}

function disposeAnalysisWorker() {
  if (state.analysisWorker) {
    state.analysisWorker.postMessage({ type: 'disposeSession' });
    state.analysisWorker.terminate();
    state.analysisWorker = null;
  }

  state.analysisRuntimeReadyPromise = null;
  state.resolveAnalysisRuntimeReady = null;

  if (state.analysisWorkerBootstrapUrl) {
    URL.revokeObjectURL(state.analysisWorkerBootstrapUrl);
    state.analysisWorkerBootstrapUrl = null;
  }
}

function disposeSpectrogramSurface() {
  const replacement = document.createElement('canvas');
  replacement.id = 'spectrogram';
  replacement.className = 'spectrogram-canvas';
  replacement.setAttribute('aria-label', 'Spectrogram');
  elements.spectrogram.replaceWith(replacement);
  elements.spectrogram = replacement;
  resetSpectrogramCanvasTransform();
}

function disposeWaveformRenderer() {
  if (state.waveformWorker) {
    state.waveformWorker.postMessage({ type: 'dispose' });
    state.waveformWorker.terminate();
    state.waveformWorker = null;
  }

  state.waveformRuntimeReadyPromise = null;
  state.resolveWaveformRuntimeReady = null;
  if (state.waveformWorkerBootstrapUrl) {
    URL.revokeObjectURL(state.waveformWorkerBootstrapUrl);
    state.waveformWorkerBootstrapUrl = null;
  }

  state.waveformCanvas = null;
  state.waveformPendingRequest = null;
  state.waveformRenderRange = { start: 0, end: 0 };
  state.waveformRenderWidth = 0;
  state.waveformRenderHeight = 0;
  state.waveformRenderVisibleSpan = 0;
  state.waveformSamplePlotMode = false;
  state.waveformRawSamplePlotMode = false;
  state.waveformAxisRenderRange = { start: 0, end: 0 };
  state.waveformAxisRenderWidth = 0;
  elements.waveformCanvasHost.replaceChildren();
  elements.waveformCanvasHost.style.width = '100%';
  elements.waveformCanvasHost.style.transform = 'translate3d(0px, 0, 0)';
  elements.waveformAxis.replaceChildren();
}

async function togglePlayback() {
  if (!state.audioTransport) {
    return;
  }

  if (!state.audioTransport.isPlaying()) {
    try {
      await state.audioTransport.play();
      syncTransport();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAnalysisStatus(`Playback unavailable: ${message}`, true);
    }

    return;
  }

  state.audioTransport.pause();
  syncTransport();
}

function seekBy(deltaSeconds) {
  if (!state.audioTransport) {
    return;
  }

  setPlaybackPosition(getCurrentPlaybackTime() + deltaSeconds);
}

function syncTransport() {
  const duration = getEffectiveDuration();
  const isPlayable = hasPlaybackTransport() && Number.isFinite(duration) && duration > 0;
  const currentTime = isPlayable ? getCurrentPlaybackTime() : 0;
  const displayRange = isSmoothFollowPlaybackActive()
    ? getWaveformRange(currentTime)
    : getWaveformRange();
  const progress = isPlayable && duration > 0 ? (currentTime / duration) : 0;

  elements.playToggle.disabled = !hasPlaybackTransport();
  elements.playToggle.textContent = isPlaybackActive() ? 'Pause' : 'Play';
  elements.seekBackward.disabled = !isPlayable;
  elements.seekForward.disabled = !isPlayable;
  elements.timeline.disabled = !isPlayable;
  elements.timeline.value = String(progress);
  elements.timeline.style.setProperty('--seek-progress', `${Math.round(progress * 100)}%`);
  elements.timeReadout.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

  applyWaveformPlaybackTime(currentTime, displayRange);
  syncFollowView(currentTime, displayRange);

  if (isPlaybackActive() && !state.playbackFrame) {
    startPlaybackLoop();
  }
}

function startPlaybackLoop() {
  window.cancelAnimationFrame(state.playbackFrame);
  state.playbackFrame = window.requestAnimationFrame(() => {
    state.playbackFrame = 0;
    syncTransport();
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

function downmixToMono(audioBuffer) {
  const mono = new Float32Array(audioBuffer.length);
  const { numberOfChannels } = audioBuffer;

  for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);

    for (let sampleIndex = 0; sampleIndex < channelData.length; sampleIndex += 1) {
      mono[sampleIndex] += channelData[sampleIndex] / numberOfChannels;
    }
  }

  return mono;
}

function createPlaybackSession(audioBuffer) {
  const channelBuffers = [];

  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const sourceChannelData = audioBuffer.getChannelData(channelIndex);
    channelBuffers.push(sourceChannelData.slice().buffer);
  }

  return {
    channelBuffers,
    durationSeconds: audioBuffer.duration,
    numberOfChannels: audioBuffer.numberOfChannels,
    sourceLength: audioBuffer.length,
    sourceSampleRate: audioBuffer.sampleRate,
  };
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

function getWaveformRange(playbackTime = null) {
  const duration = getEffectiveDuration();
  const storedRange = getStoredWaveformRange(duration);

  if (!isSmoothFollowPlaybackActive()) {
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

  state.waveformViewRange = normalizeWaveformRange(range, duration);
}

function centerWaveformRangeOnTime(range, timeSeconds, duration = getEffectiveDuration()) {
  const normalizedRange = normalizeWaveformRange(range, duration);
  const span = Math.max(0, normalizedRange.end - normalizedRange.start);

  if (span <= 0 || duration <= 0) {
    return normalizedRange;
  }

  const nextStart = clamp(timeSeconds - span * 0.5, 0, Math.max(0, duration - span));

  return {
    start: nextStart,
    end: nextStart + span,
  };
}

function expandWaveformRange(range, duration, factor) {
  const normalizedRange = normalizeWaveformRange(range, duration);
  const span = Math.max(0, normalizedRange.end - normalizedRange.start);

  if (span <= 0 || duration <= 0) {
    return normalizedRange;
  }

  const nextSpan = clamp(span * Math.max(1, factor), span, Math.max(span, duration));
  const extraSpan = nextSpan - span;
  const nextStart = clamp(
    normalizedRange.start - extraSpan * 0.5,
    0,
    Math.max(0, duration - nextSpan),
  );

  return {
    start: nextStart,
    end: nextStart + nextSpan,
  };
}

function snapWaveformRenderRange(displayRange, candidateRange, duration, renderWidth) {
  const renderSpan = Math.max(0, candidateRange.end - candidateRange.start);
  const clampedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const maxStart = Math.max(0, clampedDuration - renderSpan);

  if (renderSpan <= 0 || renderWidth <= 0 || clampedDuration <= 0) {
    return candidateRange;
  }

  const columnCount = Math.max(1, Math.round(renderWidth * WAVEFORM_RENDER_SCALE));
  const secondsPerColumn = renderSpan / columnCount;

  if (!Number.isFinite(secondsPerColumn) || secondsPerColumn <= 0) {
    return candidateRange;
  }

  const lowerBound = clamp(displayRange.end - renderSpan, 0, maxStart);
  const upperBound = clamp(displayRange.start, lowerBound, maxStart);
  const snappedStart = Math.round(candidateRange.start / secondsPerColumn) * secondsPerColumn;
  const nextStart = clamp(snappedStart, lowerBound, upperBound);

  return {
    start: nextStart,
    end: nextStart + renderSpan,
  };
}

function quantizeWaveformCssOffset(offsetPx) {
  const deviceScale = Math.max(1, WAVEFORM_RENDER_SCALE);
  return Math.round(offsetPx * deviceScale) / deviceScale;
}

function isFollowPlaybackInteractionActive() {
  return state.waveformSeekPointerId !== null || Boolean(state.selectionDrag) || Boolean(state.loopHandleDrag);
}

function isSmoothFollowPlaybackActive() {
  return Boolean(
    state.followPlayback
      && isPlaybackActive()
      && Number.isFinite(getCurrentPlaybackTime())
      && !isFollowPlaybackInteractionActive()
  );
}

function isRangeBuffered(targetRange, bufferRange, marginRatio = 0) {
  if (
    !targetRange
    || !bufferRange
    || !(targetRange.end > targetRange.start)
    || !(bufferRange.end > bufferRange.start)
  ) {
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

function getWaveformRenderRequestMetrics(displayRange = getWaveformRange()) {
  const duration = getEffectiveDuration();
  const { height, width } = getWaveformViewportSize();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  let renderRange = displayRange;
  let renderWidth = width;

  if (duration > 0 && visibleSpan > 0 && isSmoothFollowPlaybackActive()) {
    const expandedRange = expandWaveformRange(displayRange, duration, WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR);
    renderWidth = Math.max(
      width,
      Math.ceil(width * ((expandedRange.end - expandedRange.start) / visibleSpan)),
    );
    renderRange = snapWaveformRenderRange(displayRange, expandedRange, duration, renderWidth);
  }

  return {
    displayRange,
    height,
    renderRange,
    renderWidth: Math.max(1, renderWidth),
  };
}

function getWaveformAxisRenderMetrics(options = {}) {
  const displayRange = options.displayRange ?? getWaveformRange();
  const explicitRenderRange = options.renderRange;
  const explicitRenderWidth = options.renderWidth;
  const viewportWidth = Math.max(1, elements.waveformAxis.clientWidth || getWaveformViewportWidth());
  const duration = getEffectiveDuration();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  let renderRange = displayRange;
  let renderWidth = viewportWidth;

  const hasExplicitMetrics = Boolean(
    explicitRenderRange
      && Number.isFinite(explicitRenderRange.start)
      && Number.isFinite(explicitRenderRange.end)
      && explicitRenderRange.end > explicitRenderRange.start
      && Number.isFinite(explicitRenderWidth)
      && explicitRenderWidth > 0
  );

  if (hasExplicitMetrics) {
    return {
      displayRange,
      renderRange: explicitRenderRange,
      renderWidth: Math.max(1, Math.round(explicitRenderWidth)),
      viewportWidth,
    };
  }

  if (duration > 0 && visibleSpan > 0 && isSmoothFollowPlaybackActive()) {
    const expandedRange = expandWaveformRange(displayRange, duration, WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR);
    renderWidth = Math.max(
      viewportWidth,
      Math.ceil(viewportWidth * ((expandedRange.end - expandedRange.start) / visibleSpan)),
    );
    renderRange = snapWaveformRenderRange(displayRange, expandedRange, duration, renderWidth);
  }

  return {
    displayRange,
    renderRange,
    renderWidth: Math.max(1, renderWidth),
    viewportWidth,
  };
}

function isWaveformDisplaySpanCompatible(candidateVisibleSpan, displaySpan) {
  if (!Number.isFinite(candidateVisibleSpan) || !Number.isFinite(displaySpan) || displaySpan <= 0) {
    return false;
  }

  const tolerance = Math.max(SPECTROGRAM_RANGE_EPSILON_SECONDS, displaySpan * 0.001);
  return Math.abs(candidateVisibleSpan - displaySpan) <= tolerance;
}

function getCommittedWaveformRenderCandidate() {
  if (!(state.waveformRenderRange.end > state.waveformRenderRange.start) || state.waveformRenderWidth <= 0) {
    return null;
  }

  return {
    end: state.waveformRenderRange.end,
    height: state.waveformRenderHeight,
    start: state.waveformRenderRange.start,
    visibleSpan: state.waveformRenderVisibleSpan,
    width: state.waveformRenderWidth,
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

function doesWaveformRenderCandidateCoverDisplay(candidate, displayRange, metrics) {
  if (!doesWaveformRenderCandidateMatchDisplay(candidate, displayRange, metrics)) {
    return false;
  }

  if (isSmoothFollowPlaybackActive()) {
    return isRangeBuffered(displayRange, candidate, WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO);
  }

  return Math.abs(candidate.start - displayRange.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(candidate.end - displayRange.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
}

function hasWaveformRenderCoverage(displayRange = getWaveformRange()) {
  const { height, renderWidth } = getWaveformRenderRequestMetrics(displayRange);
  const displaySpan = Math.max(0, displayRange.end - displayRange.start);
  const committedCandidate = getCommittedWaveformRenderCandidate();
  const pendingCandidate = getPendingWaveformRenderCandidate();
  const metrics = { height, renderWidth, displaySpan };

  if (doesWaveformRenderCandidateCoverDisplay(committedCandidate, displayRange, metrics)) {
    return true;
  }

  return doesWaveformRenderCandidatePhysicallyCoverDisplay(committedCandidate, displayRange, metrics)
    && doesWaveformRenderCandidateCoverDisplay(pendingCandidate, displayRange, metrics);
}

function hasCommittedWaveformRenderCoverage(displayRange = getWaveformRange()) {
  const committedCandidate = getCommittedWaveformRenderCandidate();

  if (!committedCandidate) {
    return false;
  }

  const { height, renderWidth } = getWaveformRenderRequestMetrics(displayRange);
  const displaySpan = Math.max(0, displayRange.end - displayRange.start);

  return doesWaveformRenderCandidateCoverDisplay(
    committedCandidate,
    displayRange,
    { height, renderWidth, displaySpan },
  );
}

function hasCommittedWaveformDisplayCoverage(displayRange = getWaveformRange()) {
  const committedCandidate = getCommittedWaveformRenderCandidate();

  if (!committedCandidate) {
    return false;
  }

  const { height, renderWidth } = getWaveformRenderRequestMetrics(displayRange);
  const displaySpan = Math.max(0, displayRange.end - displayRange.start);

  return doesWaveformRenderCandidatePhysicallyCoverDisplay(
    committedCandidate,
    displayRange,
    { height, renderWidth, displaySpan },
  );
}

function hasWaveformAxisRenderCoverage(displayRange = getWaveformRange()) {
  if (state.waveformAxisRenderRange.end <= state.waveformAxisRenderRange.start || state.waveformAxisRenderWidth <= 0) {
    return false;
  }

  const { renderWidth } = getWaveformAxisRenderMetrics(displayRange);

  if (state.waveformAxisRenderWidth < (renderWidth - 1)) {
    return false;
  }

  if (isSmoothFollowPlaybackActive()) {
    return isRangeBuffered(displayRange, state.waveformAxisRenderRange, WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO);
  }

  return Math.abs(state.waveformAxisRenderRange.start - displayRange.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(state.waveformAxisRenderRange.end - displayRange.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
}

function applyWaveformCanvasTransform(displayRange = getWaveformRange()) {
  const renderRange = state.waveformRenderRange;
  const viewportWidth = getWaveformViewportWidth();
  const renderWidth = Math.max(0, state.waveformRenderWidth);
  const renderSpan = Math.max(0, renderRange.end - renderRange.start);

  if (!(displayRange.end > displayRange.start) || renderWidth <= 0 || renderSpan <= 0) {
    elements.waveformCanvasHost.style.width = '100%';
    elements.waveformCanvasHost.style.transform = 'translate3d(0px, 0, 0)';
    return;
  }

  const secondsPerPixel = renderSpan / renderWidth;
  const unclampedOffset = -((displayRange.start - renderRange.start) / secondsPerPixel);
  const minOffset = Math.min(0, viewportWidth - renderWidth);
  const translateX = quantizeWaveformCssOffset(clamp(unclampedOffset, minOffset, 0));

  elements.waveformCanvasHost.style.width = `${renderWidth}px`;
  elements.waveformCanvasHost.style.transform = `translate3d(${translateX}px, 0, 0)`;
}

function applyWaveformAxisTransform(displayRange = getWaveformRange()) {
  const axisContent = elements.waveformAxis.firstElementChild;
  const renderRange = state.waveformAxisRenderRange;
  const viewportWidth = Math.max(1, elements.waveformAxis.clientWidth || getWaveformViewportWidth());
  const renderWidth = Math.max(0, state.waveformAxisRenderWidth);
  const renderSpan = Math.max(0, renderRange.end - renderRange.start);

  if (!(axisContent instanceof HTMLElement)) {
    return;
  }

  if (!(displayRange.end > displayRange.start) || renderWidth <= 0 || renderSpan <= 0) {
    axisContent.style.transform = 'translate3d(0px, 0, 0)';
    return;
  }

  const secondsPerPixel = renderSpan / renderWidth;
  const unclampedOffset = -((displayRange.start - renderRange.start) / secondsPerPixel);
  const minOffset = Math.min(0, viewportWidth - renderWidth);
  const translateX = quantizeWaveformCssOffset(clamp(unclampedOffset, minOffset, 0));

  axisContent.style.transform = `translate3d(${translateX}px, 0, 0)`;
}

function resetSpectrogramCanvasTransform() {
  elements.spectrogram.style.width = '100%';
  elements.spectrogram.style.transform = 'translate3d(0px, 0, 0)';
}

function getVisibleSpectrogramRequestMetrics(displayRange = getWaveformRange()) {
  const duration = getEffectiveDuration();
  const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  let requestRange = displayRange;
  let requestPixelWidth = pixelWidth;

  if (duration > 0 && visibleSpan > 0 && isSmoothFollowPlaybackActive()) {
    requestRange = expandWaveformRange(displayRange, duration, SPECTROGRAM_FOLLOW_RENDER_BUFFER_FACTOR);
    requestPixelWidth = Math.max(
      pixelWidth,
      Math.ceil(pixelWidth * ((requestRange.end - requestRange.start) / visibleSpan)),
    );
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

  if (activeRequest.pixelHeight < pixelHeight || activeRequest.pixelWidth < pixelWidth) {
    return false;
  }

  if (isSmoothFollowPlaybackActive()) {
    return isRangeBuffered(displayRange, activeRequest, SPECTROGRAM_FOLLOW_PREFETCH_MARGIN_RATIO);
  }

  return isSameVisibleRequest(activeRequest, displayRange, { pixelHeight, pixelWidth });
}

function normalizeWaveformRange(range, duration) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  if (safeDuration <= 0) {
    return { start: 0, end: 0 };
  }

  const minVisibleDuration = getMinVisibleDuration(safeDuration);
  const safeStart = Number.isFinite(range.start) ? range.start : 0;
  const safeEnd = Number.isFinite(range.end) ? range.end : safeStart + minVisibleDuration;
  const rawSpan = Math.max(minVisibleDuration, safeEnd - safeStart);
  const nextSpan = clamp(
    rawSpan,
    minVisibleDuration,
    Math.max(minVisibleDuration, safeDuration),
  );
  const maxStart = Math.max(0, safeDuration - nextSpan);
  const nextStart = clamp(safeStart, 0, maxStart);

  return {
    start: nextStart,
    end: nextStart + nextSpan,
  };
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

function formatTime(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0:00';
  }

  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getNiceTimeStep(rawStepSec) {
  if (!Number.isFinite(rawStepSec) || rawStepSec <= 0) {
    return 0.25;
  }

  const magnitude = 10 ** Math.floor(Math.log10(rawStepSec));
  const normalized = rawStepSec / magnitude;
  const candidates = [1, 2, 2.5, 5, 10];
  const chosen = candidates.find((candidate) => normalized <= candidate) ?? 10;

  return chosen * magnitude;
}

function formatAxisLabel(seconds) {
  const totalTenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(totalTenths / 600);
  const secondsPart = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;

  return `${minutes}:${String(secondsPart).padStart(2, '0')}:${tenths}`;
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
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const roughStep = Math.max(1, (safeMax - safeMin) / Math.max(1, SPECTROGRAM_LINEAR_TICK_COUNT - 1));
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  let multiplier = 1;

  if (normalized > 5) {
    multiplier = 10;
  } else if (normalized > 2) {
    multiplier = 5;
  } else if (normalized > 1) {
    multiplier = 2;
  }

  const step = multiplier * magnitude;
  const ticks = [safeMax, safeMin];
  let value = Math.ceil(safeMin / step) * step;

  while (value < safeMax) {
    if (value > safeMin && value < safeMax) {
      ticks.push(value);
    }
    value += step;
  }

  return [...new Set(ticks.map((tick) => Math.round(tick)))]
    .filter((tick) => tick >= safeMin && tick <= safeMax)
    .sort((left, right) => right - left);
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

function getLinearFrequencyPosition(frequency, minFrequency, maxFrequency) {
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const current = clamp(frequency, safeMin, safeMax);

  return 1 - ((current - safeMin) / (safeMax - safeMin));
}

function getFrequencyAtLinearPosition(position, minFrequency, maxFrequency) {
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const ratio = 1 - clamp(position, 0, 1);

  return safeMin + ratio * (safeMax - safeMin);
}

function getLogFrequencyPosition(frequency, minFrequency, maxFrequency) {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const start = Math.log(safeMin);
  const end = Math.log(safeMax);
  const current = Math.log(clamp(frequency, safeMin, safeMax));

  return 1 - ((current - start) / (end - start));
}

function getFrequencyAtLogPosition(position, minFrequency, maxFrequency) {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const start = Math.log(safeMin);
  const end = Math.log(safeMax);
  const ratio = 1 - clamp(position, 0, 1);

  return Math.exp(start + ratio * (end - start));
}

function getMelFrequencyPosition(frequency, minFrequency, maxFrequency) {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const start = frequencyToMel(safeMin);
  const end = frequencyToMel(safeMax);
  const current = frequencyToMel(clamp(frequency, safeMin, safeMax));

  return 1 - ((current - start) / (end - start));
}

function getFrequencyAtMelPosition(position, minFrequency, maxFrequency) {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const start = frequencyToMel(safeMin);
  const end = frequencyToMel(safeMax);
  const ratio = 1 - clamp(position, 0, 1);

  return melToFrequency(start + ratio * (end - start));
}

function frequencyToMel(frequency) {
  return 1127 * Math.log(1 + (frequency / 700));
}

function melToFrequency(melValue) {
  return 700 * (Math.exp(melValue / 1127) - 1);
}

function formatFrequencyLabel(frequency) {
  if (frequency >= 1000) {
    const kiloHertz = frequency / 1000;
    const rounded = Number.isInteger(kiloHertz) ? String(kiloHertz) : kiloHertz.toFixed(1);
    return `${rounded} kHz`;
  }

  return `${Math.round(frequency)} Hz`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
