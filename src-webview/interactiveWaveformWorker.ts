import { loadWaveCoreRuntime, type WaveCoreModule, type WaveCoreRuntime } from './waveCoreRuntime';
import { resizeInteractiveWaveformSurface } from './interactiveWaveformRenderer';

const TOP_PADDING = 10;
const BOTTOM_PADDING = 10;
const CENTER_LINE_ALPHA = 0.14;
const SYMMETRIC_ENVELOPE_GAIN = 0.76;
const SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 24;
const RAW_SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 1;
const SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
const SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
const WAVEFORM_RUNTIME_VARIANT = 'waveform-worker-pending';

let requestQueue = Promise.resolve();
let renderLoopActive = false;
let pendingRenderRequest = null;
let pendingPresentation = null;
let runtimePromise: Promise<WaveCoreRuntime> | null = null;

const surfaceState = {
  backCanvas: null,
  backContext: null,
  canvas: null,
  context: null,
  width: 0,
  height: 0,
  renderScale: 2,
  color: '#8ccadd',
};

let analysisState = createEmptyAnalysisState();

function postDebugTimelineEvent(label, detail = '') {
  self.postMessage({
    type: 'debugTimelineEvent',
    body: {
      event: {
        detail,
        label,
        source: 'waveform-worker',
        timeMs: Date.now(),
      },
    },
  });
}

self.onmessage = (event) => {
  const message = event.data ?? {};

  switch (message.type) {
    case 'bootstrapRuntime':
      enqueueRequest(async () => {
        postDebugTimelineEvent('waveform-worker.bootstrapRuntime');
        const runtime = await getRuntime();
        self.postMessage({
          type: 'runtimeReady',
          body: {
            runtimeVariant: runtime.variant,
          },
        });
      });
      return;
    case 'initCanvas':
      initializeCanvas(message.body);
      postDebugTimelineEvent('waveform-worker.initCanvas');
      void pumpRenderLoop();
      return;
    case 'resizeCanvas':
      resizeCanvas(message.body);
      void pumpRenderLoop();
      return;
    case 'attachAudioSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        attachAudioSession(runtime, message.body);
      });
      return;
    case 'buildWaveformPyramid':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        buildWaveformPyramid(runtime);
        void pumpRenderLoop();
      });
      return;
    case 'renderWaveformView':
      pendingRenderRequest = message.body ?? null;
      void pumpRenderLoop();
      return;
    case 'commitWaveformRender':
      resolvePendingPresentation(message.body, true);
      return;
    case 'discardWaveformRender':
      resolvePendingPresentation(message.body, false);
      return;
    case 'disposeSession':
      resolvePendingPresentation(null, false);
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        disposeSession(runtime);
        clearCanvas();
      });
      return;
    case 'dispose':
      pendingRenderRequest = null;
      resolvePendingPresentation(null, false);
      surfaceState.backContext = null;
      surfaceState.backCanvas = null;
      surfaceState.context = null;
      surfaceState.canvas = null;
      analysisState = createEmptyAnalysisState();
      return;
    default:
      return;
  }
};

function createEmptyAnalysisState() {
  return {
    initialized: false,
    waveformBuilt: false,
    attachedSessionVersion: -1,
    sampleRate: 0,
    sampleCount: 0,
    duration: 0,
    runtimeVariant: WAVEFORM_RUNTIME_VARIANT,
    representativeSampleValues: null,
    representativeSampleValuesCapacity: 0,
    waveformData: null,
    waveformPcmPointer: 0,
    waveformSlice: null,
    waveformSlicePointer: 0,
    waveformSliceCapacity: 0,
  };
}

function enqueueRequest(task) {
  requestQueue = requestQueue
    .then(task)
    .catch((error) => {
      postError(error);
    });
}

function initializeCanvas(options) {
  if (options?.offscreenCanvas) {
    surfaceState.canvas = options.offscreenCanvas;
  }

  surfaceState.width = Math.max(1, Math.round(Number(options?.width) || surfaceState.width || 1));
  surfaceState.height = Math.max(1, Math.round(Number(options?.height) || surfaceState.height || 1));
  surfaceState.renderScale = Math.max(1, Number(options?.renderScale) || surfaceState.renderScale || 1);
  surfaceState.color = typeof options?.color === 'string' && options.color
    ? options.color
    : surfaceState.color;

  if (!surfaceState.canvas) {
    return;
  }

  resizeSurface();
  surfaceState.context = surfaceState.canvas.getContext('2d');
  ensureBackBuffer();
  clearCanvas();
}

function resizeCanvas(options) {
  const resizeSnapshot = captureDisplayedSurfaceSnapshot();
  surfaceState.width = Math.max(1, Math.round(Number(options?.width) || surfaceState.width || 1));
  surfaceState.height = Math.max(1, Math.round(Number(options?.height) || surfaceState.height || 1));
  surfaceState.renderScale = Math.max(1, Number(options?.renderScale) || surfaceState.renderScale || 1);
  surfaceState.color = typeof options?.color === 'string' && options.color
    ? options.color
    : surfaceState.color;

  const resized = resizeSurface();
  ensureBackBuffer();

  if (resized && resizeSnapshot) {
    restoreDisplayedSurfaceSnapshot(resizeSnapshot);
  }
}

function resizeSurface() {
  if (!surfaceState.canvas) {
    return false;
  }

  return resizeInteractiveWaveformSurface(
    surfaceState.canvas,
    surfaceState.width,
    surfaceState.height,
    surfaceState.renderScale,
  );
}

function captureDisplayedSurfaceSnapshot() {
  if (!surfaceState.canvas || typeof OffscreenCanvas !== 'function') {
    return null;
  }

  const width = Math.max(1, surfaceState.canvas.width);
  const height = Math.max(1, surfaceState.canvas.height);
  const snapshot = new OffscreenCanvas(width, height);
  const snapshotContext = snapshot.getContext('2d');

  if (!snapshotContext) {
    return null;
  }

  snapshotContext.drawImage(surfaceState.canvas, 0, 0);
  return snapshot;
}

function restoreDisplayedSurfaceSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  const surfaces = [
    surfaceState.canvas && surfaceState.context
      ? { canvas: surfaceState.canvas, context: surfaceState.context }
      : null,
    surfaceState.backCanvas && surfaceState.backContext
      ? { canvas: surfaceState.backCanvas, context: surfaceState.backContext }
      : null,
  ];

  for (const surface of surfaces) {
    if (!surface) {
      continue;
    }

    surface.context.save();
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.globalCompositeOperation = 'copy';
    surface.context.drawImage(
      snapshot,
      0,
      0,
      snapshot.width,
      snapshot.height,
      0,
      0,
      surface.canvas.width,
      surface.canvas.height,
    );
    surface.context.restore();
  }
}

function ensureBackBuffer() {
  if (!surfaceState.canvas) {
    surfaceState.backCanvas = null;
    surfaceState.backContext = null;
    return;
  }

  if (typeof OffscreenCanvas !== 'function') {
    surfaceState.backCanvas = null;
    surfaceState.backContext = null;
    return;
  }

  if (
    !(surfaceState.backCanvas instanceof OffscreenCanvas)
    || surfaceState.backCanvas.width !== surfaceState.canvas.width
    || surfaceState.backCanvas.height !== surfaceState.canvas.height
  ) {
    surfaceState.backCanvas = new OffscreenCanvas(
      Math.max(1, surfaceState.canvas.width),
      Math.max(1, surfaceState.canvas.height),
    );
    surfaceState.backContext = surfaceState.backCanvas.getContext('2d');
  }
}

function getRenderSurface() {
  if (surfaceState.backCanvas && surfaceState.backContext) {
    return {
      canvas: surfaceState.backCanvas,
      context: surfaceState.backContext,
    };
  }

  if (surfaceState.canvas && surfaceState.context) {
    return {
      canvas: surfaceState.canvas,
      context: surfaceState.context,
    };
  }

  return null;
}

function presentRenderSurface(renderSurface) {
  if (!renderSurface || !surfaceState.canvas || !surfaceState.context) {
    return;
  }

  if (renderSurface.canvas === surfaceState.canvas) {
    return;
  }

  surfaceState.context.save();
  surfaceState.context.setTransform(1, 0, 0, 1, 0, 0);
  surfaceState.context.globalCompositeOperation = 'copy';
  surfaceState.context.drawImage(renderSurface.canvas, 0, 0);
  surfaceState.context.restore();
}

function clearCanvas() {
  const surfaces = [
    surfaceState.backCanvas && surfaceState.backContext
      ? { canvas: surfaceState.backCanvas, context: surfaceState.backContext }
      : null,
    surfaceState.canvas && surfaceState.context
      ? { canvas: surfaceState.canvas, context: surfaceState.context }
      : null,
  ];

  for (const surface of surfaces) {
    if (!surface) {
      continue;
    }

    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  }
}

function attachAudioSession(runtime, options) {
  postDebugTimelineEvent('waveform-worker.attachAudioSession.start');
  const module = runtime.module;
  const sessionVersion = Number.isFinite(options?.sessionVersion) ? Number(options.sessionVersion) : 0;
  const sampleRate = Number(options?.sampleRate);
  const duration = Number(options?.duration);
  const sampleCount = Number(options?.sampleCount);

  if (!options?.samplesBuffer) {
    throw new Error('Transferable PCM buffer is missing.');
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    throw new Error('Audio session metadata is invalid.');
  }

  const isNewAudioSession = sessionVersion !== analysisState.attachedSessionVersion;

  if (isNewAudioSession) {
    disposeWasmSession(module);
    const samples = new Float32Array(options.samplesBuffer);

    if (!module._wave_prepare_session(sampleCount, sampleRate, duration)) {
      throw new Error('Failed to allocate waveform session.');
    }

    const pcmPointer = module._wave_get_pcm_ptr();

    if (!pcmPointer) {
      throw new Error('Wasm PCM allocation failed.');
    }

    getHeapF32View(module, pcmPointer, sampleCount).set(samples);
    analysisState.waveformPcmPointer = pcmPointer;

    analysisState.waveformData = null;
    analysisState.waveformBuilt = false;
    analysisState.waveformSlice = null;
    analysisState.waveformSliceCapacity = 0;
  }

  analysisState.initialized = true;
  analysisState.attachedSessionVersion = sessionVersion;
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  analysisState.runtimeVariant = runtime.variant;

  self.postMessage({
    type: 'analysisInitialized',
    body: {
      duration,
      runtimeVariant: analysisState.runtimeVariant,
      sampleCount,
      sampleRate,
    },
  });
  postDebugTimelineEvent('waveform-worker.attachAudioSession.done', `samples=${sampleCount} rate=${sampleRate}`);
}

function buildWaveformPyramid(runtime) {
  const startedAt = performance.now();
  postDebugTimelineEvent('waveform-worker.buildWaveformPyramid.start');
  assertInitialized();

  if (analysisState.waveformBuilt) {
    self.postMessage({
      type: 'waveformPyramidReady',
    });
    postDebugTimelineEvent('waveform-worker.buildWaveformPyramid.done', 'cache-hit');
    return;
  }

  const levelCount = runtime.module._wave_build_waveform_pyramid();
  analysisState.waveformBuilt = true;

  self.postMessage({
    type: 'waveformPyramidReady',
  });
  postDebugTimelineEvent(
    'waveform-worker.buildWaveformPyramid.done',
    `${(performance.now() - startedAt).toFixed(1)} ms levels=${levelCount}`,
  );
}
async function pumpRenderLoop() {
  if (renderLoopActive) {
    return;
  }

  renderLoopActive = true;

  try {
    while (pendingRenderRequest) {
      const request = pendingRenderRequest;
      pendingRenderRequest = null;

      await requestQueue;

      if (!request || !surfaceState.context || !surfaceState.canvas) {
        clearCanvas();
        continue;
      }

      if (!analysisState.initialized || !hasRenderableWaveformData(analysisState.waveformData)) {
        continue;
      }

      await renderWaveform(request);
    }
  } catch (error) {
    postError(error);
  } finally {
    renderLoopActive = false;
  }
}

async function renderWaveform(request) {
  const startedAt = performance.now();
  const viewStart = clamp(Number(request?.viewStart) || 0, 0, analysisState.duration);
  const viewEnd = clamp(
    Number(request?.viewEnd) || analysisState.duration,
    viewStart + (1 / analysisState.sampleRate),
    analysisState.duration,
  );
  const width = Math.max(1, Math.round(Number(request?.width) || surfaceState.width || 1));
  const height = Math.max(1, Math.round(Number(request?.height) || surfaceState.height || 1));
  const renderScale = Math.max(1, Number(request?.renderScale) || surfaceState.renderScale || 1);
  const color = typeof request?.color === 'string' && request.color
    ? request.color
    : surfaceState.color;
  const visibleSpan = Number.isFinite(request?.visibleSpan) ? Number(request.visibleSpan) : Math.max(0, viewEnd - viewStart);
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const columnCount = Math.max(1, Math.round(width * renderScale));
  const renderSpan = Math.max(1 / analysisState.sampleRate, viewEnd - viewStart);
  const visibleSampleCount = Math.max(1, renderSpan * analysisState.sampleRate);
  const samplesPerPixel = visibleSampleCount / columnCount;
  const pixelsPerSample = columnCount / visibleSampleCount;
  const runtime = await getRuntime();
  const module = runtime.module;
  const sampleData = getWaveformSampleData(module);
  const samplePlotMode = sampleData instanceof Float32Array && samplesPerPixel <= SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL;
  const rawSamplePlotMode = sampleData instanceof Float32Array && samplesPerPixel <= RAW_SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL;
  const sampleStartPosition = viewStart * analysisState.sampleRate;
  const visibleSampleSpan = Math.max(0, visibleSampleCount - 1);

  surfaceState.width = width;
  surfaceState.height = height;
  surfaceState.renderScale = renderScale;
  surfaceState.color = color;
  resizeSurface();
  ensureBackBuffer();

  let slice = null;

  if (!rawSamplePlotMode && !samplePlotMode) {
    slice = ensureWaveformSliceCapacity(module, columnCount * 2);

    if (!module._wave_extract_waveform_slice(viewStart, viewEnd, columnCount, analysisState.waveformSlicePointer)) {
      throw new Error('Waveform slice extraction failed.');
    }
  }

  self.postMessage({
    type: 'waveformReady',
    body: {
      columnCount,
      generation,
      height,
      samplePlotMode,
      rawSamplePlotMode,
      viewEnd,
      viewStart,
      visibleSpan,
      width,
    },
  });
  postDebugTimelineEvent(
    'waveform-worker.waveformReady.posted',
    `${(performance.now() - startedAt).toFixed(1)} ms cols=${columnCount}`,
  );

  const shouldPresent = await waitForPresentationDecision(generation);

  if (!shouldPresent) {
    return;
  }

  const renderSurface = getRenderSurface();

  if (!renderSurface) {
    return;
  }

  if (rawSamplePlotMode && sampleData instanceof Float32Array) {
    drawRawSamplePlot(
      renderSurface,
      sampleData,
      drawColumnsCount(columnCount),
      color,
      pixelsPerSample,
      sampleStartPosition,
      visibleSampleSpan,
    );
    presentRenderSurface(renderSurface);
    postWaveformPresented({
      columnCount,
      generation,
      height,
      rawSamplePlotMode,
      samplePlotMode,
      viewEnd,
      viewStart,
      visibleSpan,
      width,
    }, startedAt);
    return;
  }

  if (samplePlotMode && sampleData instanceof Float32Array) {
    drawRepresentativeSamplePlot(
      renderSurface,
      sampleData,
      drawColumnsCount(columnCount),
      color,
      pixelsPerSample,
      sampleStartPosition,
      visibleSampleCount,
    );
    presentRenderSurface(renderSurface);
    postWaveformPresented({
      columnCount,
      generation,
      height,
      rawSamplePlotMode,
      samplePlotMode,
      viewEnd,
      viewStart,
      visibleSpan,
      width,
    }, startedAt);
    return;
  }

  drawFrame(renderSurface, slice, columnCount, color, false, pixelsPerSample);
  presentRenderSurface(renderSurface);
  postWaveformPresented({
    columnCount,
    generation,
    height,
    rawSamplePlotMode,
    samplePlotMode,
    viewEnd,
    viewStart,
    visibleSpan,
    width,
  }, startedAt);
}

function postWaveformPresented(body, startedAt) {
  self.postMessage({
    type: 'waveformPresented',
    body,
  });
  postDebugTimelineEvent(
    'waveform-worker.waveformPresented.posted',
    `${(performance.now() - startedAt).toFixed(1)} ms cols=${body?.columnCount ?? 'n/a'}`,
  );
}

function drawColumnsCount(columnCount) {
  const canvas = surfaceState.canvas;
  const deviceWidth = canvas ? Math.max(1, canvas.width) : columnCount;
  return Math.min(columnCount, deviceWidth);
}

function drawFrame(renderSurface, slice, columnCount, color, samplePlotMode, pixelsPerSample) {
  const context = renderSurface?.context;
  const canvas = renderSurface?.canvas;

  if (!context || !canvas) {
    return;
  }

  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(TOP_PADDING * surfaceState.renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((surfaceState.height - BOTTOM_PADDING) * surfaceState.renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * 0.38;

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, surfaceState.renderScale));
  context.fillStyle = color;

  const drawColumns = Math.min(columnCount, deviceWidth);

  if (samplePlotMode) {
    drawSamplePlot(renderSurface, slice, drawColumns, color, midY, amplitudeHeight, chartTop, chartBottom, pixelsPerSample);
    return;
  }

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

function drawSamplePlot(renderSurface, slice, drawColumns, color, midY, amplitudeHeight, chartTop, chartBottom, pixelsPerSample) {
  const context = renderSurface?.context;

  if (!context || drawColumns <= 0) {
    return;
  }

  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, surfaceState.renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();

  for (let x = 0; x < drawColumns; x += 1) {
    const sampleValue = getRepresentativeSampleValue(slice, x);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);

    if (x === 0) {
      context.moveTo(x + 0.5, y);
      continue;
    }

    context.lineTo(x + 0.5, y);
  }

  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, surfaceState.renderScale * 1.1);

    for (let x = 0; x < drawColumns; x += 1) {
      const sampleValue = getRepresentativeSampleValue(slice, x);
      const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
      context.fillRect(
        Math.round(x - pointSize * 0.5),
        Math.round(y - pointSize * 0.5),
        Math.max(1, Math.round(pointSize)),
        Math.max(1, Math.round(pointSize)),
      );
    }
  }
}

function drawRepresentativeSamplePlot(renderSurface, samples, drawColumns, color, pixelsPerSample, sampleStartPosition, visibleSampleCount) {
  const context = renderSurface?.context;
  const canvas = renderSurface?.canvas;

  if (!context || !canvas || drawColumns <= 0 || samples.length === 0) {
    return;
  }

  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(TOP_PADDING * surfaceState.renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((surfaceState.height - BOTTOM_PADDING) * surfaceState.renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * 0.38;

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, surfaceState.renderScale));
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, surfaceState.renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  const representativeValues = ensureRepresentativeSampleValueCapacity(drawColumns);

  for (let x = 0; x < drawColumns; x += 1) {
    const columnStartPosition = sampleStartPosition + (x / drawColumns) * visibleSampleCount;
    const columnEndPosition = sampleStartPosition + ((x + 1) / drawColumns) * visibleSampleCount;
    const sampleValue = pickRepresentativeSampleValue(samples, columnStartPosition, columnEndPosition);
    representativeValues[x] = sampleValue;
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);

    if (x === 0) {
      context.moveTo(x + 0.5, y);
      continue;
    }

    context.lineTo(x + 0.5, y);
  }

  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, surfaceState.renderScale * 1.1);
    context.beginPath();

    for (let x = 0; x < drawColumns; x += 1) {
      const sampleValue = representativeValues[x] ?? 0;
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

function drawRawSamplePlot(renderSurface, samples, drawColumns, color, pixelsPerSample, sampleStartPosition, visibleSampleSpan) {
  const context = renderSurface?.context;
  const canvas = renderSurface?.canvas;

  if (!context || !canvas || drawColumns <= 0 || samples.length === 0) {
    return;
  }

  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(TOP_PADDING * surfaceState.renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((surfaceState.height - BOTTOM_PADDING) * surfaceState.renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * 0.38;
  const maxSampleIndex = Math.max(0, samples.length - 1);

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, surfaceState.renderScale));
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, surfaceState.renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();

  for (let x = 0; x < drawColumns; x += 1) {
    const ratio = drawColumns <= 1 ? 0 : x / (drawColumns - 1);
    const samplePosition = clamp(sampleStartPosition + ratio * visibleSampleSpan, 0, maxSampleIndex);
    const sampleValue = getInterpolatedSample(samples, samplePosition);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);

    if (x === 0) {
      context.moveTo(x + 0.5, y);
      continue;
    }

    context.lineTo(x + 0.5, y);
  }

  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, surfaceState.renderScale * 1.1);
    const firstSampleIndex = Math.max(0, Math.ceil(sampleStartPosition));
    const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartPosition + visibleSampleSpan));
    context.beginPath();

    for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
      const ratio = visibleSampleSpan <= 0
        ? 0
        : (sampleIndex - sampleStartPosition) / visibleSampleSpan;
      const x = clamp(ratio * Math.max(0, drawColumns - 1), 0, Math.max(0, drawColumns - 1));
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

function getRepresentativeSampleValue(slice, columnIndex) {
  const sourceIndex = columnIndex * 2;
  const minValue = slice[sourceIndex] ?? 0;
  const maxValue = slice[sourceIndex + 1] ?? 0;

  if (Math.abs(maxValue - minValue) <= 1e-6) {
    return clamp(minValue, -1, 1);
  }

  return clamp((minValue + maxValue) * 0.5, -1, 1);
}

function getInterpolatedSample(samples, position) {
  const index = Math.floor(position);
  const nextIndex = Math.min(samples.length - 1, index + 1);
  const fraction = position - index;
  const a = clamp(samples[index] ?? 0, -1, 1);
  const b = clamp(samples[nextIndex] ?? 0, -1, 1);

  return a + (b - a) * fraction;
}

function pickRepresentativeSampleValue(samples, startPosition, endPosition) {
  const maxSampleIndex = Math.max(0, samples.length - 1);

  if (maxSampleIndex < 0) {
    return 0;
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

  return bestValue;
}

function waitForPresentationDecision(generation) {
  return new Promise((resolve) => {
    pendingPresentation = {
      generation,
      resolve,
    };
  });
}

function resolvePendingPresentation(body, shouldPresent) {
  if (!pendingPresentation) {
    return;
  }

  const generation = Number(body?.generation);

  if (Number.isFinite(generation) && pendingPresentation.generation !== generation) {
    return;
  }

  const { resolve } = pendingPresentation;
  pendingPresentation = null;
  resolve(shouldPresent);
}

function ensureWaveformSliceCapacity(module, floatCount) {
  if (
    analysisState.waveformSliceCapacity >= floatCount
    && analysisState.waveformSlicePointer
  ) {
    const view = getHeapF32View(module, analysisState.waveformSlicePointer, floatCount);
    analysisState.waveformSlice = view;
    return view;
  }

  if (analysisState.waveformSlicePointer) {
    module._free(analysisState.waveformSlicePointer);
  }

  const pointer = module._malloc(floatCount * Float32Array.BYTES_PER_ELEMENT);

  if (!pointer) {
    throw new Error('Failed to allocate waveform slice buffer.');
  }

  analysisState.waveformSlicePointer = pointer;
  analysisState.waveformSliceCapacity = floatCount;
  analysisState.waveformSlice = getHeapF32View(module, pointer, floatCount);
  return analysisState.waveformSlice;
}

function ensureRepresentativeSampleValueCapacity(count) {
  if (
    analysisState.representativeSampleValuesCapacity >= count
    && analysisState.representativeSampleValues instanceof Float32Array
  ) {
    return analysisState.representativeSampleValues;
  }

  analysisState.representativeSampleValues = new Float32Array(count);
  analysisState.representativeSampleValuesCapacity = count;
  return analysisState.representativeSampleValues;
}

function hasRenderableWaveformData(waveformData) {
  return Boolean(analysisState.waveformPcmPointer && analysisState.sampleCount > 0);
}

function hasSampleWaveformData(waveformData) {
  return waveformData?.samples instanceof Float32Array && waveformData.samples.length > 0;
}

function getWaveformSampleData(module: WaveCoreModule): Float32Array | null {
  if (!analysisState.waveformPcmPointer || analysisState.sampleCount <= 0) {
    return null;
  }

  return getHeapF32View(module, analysisState.waveformPcmPointer, analysisState.sampleCount);
}

function disposeWasmSession(module: WaveCoreModule) {
  if (analysisState.waveformSlicePointer) {
    module._free(analysisState.waveformSlicePointer);
  }

  module._wave_dispose_session();
  analysisState.waveformPcmPointer = 0;
  analysisState.waveformSlicePointer = 0;
  analysisState.waveformSlice = null;
  analysisState.waveformSliceCapacity = 0;
}

function disposeSession(runtime: WaveCoreRuntime) {
  if (analysisState.initialized) {
    disposeWasmSession(runtime.module);
  }

  analysisState = createEmptyAnalysisState();
}

function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = loadWaveCoreRuntime();
  }

  return runtimePromise;
}

function getHeapF32View(module: WaveCoreModule, pointer: number, length: number): Float32Array {
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}

function assertInitialized() {
  if (!analysisState.initialized) {
    throw new Error('Waveform analysis is not initialized.');
  }
}

function postError(error) {
  const text = error instanceof Error ? error.message : String(error);

  self.postMessage({
    type: 'error',
    body: { message: text },
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
