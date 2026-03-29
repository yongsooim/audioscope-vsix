// src-webview/waveCoreRuntime.js
var exportedFunctionNames = [
  "malloc",
  "free",
  "wave_dispose_session",
  "wave_prepare_session",
  "wave_get_pcm_ptr",
  "wave_measure_loudness_summary",
  "wave_build_waveform_pyramid",
  "wave_extract_waveform_slice",
  "wave_render_spectrogram_tile_rgba"
];
var wasmCandidates = [
  {
    url: new URL("../media/wave_core_simd.wasm", import.meta.url),
    variant: "wave-core-wasm-simd"
  },
  {
    url: new URL("../media/wave_core_fallback.wasm", import.meta.url),
    variant: "wave-core-wasm-fallback"
  }
];
var runtimePromise = null;
async function loadWaveCoreRuntime() {
  if (!runtimePromise) {
    runtimePromise = instantiateWaveCoreRuntime();
  }
  return runtimePromise;
}
async function instantiateWaveCoreRuntime() {
  const errors = [];
  for (const candidate of wasmCandidates) {
    try {
      const instance = await instantiateWasm(candidate.url);
      return {
        module: createModuleFacade(instance.exports),
        variant: candidate.variant
      };
    } catch (error) {
      errors.push(`${candidate.variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to load wave core runtime. ${errors.join(" | ")}`);
}
async function instantiateWasm(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${url.pathname}: ${response.status}`);
  }
  const imports = {};
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try {
      const { instance: instance2 } = await WebAssembly.instantiateStreaming(response, imports);
      return instance2;
    } catch {
    }
  }
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}
function createModuleFacade(exports) {
  const module = {};
  let currentBuffer = null;
  const refreshViews = () => {
    const memory = exports.memory;
    if (!memory) {
      throw new Error("Wave core memory export is missing.");
    }
    if (currentBuffer === memory.buffer) {
      return;
    }
    currentBuffer = memory.buffer;
    module.HEAPU8 = new Uint8Array(currentBuffer);
    module.HEAPF32 = new Float32Array(currentBuffer);
  };
  refreshViews();
  module.memory = exports.memory;
  for (const name of exportedFunctionNames) {
    const fn = exports[name];
    if (typeof fn !== "function") {
      throw new Error(`Wave core export "${name}" is missing.`);
    }
    module[`_${name}`] = (...args) => {
      const result = fn(...args);
      refreshViews();
      return result;
    };
  }
  return module;
}

// src-webview/interactiveWaveformWorker.js
var TOP_PADDING = 10;
var BOTTOM_PADDING = 10;
var CENTER_LINE_ALPHA = 0.14;
var SYMMETRIC_ENVELOPE_GAIN = 0.76;
var SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL = 8;
var SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
var SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
var runtimePromise2 = null;
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
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        self.postMessage({
          type: "runtimeReady",
          body: {
            runtimeVariant: runtime.variant
          }
        });
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
        const runtime = await getRuntime();
        attachAudioSession(runtime, message.body);
      });
      return;
    case "buildWaveformPyramid":
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        buildWaveformPyramid(runtime);
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
        const runtime = await getRuntime();
        disposeSession(runtime);
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
    runtimeVariant: null,
    waveformOutputPointer: 0,
    waveformOutputCapacity: 0
  };
}
function enqueueRequest(task) {
  requestQueue = requestQueue.then(task).catch((error) => {
    postError(error);
  });
}
function getRuntime() {
  if (!runtimePromise2) {
    runtimePromise2 = loadWaveCoreRuntime();
  }
  return runtimePromise2;
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
  surfaceState.canvas.width = Math.max(1, Math.round(surfaceState.width * surfaceState.renderScale));
  surfaceState.canvas.height = Math.max(1, Math.round(surfaceState.height * surfaceState.renderScale));
}
function clearCanvas() {
  if (!surfaceState.context || !surfaceState.canvas) {
    return;
  }
  surfaceState.context.setTransform(1, 0, 0, 1, 0, 0);
  surfaceState.context.clearRect(0, 0, surfaceState.canvas.width, surfaceState.canvas.height);
}
function attachAudioSession(runtime, options) {
  const module = runtime.module;
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
    disposeWasmSession(module);
    if (!module._wave_prepare_session(sampleCount, sampleRate, duration)) {
      throw new Error("Failed to allocate waveform session.");
    }
    const pcmPointer = module._wave_get_pcm_ptr();
    if (!pcmPointer) {
      throw new Error("Wasm PCM allocation failed.");
    }
    const pcmSource = transportMode === "shared" ? new Float32Array(options.pcmSab) : new Float32Array(options.samplesBuffer);
    const pcmTarget = getHeapF32View(module, pcmPointer, sampleCount);
    pcmTarget.set(pcmSource);
  }
  analysisState.initialized = true;
  analysisState.waveformBuilt = false;
  analysisState.transportMode = transportMode;
  analysisState.attachedSessionVersion = sessionVersion;
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  analysisState.runtimeVariant = runtime.variant;
  self.postMessage({
    type: "analysisInitialized",
    body: {
      duration,
      runtimeVariant: runtime.variant,
      sampleCount,
      sampleRate
    }
  });
}
function buildWaveformPyramid(runtime) {
  assertInitialized();
  if (!runtime.module._wave_build_waveform_pyramid()) {
    throw new Error("Waveform pyramid build failed.");
  }
  analysisState.waveformBuilt = true;
  self.postMessage({
    type: "waveformPyramidReady"
  });
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
      if (!analysisState.initialized || !analysisState.waveformBuilt) {
        continue;
      }
      const runtime = await getRuntime();
      await renderWaveform(runtime, request);
    }
  } catch (error) {
    postError(error);
  } finally {
    renderLoopActive = false;
  }
}
async function renderWaveform(runtime, request) {
  const module = runtime.module;
  const viewStart = clamp(Number(request?.viewStart) || 0, 0, analysisState.duration);
  const viewEnd = clamp(
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
  const samplePlotMode = samplesPerPixel <= SAMPLE_PLOT_MAX_SAMPLES_PER_PIXEL;
  surfaceState.width = width;
  surfaceState.height = height;
  surfaceState.renderScale = renderScale;
  surfaceState.color = color;
  resizeSurface();
  ensureWaveformOutputCapacity(module, columnCount * 2);
  const ok = module._wave_extract_waveform_slice(
    viewStart,
    viewEnd,
    columnCount,
    analysisState.waveformOutputPointer
  );
  if (!ok) {
    throw new Error("Waveform slice extraction failed.");
  }
  const slice = getHeapF32View(module, analysisState.waveformOutputPointer, columnCount * 2);
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
    const top = clamp(Math.round(midY - symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    const bottom = clamp(Math.round(midY + symmetricPeak * amplitudeHeight), chartTop, chartBottom);
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
    return clamp(minValue, -1, 1);
  }
  return clamp((minValue + maxValue) * 0.5, -1, 1);
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
function ensureWaveformOutputCapacity(module, floatCount) {
  if (analysisState.waveformOutputCapacity >= floatCount && analysisState.waveformOutputPointer) {
    return;
  }
  if (analysisState.waveformOutputPointer) {
    module._free(analysisState.waveformOutputPointer);
  }
  analysisState.waveformOutputPointer = module._malloc(floatCount * Float32Array.BYTES_PER_ELEMENT);
  analysisState.waveformOutputCapacity = floatCount;
}
function getHeapF32View(module, pointer, length) {
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}
function disposeWasmSession(module) {
  if (analysisState.waveformOutputPointer) {
    module._free(analysisState.waveformOutputPointer);
  }
  module._wave_dispose_session();
  analysisState.waveformOutputPointer = 0;
  analysisState.waveformOutputCapacity = 0;
}
function disposeSession(runtime) {
  if (analysisState.initialized) {
    disposeWasmSession(runtime.module);
  }
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
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
