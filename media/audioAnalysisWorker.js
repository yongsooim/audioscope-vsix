// src-webview/waveCoreRuntime.js
var exportedFunctionNames = [
  "malloc",
  "free",
  "wave_dispose_session",
  "wave_prepare_session",
  "wave_get_pcm_ptr",
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

// src-webview/sharedBuffers.js
var TILE_COLUMN_COUNT = 256;
function quantizeCeil(value, bucketSize) {
  return Math.max(bucketSize, Math.ceil(value / bucketSize) * bucketSize);
}

// src-webview/audioAnalysisWorker.js
var MIN_FREQUENCY = 20;
var MAX_FREQUENCY = 2e4;
var ROW_BUCKET_SIZE = 32;
var QUALITY_PRESETS = {
  balanced: {
    rowsMultiplier: 1.5,
    colsMultiplier: 2.5,
    lowFrequencyDecimationFactor: 2
  },
  high: {
    rowsMultiplier: 2.5,
    colsMultiplier: 4,
    lowFrequencyDecimationFactor: 4
  },
  max: {
    rowsMultiplier: 4,
    colsMultiplier: 6,
    lowFrequencyDecimationFactor: 4
  }
};
var FFT_SIZE_OPTIONS = [1024, 2048, 4096, 8192, 16384];
var OVERLAP_RATIO_OPTIONS = [0.5, 0.75, 0.875];
var runtimePromise2 = null;
var requestQueue = Promise.resolve();
var overviewRenderLoopActive = false;
var visibleRenderLoopActive = false;
var pendingOverviewRequest = null;
var pendingVisibleRequest = null;
var surfaceState = {
  canvas: null,
  context: null,
  pixelWidth: 0,
  pixelHeight: 0
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
      return;
    case "resizeCanvas":
      resizeCanvas(message.body);
      return;
    case "attachAudioSession":
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        attachAudioSession(runtime, message.body);
      });
      return;
    case "renderOverview":
      pendingOverviewRequest = message.body ?? null;
      void pumpOverviewLoop();
      return;
    case "renderVisibleRange":
      if (message.body) {
        updateCurrentDisplayRange(message.body);
      }
      pendingVisibleRequest = message.body ?? null;
      paintSpectrogramDisplay();
      void pumpVisibleLoop();
      return;
    case "cancelGeneration":
      cancelGeneration(message.body?.generation);
      return;
    case "disposeSession":
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        disposeSession(runtime);
        paintSpectrogramDisplay();
      });
      return;
    case "dispose":
      pendingOverviewRequest = null;
      pendingVisibleRequest = null;
      surfaceState.canvas = null;
      surfaceState.context = null;
      analysisState = createEmptyAnalysisState();
      return;
    default:
      return;
  }
};
function createEmptyLayerState(kind) {
  return {
    kind,
    generation: kind === "overview" ? 0 : -1,
    ready: false,
    requestPending: false,
    plan: null
  };
}
function createEmptyAnalysisState() {
  return {
    initialized: false,
    transportMode: "shared",
    attachedSessionVersion: -1,
    sampleRate: 0,
    sampleCount: 0,
    duration: 0,
    quality: "high",
    minFrequency: MIN_FREQUENCY,
    maxFrequency: MAX_FREQUENCY,
    runtimeVariant: null,
    generationStatus: /* @__PURE__ */ new Map(),
    tileCache: /* @__PURE__ */ new Map(),
    overview: createEmptyLayerState("overview"),
    visible: createEmptyLayerState("visible"),
    currentDisplayRange: {
      start: 0,
      end: 0,
      pixelWidth: 0,
      pixelHeight: 0
    },
    spectrogramOutputPointer: 0,
    spectrogramOutputCapacity: 0
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
function normalizeQualityPreset(value) {
  return value === "balanced" || value === "max" ? value : "high";
}
function initializeCanvas(options) {
  if (options?.offscreenCanvas) {
    surfaceState.canvas = options.offscreenCanvas;
  }
  surfaceState.pixelWidth = Math.max(1, Math.round(Number(options?.pixelWidth) || surfaceState.pixelWidth || 1));
  surfaceState.pixelHeight = Math.max(1, Math.round(Number(options?.pixelHeight) || surfaceState.pixelHeight || 1));
  if (!surfaceState.canvas) {
    return;
  }
  surfaceState.canvas.width = surfaceState.pixelWidth;
  surfaceState.canvas.height = surfaceState.pixelHeight;
  surfaceState.context = surfaceState.canvas.getContext("2d", { alpha: false });
  paintSpectrogramDisplay();
}
function resizeCanvas(options) {
  surfaceState.pixelWidth = Math.max(1, Math.round(Number(options?.pixelWidth) || surfaceState.pixelWidth || 1));
  surfaceState.pixelHeight = Math.max(1, Math.round(Number(options?.pixelHeight) || surfaceState.pixelHeight || 1));
  if (!surfaceState.canvas) {
    return;
  }
  surfaceState.canvas.width = surfaceState.pixelWidth;
  surfaceState.canvas.height = surfaceState.pixelHeight;
  analysisState.currentDisplayRange.pixelWidth = surfaceState.pixelWidth;
  analysisState.currentDisplayRange.pixelHeight = surfaceState.pixelHeight;
  paintSpectrogramDisplay();
}
function attachAudioSession(runtime, options) {
  const module = runtime.module;
  const transportMode = options?.transportMode === "transfer" ? "transfer" : "shared";
  const sessionVersion = Number.isFinite(options?.sessionVersion) ? Number(options.sessionVersion) : 0;
  const sampleRate = Number(options?.sampleRate);
  const duration = Number(options?.duration);
  const sampleCount = Number(options?.sampleCount);
  const quality = normalizeQualityPreset(options?.quality);
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
      throw new Error("Failed to allocate spectrogram session.");
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
  analysisState.transportMode = transportMode;
  analysisState.attachedSessionVersion = sessionVersion;
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  analysisState.quality = quality;
  analysisState.minFrequency = MIN_FREQUENCY;
  analysisState.maxFrequency = Math.min(MAX_FREQUENCY, sampleRate / 2);
  analysisState.runtimeVariant = runtime.variant;
  if (isNewAudioSession) {
    analysisState.tileCache.clear();
    analysisState.generationStatus.clear();
    analysisState.overview = createEmptyLayerState("overview");
    analysisState.visible = createEmptyLayerState("visible");
  }
  self.postMessage({
    type: "analysisInitialized",
    body: {
      duration,
      maxFrequency: analysisState.maxFrequency,
      minFrequency: analysisState.minFrequency,
      quality,
      runtimeVariant: runtime.variant,
      sampleCount,
      sampleRate
    }
  });
}
function updateCurrentDisplayRange(request) {
  const start = clamp(Number(request?.displayStart) || 0, 0, analysisState.duration);
  const end = clamp(
    Number(request?.displayEnd) || analysisState.duration,
    start + (analysisState.sampleRate > 0 ? 1 / analysisState.sampleRate : 1e-6),
    analysisState.duration || start + 1e-6
  );
  analysisState.currentDisplayRange = {
    start,
    end,
    pixelWidth: Math.max(1, Math.round(Number(request?.pixelWidth) || surfaceState.pixelWidth || 1)),
    pixelHeight: Math.max(1, Math.round(Number(request?.pixelHeight) || surfaceState.pixelHeight || 1))
  };
}
function cancelGeneration(generation) {
  if (!Number.isFinite(generation)) {
    return;
  }
  analysisState.generationStatus.set(Number(generation), { cancelled: true });
}
function isGenerationCancelled(generation) {
  return analysisState.generationStatus.get(generation)?.cancelled === true;
}
async function pumpOverviewLoop() {
  if (overviewRenderLoopActive) {
    return;
  }
  overviewRenderLoopActive = true;
  try {
    while (pendingOverviewRequest) {
      const request = pendingOverviewRequest;
      pendingOverviewRequest = null;
      await requestQueue;
      if (!request || !analysisState.initialized) {
        continue;
      }
      const runtime = await getRuntime();
      const plan = createRequestPlan({
        ...request,
        generation: 0,
        requestKind: "overview",
        viewEnd: analysisState.duration,
        viewStart: 0
      });
      analysisState.overview = {
        generation: 0,
        kind: "overview",
        plan,
        ready: false,
        requestPending: true
      };
      await ensurePlanTiles(runtime, plan);
      analysisState.overview = {
        generation: 0,
        kind: "overview",
        plan,
        ready: true,
        requestPending: false
      };
      paintSpectrogramDisplay();
      self.postMessage({
        type: "overviewReady",
        body: createLayerReadyBody(plan)
      });
    }
  } catch (error) {
    postError(error);
  } finally {
    overviewRenderLoopActive = false;
  }
}
async function pumpVisibleLoop() {
  if (visibleRenderLoopActive) {
    return;
  }
  visibleRenderLoopActive = true;
  try {
    while (pendingVisibleRequest) {
      const request = pendingVisibleRequest;
      pendingVisibleRequest = null;
      await requestQueue;
      if (!request || !analysisState.initialized) {
        continue;
      }
      updateCurrentDisplayRange(request);
      const plan = createRequestPlan({
        ...request,
        requestKind: "visible",
        viewEnd: request.requestEnd,
        viewStart: request.requestStart
      });
      if (isEquivalentPlan(plan, analysisState.visible.plan) && analysisState.visible.ready) {
        analysisState.visible.generation = plan.generation;
        paintSpectrogramDisplay();
        continue;
      }
      analysisState.generationStatus.set(plan.generation, { cancelled: false });
      analysisState.visible = {
        generation: plan.generation,
        kind: "visible",
        plan,
        ready: false,
        requestPending: true
      };
      const completed = await ensurePlanTiles(runtimePromise2 ? await runtimePromise2 : await getRuntime(), plan, {
        onTileReady: () => {
          if (analysisState.visible.generation === plan.generation) {
            paintSpectrogramDisplay();
          }
        },
        shouldAbort: () => shouldAbortVisiblePlan(plan)
      });
      if (!completed || shouldAbortVisiblePlan(plan)) {
        continue;
      }
      analysisState.visible = {
        generation: plan.generation,
        kind: "visible",
        plan,
        ready: true,
        requestPending: false
      };
      paintSpectrogramDisplay();
      self.postMessage({
        type: "visibleReady",
        body: createLayerReadyBody(plan)
      });
    }
  } catch (error) {
    postError(error);
  } finally {
    visibleRenderLoopActive = false;
  }
}
function shouldAbortVisiblePlan(plan) {
  if (isGenerationCancelled(plan.generation)) {
    return true;
  }
  return Boolean(
    pendingVisibleRequest && Number.isFinite(pendingVisibleRequest.generation) && Number(pendingVisibleRequest.generation) !== plan.generation
  );
}
async function ensurePlanTiles(runtime, plan, options = {}) {
  const onTileReady = typeof options.onTileReady === "function" ? options.onTileReady : null;
  const shouldAbort = typeof options.shouldAbort === "function" ? options.shouldAbort : null;
  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    if (shouldAbort?.()) {
      return false;
    }
    const cacheKey = buildTileCacheKey(plan, tileIndex);
    if (!analysisState.tileCache.has(cacheKey)) {
      const tileStart = tileIndex * plan.tileDuration;
      const tileEnd = Math.min(analysisState.duration, tileStart + plan.tileDuration);
      const tileCanvas = renderTile(runtime, plan, tileIndex, tileStart, tileEnd);
      analysisState.tileCache.set(cacheKey, {
        canvas: tileCanvas,
        columnCount: TILE_COLUMN_COUNT,
        rowCount: plan.rowCount,
        tileEnd,
        tileIndex,
        tileKey: cacheKey,
        tileStart
      });
    }
    onTileReady?.();
    await yieldToEventLoop();
  }
  return true;
}
function renderTile(runtime, plan, tileIndex, tileStart, tileEnd) {
  ensureSpectrogramOutputCapacity(runtime.module, TILE_COLUMN_COUNT * plan.rowCount * 4);
  const ok = runtime.module._wave_render_spectrogram_tile_rgba(
    tileStart,
    tileEnd,
    TILE_COLUMN_COUNT,
    plan.rowCount,
    plan.fftSize,
    plan.decimationFactor,
    analysisState.minFrequency,
    analysisState.maxFrequency,
    analysisState.spectrogramOutputPointer
  );
  if (!ok) {
    throw new Error(`Spectrogram tile render failed for tile ${tileIndex}.`);
  }
  const rgba = getHeapU8View(runtime.module, analysisState.spectrogramOutputPointer, TILE_COLUMN_COUNT * plan.rowCount * 4);
  return createTileCanvas(rgba, TILE_COLUMN_COUNT, plan.rowCount);
}
function createTileCanvas(rgba, columnCount, rowCount) {
  const tileCanvas = new OffscreenCanvas(columnCount, rowCount);
  const tileContext = tileCanvas.getContext("2d", { alpha: false });
  if (!tileContext) {
    throw new Error("OffscreenCanvas 2D context is unavailable.");
  }
  const imageData = tileContext.createImageData(columnCount, rowCount);
  imageData.data.set(new Uint8ClampedArray(rgba));
  tileContext.putImageData(imageData, 0, 0);
  return tileCanvas;
}
function paintSpectrogramDisplay() {
  const context = surfaceState.context;
  if (!context) {
    return;
  }
  drawBackground(context, surfaceState.pixelWidth, surfaceState.pixelHeight);
  const displayRange = analysisState.currentDisplayRange;
  if (!(displayRange.end > displayRange.start)) {
    return;
  }
  if (analysisState.overview.plan) {
    paintLayer(context, analysisState.overview.plan, displayRange, {
      smoothing: true,
      smoothingQuality: "high"
    });
  }
  if (analysisState.visible.plan) {
    paintLayer(context, analysisState.visible.plan, displayRange, {
      smoothing: false,
      smoothingQuality: "low"
    });
  }
}
function drawBackground(context, width, height) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "#171127");
  background.addColorStop(0.46, "#0d0b19");
  background.addColorStop(1, "#04050c");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
}
function paintLayer(context, plan, displayRange, { smoothing, smoothingQuality }) {
  if (!plan) {
    return;
  }
  const span = Math.max(1e-6, displayRange.end - displayRange.start);
  const destinationWidth = Math.max(1, surfaceState.pixelWidth);
  const destinationHeight = Math.max(1, surfaceState.pixelHeight);
  context.imageSmoothingEnabled = smoothing;
  context.imageSmoothingQuality = smoothingQuality;
  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    const cacheKey = buildTileCacheKey(plan, tileIndex);
    const tile = analysisState.tileCache.get(cacheKey);
    if (!tile) {
      continue;
    }
    const tileSpan = Math.max(1e-6, tile.tileEnd - tile.tileStart);
    const overlapStart = Math.max(displayRange.start, tile.tileStart);
    const overlapEnd = Math.min(displayRange.end, tile.tileEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }
    const sourceStartRatio = (overlapStart - tile.tileStart) / tileSpan;
    const sourceEndRatio = (overlapEnd - tile.tileStart) / tileSpan;
    const destinationStartRatio = (overlapStart - displayRange.start) / span;
    const destinationEndRatio = (overlapEnd - displayRange.start) / span;
    const sourceX = clamp(Math.floor(sourceStartRatio * tile.columnCount), 0, Math.max(0, tile.columnCount - 1));
    const sourceWidth = Math.max(
      1,
      Math.min(
        tile.columnCount - sourceX,
        Math.ceil((sourceEndRatio - sourceStartRatio) * tile.columnCount)
      )
    );
    const destinationX = Math.floor(destinationStartRatio * destinationWidth);
    const destinationWidthPx = Math.max(
      1,
      Math.ceil((destinationEndRatio - destinationStartRatio) * destinationWidth)
    );
    context.drawImage(
      tile.canvas,
      sourceX,
      0,
      sourceWidth,
      tile.rowCount,
      destinationX,
      0,
      destinationWidthPx,
      destinationHeight
    );
  }
}
function createRequestPlan(request) {
  const preset = QUALITY_PRESETS[analysisState.quality];
  const requestKind = request?.requestKind === "overview" ? "overview" : "visible";
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const requestedStart = Number.isFinite(request?.viewStart) ? Number(request.viewStart) : 0;
  const requestedEnd = Number.isFinite(request?.viewEnd) ? Number(request.viewEnd) : analysisState.duration;
  const viewStart = clamp(requestedStart, 0, analysisState.duration);
  const viewEnd = clamp(
    Math.max(viewStart + 1 / analysisState.sampleRate, requestedEnd),
    viewStart + 1 / analysisState.sampleRate,
    analysisState.duration
  );
  const pixelWidth = Math.max(1, Math.round(Number(request?.pixelWidth) || surfaceState.pixelWidth || 1));
  const pixelHeight = Math.max(1, Math.round(Number(request?.pixelHeight) || surfaceState.pixelHeight || 1));
  const dprBucket = Math.max(2, Math.round(Number(request?.dpr) || 2));
  const fftSize = normalizeFftSize(request?.fftSize);
  const overlapRatio = normalizeOverlapRatio(request?.overlapRatio);
  const rowCount = quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier), ROW_BUCKET_SIZE);
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2)
  );
  const hopSamples = Math.max(1, Math.round(fftSize * (1 - overlapRatio)));
  const secondsPerColumn = hopSamples / analysisState.sampleRate;
  const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / analysisState.sampleRate);
  const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
  const endTileIndex = Math.max(
    startTileIndex,
    Math.floor(Math.max(viewStart, viewEnd - secondsPerColumn * 0.5) / tileDuration)
  );
  const windowSeconds = fftSize / analysisState.sampleRate;
  const configKey = `fft${fftSize}-ov${Math.round(overlapRatio * 1e3)}-rows${rowCount}`;
  return {
    decimationFactor: Math.max(1, preset.lowFrequencyDecimationFactor || 1),
    configKey,
    dprBucket,
    endTileIndex,
    fftSize,
    generation,
    hopSamples,
    hopSeconds: secondsPerColumn,
    overlapRatio,
    pixelHeight,
    pixelWidth,
    requestKind,
    rowCount,
    startTileIndex,
    targetColumns,
    tileDuration,
    viewEnd,
    viewStart,
    windowSeconds
  };
}
function buildTileCacheKey(plan, tileIndex) {
  return [
    analysisState.quality,
    plan.configKey,
    `tile${tileIndex}`,
    `dpr${plan.dprBucket}`
  ].join(":");
}
function createLayerReadyBody(plan) {
  return {
    decimationFactor: plan.decimationFactor,
    fftSize: plan.fftSize,
    generation: plan.generation,
    hopSamples: plan.hopSamples,
    hopSeconds: plan.hopSeconds,
    overlapRatio: plan.overlapRatio,
    pixelHeight: plan.pixelHeight,
    pixelWidth: plan.pixelWidth,
    requestKind: plan.requestKind,
    runtimeVariant: analysisState.runtimeVariant,
    targetColumns: plan.targetColumns,
    targetRows: plan.rowCount,
    viewEnd: plan.viewEnd,
    viewStart: plan.viewStart,
    windowSeconds: plan.windowSeconds
  };
}
function isEquivalentPlan(left, right) {
  if (!left || !right) {
    return false;
  }
  return left.requestKind === right.requestKind && left.dprBucket === right.dprBucket && left.pixelWidth === right.pixelWidth && left.pixelHeight === right.pixelHeight && left.rowCount === right.rowCount && left.targetColumns === right.targetColumns && left.fftSize === right.fftSize && Math.abs(left.overlapRatio - right.overlapRatio) <= 1e-6 && Math.abs(left.viewStart - right.viewStart) <= 1e-6 && Math.abs(left.viewEnd - right.viewEnd) <= 1e-6;
}
function normalizeFftSize(value) {
  const numericValue = Number(value);
  return FFT_SIZE_OPTIONS.includes(numericValue) ? numericValue : 8192;
}
function normalizeOverlapRatio(value) {
  const numericValue = Number(value);
  return OVERLAP_RATIO_OPTIONS.includes(numericValue) ? numericValue : 0.75;
}
function ensureSpectrogramOutputCapacity(module, byteLength) {
  if (analysisState.spectrogramOutputCapacity >= byteLength && analysisState.spectrogramOutputPointer) {
    return;
  }
  if (analysisState.spectrogramOutputPointer) {
    module._free(analysisState.spectrogramOutputPointer);
  }
  analysisState.spectrogramOutputPointer = module._malloc(byteLength);
  analysisState.spectrogramOutputCapacity = byteLength;
}
function getHeapF32View(module, pointer, length) {
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}
function getHeapU8View(module, pointer, length) {
  return new Uint8Array(module.HEAPU8.buffer, pointer, length);
}
function disposeWasmSession(module) {
  if (analysisState.spectrogramOutputPointer) {
    module._free(analysisState.spectrogramOutputPointer);
  }
  module._wave_dispose_session();
  analysisState.spectrogramOutputPointer = 0;
  analysisState.spectrogramOutputCapacity = 0;
}
function disposeSession(runtime) {
  if (analysisState.initialized) {
    disposeWasmSession(runtime.module);
  }
  analysisState = createEmptyAnalysisState();
}
function yieldToEventLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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
