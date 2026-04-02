import { loadWaveCoreRuntime, type WaveCoreModule, type WaveCoreRuntime } from './waveCoreRuntime';
import { resizeInteractiveWaveformSurface } from './interactiveWaveformRenderer';
import {
  WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
  WAVEFORM_BOTTOM_PADDING_PX as BOTTOM_PADDING,
  WAVEFORM_TOP_PADDING_PX as TOP_PADDING,
} from './waveformGeometry';

const CENTER_LINE_ALPHA = 0.14;
const SYMMETRIC_ENVELOPE_GAIN = 0.76;
const SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 24;
const RAW_SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 1;
const SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 20;
const SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 28;
const RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 0.9;
const RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 1.15;
const SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
const SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
const WAVEFORM_RUNTIME_VARIANT = 'waveform-worker-pending';
let requestQueue = Promise.resolve();
let renderLoopActive = false;
let pendingRenderRequest = null;
let latestRequestedGeneration = 0;
let runtimePromise: Promise<WaveCoreRuntime> | null = null;

const surfaceState = {
  canvas: null,
  context: null,
  width: 0,
  height: 0,
  renderScale: 2,
  color: '#8ccadd',
};

let analysisState = createEmptyAnalysisState();

self.onmessage = (event) => {
  const message = event.data ?? {};

  switch (message.type) {
    case 'bootstrapRuntime':
      enqueueRequest(async () => {
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
      latestRequestedGeneration = Number.isFinite(Number(message.body?.generation))
        ? Number(message.body.generation)
        : latestRequestedGeneration;
      void pumpRenderLoop();
      return;
    case 'disposeSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        disposeSession(runtime);
        clearCanvas();
      });
      return;
    case 'dispose':
      pendingRenderRequest = null;
      latestRequestedGeneration = 0;
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
    plotMode: 'envelope',
    waveformData: null,
    waveformPcmPointer: 0,
    waveformSliceMetaPointer: 0,
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

  if (surfaceState.canvas) {
    resizeDisplaySurface();
    surfaceState.context = surfaceState.canvas.getContext('2d');
  }
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

  const resized = resizeDisplaySurface();

  if (resized && resizeSnapshot) {
    restoreDisplayedSurfaceSnapshot(resizeSnapshot);
  }
}

function resizeSurface(surface, width, height, renderScale) {
  if (!surface) {
    return false;
  }

  return resizeInteractiveWaveformSurface(
    surface,
    width,
    height,
    renderScale,
  );
}

function resizeDisplaySurface() {
  if (!surfaceState.canvas) {
    return false;
  }

  return resizeSurface(
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

function clearCanvas() {
  const surfaces = [
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
}

function buildWaveformPyramid(runtime) {
  assertInitialized();

  if (analysisState.waveformBuilt) {
    self.postMessage({
      type: 'waveformPyramidReady',
    });
    return;
  }

  runtime.module._wave_build_waveform_pyramid();
  analysisState.waveformBuilt = true;

  self.postMessage({
    type: 'waveformPyramidReady',
  });
}
async function pumpRenderLoop() {
  if (renderLoopActive) {
    return;
  }

  renderLoopActive = true;

  try {
    while (pendingRenderRequest) {
      if (pendingRenderRequest) {
        const request = pendingRenderRequest;
        pendingRenderRequest = null;

        await requestQueue;

        if (!request) {
          clearCanvas();
          continue;
        }

        if (!analysisState.initialized || !hasRenderableWaveformData(analysisState.waveformData)) {
          continue;
        }

        await renderWaveform(request);
      }
    }
  } catch (error) {
    postError(error);
  } finally {
    renderLoopActive = false;
  }
}

async function renderWaveform(request) {
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
  const plotMode = resolveWaveformPlotMode(samplesPerPixel, sampleData instanceof Float32Array);
  const samplePlotMode = plotMode !== 'envelope';
  const rawSamplePlotMode = plotMode === 'raw';
  const sampleStartPosition = viewStart * analysisState.sampleRate;
  const visibleSampleSpan = Math.max(0, visibleSampleCount - 1);

  analysisState.plotMode = plotMode;

  surfaceState.width = width;
  surfaceState.height = height;
  surfaceState.renderScale = renderScale;
  surfaceState.color = color;
  resizeDisplaySurface();

  let slice = null;
  let actualViewStart = viewStart;
  let actualViewEnd = viewEnd;

  if (!rawSamplePlotMode && !samplePlotMode) {
    slice = ensureWaveformSliceCapacity(module, columnCount * 2);
    const sliceMetaPointer = ensureWaveformSliceMetaPointer(module);

    if (!module._wave_extract_waveform_slice(
      viewStart,
      viewEnd,
      columnCount,
      analysisState.waveformSlicePointer,
      sliceMetaPointer,
    )) {
      throw new Error('Waveform slice extraction failed.');
    }

    const sliceMeta = readWaveformSliceMeta(module, sliceMetaPointer);
    actualViewStart = Number.isFinite(sliceMeta.start) ? sliceMeta.start : viewStart;
    actualViewEnd = Number.isFinite(sliceMeta.end) ? sliceMeta.end : viewEnd;
  }

  if (generation !== latestRequestedGeneration) {
    return;
  }

  const renderSurface = surfaceState.canvas && surfaceState.context
    ? {
      canvas: surfaceState.canvas,
      context: surfaceState.context,
    }
    : null;

  if (!renderSurface) {
    return;
  }

  if (rawSamplePlotMode && sampleData instanceof Float32Array) {
    drawRawSamplePlot(
      renderSurface,
      sampleData,
      color,
      pixelsPerSample,
      sampleStartPosition,
      visibleSampleSpan,
    );
    if (generation !== latestRequestedGeneration) {
      return;
    }
    postWaveformPresented({
      columnCount,
      generation,
      height,
      rawSamplePlotMode,
      samplePlotMode,
      viewEnd: actualViewEnd,
      viewStart: actualViewStart,
      visibleSpan,
      width,
    });
    return;
  }

  if (samplePlotMode && sampleData instanceof Float32Array) {
    drawRepresentativeSamplePlot(
      renderSurface,
      sampleData,
      color,
      pixelsPerSample,
      sampleStartPosition,
      visibleSampleCount,
      visibleSampleSpan,
    );
    if (generation !== latestRequestedGeneration) {
      return;
    }
    postWaveformPresented({
      columnCount,
      generation,
      height,
      rawSamplePlotMode,
      samplePlotMode,
      viewEnd: actualViewEnd,
      viewStart: actualViewStart,
      visibleSpan,
      width,
    });
    return;
  }

  drawFrame(renderSurface, slice, columnCount, color, false, pixelsPerSample);
  if (generation !== latestRequestedGeneration) {
    return;
  }

  postWaveformPresented({
    columnCount,
    generation,
    height,
    rawSamplePlotMode,
    samplePlotMode,
    viewEnd: actualViewEnd,
    viewStart: actualViewStart,
    visibleSpan,
    width,
  });
}

function postWaveformPresented(body) {
  self.postMessage({
    type: 'waveformPresented',
    body,
  });
}

function drawColumnsCount(renderSurface, columnCount) {
  const canvas = renderSurface?.canvas ?? surfaceState.canvas;
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
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;

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

function resolveWaveformPlotMode(samplesPerPixel, hasSampleData) {
  if (!hasSampleData) {
    return 'envelope';
  }

  if (analysisState.plotMode === 'raw') {
    if (samplesPerPixel <= RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL) {
      return 'raw';
    }

    return samplesPerPixel <= SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (analysisState.plotMode === 'sample') {
    if (samplesPerPixel <= RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
      return 'raw';
    }

    return samplesPerPixel <= SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (samplesPerPixel <= RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
    return 'raw';
  }

  return samplesPerPixel <= SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
}

function getRenderableSampleX(samplePosition, sampleStartPosition, visibleSampleSpan, drawColumns) {
  const maxX = Math.max(0, drawColumns - 1);

  if (maxX <= 0 || visibleSampleSpan <= 0) {
    return 0;
  }

  return clamp(((samplePosition - sampleStartPosition) / visibleSampleSpan) * maxX, 0, maxX);
}

function getSampleBucketSize(visibleSampleCount, drawColumns) {
  if (!(visibleSampleCount > 0) || !(drawColumns > 0)) {
    return 1;
  }

  return Math.max(1, Math.round(visibleSampleCount / drawColumns));
}

function appendWaveformPlotPoint(points, x, sampleValue) {
  const normalizedValue = clamp(sampleValue ?? 0, -1, 1);
  const previousPoint = points[points.length - 1] ?? null;

  if (previousPoint && Math.abs(previousPoint.x - x) <= 0.01) {
    if (Math.abs(normalizedValue) >= Math.abs(previousPoint.sampleValue)) {
      previousPoint.sampleValue = normalizedValue;
    }
    return;
  }

  points.push({
    sampleValue: normalizedValue,
    x,
  });
}

function drawRepresentativeSamplePlot(renderSurface, samples, color, pixelsPerSample, sampleStartPosition, visibleSampleCount, visibleSampleSpan) {
  const context = renderSurface?.context;
  const canvas = renderSurface?.canvas;
  const drawColumns = drawColumnsCount(renderSurface, Math.max(1, canvas?.width ?? 1));

  if (!context || !canvas || drawColumns <= 0 || samples.length === 0) {
    return;
  }

  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(TOP_PADDING * surfaceState.renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((surfaceState.height - BOTTOM_PADDING) * surfaceState.renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;

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
  const maxX = Math.max(0, drawColumns - 1);
  const bucketSize = getSampleBucketSize(visibleSampleCount, drawColumns);
  const plotPoints = [];
  const bucketStartIndex = Math.floor(sampleStartPosition / bucketSize);
  const bucketEndIndex = Math.ceil((sampleStartPosition + visibleSampleCount) / bucketSize);

  appendWaveformPlotPoint(plotPoints, 0, getInterpolatedSample(samples, sampleStartPosition));

  for (let bucketIndex = bucketStartIndex; bucketIndex < bucketEndIndex; bucketIndex += 1) {
    const bucketStart = bucketIndex * bucketSize;
    const bucketEnd = bucketStart + bucketSize;
    const samplePoint = pickRepresentativeSamplePoint(samples, bucketStart, bucketEnd);

    if (!samplePoint) {
      continue;
    }

    appendWaveformPlotPoint(
      plotPoints,
      getRenderableSampleX(samplePoint.sampleIndex, sampleStartPosition, visibleSampleSpan, drawColumns),
      samplePoint.sampleValue,
    );
  }

  appendWaveformPlotPoint(
    plotPoints,
    maxX,
    getInterpolatedSample(samples, sampleStartPosition + visibleSampleSpan),
  );

  for (let pointIndex = 0; pointIndex < plotPoints.length; pointIndex += 1) {
    const plotPoint = plotPoints[pointIndex];
    const y = clamp(midY - plotPoint.sampleValue * amplitudeHeight, chartTop, chartBottom);

    if (pointIndex === 0) {
      context.moveTo(plotPoint.x, y);
      continue;
    }

    context.lineTo(plotPoint.x, y);
  }

  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, surfaceState.renderScale * 1.1);
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

function drawRawSamplePlot(renderSurface, samples, color, pixelsPerSample, sampleStartPosition, visibleSampleSpan) {
  const context = renderSurface?.context;
  const canvas = renderSurface?.canvas;
  const drawColumns = drawColumnsCount(renderSurface, Math.max(1, canvas?.width ?? 1));

  if (!context || !canvas || drawColumns <= 0 || samples.length === 0) {
    return;
  }

  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(TOP_PADDING * surfaceState.renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((surfaceState.height - BOTTOM_PADDING) * surfaceState.renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;
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
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartPosition));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartPosition + visibleSampleSpan));
  const startY = clamp(midY - getInterpolatedSample(samples, sampleStartPosition) * amplitudeHeight, chartTop, chartBottom);
  context.moveTo(0, startY);

  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getRenderableSampleX(sampleIndex, sampleStartPosition, visibleSampleSpan, drawColumns);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.lineTo(x, y);
  }

  const endX = Math.max(0, drawColumns - 1);
  const endY = clamp(
    midY - getInterpolatedSample(samples, sampleStartPosition + visibleSampleSpan) * amplitudeHeight,
    chartTop,
    chartBottom,
  );
  context.lineTo(endX, endY);

  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, surfaceState.renderScale * 1.1);
    context.beginPath();

    for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
      const x = getRenderableSampleX(sampleIndex, sampleStartPosition, visibleSampleSpan, drawColumns);
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

function pickRepresentativeSamplePoint(samples, startPosition, endPosition) {
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

function ensureWaveformSliceMetaPointer(module) {
  if (analysisState.waveformSliceMetaPointer) {
    return analysisState.waveformSliceMetaPointer;
  }

  const pointer = module._malloc(Float64Array.BYTES_PER_ELEMENT * 2);

  if (!pointer) {
    throw new Error('Failed to allocate waveform slice metadata buffer.');
  }

  analysisState.waveformSliceMetaPointer = pointer;
  return pointer;
}

function readWaveformSliceMeta(module, pointer) {
  const offset = Math.floor(pointer / Float64Array.BYTES_PER_ELEMENT);
  return {
    end: Number(module.HEAPF64[offset + 1] ?? 0),
    start: Number(module.HEAPF64[offset] ?? 0),
  };
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

  if (analysisState.waveformSliceMetaPointer) {
    module._free(analysisState.waveformSliceMetaPointer);
  }

  module._wave_dispose_session();
  analysisState.waveformPcmPointer = 0;
  analysisState.waveformSliceMetaPointer = 0;
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
