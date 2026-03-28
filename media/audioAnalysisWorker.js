// src-webview/waveCoreRuntime.js
import createWaveCoreModule from "../media/wave_core.js";
var runtimePromise = null;
async function loadWaveCoreRuntime() {
  if (!runtimePromise) {
    runtimePromise = createWaveCoreModule({
      locateFile: (path) => new URL(path, import.meta.url).toString()
    }).then((module) => ({
      module,
      variant: "wave-core-wasm"
    }));
  }
  return runtimePromise;
}

// src-webview/sharedBuffers.js
var TILE_COLUMN_COUNT = 256;
var WAVEFORM_SLOT_COUNT = 8;
var SPECTROGRAM_SLOT_COUNT = 12;
var CONTROL_INDEX = {
  sessionVersion: 0,
  attached: 1,
  waveformSlotBase: 16,
  spectrogramSlotBase: 48
};
function getWaveformSlotLength(maxColumns) {
  return maxColumns * 2;
}
function getWaveformSlotView(waveformSab, maxColumns, slotId) {
  const slotLength = getWaveformSlotLength(maxColumns);
  const byteOffset = Float32Array.BYTES_PER_ELEMENT * slotLength * slotId;
  return new Float32Array(waveformSab, byteOffset, slotLength);
}
function getSpectrogramSlotByteLength(maxColumns, maxRows) {
  return maxColumns * maxRows * 4;
}
function getSpectrogramSlotView(spectrogramSab, maxColumns, maxRows, slotId, width, height) {
  const maxSlotBytes = getSpectrogramSlotByteLength(maxColumns, maxRows);
  const byteOffset = maxSlotBytes * slotId;
  return new Uint8ClampedArray(spectrogramSab, byteOffset, width * height * 4);
}
function markWaveformSlotReady(controlView, slotId, sequence) {
  Atomics.store(controlView, CONTROL_INDEX.waveformSlotBase + slotId, sequence);
}
function markSpectrogramSlotReady(controlView, slotId, sequence) {
  Atomics.store(controlView, CONTROL_INDEX.spectrogramSlotBase + slotId, sequence);
}
function quantizeCeil(value, bucketSize) {
  return Math.max(bucketSize, Math.ceil(value / bucketSize) * bucketSize);
}
function quantizeSamplesPerPixel(samplesPerPixel) {
  const safeValue = Math.max(1, samplesPerPixel);
  const bucketExponent = Math.round(Math.log2(safeValue) * 2) / 2;
  return 2 ** bucketExponent;
}
function formatBucketNumber(value) {
  return String(Math.round(value * 100) / 100).replace(".", "_");
}

// src-webview/audioAnalysisWorker.js
var MIN_FREQUENCY = 20;
var MAX_FREQUENCY = 2e4;
var ROW_BUCKET_SIZE = 32;
var QUALITY_PRESETS = {
  balanced: {
    rowsMultiplier: 1.5,
    colsMultiplier: 2.5,
    fftSizes: [2048, 4096, 8192],
    lowFrequencyDecimationFactor: 2
  },
  high: {
    rowsMultiplier: 2.5,
    colsMultiplier: 4,
    fftSizes: [4096, 8192, 16384],
    lowFrequencyDecimationFactor: 4
  },
  max: {
    rowsMultiplier: 4,
    colsMultiplier: 6,
    fftSizes: [8192, 16384, 16384],
    lowFrequencyDecimationFactor: 4
  }
};
var requestQueue = Promise.resolve();
var runtimePromise2 = null;
var analysisState = createEmptyAnalysisState();
self.onmessage = (event) => {
  const message = event.data;
  switch (message?.type) {
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
      });
      return;
    case "requestWaveformSlice":
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        requestWaveformSlice(runtime, message.body);
      });
      return;
    case "requestSpectrogramTiles":
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        await requestSpectrogramTiles(runtime, message.body);
      });
      return;
    case "cancelGeneration":
      cancelGeneration(message.body?.generation);
      return;
    case "releaseSpectrogramSlot":
      releaseSpectrogramSlot(message.body?.slotId);
      return;
    case "disposeSession":
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        disposeSession(runtime);
      });
      return;
    default:
      return;
  }
};
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
    pcmSab: null,
    controlSab: null,
    controlView: null,
    waveformSab: null,
    waveformMaxColumns: 0,
    spectrogramSab: null,
    spectrogramMaxColumns: 0,
    spectrogramMaxRows: 0,
    generationStatus: /* @__PURE__ */ new Map(),
    tileCache: /* @__PURE__ */ new Map(),
    waveformRequestSequence: 0,
    spectrogramRequestSequence: 0,
    slotReleaseResolvers: [],
    slotBusy: new Array(SPECTROGRAM_SLOT_COUNT).fill(false),
    pcmPointer: 0,
    waveformOutputPointer: 0,
    waveformOutputCapacity: 0,
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
function attachAudioSession(runtime, options) {
  const module = runtime.module;
  const transportMode = options?.transportMode === "transfer" ? "transfer" : "shared";
  const sessionVersion = Number.isFinite(options?.sessionVersion) ? Number(options.sessionVersion) : 0;
  const sampleRate = Number(options?.sampleRate);
  const duration = Number(options?.duration);
  const sampleCount = Number(options?.sampleCount);
  const quality = normalizeQualityPreset(options?.quality);
  if (transportMode === "shared" && (!options?.pcmSab || !options?.controlSab || !options?.waveformSab || !options?.spectrogramSab)) {
    throw new Error("Shared buffers are missing.");
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
      throw new Error("Failed to allocate wasm audio session.");
    }
    const pcmPointer = module._wave_get_pcm_ptr();
    if (!pcmPointer) {
      throw new Error("Wasm PCM allocation failed.");
    }
    const pcmSource = transportMode === "shared" ? new Float32Array(options.pcmSab) : new Float32Array(options.samplesBuffer);
    const pcmTarget = getHeapF32View(module, pcmPointer, sampleCount);
    pcmTarget.set(pcmSource);
    analysisState.pcmPointer = pcmPointer;
    analysisState.tileCache.clear();
    analysisState.generationStatus.clear();
  }
  analysisState.initialized = true;
  analysisState.attachedSessionVersion = sessionVersion;
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  analysisState.quality = quality;
  analysisState.transportMode = transportMode;
  analysisState.minFrequency = MIN_FREQUENCY;
  analysisState.maxFrequency = Math.min(MAX_FREQUENCY, sampleRate / 2);
  analysisState.runtimeVariant = runtime.variant;
  analysisState.pcmSab = transportMode === "shared" ? options.pcmSab : null;
  analysisState.controlSab = transportMode === "shared" ? options.controlSab : null;
  analysisState.controlView = transportMode === "shared" ? new Int32Array(options.controlSab) : null;
  analysisState.waveformSab = transportMode === "shared" ? options.waveformSab : null;
  analysisState.waveformMaxColumns = transportMode === "shared" ? Math.max(1, Math.round(options.waveformMaxColumns || 1)) : 0;
  analysisState.spectrogramSab = transportMode === "shared" ? options.spectrogramSab : null;
  analysisState.spectrogramMaxColumns = transportMode === "shared" ? Math.max(TILE_COLUMN_COUNT, Math.round(options.spectrogramMaxColumns || TILE_COLUMN_COUNT)) : 0;
  analysisState.spectrogramMaxRows = transportMode === "shared" ? Math.max(ROW_BUCKET_SIZE, Math.round(options.spectrogramMaxRows || ROW_BUCKET_SIZE)) : 0;
  analysisState.slotBusy = new Array(SPECTROGRAM_SLOT_COUNT).fill(false);
  analysisState.slotReleaseResolvers = [];
  if (analysisState.controlView) {
    Atomics.store(analysisState.controlView, CONTROL_INDEX.sessionVersion, sessionVersion);
    Atomics.store(analysisState.controlView, CONTROL_INDEX.attached, 1);
  }
  if (isNewAudioSession) {
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
}
function buildWaveformPyramid(runtime) {
  assertInitialized();
  if (!runtime.module._wave_build_waveform_pyramid()) {
    throw new Error("Waveform pyramid build failed.");
  }
  self.postMessage({
    type: "waveformPyramidReady"
  });
}
function requestWaveformSlice(runtime, request) {
  assertInitialized();
  const viewStart = clamp(Number(request?.viewStart) || 0, 0, analysisState.duration);
  const viewEnd = clamp(Number(request?.viewEnd) || analysisState.duration, viewStart + 1 / analysisState.sampleRate, analysisState.duration);
  const requestedColumnCount = Math.max(1, Math.round(Number(request?.columnCount) || 1));
  const columnCount = analysisState.transportMode === "shared" ? Math.min(analysisState.waveformMaxColumns, requestedColumnCount) : requestedColumnCount;
  const slotId = Math.abs(Math.round(Number(request?.slotId) || 0)) % WAVEFORM_SLOT_COUNT;
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const sequence = analysisState.waveformRequestSequence + 1;
  analysisState.waveformRequestSequence = sequence;
  ensureWaveformOutputCapacity(runtime.module, columnCount * 2);
  const ok = runtime.module._wave_extract_waveform_slice(
    viewStart,
    viewEnd,
    columnCount,
    analysisState.waveformOutputPointer
  );
  if (!ok) {
    throw new Error("Waveform slice extraction failed.");
  }
  const output = getHeapF32View(runtime.module, analysisState.waveformOutputPointer, columnCount * 2);
  if (analysisState.transportMode === "shared") {
    const slotView = getWaveformSlotView(analysisState.waveformSab, analysisState.waveformMaxColumns, slotId);
    slotView.fill(0);
    slotView.set(output.subarray(0, columnCount * 2));
    markWaveformSlotReady(analysisState.controlView, slotId, sequence);
    self.postMessage({
      type: "waveformSliceReady",
      body: {
        columnCount,
        generation,
        sequence,
        slotId,
        transportMode: analysisState.transportMode,
        viewEnd,
        viewStart
      }
    });
    return;
  }
  const transferableSlice = new Float32Array(output.subarray(0, columnCount * 2));
  self.postMessage({
    type: "waveformSliceReady",
    body: {
      columnCount,
      generation,
      sliceBuffer: transferableSlice.buffer,
      transportMode: analysisState.transportMode,
      viewEnd,
      viewStart
    }
  }, [transferableSlice.buffer]);
}
function cancelGeneration(generation) {
  if (!Number.isFinite(generation)) {
    return;
  }
  analysisState.generationStatus.set(generation, { cancelled: true });
}
function isGenerationCancelled(generation) {
  return analysisState.generationStatus.get(generation)?.cancelled === true;
}
async function requestSpectrogramTiles(runtime, request) {
  assertInitialized();
  const plan = createRequestPlan(request);
  const existingGenerationStatus = analysisState.generationStatus.get(plan.generation);
  if (existingGenerationStatus?.cancelled) {
    postCancelled(plan);
    return;
  }
  analysisState.generationStatus.set(plan.generation, { cancelled: false });
  let completedTiles = 0;
  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    if (isGenerationCancelled(plan.generation)) {
      postCancelled(plan);
      return;
    }
    const cacheKey = buildTileCacheKey(plan, tileIndex);
    const tileStart = tileIndex * plan.tileDuration;
    const tileEnd = Math.min(analysisState.duration, tileStart + plan.tileDuration);
    const usingSharedTransport = analysisState.transportMode === "shared";
    const slotId = usingSharedTransport ? await acquireSpectrogramSlot() : null;
    const slotView = usingSharedTransport ? getSpectrogramSlotView(
      analysisState.spectrogramSab,
      analysisState.spectrogramMaxColumns,
      analysisState.spectrogramMaxRows,
      slotId,
      TILE_COLUMN_COUNT,
      plan.rowCount
    ) : null;
    let fromCache = true;
    const cached = analysisState.tileCache.get(cacheKey);
    let rgbaTransferBuffer = null;
    if (cached) {
      if (usingSharedTransport) {
        slotView.set(cached);
      } else {
        rgbaTransferBuffer = new Uint8ClampedArray(cached);
      }
    } else {
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
        if (usingSharedTransport) {
          releaseSpectrogramSlot(slotId);
        }
        throw new Error("Spectrogram tile render failed.");
      }
      const output = getHeapU8View(runtime.module, analysisState.spectrogramOutputPointer, TILE_COLUMN_COUNT * plan.rowCount * 4);
      const cachedTile = new Uint8ClampedArray(output);
      if (usingSharedTransport) {
        slotView.set(cachedTile);
      } else {
        rgbaTransferBuffer = new Uint8ClampedArray(cachedTile);
      }
      analysisState.tileCache.set(cacheKey, cachedTile);
      fromCache = false;
    }
    completedTiles += 1;
    if (usingSharedTransport) {
      const sequence = analysisState.spectrogramRequestSequence + 1;
      analysisState.spectrogramRequestSequence = sequence;
      markSpectrogramSlotReady(analysisState.controlView, slotId, sequence);
      self.postMessage({
        type: "spectrogramTile",
        body: {
          columnCount: TILE_COLUMN_COUNT,
          completedTiles,
          dprBucket: plan.dprBucket,
          fftSize: plan.fftSize,
          fromCache,
          generation: plan.generation,
          requestKind: plan.requestKind,
          rowCount: plan.rowCount,
          runtimeVariant: analysisState.runtimeVariant,
          sequence,
          slotId,
          tileEnd,
          tileIndex,
          tileKey: cacheKey,
          tileStart,
          totalTiles: plan.totalTiles,
          transportMode: analysisState.transportMode,
          zoomBucket: plan.zoomBucket,
          targetColumns: plan.targetColumns,
          targetRows: plan.rowCount
        }
      });
    } else {
      self.postMessage({
        type: "spectrogramTile",
        body: {
          columnCount: TILE_COLUMN_COUNT,
          completedTiles,
          dprBucket: plan.dprBucket,
          fftSize: plan.fftSize,
          fromCache,
          generation: plan.generation,
          requestKind: plan.requestKind,
          rowCount: plan.rowCount,
          rgbaBuffer: rgbaTransferBuffer.buffer,
          runtimeVariant: analysisState.runtimeVariant,
          tileEnd,
          tileIndex,
          tileKey: cacheKey,
          tileStart,
          totalTiles: plan.totalTiles,
          transportMode: analysisState.transportMode,
          zoomBucket: plan.zoomBucket,
          targetColumns: plan.targetColumns,
          targetRows: plan.rowCount
        }
      }, [rgbaTransferBuffer.buffer]);
    }
    await yieldToEventLoop();
  }
  if (isGenerationCancelled(plan.generation)) {
    postCancelled(plan);
    return;
  }
  self.postMessage({
    type: "spectrogramTilesComplete",
    body: {
      completedTiles,
      dprBucket: plan.dprBucket,
      fftSize: plan.fftSize,
      generation: plan.generation,
      requestKind: plan.requestKind,
      runtimeVariant: analysisState.runtimeVariant,
      targetColumns: plan.targetColumns,
      targetRows: plan.rowCount,
      totalTiles: plan.totalTiles,
      viewEnd: plan.viewEnd,
      viewStart: plan.viewStart,
      zoomBucket: plan.zoomBucket
    }
  });
}
function createRequestPlan(request) {
  const preset = QUALITY_PRESETS[analysisState.quality];
  const usingSharedTransport = analysisState.transportMode === "shared";
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
  const pixelWidth = Math.max(1, Math.round(Number(request?.pixelWidth) || 1));
  const pixelHeight = Math.max(1, Math.round(Number(request?.pixelHeight) || 1));
  const dprBucket = Math.max(2, Math.round(Number(request?.dpr) || 2));
  const spanSeconds = Math.max(1 / analysisState.sampleRate, viewEnd - viewStart);
  const spanSamples = spanSeconds * analysisState.sampleRate;
  const samplesPerPixel = spanSamples / Math.max(1, pixelWidth);
  const zoomSelection = selectZoomPolicy(preset, samplesPerPixel);
  const bucketedSamplesPerPixel = quantizeSamplesPerPixel(samplesPerPixel);
  const requestedRowCount = quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier), ROW_BUCKET_SIZE);
  const rowCount = usingSharedTransport ? Math.min(analysisState.spectrogramMaxRows, requestedRowCount) : requestedRowCount;
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    usingSharedTransport ? Math.min(
      analysisState.spectrogramMaxColumns,
      quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2)
    ) : quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2)
  );
  const secondsPerColumn = Math.max(
    1 / analysisState.sampleRate,
    bucketedSamplesPerPixel / preset.colsMultiplier / analysisState.sampleRate
  );
  const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / analysisState.sampleRate);
  const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
  const endTileIndex = Math.max(
    startTileIndex,
    Math.floor(Math.max(viewStart, viewEnd - secondsPerColumn * 0.5) / tileDuration)
  );
  const totalTiles = endTileIndex - startTileIndex + 1;
  return {
    decimationFactor: Math.max(1, preset.lowFrequencyDecimationFactor || 1),
    dprBucket,
    endTileIndex,
    fftSize: zoomSelection.fftSize,
    generation,
    pixelHeight,
    pixelWidth,
    requestKind,
    rowCount,
    secondsPerColumn,
    startTileIndex,
    targetColumns,
    tileDuration,
    totalTiles,
    viewEnd,
    viewStart,
    zoomBucket: `${zoomSelection.bucket}-spp${formatBucketNumber(bucketedSamplesPerPixel)}-rows${rowCount}`
  };
}
function selectZoomPolicy(preset, samplesPerPixel) {
  const [highZoomFft, mediumZoomFft, lowZoomFft] = preset.fftSizes;
  const highZoomThreshold = Math.max(32, highZoomFft / preset.colsMultiplier);
  const mediumZoomThreshold = Math.max(highZoomThreshold * 1.75, mediumZoomFft / preset.colsMultiplier);
  if (samplesPerPixel <= highZoomThreshold) {
    return {
      bucket: "high",
      fftSize: highZoomFft
    };
  }
  if (samplesPerPixel <= mediumZoomThreshold) {
    return {
      bucket: "medium",
      fftSize: mediumZoomFft
    };
  }
  return {
    bucket: "low",
    fftSize: lowZoomFft
  };
}
function buildTileCacheKey(plan, tileIndex) {
  return [
    analysisState.quality,
    plan.zoomBucket,
    `tile${tileIndex}`,
    `dpr${plan.dprBucket}`
  ].join(":");
}
function acquireSpectrogramSlot() {
  const freeIndex = analysisState.slotBusy.findIndex((entry) => entry === false);
  if (freeIndex >= 0) {
    analysisState.slotBusy[freeIndex] = true;
    return Promise.resolve(freeIndex);
  }
  return new Promise((resolve) => {
    analysisState.slotReleaseResolvers.push(resolve);
  });
}
function releaseSpectrogramSlot(slotId) {
  if (analysisState.transportMode !== "shared") {
    return;
  }
  if (!Number.isFinite(slotId)) {
    return;
  }
  const safeSlotId = Math.max(0, Math.min(SPECTROGRAM_SLOT_COUNT - 1, Math.round(slotId)));
  const waiter = analysisState.slotReleaseResolvers.shift();
  if (waiter) {
    analysisState.slotBusy[safeSlotId] = true;
    waiter(safeSlotId);
    return;
  }
  analysisState.slotBusy[safeSlotId] = false;
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
  if (analysisState.waveformOutputPointer) {
    module._free(analysisState.waveformOutputPointer);
  }
  if (analysisState.spectrogramOutputPointer) {
    module._free(analysisState.spectrogramOutputPointer);
  }
  module._wave_dispose_session();
  analysisState.waveformOutputPointer = 0;
  analysisState.waveformOutputCapacity = 0;
  analysisState.spectrogramOutputPointer = 0;
  analysisState.spectrogramOutputCapacity = 0;
}
function disposeSession(runtime) {
  if (analysisState.initialized) {
    disposeWasmSession(runtime.module);
  }
  analysisState = createEmptyAnalysisState();
}
function assertInitialized() {
  if (!analysisState.initialized) {
    throw new Error("Analysis is not initialized.");
  }
}
function yieldToEventLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
function postCancelled(plan) {
  self.postMessage({
    type: "spectrogramTilesCancelled",
    body: {
      generation: plan.generation,
      requestKind: plan.requestKind
    }
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
