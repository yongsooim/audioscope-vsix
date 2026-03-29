// src-webview/interactiveWaveformRenderer.ts
var MIN_LEVEL_BLOCK_SIZE = 16;
var LEVEL_SCALE_FACTOR = 4;
var MIN_LEVEL_BUCKETS = 512;
function buildInteractiveWaveformData(channelData, options = {}) {
  const samples = normalizeInteractiveWaveformSamples(channelData, options);
  const levels = [];
  let previousLevel = null;
  for (const blockSize of getInteractiveWaveformBlockSizes(samples.length)) {
    const level = previousLevel && blockSize === previousLevel.blockSize * LEVEL_SCALE_FACTOR ? buildPeakLevelFromPrevious(previousLevel) : buildInteractiveWaveformLevel(samples, blockSize);
    levels.push(level);
    previousLevel = level;
  }
  return { sampleCount: samples.length, samples, levels };
}
function normalizeInteractiveWaveformSamples(channelData, options = {}) {
  const shouldCopy = options?.copy !== false || !(channelData instanceof Float32Array);
  if (!shouldCopy) {
    return channelData;
  }
  const sampleCount = channelData.length;
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = clamp(channelData[index] ?? 0, -1, 1);
  }
  return samples;
}
function createInteractiveWaveformPreviewData({
  bucketCount,
  minMaxBuffer,
  samplesPerBucket
}) {
  const safeBucketCount = Math.max(1, Math.round(Number(bucketCount) || 0));
  const safeSamplesPerBucket = Math.max(1, Math.round(Number(samplesPerBucket) || 0));
  const source = minMaxBuffer instanceof Float32Array ? minMaxBuffer : minMaxBuffer instanceof ArrayBuffer ? new Float32Array(minMaxBuffer) : null;
  if (!source || source.length < safeBucketCount * 2) {
    return {
      sampleCount: safeBucketCount * safeSamplesPerBucket,
      samples: null,
      levels: []
    };
  }
  const baseLevel = buildPreviewBaseLevel(source, safeBucketCount, safeSamplesPerBucket);
  const levels = [baseLevel];
  let previousLevel = baseLevel;
  while (previousLevel.maxPeaks.length > MIN_LEVEL_BUCKETS) {
    previousLevel = buildPeakLevelFromPrevious(previousLevel);
    levels.push(previousLevel);
  }
  return {
    sampleCount: safeBucketCount * safeSamplesPerBucket,
    samples: null,
    levels
  };
}
function getInteractiveWaveformBlockSizes(sampleCount) {
  const blockSizes = [];
  let blockSize = MIN_LEVEL_BLOCK_SIZE;
  while (blockSize < sampleCount) {
    blockSizes.push(blockSize);
    const nextBlockSize = blockSize * LEVEL_SCALE_FACTOR;
    if (Math.ceil(sampleCount / blockSize) <= MIN_LEVEL_BUCKETS) {
      break;
    }
    blockSize = nextBlockSize;
  }
  return blockSizes;
}
function buildInteractiveWaveformLevel(samples, blockSize) {
  return buildPeakLevel(samples, blockSize);
}
function extractInteractiveWaveformSlice(waveformData, duration, viewStart, viewEnd, columnCount, output = null) {
  const safeColumnCount = Math.max(1, Math.round(columnCount || 0));
  const target = output instanceof Float32Array && output.length >= safeColumnCount * 2 ? output : new Float32Array(safeColumnCount * 2);
  if (!waveformData || duration <= 0 || viewEnd <= viewStart || safeColumnCount <= 0) {
    target.fill(0, 0, safeColumnCount * 2);
    return target;
  }
  const clampedStart = clamp(viewStart, 0, duration);
  const clampedEnd = clamp(viewEnd, clampedStart + 1e-4, duration);
  const sampleCount = getWaveformDataSampleCount(waveformData);
  const samples = getWaveformDataSamples(waveformData);
  const levels = Array.isArray(waveformData.levels) ? waveformData.levels : [];
  if (sampleCount <= 0) {
    target.fill(0, 0, safeColumnCount * 2);
    return target;
  }
  const startSample = Math.floor(clampedStart / duration * sampleCount);
  const endSample = Math.ceil(clampedEnd / duration * sampleCount);
  const visibleSamples = Math.max(1, endSample - startSample);
  const samplesPerColumn = Math.max(1, visibleSamples / safeColumnCount);
  const selectedLevel = pickLevel(levels, samplesPerColumn) ?? levels[0] ?? null;
  for (let columnIndex = 0; columnIndex < safeColumnCount; columnIndex += 1) {
    const columnStartSample = Math.floor(startSample + columnIndex / safeColumnCount * visibleSamples);
    const columnEndSample = Math.ceil(startSample + (columnIndex + 1) / safeColumnCount * visibleSamples);
    const range = selectedLevel ? getLevelRange(selectedLevel, columnStartSample, columnEndSample) : samples ? getSampleRange(samples, columnStartSample, columnEndSample) : { min: 0, max: 0 };
    const targetIndex = columnIndex * 2;
    target[targetIndex] = Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max ? range.min : 0;
    target[targetIndex + 1] = Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max ? range.max : 0;
  }
  return target;
}
function resizeInteractiveWaveformSurface(surface, width, height, renderScale) {
  surface.width = Math.max(1, Math.round(width * renderScale));
  surface.height = Math.max(1, Math.round(height * renderScale));
}
function buildPeakLevel(samples, blockSize) {
  const blockCount = Math.ceil(samples.length / blockSize);
  const minPeaks = new Float32Array(blockCount);
  const maxPeaks = new Float32Array(blockCount);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const start = blockIndex * blockSize;
    const end = Math.min(samples.length, start + blockSize);
    let minPeak = 1;
    let maxPeak = -1;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const value = clamp(samples[sampleIndex] ?? 0, -1, 1);
      if (value < minPeak) {
        minPeak = value;
      }
      if (value > maxPeak) {
        maxPeak = value;
      }
    }
    minPeaks[blockIndex] = minPeak;
    maxPeaks[blockIndex] = maxPeak;
  }
  return { blockSize, minPeaks, maxPeaks };
}
function buildPreviewBaseLevel(source, bucketCount, samplesPerBucket) {
  const minPeaks = new Float32Array(bucketCount);
  const maxPeaks = new Float32Array(bucketCount);
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const sourceIndex = bucketIndex * 2;
    const range = normalizeEnvelopeRange(source[sourceIndex], source[sourceIndex + 1]);
    minPeaks[bucketIndex] = range.min;
    maxPeaks[bucketIndex] = range.max;
  }
  return {
    blockSize: samplesPerBucket,
    minPeaks,
    maxPeaks
  };
}
function buildPeakLevelFromPrevious(previousLevel) {
  const blockCount = Math.ceil(previousLevel.maxPeaks.length / LEVEL_SCALE_FACTOR);
  const minPeaks = new Float32Array(blockCount);
  const maxPeaks = new Float32Array(blockCount);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const start = blockIndex * LEVEL_SCALE_FACTOR;
    const end = Math.min(previousLevel.maxPeaks.length, start + LEVEL_SCALE_FACTOR);
    let minPeak = 1;
    let maxPeak = -1;
    for (let peakIndex = start; peakIndex < end; peakIndex += 1) {
      const blockMin = previousLevel.minPeaks[peakIndex] ?? 0;
      const blockMax = previousLevel.maxPeaks[peakIndex] ?? 0;
      if (blockMin < minPeak) {
        minPeak = blockMin;
      }
      if (blockMax > maxPeak) {
        maxPeak = blockMax;
      }
    }
    minPeaks[blockIndex] = minPeak;
    maxPeaks[blockIndex] = maxPeak;
  }
  return {
    blockSize: previousLevel.blockSize * LEVEL_SCALE_FACTOR,
    minPeaks,
    maxPeaks
  };
}
function getLevelRange(level, startSample, endSample) {
  const startBlock = Math.max(0, Math.floor(startSample / level.blockSize));
  const endBlock = Math.min(level.maxPeaks.length, Math.ceil(endSample / level.blockSize));
  if (endBlock <= startBlock) {
    return { min: 0, max: 0 };
  }
  let min = 1;
  let max = -1;
  for (let blockIndex = startBlock; blockIndex < endBlock; blockIndex += 1) {
    const blockMin = level.minPeaks[blockIndex] ?? 0;
    const blockMax = level.maxPeaks[blockIndex] ?? 0;
    if (blockMin < min) {
      min = blockMin;
    }
    if (blockMax > max) {
      max = blockMax;
    }
  }
  return { min, max };
}
function getSampleRange(samples, startSample, endSample) {
  const safeStart = Math.max(0, startSample);
  const safeEnd = Math.min(samples.length, endSample);
  if (safeEnd <= safeStart) {
    return { min: 0, max: 0 };
  }
  let min = 1;
  let max = -1;
  for (let sampleIndex = safeStart; sampleIndex < safeEnd; sampleIndex += 1) {
    const value = clamp(samples[sampleIndex] ?? 0, -1, 1);
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  return { min, max };
}
function pickLevel(levels, samplesPerPixel) {
  let selected = null;
  for (const level of levels) {
    if (level.blockSize <= samplesPerPixel * 1.5) {
      selected = level;
      continue;
    }
    break;
  }
  return selected;
}
function getWaveformDataSampleCount(waveformData) {
  if (!waveformData || typeof waveformData !== "object") {
    return 0;
  }
  const explicitSampleCount = Number(waveformData.sampleCount);
  if (Number.isFinite(explicitSampleCount) && explicitSampleCount > 0) {
    return explicitSampleCount;
  }
  return waveformData.samples instanceof Float32Array ? waveformData.samples.length : 0;
}
function getWaveformDataSamples(waveformData) {
  return waveformData?.samples instanceof Float32Array ? waveformData.samples : null;
}
function normalizeEnvelopeRange(minValue, maxValue) {
  const safeMin = clamp(Number.isFinite(minValue) ? minValue : 0, -1, 1);
  const safeMax = clamp(Number.isFinite(maxValue) ? maxValue : 0, -1, 1);
  if (safeMin <= safeMax) {
    return {
      min: safeMin,
      max: safeMax
    };
  }
  return {
    min: Math.min(safeMin, safeMax),
    max: Math.max(safeMin, safeMax)
  };
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// src-webview/interactiveWaveformWorker.ts
var TOP_PADDING = 10;
var BOTTOM_PADDING = 10;
var CENTER_LINE_ALPHA = 0.14;
var SYMMETRIC_ENVELOPE_GAIN = 0.76;
var SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 8;
var SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
var SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
var WAVEFORM_RUNTIME_VARIANT = "waveform-js-worker";
var requestQueue = Promise.resolve();
var renderLoopActive = false;
var pendingRenderRequest = null;
var pendingPresentation = null;
var surfaceState = {
  canvas: null,
  context: null,
  width: 0,
  height: 0,
  renderScale: 2,
  color: "#7dd3fc"
};
var analysisState = createEmptyAnalysisState();
self.onmessage = (event) => {
  const message = event.data ?? {};
  switch (message.type) {
    case "bootstrapRuntime":
      self.postMessage({
        type: "runtimeReady",
        body: {
          runtimeVariant: WAVEFORM_RUNTIME_VARIANT
        }
      });
      return;
    case "initCanvas":
      initializeCanvas(message.body);
      void pumpRenderLoop();
      return;
    case "resizeCanvas":
      resizeCanvas(message.body);
      void pumpRenderLoop();
      return;
    case "attachAudioSession":
      enqueueRequest(async () => {
        attachAudioSession(message.body);
      });
      return;
    case "attachPreviewEnvelope":
      enqueueRequest(async () => {
        attachPreviewEnvelope(message.body);
        void pumpRenderLoop();
      });
      return;
    case "buildWaveformPyramid":
      enqueueRequest(async () => {
        buildWaveformPyramid();
        void pumpRenderLoop();
      });
      return;
    case "renderWaveformView":
      pendingRenderRequest = message.body ?? null;
      void pumpRenderLoop();
      return;
    case "commitWaveformRender":
      resolvePendingPresentation(message.body, true);
      return;
    case "discardWaveformRender":
      resolvePendingPresentation(message.body, false);
      return;
    case "disposeSession":
      resolvePendingPresentation(null, false);
      enqueueRequest(async () => {
        disposeSession();
        clearCanvas();
      });
      return;
    case "dispose":
      pendingRenderRequest = null;
      resolvePendingPresentation(null, false);
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
    transportMode: "shared",
    attachedSessionVersion: -1,
    sampleRate: 0,
    sampleCount: 0,
    duration: 0,
    runtimeVariant: WAVEFORM_RUNTIME_VARIANT,
    waveformData: null,
    waveformSlice: null,
    waveformSliceCapacity: 0
  };
}
function enqueueRequest(task) {
  requestQueue = requestQueue.then(task).catch((error) => {
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
  surfaceState.color = typeof options?.color === "string" && options.color ? options.color : surfaceState.color;
  if (!surfaceState.canvas) {
    return;
  }
  resizeSurface();
  surfaceState.context = surfaceState.canvas.getContext("2d");
  clearCanvas();
}
function resizeCanvas(options) {
  surfaceState.width = Math.max(1, Math.round(Number(options?.width) || surfaceState.width || 1));
  surfaceState.height = Math.max(1, Math.round(Number(options?.height) || surfaceState.height || 1));
  surfaceState.renderScale = Math.max(1, Number(options?.renderScale) || surfaceState.renderScale || 1);
  surfaceState.color = typeof options?.color === "string" && options.color ? options.color : surfaceState.color;
  resizeSurface();
}
function resizeSurface() {
  if (!surfaceState.canvas) {
    return;
  }
  resizeInteractiveWaveformSurface(
    surfaceState.canvas,
    surfaceState.width,
    surfaceState.height,
    surfaceState.renderScale
  );
}
function clearCanvas() {
  if (!surfaceState.context || !surfaceState.canvas) {
    return;
  }
  surfaceState.context.setTransform(1, 0, 0, 1, 0, 0);
  surfaceState.context.clearRect(0, 0, surfaceState.canvas.width, surfaceState.canvas.height);
}
function attachAudioSession(options) {
  const transportMode = options?.transportMode === "transfer" ? "transfer" : "shared";
  const sessionVersion = Number.isFinite(options?.sessionVersion) ? Number(options.sessionVersion) : 0;
  const sampleRate = Number(options?.sampleRate);
  const duration = Number(options?.duration);
  const sampleCount = Number(options?.sampleCount);
  if (transportMode === "shared" && !options?.pcmSab) {
    throw new Error("Shared PCM buffer is missing.");
  }
  if (transportMode === "transfer" && !options?.samplesBuffer) {
    throw new Error("Transferable PCM buffer is missing.");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    throw new Error("Audio session metadata is invalid.");
  }
  const isNewAudioSession = sessionVersion !== analysisState.attachedSessionVersion;
  if (isNewAudioSession) {
    const samples = transportMode === "shared" ? new Float32Array(options.pcmSab) : new Float32Array(options.samplesBuffer);
    analysisState.waveformData = {
      samples,
      levels: []
    };
    analysisState.waveformBuilt = false;
    analysisState.waveformSlice = null;
    analysisState.waveformSliceCapacity = 0;
  }
  analysisState.initialized = true;
  analysisState.transportMode = transportMode;
  analysisState.attachedSessionVersion = sessionVersion;
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  self.postMessage({
    type: "analysisInitialized",
    body: {
      duration,
      runtimeVariant: analysisState.runtimeVariant,
      sampleCount,
      sampleRate
    }
  });
}
function buildWaveformPyramid() {
  assertInitialized();
  if (analysisState.waveformBuilt) {
    self.postMessage({
      type: "waveformPyramidReady"
    });
    return;
  }
  const samples = analysisState.waveformData?.samples;
  if (!(samples instanceof Float32Array)) {
    throw new Error("Waveform samples are unavailable.");
  }
  analysisState.waveformData = buildInteractiveWaveformData(samples, { copy: false });
  analysisState.waveformBuilt = true;
  self.postMessage({
    type: "waveformPyramidReady"
  });
}
function attachPreviewEnvelope(options) {
  const duration = Number(options?.duration);
  const sampleRate = Number(options?.sampleRate);
  const sampleCount = Number(options?.sampleCount);
  const bucketCount = Number(options?.bucketCount);
  const samplesPerBucket = Number(options?.samplesPerBucket);
  if (!(options?.minMaxBuffer instanceof ArrayBuffer)) {
    throw new Error("Waveform preview envelope buffer is missing.");
  }
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(sampleCount) || sampleCount <= 0 || !Number.isFinite(bucketCount) || bucketCount <= 0 || !Number.isFinite(samplesPerBucket) || samplesPerBucket <= 0) {
    throw new Error("Waveform preview envelope metadata is invalid.");
  }
  analysisState.initialized = true;
  analysisState.transportMode = "preview";
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  analysisState.waveformData = createInteractiveWaveformPreviewData({
    bucketCount,
    minMaxBuffer: options.minMaxBuffer,
    samplesPerBucket
  });
  analysisState.waveformBuilt = true;
  analysisState.waveformSlice = null;
  analysisState.waveformSliceCapacity = 0;
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
  const viewStart = clamp2(Number(request?.viewStart) || 0, 0, analysisState.duration);
  const viewEnd = clamp2(
    Number(request?.viewEnd) || analysisState.duration,
    viewStart + 1 / analysisState.sampleRate,
    analysisState.duration
  );
  const width = Math.max(1, Math.round(Number(request?.width) || surfaceState.width || 1));
  const height = Math.max(1, Math.round(Number(request?.height) || surfaceState.height || 1));
  const renderScale = Math.max(1, Number(request?.renderScale) || surfaceState.renderScale || 1);
  const color = typeof request?.color === "string" && request.color ? request.color : surfaceState.color;
  const visibleSpan = Number.isFinite(request?.visibleSpan) ? Number(request.visibleSpan) : Math.max(0, viewEnd - viewStart);
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const columnCount = Math.max(1, Math.round(width * renderScale));
  const renderSpan = Math.max(1 / analysisState.sampleRate, viewEnd - viewStart);
  const samplesPerPixel = renderSpan * analysisState.sampleRate / columnCount;
  const pixelsPerSample = columnCount / Math.max(1, renderSpan * analysisState.sampleRate);
  const samplePlotMode = hasSampleWaveformData(analysisState.waveformData) && samplesPerPixel <= SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL;
  surfaceState.width = width;
  surfaceState.height = height;
  surfaceState.renderScale = renderScale;
  surfaceState.color = color;
  resizeSurface();
  const slice = ensureWaveformSliceCapacity(columnCount * 2);
  extractInteractiveWaveformSlice(
    analysisState.waveformData,
    analysisState.duration,
    viewStart,
    viewEnd,
    columnCount,
    slice
  );
  self.postMessage({
    type: "waveformReady",
    body: {
      columnCount,
      generation,
      height,
      viewEnd,
      viewStart,
      visibleSpan,
      width
    }
  });
  const shouldPresent = await waitForPresentationDecision(generation);
  if (!shouldPresent) {
    return;
  }
  drawFrame(slice, columnCount, color, samplePlotMode, pixelsPerSample);
}
function drawFrame(slice, columnCount, color, samplePlotMode, pixelsPerSample) {
  const context = surfaceState.context;
  const canvas = surfaceState.canvas;
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
    drawSamplePlot(slice, drawColumns, color, midY, amplitudeHeight, chartTop, chartBottom, pixelsPerSample);
    return;
  }
  for (let x = 0; x < drawColumns; x += 1) {
    const sourceIndex = x * 2;
    const minValue = slice[sourceIndex] ?? 0;
    const maxValue = slice[sourceIndex + 1] ?? 0;
    const symmetricPeak = Math.max(Math.abs(minValue), Math.abs(maxValue)) * SYMMETRIC_ENVELOPE_GAIN;
    const top = clamp2(Math.round(midY - symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    const bottom = clamp2(Math.round(midY + symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
  }
}
function drawSamplePlot(slice, drawColumns, color, midY, amplitudeHeight, chartTop, chartBottom, pixelsPerSample) {
  const context = surfaceState.context;
  if (!context || drawColumns <= 0) {
    return;
  }
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, surfaceState.renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  for (let x = 0; x < drawColumns; x += 1) {
    const sampleValue = getRepresentativeSampleValue(slice, x);
    const y = clamp2(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
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
      const y = clamp2(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
      context.fillRect(
        Math.round(x - pointSize * 0.5),
        Math.round(y - pointSize * 0.5),
        Math.max(1, Math.round(pointSize)),
        Math.max(1, Math.round(pointSize))
      );
    }
  }
}
function getRepresentativeSampleValue(slice, columnIndex) {
  const sourceIndex = columnIndex * 2;
  const minValue = slice[sourceIndex] ?? 0;
  const maxValue = slice[sourceIndex + 1] ?? 0;
  if (Math.abs(maxValue - minValue) <= 1e-6) {
    return clamp2(minValue, -1, 1);
  }
  return clamp2((minValue + maxValue) * 0.5, -1, 1);
}
function waitForPresentationDecision(generation) {
  return new Promise((resolve) => {
    pendingPresentation = {
      generation,
      resolve
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
function ensureWaveformSliceCapacity(floatCount) {
  if (analysisState.waveformSliceCapacity >= floatCount && analysisState.waveformSlice) {
    return analysisState.waveformSlice;
  }
  analysisState.waveformSlice = new Float32Array(floatCount);
  analysisState.waveformSliceCapacity = floatCount;
  return analysisState.waveformSlice;
}
function hasRenderableWaveformData(waveformData) {
  return hasSampleWaveformData(waveformData) || Array.isArray(waveformData?.levels) && waveformData.levels.length > 0;
}
function hasSampleWaveformData(waveformData) {
  return waveformData?.samples instanceof Float32Array && waveformData.samples.length > 0;
}
function disposeSession() {
  analysisState = createEmptyAnalysisState();
}
function assertInitialized() {
  if (!analysisState.initialized) {
    throw new Error("Waveform analysis is not initialized.");
  }
}
function postError(error) {
  const text = error instanceof Error ? error.message : String(error);
  self.postMessage({
    type: "error",
    body: { message: text }
  });
}
function clamp2(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
