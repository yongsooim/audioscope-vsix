import { loadWaveCoreRuntime } from './waveCoreRuntime.js';
import {
  TILE_COLUMN_COUNT,
  quantizeCeil,
} from './sharedBuffers.js';

const MIN_FREQUENCY = 20;
const MAX_FREQUENCY = 20000;
const ROW_BUCKET_SIZE = 32;

const QUALITY_PRESETS = {
  balanced: {
    rowsMultiplier: 1.5,
    colsMultiplier: 2.5,
    lowFrequencyDecimationFactor: 2,
  },
  high: {
    rowsMultiplier: 2.5,
    colsMultiplier: 4,
    lowFrequencyDecimationFactor: 4,
  },
  max: {
    rowsMultiplier: 4,
    colsMultiplier: 6,
    lowFrequencyDecimationFactor: 4,
  },
};

const FFT_SIZE_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const OVERLAP_RATIO_OPTIONS = [0.5, 0.75, 0.875];
const SCALOGRAM_COLUMN_CHUNK_SIZE = 32;
const SCALOGRAM_ROW_BLOCK_SIZE = 32;
const LOUDNESS_SUMMARY_OUTPUT_LENGTH = 4;
const ANALYSIS_TYPE_CODES = {
  spectrogram: 0,
  mel: 1,
  scalogram: 2,
};
const FREQUENCY_SCALE_CODES = {
  log: 0,
  linear: 1,
};
const SCALOGRAM_HOP_SAMPLES_BY_QUALITY = {
  balanced: 2048,
  high: 1024,
  max: 512,
};

let runtimePromise = null;
let requestQueue = Promise.resolve();
let overviewRenderLoopActive = false;
let visibleRenderLoopActive = false;
let pendingOverviewRequest = null;
let pendingVisibleRequest = null;

const surfaceState = {
  canvas: null,
  context: null,
  pixelWidth: 0,
  pixelHeight: 0,
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
      return;
    case 'resizeCanvas':
      resizeCanvas(message.body);
      return;
    case 'attachAudioSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        attachAudioSession(runtime, message.body);
      });
      return;
    case 'renderOverview':
      registerActiveConfigVersion(message.body?.configVersion);
      pendingOverviewRequest = message.body ?? null;
      void pumpOverviewLoop();
      return;
    case 'renderVisibleRange':
      registerActiveConfigVersion(message.body?.configVersion);
      if (message.body) {
        updateCurrentDisplayRange(message.body);
      }
      pendingVisibleRequest = message.body ?? null;
      paintSpectrogramDisplay();
      void pumpVisibleLoop();
      return;
    case 'cancelGeneration':
      cancelGeneration(message.body?.generation);
      return;
    case 'disposeSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        disposeSession(runtime);
        paintSpectrogramDisplay();
      });
      return;
    case 'dispose':
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
    generation: kind === 'overview' ? 0 : -1,
    ready: false,
    requestPending: false,
    plan: null,
  };
}

function createEmptyAnalysisState() {
  return {
    initialized: false,
    transportMode: 'shared',
    attachedSessionVersion: -1,
    sampleRate: 0,
    sampleCount: 0,
    duration: 0,
    quality: 'high',
    minFrequency: MIN_FREQUENCY,
    maxFrequency: MAX_FREQUENCY,
    runtimeVariant: null,
    activeConfigVersion: 0,
    generationStatus: new Map(),
    tileCache: new Map(),
    overview: createEmptyLayerState('overview'),
    visible: createEmptyLayerState('visible'),
    currentDisplayRange: {
      start: 0,
      end: 0,
      pixelWidth: 0,
      pixelHeight: 0,
    },
    spectrogramOutputPointer: 0,
    spectrogramOutputCapacity: 0,
  };
}

function enqueueRequest(task) {
  requestQueue = requestQueue
    .then(task)
    .catch((error) => {
      postError(error);
    });
}

function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = loadWaveCoreRuntime();
  }

  return runtimePromise;
}

function normalizeQualityPreset(value) {
  return value === 'balanced' || value === 'max' ? value : 'high';
}

function normalizeAnalysisType(value) {
  return value === 'mel' || value === 'scalogram' ? value : 'spectrogram';
}

function normalizeFrequencyScale(value) {
  return value === 'linear' ? 'linear' : 'log';
}

function getEffectiveFrequencyScale(analysisType, value) {
  return analysisType === 'spectrogram' ? normalizeFrequencyScale(value) : 'log';
}

function getScalogramHopSamples(quality) {
  return SCALOGRAM_HOP_SAMPLES_BY_QUALITY[quality] ?? SCALOGRAM_HOP_SAMPLES_BY_QUALITY.high;
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
  surfaceState.context = surfaceState.canvas.getContext('2d', { alpha: false });
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
  const transportMode = options?.transportMode === 'transfer' ? 'transfer' : 'shared';
  const sessionVersion = Number.isFinite(options?.sessionVersion) ? Number(options.sessionVersion) : 0;
  const sampleRate = Number(options?.sampleRate);
  const duration = Number(options?.duration);
  const sampleCount = Number(options?.sampleCount);
  const quality = normalizeQualityPreset(options?.quality);

  if (transportMode === 'shared' && !options?.pcmSab) {
    throw new Error('Shared PCM buffer is missing.');
  }

  if (transportMode === 'transfer' && !options?.samplesBuffer) {
    throw new Error('Transferable PCM buffer is missing.');
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    throw new Error('Audio session metadata is invalid.');
  }

  const isNewAudioSession = sessionVersion !== analysisState.attachedSessionVersion;

  if (isNewAudioSession) {
    disposeWasmSession(module);

    if (!module._wave_prepare_session(sampleCount, sampleRate, duration)) {
      throw new Error('Failed to allocate spectrogram session.');
    }

    const pcmPointer = module._wave_get_pcm_ptr();

    if (!pcmPointer) {
      throw new Error('Wasm PCM allocation failed.');
    }

    const pcmSource = transportMode === 'shared'
      ? new Float32Array(options.pcmSab)
      : new Float32Array(options.samplesBuffer);
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
    analysisState.overview = createEmptyLayerState('overview');
    analysisState.visible = createEmptyLayerState('visible');
  }

  self.postMessage({
    type: 'analysisInitialized',
    body: {
      duration,
      maxFrequency: analysisState.maxFrequency,
      minFrequency: analysisState.minFrequency,
      quality,
      runtimeVariant: runtime.variant,
      sampleCount,
      sampleRate,
    },
  });

  try {
    const loudnessSummary = computeLoudnessSummary(runtime);
    self.postMessage({
      type: 'loudnessSummaryReady',
      body: {
        ...loudnessSummary,
        channelMode: 'mono-downmix',
        source: 'libebur128',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: 'loudnessSummaryError',
      body: { message },
    });
  }
}

function updateCurrentDisplayRange(request) {
  const start = clamp(Number(request?.displayStart) || 0, 0, analysisState.duration);
  const end = clamp(
    Number(request?.displayEnd) || analysisState.duration,
    start + (analysisState.sampleRate > 0 ? (1 / analysisState.sampleRate) : 1e-6),
    analysisState.duration || start + 1e-6,
  );

  analysisState.currentDisplayRange = {
    start,
    end,
    pixelWidth: Math.max(1, Math.round(Number(request?.pixelWidth) || surfaceState.pixelWidth || 1)),
    pixelHeight: Math.max(1, Math.round(Number(request?.pixelHeight) || surfaceState.pixelHeight || 1)),
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

function normalizeConfigVersion(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

function getRequestConfigVersion(request) {
  return normalizeConfigVersion(request?.configVersion);
}

function registerActiveConfigVersion(value) {
  const nextConfigVersion = normalizeConfigVersion(value);

  if (nextConfigVersion === analysisState.activeConfigVersion) {
    return;
  }

  analysisState.activeConfigVersion = nextConfigVersion;
  analysisState.generationStatus.clear();
  analysisState.overview = createEmptyLayerState('overview');
  analysisState.visible = createEmptyLayerState('visible');
  pendingOverviewRequest = null;
  pendingVisibleRequest = null;
  paintSpectrogramDisplay();
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
        requestKind: 'overview',
        viewEnd: analysisState.duration,
        viewStart: 0,
      });

      analysisState.overview = {
        generation: 0,
        kind: 'overview',
        plan,
        ready: false,
        requestPending: true,
      };

      const completed = await ensurePlanTiles(runtime, plan, {
        shouldAbort: () => shouldAbortOverviewPlan(plan),
      });

      if (!completed || shouldAbortOverviewPlan(plan)) {
        continue;
      }

      analysisState.overview = {
        generation: 0,
        kind: 'overview',
        plan,
        ready: true,
        requestPending: false,
      };

      paintSpectrogramDisplay();

      self.postMessage({
        type: 'overviewReady',
        body: createLayerReadyBody(plan),
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
        requestKind: 'visible',
        viewEnd: request.requestEnd,
        viewStart: request.requestStart,
      });

      if (isEquivalentPlan(plan, analysisState.visible.plan) && analysisState.visible.ready) {
        analysisState.visible.generation = plan.generation;
        paintSpectrogramDisplay();
        continue;
      }

      analysisState.generationStatus.set(plan.generation, { cancelled: false });
      analysisState.visible = {
        generation: plan.generation,
        kind: 'visible',
        plan,
        ready: false,
        requestPending: true,
      };

      const completed = await ensurePlanTiles(runtimePromise ? await runtimePromise : await getRuntime(), plan, {
        onTileReady: () => {
          if (analysisState.visible.generation === plan.generation) {
            paintSpectrogramDisplay();
          }
        },
        shouldAbort: () => shouldAbortVisiblePlan(plan),
      });

      if (!completed || shouldAbortVisiblePlan(plan)) {
        continue;
      }

      analysisState.visible = {
        generation: plan.generation,
        kind: 'visible',
        plan,
        ready: true,
        requestPending: false,
      };

      paintSpectrogramDisplay();

      self.postMessage({
        type: 'visibleReady',
        body: createLayerReadyBody(plan),
      });
    }
  } catch (error) {
    postError(error);
  } finally {
    visibleRenderLoopActive = false;
  }
}

function shouldAbortVisiblePlan(plan) {
  if (plan.configVersion !== analysisState.activeConfigVersion) {
    return true;
  }

  if (isGenerationCancelled(plan.generation)) {
    return true;
  }

  return Boolean(
    pendingVisibleRequest
    && (
      getRequestConfigVersion(pendingVisibleRequest) !== plan.configVersion
      || (
        Number.isFinite(pendingVisibleRequest.generation)
        && Number(pendingVisibleRequest.generation) !== plan.generation
      )
    )
  );
}

function shouldAbortOverviewPlan(plan) {
  if (plan.configVersion !== analysisState.activeConfigVersion) {
    return true;
  }

  return Boolean(
    pendingOverviewRequest
    && getRequestConfigVersion(pendingOverviewRequest) !== plan.configVersion
  );
}

async function ensurePlanTiles(runtime, plan, options = {}) {
  const onTileReady = typeof options.onTileReady === 'function' ? options.onTileReady : null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;

  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    if (shouldAbort?.()) {
      return false;
    }

    const cacheKey = buildTileCacheKey(plan, tileIndex);
    const tileStart = tileIndex * plan.tileDuration;
    const tileEnd = Math.min(analysisState.duration, tileStart + plan.tileDuration);
    const existingTile = analysisState.tileCache.get(cacheKey) ?? null;

    if (!existingTile || existingTile.complete !== true) {
      const tileRecord = await renderTile(runtime, plan, tileIndex, tileStart, tileEnd, {
        cacheKey,
        existingTile,
        onChunkReady: onTileReady,
        shouldAbort,
      });

      if (!tileRecord) {
        return false;
      }
    }

    onTileReady?.();
    await yieldToEventLoop();
  }

  return true;
}

function createTileRecord({ cacheKey, rowCount, tileEnd, tileIndex, tileStart }) {
  const canvas = new OffscreenCanvas(TILE_COLUMN_COUNT, rowCount);
  const context = canvas.getContext('2d', { alpha: false });

  if (!context) {
    throw new Error('OffscreenCanvas 2D context is unavailable.');
  }

  const imageData = context.createImageData(TILE_COLUMN_COUNT, rowCount);

  return {
    canvas,
    columnCount: TILE_COLUMN_COUNT,
    complete: false,
    context,
    imageData,
    renderedColumns: 0,
    rowCount,
    tileEnd,
    tileIndex,
    tileKey: cacheKey,
    tileStart,
  };
}

function drawTileChunk(tileRecord, rgba, columnOffset, columnCount, rowCount) {
  const destination = tileRecord.imageData.data;

  if (columnOffset === 0 && columnCount === tileRecord.columnCount) {
    destination.set(rgba);
  } else {
    const sourceRowLength = columnCount * 4;
    const destinationRowLength = tileRecord.columnCount * 4;
    const destinationOffset = columnOffset * 4;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const sourceStart = rowIndex * sourceRowLength;
      const sourceEnd = sourceStart + sourceRowLength;
      const destinationStart = rowIndex * destinationRowLength + destinationOffset;
      destination.set(rgba.subarray(sourceStart, sourceEnd), destinationStart);
    }
  }

  tileRecord.context.putImageData(tileRecord.imageData, 0, 0, columnOffset, 0, columnCount, rowCount);
}

function renderTileChunk(runtime, plan, tileIndex, tileStart, tileEnd, tileRecord, startColumn, columnCount) {
  const tileSpan = tileEnd - tileStart;
  const chunkStart = tileStart + ((startColumn / TILE_COLUMN_COUNT) * tileSpan);
  const chunkEnd = tileStart + (((startColumn + columnCount) / TILE_COLUMN_COUNT) * tileSpan);
  const byteLength = columnCount * plan.rowCount * 4;

  ensureSpectrogramOutputCapacity(runtime.module, byteLength);

  const ok = runtime.module._wave_render_spectrogram_tile_rgba(
    chunkStart,
    chunkEnd,
    columnCount,
    plan.rowCount,
    plan.fftSize,
    plan.decimationFactor,
    analysisState.minFrequency,
    analysisState.maxFrequency,
    ANALYSIS_TYPE_CODES[plan.analysisType] ?? ANALYSIS_TYPE_CODES.spectrogram,
    FREQUENCY_SCALE_CODES[plan.frequencyScale] ?? FREQUENCY_SCALE_CODES.log,
    analysisState.spectrogramOutputPointer,
  );

  if (!ok) {
    throw new Error(`Spectrogram tile render failed for tile ${tileIndex} chunk ${startColumn}.`);
  }

  const rgba = getHeapU8View(runtime.module, analysisState.spectrogramOutputPointer, byteLength);
  drawTileChunk(tileRecord, rgba, startColumn, columnCount, plan.rowCount);
}

async function renderTile(runtime, plan, tileIndex, tileStart, tileEnd, options = {}) {
  const cacheKey = typeof options.cacheKey === 'string' ? options.cacheKey : buildTileCacheKey(plan, tileIndex);
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const onChunkReady = typeof options.onChunkReady === 'function' ? options.onChunkReady : null;
  const chunkColumnCount = plan.analysisType === 'scalogram' ? SCALOGRAM_COLUMN_CHUNK_SIZE : TILE_COLUMN_COUNT;
  const existingTile = options.existingTile;
  const tileRecord = existingTile ?? createTileRecord({
    cacheKey,
    rowCount: plan.rowCount,
    tileEnd,
    tileIndex,
    tileStart,
  });

  if (!tileRecord.context) {
    tileRecord.context = tileRecord.canvas.getContext('2d', { alpha: false });
    if (!tileRecord.context) {
      throw new Error('OffscreenCanvas 2D context is unavailable.');
    }
    tileRecord.imageData = tileRecord.context.createImageData(tileRecord.columnCount, tileRecord.rowCount);
  }

  analysisState.tileCache.set(cacheKey, tileRecord);

  while (tileRecord.renderedColumns < TILE_COLUMN_COUNT) {
    if (shouldAbort?.()) {
      return null;
    }

    const startColumn = tileRecord.renderedColumns;
    const columnCount = Math.min(chunkColumnCount, TILE_COLUMN_COUNT - startColumn);
    renderTileChunk(runtime, plan, tileIndex, tileStart, tileEnd, tileRecord, startColumn, columnCount);
    tileRecord.renderedColumns += columnCount;
    tileRecord.complete = tileRecord.renderedColumns >= TILE_COLUMN_COUNT;
    onChunkReady?.();

    if (chunkColumnCount < TILE_COLUMN_COUNT) {
      await yieldToEventLoop();
    }
  }

  return tileRecord;
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
      smoothingQuality: 'high',
    });
  }

  if (analysisState.visible.plan) {
    paintLayer(context, analysisState.visible.plan, displayRange, {
      smoothing: false,
      smoothingQuality: 'low',
    });
  }
}

function drawBackground(context, width, height) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, '#171127');
  background.addColorStop(0.46, '#0d0b19');
  background.addColorStop(1, '#04050c');

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
    const availableColumns = tile.complete ? tile.columnCount : Math.max(0, tile.renderedColumns ?? 0);
    if (availableColumns <= 0) {
      continue;
    }
    const availableTileEnd = tile.tileStart + ((availableColumns / tile.columnCount) * tileSpan);
    const overlapEnd = Math.min(displayRange.end, availableTileEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const sourceStartRatio = (overlapStart - tile.tileStart) / tileSpan;
    const sourceEndRatio = (overlapEnd - tile.tileStart) / tileSpan;
    const destinationStartRatio = (overlapStart - displayRange.start) / span;
    const destinationEndRatio = (overlapEnd - displayRange.start) / span;
    const sourceX = clamp(Math.floor(sourceStartRatio * tile.columnCount), 0, Math.max(0, tile.columnCount - 1));
    if (sourceX >= availableColumns) {
      continue;
    }
    const sourceWidth = Math.max(
      1,
      Math.min(
        availableColumns - sourceX,
        Math.ceil((sourceEndRatio - sourceStartRatio) * tile.columnCount),
      ),
    );
    const destinationX = Math.floor(destinationStartRatio * destinationWidth);
    const destinationWidthPx = Math.max(
      1,
      Math.ceil((destinationEndRatio - destinationStartRatio) * destinationWidth),
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
      destinationHeight,
    );
  }
}

function createRequestPlan(request) {
  const preset = QUALITY_PRESETS[analysisState.quality];
  const requestKind = request?.requestKind === 'overview' ? 'overview' : 'visible';
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const configVersion = getRequestConfigVersion(request);
  const requestedStart = Number.isFinite(request?.viewStart) ? Number(request.viewStart) : 0;
  const requestedEnd = Number.isFinite(request?.viewEnd) ? Number(request.viewEnd) : analysisState.duration;
  const viewStart = clamp(requestedStart, 0, analysisState.duration);
  const viewEnd = clamp(
    Math.max(viewStart + (1 / analysisState.sampleRate), requestedEnd),
    viewStart + (1 / analysisState.sampleRate),
    analysisState.duration,
  );
  const requestedDisplayStart = Number.isFinite(request?.displayStart) ? Number(request.displayStart) : viewStart;
  const displayStart = clamp(requestedDisplayStart, 0, analysisState.duration);
  const requestedDisplayEnd = Number.isFinite(request?.displayEnd) ? Number(request.displayEnd) : viewEnd;
  const displayEnd = clamp(
    Math.max(displayStart + (1 / analysisState.sampleRate), requestedDisplayEnd),
    displayStart + (1 / analysisState.sampleRate),
    analysisState.duration,
  );
  const pixelWidth = Math.max(1, Math.round(Number(request?.pixelWidth) || surfaceState.pixelWidth || 1));
  const pixelHeight = Math.max(1, Math.round(Number(request?.pixelHeight) || surfaceState.pixelHeight || 1));
  const dprBucket = Math.max(2, Math.round(Number(request?.dpr) || 2));
  const analysisType = normalizeAnalysisType(request?.analysisType);
  const frequencyScale = getEffectiveFrequencyScale(analysisType, request?.frequencyScale);
  const fftSize = analysisType === 'scalogram' ? 0 : normalizeFftSize(request?.fftSize);
  const overlapRatio = analysisType === 'scalogram' ? 0 : normalizeOverlapRatio(request?.overlapRatio);
  const rowBucketSize = analysisType === 'scalogram' ? SCALOGRAM_ROW_BLOCK_SIZE : ROW_BUCKET_SIZE;
  const rowCount = quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier), rowBucketSize);
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2),
  );
  const hopSamples = analysisType === 'scalogram'
    ? getScalogramHopSamples(analysisState.quality)
    : Math.max(1, Math.round(fftSize * (1 - overlapRatio)));
  const secondsPerColumn = hopSamples / analysisState.sampleRate;
  const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / analysisState.sampleRate);
  const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
  const endTileIndex = Math.max(
    startTileIndex,
    Math.floor(Math.max(viewStart, viewEnd - (secondsPerColumn * 0.5)) / tileDuration),
  );
  const windowSeconds = analysisType === 'scalogram' ? 0 : fftSize / analysisState.sampleRate;
  const decimationFactor = analysisType === 'spectrogram'
    ? Math.max(1, preset.lowFrequencyDecimationFactor || 1)
    : 1;
  const configKey = [
    `type${analysisType}`,
    `scale${frequencyScale}`,
    `fft${fftSize}`,
    `ov${Math.round(overlapRatio * 1000)}`,
    `hop${hopSamples}`,
    `rows${rowCount}`,
  ].join('-');

  return {
    analysisType,
    decimationFactor,
    configKey,
    configVersion,
    displayEnd,
    displayStart,
    dprBucket,
    endTileIndex,
    fftSize,
    frequencyScale,
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
    windowSeconds,
  };
}

function buildTileCacheKey(plan, tileIndex) {
  return [
    analysisState.quality,
    plan.configKey,
    `tile${tileIndex}`,
    `dpr${plan.dprBucket}`,
  ].join(':');
}

function createLayerReadyBody(plan) {
  return {
    analysisType: plan.analysisType,
    configVersion: plan.configVersion,
    decimationFactor: plan.decimationFactor,
    displayEnd: plan.displayEnd,
    displayStart: plan.displayStart,
    fftSize: plan.fftSize,
    frequencyScale: plan.frequencyScale,
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
    windowSeconds: plan.windowSeconds,
  };
}

function isEquivalentPlan(left, right) {
  if (!left || !right) {
    return false;
  }

  return left.requestKind === right.requestKind
    && left.configVersion === right.configVersion
    && left.analysisType === right.analysisType
    && left.dprBucket === right.dprBucket
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && left.rowCount === right.rowCount
    && left.targetColumns === right.targetColumns
    && left.fftSize === right.fftSize
    && left.frequencyScale === right.frequencyScale
    && Math.abs(left.overlapRatio - right.overlapRatio) <= 1e-6
    && Math.abs(left.viewStart - right.viewStart) <= 1e-6
    && Math.abs(left.viewEnd - right.viewEnd) <= 1e-6;
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

function computeLoudnessSummary(runtime) {
  const module = runtime.module;
  const byteLength = LOUDNESS_SUMMARY_OUTPUT_LENGTH * Float32Array.BYTES_PER_ELEMENT;
  const outputPointer = module._malloc(byteLength);

  if (!outputPointer) {
    throw new Error('Failed to allocate loudness summary buffer.');
  }

  try {
    if (!module._wave_measure_loudness_summary(outputPointer)) {
      throw new Error('Failed to measure loudness summary.');
    }

    const output = getHeapF32View(module, outputPointer, LOUDNESS_SUMMARY_OUTPUT_LENGTH);

    return {
      integratedLufs: output[0],
      loudnessRangeLu: output[1],
      samplePeakDbfs: output[2],
      truePeakDbtp: output[3],
    };
  } finally {
    module._free(outputPointer);
  }
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
    type: 'error',
    body: { message: text },
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
