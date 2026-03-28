import {
  DISPLAY_MIN_DPR,
  TILE_COLUMN_COUNT,
} from '../src-webview/sharedBuffers.js';

const vscode = acquireVsCodeApi();
const analysisWorkerScriptUri = document.body.dataset.workerSrc;
const waveformWorkerScriptUri = document.body.dataset.waveformWorkerSrc;
const DISPLAY_PIXEL_RATIO = Math.max(window.devicePixelRatio || 1, DISPLAY_MIN_DPR);
const HAS_SHARED_RUNTIME_SUPPORT =
  typeof SharedArrayBuffer === 'function'
  && window.crossOriginIsolated
  && typeof Worker !== 'undefined';
const TRANSPORT_MODE_OVERRIDE_KEY = 'wavePreview.transportModeOverride';
const RUNTIME_TRANSPORT_MODE = getRuntimeTransportMode();

const SPECTROGRAM_MIN_FREQUENCY = 20;
const SPECTROGRAM_MAX_FREQUENCY = 20000;
const SPECTROGRAM_TICKS = [20000, 16000, 12000, 8000, 4000, 2000, 1000, 400, 100, 40, 20];
const SPECTROGRAM_OVERVIEW_WIDTH_SCALE = 0.45;
const SPECTROGRAM_OVERVIEW_HEIGHT_SCALE = 0.7;
const SPECTROGRAM_RANGE_EPSILON_SECONDS = 1 / 2000;
const SPECTROGRAM_ROW_BUCKET_SIZE = 32;

const WAVEFORM_COLOR = '#7dd3fc';
const WAVEFORM_RENDER_SCALE = DISPLAY_PIXEL_RATIO;
const WAVEFORM_MAX_ZOOM_FACTOR = 1000;
const WAVEFORM_ZOOM_STEP_FACTOR = 1.75;
const WAVEFORM_WHEEL_ZOOM_TARGET_RATIO = 0.5;
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
const SEEK_END_EPSILON_SECONDS = 1 / 120;
const ANALYSIS_IDLE_TIMEOUT_MS = 1500;
const ANALYSIS_FALLBACK_DELAY_MS = 240;
const SEEK_COMMIT_TOLERANCE_SECONDS = 0.02;
const SEEK_COMMIT_TIMEOUT_MS = 250;

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
const SPECTROGRAM_OVERLAP_OPTIONS = [0.5, 0.75, 0.875];

const elements = {
  waveformViewport: document.getElementById('waveform-viewport'),
  waveformCanvasHost: document.getElementById('waveform-canvas-host'),
  waveformHitTarget: document.getElementById('waveform-hit-target'),
  waveformHoverTooltip: document.getElementById('waveform-hover-tooltip'),
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
  waveClearLoop: document.getElementById('wave-clear-loop'),
  waveZoomOut: document.getElementById('wave-zoom-out'),
  waveZoomReset: document.getElementById('wave-zoom-reset'),
  waveZoomIn: document.getElementById('wave-zoom-in'),
  waveFollow: document.getElementById('wave-follow'),
  spectrogram: document.getElementById('spectrogram'),
  spectrogramSelection: document.getElementById('spectrogram-selection'),
  spectrogramProgress: document.getElementById('spectrogram-progress'),
  spectrogramCursor: document.getElementById('spectrogram-cursor'),
  spectrogramLoopStart: document.getElementById('spectrogram-loop-start'),
  spectrogramLoopEnd: document.getElementById('spectrogram-loop-end'),
  spectrogramMeta: document.getElementById('spectrogram-meta'),
  spectrogramFftSelect: document.getElementById('spectrogram-fft-select'),
  spectrogramOverlapSelect: document.getElementById('spectrogram-overlap-select'),
  spectrogramHoverTooltip: document.getElementById('spectrogram-hover-tooltip'),
  spectrogramAxis: document.getElementById('spectrogram-axis'),
  spectrogramGuides: document.getElementById('spectrogram-guides'),
  spectrogramHitTarget: document.getElementById('spectrogram-hit-target'),
  jumpStart: document.getElementById('jump-start'),
  seekBackward: document.getElementById('seek-backward'),
  playToggle: document.getElementById('play-toggle'),
  seekForward: document.getElementById('seek-forward'),
  jumpEnd: document.getElementById('jump-end'),
  timeline: document.getElementById('timeline'),
  timelineHoverTooltip: document.getElementById('timeline-hover-tooltip'),
  timeReadout: document.getElementById('time-readout'),
  analysisStatus: document.getElementById('analysis-status'),
  status: document.getElementById('status'),
};

const state = {
  activeFile: null,
  loadToken: 0,
  audio: null,
  audioBlobUrl: null,
  sourceArrayBuffer: null,
  sourceFetchController: null,
  fetchController: null,
  analysisWorker: null,
  analysisWorkerBootstrapUrl: null,
  analysisRuntimeReadyPromise: null,
  resolveAnalysisRuntimeReady: null,
  analysisIdleCallbackId: null,
  analysisTimeoutId: null,
  analysisStartedForLoadToken: 0,
  waveformWorker: null,
  waveformWorkerBootstrapUrl: null,
  waveformRuntimeReadyPromise: null,
  resolveWaveformRuntimeReady: null,
  waveformSurfaceReadyPromise: null,
  spectrogramSurfaceReadyPromise: null,
  waveformCanvas: null,
  waveformViewRange: { start: 0, end: 0 },
  waveformSeekPointerId: null,
  selectionDrag: null,
  selectionDraft: null,
  loopHandleDrag: null,
  loopRange: null,
  pendingSeekTime: 0,
  followPlayback: true,
  transportMode: RUNTIME_TRANSPORT_MODE,
  spectrogramRenderConfig: {
    fftSize: 8192,
    overlapRatio: 0.75,
  },
  analysis: null,
  sessionVersion: 0,
  pcmSab: null,
  waveformRequestGeneration: 0,
  waveformPendingRequest: null,
  waveformRenderRange: { start: 0, end: 0 },
  waveformRenderWidth: 0,
  waveformRenderHeight: 0,
  waveformRenderVisibleSpan: 0,
  waveformAxisRenderRange: { start: 0, end: 0 },
  waveformAxisRenderWidth: 0,
  playbackFrame: 0,
  spectrogramFrame: 0,
  spectrogramRequestFrame: 0,
};

if (
  typeof elements.spectrogram?.transferControlToOffscreen !== 'function'
  || typeof OffscreenCanvas !== 'function'
) {
  setFatalStatus('OffscreenCanvas is required for this preview.');
} else {
  initializeKeyboardFocus();
  state.followPlayback = elements.waveFollow.checked;
  attachUiEvents();
  attachResizeObservers();
  renderWaveformUi();
  renderSpectrogramScale();
  renderSpectrogramMeta();
  vscode.postMessage({ type: 'ready' });
}

window.addEventListener('message', (event) => {
  const message = event.data;

  if (message?.type === 'loadAudio') {
    state.activeFile = message.body;
    void loadAudioFile(message.body);
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

function getRuntimeTransportMode() {
  let override = null;

  try {
    override = window.localStorage?.getItem(TRANSPORT_MODE_OVERRIDE_KEY) ?? null;
  } catch {
    override = null;
  }

  if (override === 'shared' && HAS_SHARED_RUNTIME_SUPPORT) {
    return 'shared';
  }

  if (override === 'transfer') {
    return 'transfer';
  }

  return HAS_SHARED_RUNTIME_SUPPORT ? 'shared' : 'transfer';
}

function normalizeSpectrogramFftSize(value) {
  const numericValue = Number(value);
  return SPECTROGRAM_FFT_OPTIONS.includes(numericValue) ? numericValue : 8192;
}

function normalizeSpectrogramOverlapRatio(value) {
  const numericValue = Number(value);
  return SPECTROGRAM_OVERLAP_OPTIONS.includes(numericValue) ? numericValue : 0.75;
}

window.addEventListener('keydown', (event) => {
  if (!state.audio || event.defaultPrevented) {
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
  clearFatalStatus();
  setAnalysisStatus('Preparing playback…');

  const audio = new Audio();
  audio.preload = 'auto';
  state.audio = audio;
  state.pendingSeekTime = 0;
  state.waveformViewRange = { start: 0, end: 0 };

  bindAudioEvents(audio, loadToken, payload);
  state.waveformSurfaceReadyPromise = initializeWaveformSurface(loadToken);
  state.spectrogramSurfaceReadyPromise = initializeSpectrogramSurface(loadToken);
  syncTransport();
  renderWaveformUi();
  renderSpectrogramScale();
  void loadPlaybackSource(loadToken, payload, audio);
}

function bindAudioEvents(audio, loadToken, payload) {
  const syncPlaybackTime = () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    if (audio.paused === false && Number.isFinite(audio.currentTime)) {
      state.pendingSeekTime = audio.currentTime;
    }

    syncTransport();
  };

  const syncPausedTime = () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    if (Number.isFinite(audio.currentTime)) {
      state.pendingSeekTime = audio.currentTime;
    }

    syncTransport();
  };

  const syncWithoutCommit = () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    syncTransport();
  };

  const syncMetadata = () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    ensureWaveformViewRange();
    renderWaveformUi();
    void syncWaveformView();
    syncTransport();
  };

  audio.addEventListener('canplay', syncWithoutCommit);
  audio.addEventListener('canplay', () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    scheduleDeferredAnalysis(loadToken, payload);
  }, { once: true });
  audio.addEventListener('durationchange', syncMetadata);
  audio.addEventListener('loadedmetadata', syncMetadata);
  audio.addEventListener('play', () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    startPlaybackLoop();
    if (Number.isFinite(audio.currentTime)) {
      state.pendingSeekTime = audio.currentTime;
    }
    syncTransport();
  });
  audio.addEventListener('pause', syncPausedTime);
  audio.addEventListener('ended', () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    if (state.loopRange && state.loopRange.end > state.loopRange.start) {
      void restartLoopPlayback(audio, state.loopRange.start);
      return;
    }

    syncTransport();
  });
  audio.addEventListener('timeupdate', syncPlaybackTime);
  audio.addEventListener('seeking', syncWithoutCommit);
  audio.addEventListener('seeked', syncWithoutCommit);
  audio.addEventListener('error', () => {
    if (loadToken !== state.loadToken) {
      return;
    }

    cancelDeferredAnalysis();
    setFatalStatus('Unable to play this audio file.');
  });
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

async function loadPlaybackSource(loadToken, payload, audio) {
  const controller = new AbortController();
  state.sourceFetchController = controller;

  try {
    setAnalysisStatus('Loading audio…');

    const response = await fetch(payload.sourceUri, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const audioData = await response.arrayBuffer();

    if (loadToken !== state.loadToken) {
      return;
    }

    state.sourceArrayBuffer = audioData;

    const mimeType = response.headers.get('content-type') || guessAudioMimeType(payload.sourceUri);
    const audioBlob = new Blob([audioData], { type: mimeType });
    const audioBlobUrl = URL.createObjectURL(audioBlob);

    if (state.audioBlobUrl) {
      URL.revokeObjectURL(state.audioBlobUrl);
    }

    state.audioBlobUrl = audioBlobUrl;
    audio.src = audioBlobUrl;
    audio.load();
    setAnalysisStatus('Buffering playback…');
  } catch (error) {
    if (loadToken !== state.loadToken || controller.signal.aborted) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
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
}

function scheduleDeferredAnalysis(loadToken, payload) {
  if (loadToken !== state.loadToken || state.analysisStartedForLoadToken === loadToken) {
    return;
  }

  cancelDeferredAnalysis();
  setAnalysisStatus('Queued');

  const startDeferredAnalysis = () => {
    if (loadToken !== state.loadToken || state.analysisStartedForLoadToken === loadToken) {
      return;
    }

    state.analysisIdleCallbackId = null;
    state.analysisTimeoutId = null;
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
    setAnalysisStatus('Analysis worker is unavailable.', true);
    return;
  }

  const controller = new AbortController();
  state.fetchController = controller;

  try {
    let audioData = state.sourceArrayBuffer;

    if (!audioData) {
      setAnalysisStatus('Loading audio for analysis…');

      const response = await fetch(payload.sourceUri, { signal: controller.signal });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      audioData = await response.arrayBuffer();
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

    setAnalysisStatus('Initializing wasm pipelines…');
    await Promise.all([
      state.analysisRuntimeReadyPromise,
      state.waveformRuntimeReadyPromise,
    ]);

    if (loadToken !== state.loadToken) {
      return;
    }

    setAnalysisStatus('Decoding audio…');

    const decodedAudio = await decodeAudioData(audioData);
    const monoSamples = downmixToMono(decodedAudio);

    if (loadToken !== state.loadToken) {
      return;
    }

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
    setAnalysisStatus('Queued');

    if (state.transportMode === 'shared') {
      ensureSharedAudioBuffer(monoSamples, decodedAudio.sampleRate);

      const sharedBody = {
        duration: decodedAudio.duration,
        pcmSab: state.pcmSab,
        quality: state.analysis.quality,
        sampleCount: monoSamples.length,
        sampleRate: decodedAudio.sampleRate,
        sessionVersion: state.sessionVersion,
        transportMode: state.transportMode,
      };

      waveformWorker.postMessage({
        type: 'attachAudioSession',
        body: sharedBody,
      });
      analysisWorker.postMessage({
        type: 'attachAudioSession',
        body: sharedBody,
      });
    } else {
      const waveformSamples = monoSamples.slice();

      waveformWorker.postMessage({
        type: 'attachAudioSession',
        body: {
          duration: decodedAudio.duration,
          quality: state.analysis.quality,
          sampleCount: waveformSamples.length,
          sampleRate: decodedAudio.sampleRate,
          samplesBuffer: waveformSamples.buffer,
          sessionVersion: state.sessionVersion,
          transportMode: state.transportMode,
        },
      }, [waveformSamples.buffer]);

      analysisWorker.postMessage({
        type: 'attachAudioSession',
        body: {
          duration: decodedAudio.duration,
          quality: state.analysis.quality,
          sampleCount: monoSamples.length,
          sampleRate: decodedAudio.sampleRate,
          samplesBuffer: monoSamples.buffer,
          sessionVersion: state.sessionVersion,
          transportMode: state.transportMode,
        },
      }, [monoSamples.buffer]);
    }

    waveformWorker.postMessage({ type: 'buildWaveformPyramid' });
    requestOverviewSpectrogram({ force: true });
    scheduleSpectrogramRender({ force: true });
    void syncWaveformView();
  } catch (error) {
    if (loadToken !== state.loadToken || controller.signal.aborted) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    setAnalysisStatus(`Analysis unavailable: ${message}`, true);
  } finally {
    if (state.fetchController === controller) {
      state.fetchController = null;
    }
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

  if (message?.type === 'overviewReady') {
    const { body } = message;

    state.analysis.overview = {
      ...state.analysis.overview,
      complete: true,
      decimationFactor: body.decimationFactor,
      fftSize: body.fftSize,
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
      generation: body.generation,
      pixelHeight: body.pixelHeight,
      pixelWidth: body.pixelWidth,
      viewEnd: body.viewEnd,
      viewStart: body.viewStart,
    };
    state.analysis.visible = {
      ...state.analysis.visible,
      complete: true,
      decimationFactor: body.decimationFactor,
      fftSize: body.fftSize,
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
    setAnalysisStatus('Ready');
    renderSpectrogramMeta();
    return;
  }

  if (message?.type === 'error') {
    disposeAnalysisWorker();
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

  if (!state.analysis) {
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

    if (displayRange.end <= displayRange.start) {
      return;
    }

    const previousGeneration = state.analysis.generation;
    const needsNewGeneration = force || !isSameVisibleRequest(
      state.analysis.activeVisibleRequest,
      requestRange,
      { pixelHeight, pixelWidth },
    );
    const generation = needsNewGeneration ? previousGeneration + 1 : previousGeneration;

    if (needsNewGeneration) {
      state.analysis.generation = generation;
      state.analysis.activeVisibleRequest = {
        generation,
        pixelHeight,
        pixelWidth,
        viewEnd: requestRange.end,
        viewStart: requestRange.start,
      };
      state.analysis.visible = {
        ...createSpectrogramLayerState('visible'),
        dpr: DISPLAY_PIXEL_RATIO,
        generation,
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
        displayEnd: displayRange.end,
        displayStart: displayRange.start,
        dpr: DISPLAY_PIXEL_RATIO,
        fftSize: state.spectrogramRenderConfig.fftSize,
        generation,
        overlapRatio: state.spectrogramRenderConfig.overlapRatio,
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

function ensureSharedAudioBuffer(samples, sampleRate) {
  if (!state.pcmSab || new Float32Array(state.pcmSab).length !== samples.length) {
    state.pcmSab = new SharedArrayBuffer(samples.length * Float32Array.BYTES_PER_ELEMENT);
  }

  new Float32Array(state.pcmSab).set(samples);

  if (state.analysis) {
    state.analysis.sampleRate = sampleRate;
    state.analysis.sampleCount = samples.length;
  }
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

  if (
    !force
    && (state.analysis.overview.requestPending || state.analysis.overview.ready)
    && Math.abs((state.analysis.overview.pixelWidth ?? 0) - pixelWidth) <= 1
    && Math.abs((state.analysis.overview.pixelHeight ?? 0) - pixelHeight) <= 1
  ) {
    return;
  }

  state.analysis.overview = {
    ...createSpectrogramLayerState('overview'),
    dpr: DISPLAY_PIXEL_RATIO,
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
      dpr: DISPLAY_PIXEL_RATIO,
      fftSize: state.spectrogramRenderConfig.fftSize,
      overlapRatio: state.spectrogramRenderConfig.overlapRatio,
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

  return Math.abs(activeRequest.viewStart - range.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(activeRequest.viewEnd - range.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
    && Math.abs(activeRequest.pixelWidth - size.pixelWidth) <= 1
    && Math.abs(activeRequest.pixelHeight - size.pixelHeight) <= 1;
}

function handleWaveformReady(body) {
  if (!state.waveformWorker || body.generation !== state.waveformRequestGeneration) {
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
  state.waveformPendingRequest = null;
  applyWaveformCanvasTransform();
}

function renderSpectrogramScale() {
  const minFrequency = state.analysis?.minFrequency ?? SPECTROGRAM_MIN_FREQUENCY;
  const maxFrequency = state.analysis?.maxFrequency ?? SPECTROGRAM_MAX_FREQUENCY;
  const visibleTicks = SPECTROGRAM_TICKS.filter((tick) => tick >= minFrequency && tick <= maxFrequency);

  elements.spectrogramAxis.replaceChildren();
  elements.spectrogramGuides.replaceChildren();

  visibleTicks.forEach((tick, index) => {
    const position = getLogFrequencyPosition(tick, minFrequency, maxFrequency);
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
  if (!elements.spectrogramMeta || !elements.spectrogramFftSelect || !elements.spectrogramOverlapSelect) {
    return;
  }

  const layer = getActiveSpectrogramMetaLayer();

  elements.spectrogramFftSelect.value = String(normalizeSpectrogramFftSize(layer?.fftSize));
  elements.spectrogramOverlapSelect.value = String(normalizeSpectrogramOverlapRatio(layer?.overlapRatio));
}

function refreshSpectrogramAnalysisConfig() {
  if (!state.analysis) {
    return;
  }

  state.analysis.activeVisibleRequest = null;
  state.analysis.overview = createSpectrogramLayerState('overview');
  state.analysis.visible = createSpectrogramLayerState('visible');

  if (state.analysisWorker && state.analysis.generation > 0) {
    state.analysisWorker.postMessage({
      type: 'cancelGeneration',
      body: { generation: state.analysis.generation },
    });
  }

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

function getSeekableEndTime(duration = getEffectiveDuration()) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.max(0, duration - Math.min(SEEK_END_EPSILON_SECONDS, duration / 2));
}

function getPreferredPlaybackTime() {
  const duration = getEffectiveDuration();
  const seekableEndTime = getSeekableEndTime(duration);
  const audioTime = state.audio?.currentTime;
  const isPlaying = state.audio?.paused === false;
  const baseTime = isPlaying && Number.isFinite(audioTime)
    ? audioTime
    : Number.isFinite(state.pendingSeekTime)
      ? state.pendingSeekTime
      : Number.isFinite(audioTime)
        ? audioTime
        : 0;
  const shouldRestartFromStart = !isPlaying && (
    state.audio?.ended === true
    || baseTime >= (seekableEndTime - SEEK_COMMIT_TOLERANCE_SECONDS)
  );

  if (state.loopRange && state.loopRange.end > state.loopRange.start) {
    if (baseTime < state.loopRange.start || shouldWrapLoop(state.loopRange, baseTime)) {
      return state.loopRange.start;
    }

    return clamp(baseTime, state.loopRange.start, getSeekableEndTime(state.loopRange.end));
  }

  if (shouldRestartFromStart) {
    return 0;
  }

  return clamp(baseTime, 0, getSeekableEndTime(duration));
}

function setPlaybackPosition(timeSeconds, { sync = true } = {}) {
  if (!state.audio) {
    return;
  }

  const duration = getEffectiveDuration();

  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(timeSeconds)) {
    return;
  }

  const nextTime = clamp(timeSeconds, 0, getSeekableEndTime(duration));
  state.pendingSeekTime = nextTime;

  if (Number.isFinite(state.audio.currentTime) && Math.abs(state.audio.currentTime - nextTime) <= 1e-4) {
    if (sync) {
      syncTransport();
    }
    return;
  }

  try {
    state.audio.currentTime = nextTime;
  } catch {
    // Keep pendingSeekTime so the next playback start still honors the user's seek.
  }

  if (sync) {
    syncTransport();
  }
}

function isPlaybackTimeCommitted(targetTime) {
  if (!state.audio || !Number.isFinite(targetTime)) {
    return true;
  }

  return Math.abs((state.audio.currentTime ?? 0) - targetTime) <= SEEK_COMMIT_TOLERANCE_SECONDS;
}

async function ensurePlaybackPositionCommitted(targetTime) {
  if (!state.audio || isPlaybackTimeCommitted(targetTime)) {
    return;
  }

  await new Promise((resolve) => {
    if (!state.audio) {
      resolve();
      return;
    }

    const audio = state.audio;
    let timeoutId = 0;

    const finalize = () => {
      audio.removeEventListener('seeked', handleCommitCheck);
      audio.removeEventListener('timeupdate', handleCommitCheck);
      audio.removeEventListener('canplay', handleCommitCheck);

      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }

      resolve();
    };

    const handleCommitCheck = () => {
      if (isPlaybackTimeCommitted(targetTime)) {
        finalize();
      }
    };

    audio.addEventListener('seeked', handleCommitCheck);
    audio.addEventListener('timeupdate', handleCommitCheck);
    audio.addEventListener('canplay', handleCommitCheck);
    timeoutId = window.setTimeout(finalize, SEEK_COMMIT_TIMEOUT_MS);
    handleCommitCheck();
  });
}

async function restartLoopPlayback(audio, loopStartTime) {
  state.pendingSeekTime = loopStartTime;

  try {
    audio.currentTime = loopStartTime;
  } catch {
    // Keep pending seek time so a later playback retry still restarts at the loop start.
  }

  await ensurePlaybackPositionCommitted(loopStartTime);
  await audio.play().catch(() => {});
  syncTransport();
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

  elements.waveZoomReset.textContent = `${zoomFactor.toFixed(1)}x`;
  elements.waveFollow.checked = state.followPlayback;
  elements.waveHint.textContent =
    duration > 0
      ? 'Click to seek. Drag to set a loop. Wheel to zoom or pan.'
      : 'Playback starts immediately. Waveform fills in after decode.';
  elements.waveLoopLabel.textContent = loopLabelRange
    ? `Loop ${formatAxisLabel(loopLabelRange.start)} - ${formatAxisLabel(loopLabelRange.end)}`
    : 'No loop selection';
  elements.waveClearLoop.hidden = !state.loopRange;

  renderWaveformAxis();
  applyWaveformOverviewThumb();
  syncWaveformSelection();
  applyWaveformPlaybackTime(state.audio?.currentTime ?? 0);
  applyWaveformCanvasTransform(range);
  scheduleSpectrogramRender();
}

function renderWaveformAxis() {
  const { displayRange, renderRange, renderWidth, viewportWidth } = getWaveformAxisRenderMetrics();
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

function applyWaveformOverviewThumb() {
  const duration = getEffectiveDuration();
  const range = getWaveformRange();
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

function applyWaveformPlaybackTime(timeSeconds) {
  const range = getWaveformRange();
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

function syncFollowView(timeSeconds) {
  if (
    !state.followPlayback ||
    !Number.isFinite(timeSeconds) ||
    timeSeconds < 0 ||
    isFollowPlaybackInteractionActive()
  ) {
    return;
  }

  if (isSmoothFollowPlaybackActive()) {
    const range = getWaveformRange();
    applyWaveformOverviewThumb();
    syncWaveformSelection();
    applyWaveformCanvasTransform(range);
    applyWaveformAxisTransform(range);

    if (!hasWaveformAxisRenderCoverage(range)) {
      renderWaveformAxis();
    }

    if (!hasWaveformRenderCoverage(range)) {
      void syncWaveformView();
    }

    scheduleSpectrogramRender();
    return;
  }

  const duration = getEffectiveDuration();
  const range = getWaveformRange();
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

  if (state.transportMode === 'shared' && state.analysis && !state.pcmSab) {
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

function updateWaveformHoverTooltip(event) {
  const duration = getEffectiveDuration();

  if (!state.audio || duration <= 0) {
    hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
    return;
  }

  updateSurfaceHoverTooltip(
    elements.waveformHoverTooltip,
    elements.waveformViewport ?? elements.waveformHitTarget,
    event,
    formatAxisLabel(getTimeAtWaveformPointerEvent(event)),
  );
}

function hideWaveformHoverTooltip() {
  hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
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

  return getFrequencyAtLogPosition(position, minFrequency, maxFrequency);
}

function updateSpectrogramHoverTooltip(event) {
  const duration = getEffectiveDuration();

  if (!state.audio || duration <= 0) {
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
    if (
      state.audio &&
      state.audio.paused === false &&
      (state.audio.currentTime < nextSelection.start || state.audio.currentTime >= nextSelection.end)
    ) {
      state.audio.currentTime = nextSelection.start;
      state.pendingSeekTime = nextSelection.start;
      syncTransport();
    }
    renderWaveformUi();
    return;
  }

  if (!isTimeWithinLoopRange(state.loopRange, selectionDrag.anchorTime)) {
    state.loopRange = null;
  }

  seekWaveformTo(selectionDrag.anchorTime);
  renderWaveformUi();
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
  }

  renderWaveformUi();
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
  const anchorTime = shouldPreserveFollowZoom && Number.isFinite(state.audio?.currentTime)
    ? clamp(state.audio.currentTime, 0, duration)
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

      nextStart = anchorTime - nextSpan * (
        shouldPreserveFollowZoom
          ? WAVEFORM_FOLLOW_TARGET_RATIO
          : WAVEFORM_WHEEL_ZOOM_TARGET_RATIO
      );
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

  elements.jumpStart.addEventListener('click', () => {
    seekWaveformTo(state.loopRange?.start ?? 0);
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
  elements.jumpEnd.addEventListener('click', () => {
    const loopEnd = state.loopRange?.end;
    seekWaveformTo(Number.isFinite(loopEnd) ? getSeekableEndTime(loopEnd) : getSeekableEndTime());
  });

  elements.timeline.addEventListener('input', (event) => {
    if (!state.audio) {
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
    renderWaveformUi();
  });

  elements.waveformViewport.addEventListener('wheel', (event) => {
    handleSharedViewportWheel(event, elements.waveformViewport);
  }, { passive: false });

  elements.waveformHitTarget.addEventListener('pointerdown', (event) => {
    const duration = getEffectiveDuration();
    const range = getWaveformRange();

    if (!state.audio || duration <= 0 || range.end <= range.start) {
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

    if (!state.audio || duration <= 0 || range.end <= range.start) {
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
    const { height, width } = getWaveformViewportSize();
    const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();

    if (state.waveformWorker) {
      state.waveformWorker.postMessage({
        type: 'resizeCanvas',
        body: {
          color: WAVEFORM_COLOR,
          height,
          renderScale: WAVEFORM_RENDER_SCALE,
          width,
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
    void syncWaveformView();
    renderSpectrogramScale();
    requestOverviewSpectrogram({ force: true });
    queueVisibleSpectrogramRequest({ force: true });
    scheduleSpectrogramRender({ force: true });
  });

  resizeObserver.observe(document.body);
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

  if (state.sourceFetchController) {
    state.sourceFetchController.abort();
    state.sourceFetchController = null;
  }

  if (state.fetchController) {
    state.fetchController.abort();
    state.fetchController = null;
  }

  disposeAnalysisWorker();
  disposeWaveformRenderer();
  disposeSpectrogramSurface();

  if (state.audio) {
    state.audio.pause();
    state.audio.removeAttribute('src');
    state.audio.load();
    state.audio = null;
  }

  if (state.audioBlobUrl) {
    URL.revokeObjectURL(state.audioBlobUrl);
    state.audioBlobUrl = null;
  }

  state.pcmSab = null;
  state.waveformRequestGeneration = 0;
  state.waveformPendingRequest = null;
  state.waveformRenderRange = { start: 0, end: 0 };
  state.waveformRenderWidth = 0;
  state.waveformRenderHeight = 0;
  state.waveformRenderVisibleSpan = 0;
  state.waveformAxisRenderRange = { start: 0, end: 0 };
  state.waveformAxisRenderWidth = 0;
  state.sourceArrayBuffer = null;
  state.waveformViewRange = { start: 0, end: 0 };
  state.waveformSeekPointerId = null;
  state.selectionDrag = null;
  state.selectionDraft = null;
  state.loopHandleDrag = null;
  state.loopRange = null;
  state.pendingSeekTime = 0;
  state.analysisStartedForLoadToken = 0;
  state.sessionVersion = 0;
  state.analysis = null;
  state.waveformSurfaceReadyPromise = null;
  state.spectrogramSurfaceReadyPromise = null;
  hideWaveformHoverTooltip();
  hideSpectrogramHoverTooltip();
  renderWaveformUi();
  renderSpectrogramMeta();
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
  state.waveformAxisRenderRange = { start: 0, end: 0 };
  state.waveformAxisRenderWidth = 0;
  elements.waveformCanvasHost.replaceChildren();
  elements.waveformCanvasHost.style.width = '100%';
  elements.waveformCanvasHost.style.transform = 'translate3d(0px, 0, 0)';
  elements.waveformAxis.replaceChildren();
}

async function togglePlayback() {
  if (!state.audio) {
    return;
  }

  if (state.audio.paused) {
    try {
      const targetTime = getPreferredPlaybackTime();
      setPlaybackPosition(targetTime, { sync: false });
      await ensurePlaybackPositionCommitted(targetTime);

      await state.audio.play();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAnalysisStatus(`Playback unavailable: ${message}`, true);
    }

    return;
  }

  state.audio.pause();
}

function seekBy(deltaSeconds) {
  if (!state.audio) {
    return;
  }

  setPlaybackPosition(getPreferredPlaybackTime() + deltaSeconds);
}

function syncTransport() {
  const duration = getEffectiveDuration();
  const isPlayable = Boolean(state.audio) && Number.isFinite(duration) && duration > 0;

  if (
    state.audio &&
    state.audio.paused === false &&
    state.loopRange &&
    state.loopRange.end > state.loopRange.start &&
    shouldWrapLoop(state.loopRange, state.audio.currentTime)
  ) {
    state.pendingSeekTime = state.loopRange.start;
    state.audio.currentTime = state.loopRange.start;
  }

  const liveCurrentTime = Number.isFinite(state.audio?.currentTime) ? state.audio.currentTime : 0;
  const preferredCurrentTime = state.audio?.paused === false ? liveCurrentTime : getPreferredPlaybackTime();
  const currentTime = clamp(preferredCurrentTime, 0, duration || 0);
  const progress = isPlayable && duration > 0 ? (currentTime / duration) : 0;

  elements.playToggle.disabled = !state.audio;
  elements.playToggle.textContent = state.audio?.paused === false ? 'Pause' : 'Play';
  elements.jumpStart.disabled = !isPlayable;
  elements.seekBackward.disabled = !isPlayable;
  elements.seekForward.disabled = !isPlayable;
  elements.jumpEnd.disabled = !isPlayable;
  elements.timeline.disabled = !isPlayable;
  elements.timeline.value = String(progress);
  elements.timeline.style.setProperty('--seek-progress', `${Math.round(progress * 100)}%`);
  elements.timeReadout.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

  applyWaveformPlaybackTime(currentTime);
  syncFollowView(currentTime);

  if (state.audio?.paused === false && !state.playbackFrame) {
    startPlaybackLoop();
  }
}

function startPlaybackLoop() {
  window.cancelAnimationFrame(state.playbackFrame);
  state.playbackFrame = window.requestAnimationFrame(() => {
    state.playbackFrame = 0;

    if (state.audio?.paused === false) {
      syncTransport();
    }
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

function getWaveformViewportSize() {
  return {
    width: Math.max(1, elements.waveformViewport.clientWidth),
    height: Math.max(1, elements.waveformViewport.clientHeight),
  };
}

function getWaveformViewportWidth() {
  return Math.max(1, elements.waveformViewport.clientWidth);
}

function getWaveformRange() {
  const duration = getEffectiveDuration();
  const storedRange = getStoredWaveformRange(duration);

  if (!isSmoothFollowPlaybackActive()) {
    return storedRange;
  }

  const timeSeconds = clamp(
    Number.isFinite(state.audio?.currentTime) ? state.audio.currentTime : getPreferredPlaybackTime(),
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

function isFollowPlaybackInteractionActive() {
  return state.waveformSeekPointerId !== null || Boolean(state.selectionDrag) || Boolean(state.loopHandleDrag);
}

function isSmoothFollowPlaybackActive() {
  return Boolean(
    state.followPlayback
      && state.audio?.paused === false
      && Number.isFinite(state.audio?.currentTime)
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
    renderRange = expandWaveformRange(displayRange, duration, WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR);
    renderWidth = Math.max(
      width,
      Math.ceil(width * ((renderRange.end - renderRange.start) / visibleSpan)),
    );
  }

  return {
    displayRange,
    height,
    renderRange,
    renderWidth: Math.max(1, renderWidth),
  };
}

function getWaveformAxisRenderMetrics(displayRange = getWaveformRange()) {
  const viewportWidth = Math.max(1, elements.waveformAxis.clientWidth || getWaveformViewportWidth());
  const duration = getEffectiveDuration();
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  let renderRange = displayRange;
  let renderWidth = viewportWidth;

  if (duration > 0 && visibleSpan > 0 && isSmoothFollowPlaybackActive()) {
    renderRange = expandWaveformRange(displayRange, duration, WAVEFORM_FOLLOW_RENDER_BUFFER_FACTOR);
    renderWidth = Math.max(
      viewportWidth,
      Math.ceil(viewportWidth * ((renderRange.end - renderRange.start) / visibleSpan)),
    );
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

function hasWaveformRenderCoverage(displayRange = getWaveformRange()) {
  const { height, renderWidth } = getWaveformRenderRequestMetrics(displayRange);
  const displaySpan = Math.max(0, displayRange.end - displayRange.start);
  const candidates = [];

  if (state.waveformPendingRequest) {
    candidates.push(state.waveformPendingRequest);
  }

  if (state.waveformRenderRange.end > state.waveformRenderRange.start && state.waveformRenderWidth > 0) {
    candidates.push({
      end: state.waveformRenderRange.end,
      height: state.waveformRenderHeight,
      start: state.waveformRenderRange.start,
      visibleSpan: state.waveformRenderVisibleSpan,
      width: state.waveformRenderWidth,
    });
  }

  return candidates.some((candidate) => {
    if (
      !candidate
      || Math.abs((candidate.height ?? height) - height) > 1
      || (candidate.width ?? 0) < (renderWidth - 1)
      || !isWaveformDisplaySpanCompatible(candidate.visibleSpan, displaySpan)
    ) {
      return false;
    }

    if (isSmoothFollowPlaybackActive()) {
      return isRangeBuffered(displayRange, candidate, WAVEFORM_FOLLOW_PREFETCH_MARGIN_RATIO);
    }

    return Math.abs(candidate.start - displayRange.start) <= SPECTROGRAM_RANGE_EPSILON_SECONDS
      && Math.abs(candidate.end - displayRange.end) <= SPECTROGRAM_RANGE_EPSILON_SECONDS;
  });
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
  const translateX = clamp(unclampedOffset, minOffset, 0);

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
  const translateX = clamp(unclampedOffset, minOffset, 0);

  axisContent.style.transform = `translate3d(${translateX}px, 0, 0)`;
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

  return Math.min(duration, Math.max(0.001, duration / WAVEFORM_MAX_ZOOM_FACTOR));
}

function getEffectiveDuration() {
  const analysisDuration = state.analysis?.duration;

  if (Number.isFinite(analysisDuration) && analysisDuration > 0) {
    return analysisDuration;
  }

  const audioDuration = state.audio?.duration;

  if (Number.isFinite(audioDuration) && audioDuration > 0) {
    return audioDuration;
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

function getLogFrequencyPosition(frequency, minFrequency, maxFrequency) {
  const start = Math.log(minFrequency);
  const end = Math.log(maxFrequency);
  const current = Math.log(clamp(frequency, minFrequency, maxFrequency));

  return 1 - ((current - start) / (end - start));
}

function getFrequencyAtLogPosition(position, minFrequency, maxFrequency) {
  const start = Math.log(minFrequency);
  const end = Math.log(maxFrequency);
  const ratio = 1 - clamp(position, 0, 1);

  return Math.exp(start + ratio * (end - start));
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
