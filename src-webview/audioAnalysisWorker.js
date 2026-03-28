import PFFFTNonSimd from '../node_modules/@echogarden/pffft-wasm/dist/non-simd/pffft.js';
import wasmBinaryNonSimd from '../node_modules/@echogarden/pffft-wasm/dist/non-simd/pffft.wasm';
import PFFFTSimd from '../node_modules/@echogarden/pffft-wasm/dist/simd/pffft.js';
import wasmBinarySimd from '../node_modules/@echogarden/pffft-wasm/dist/simd/pffft.wasm';

const FORWARD_DIRECTION = 0;
const REAL_TRANSFORM = 0;
const MIN_FREQUENCY = 20;
const MAX_FREQUENCY = 20000;
const MIN_DB = -92;
const MAX_DB = -12;
const TILE_COLUMN_COUNT = 256;
const ROW_BUCKET_SIZE = 32;
const LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY = 1200;

const QUALITY_PRESETS = {
  balanced: {
    rowsMultiplier: 1.5,
    colsMultiplier: 2.5,
    fftSizes: [2048, 4096, 8192],
    lowFrequencyDecimationFactor: 2,
  },
  high: {
    rowsMultiplier: 2.5,
    colsMultiplier: 4,
    fftSizes: [4096, 8192, 16384],
    lowFrequencyDecimationFactor: 4,
  },
  max: {
    rowsMultiplier: 4,
    colsMultiplier: 6,
    fftSizes: [8192, 16384, 16384],
    lowFrequencyDecimationFactor: 4,
  },
};

let pffftRuntimePromise = null;
let requestQueue = Promise.resolve();
let analysisState = createEmptyAnalysisState();

self.onmessage = (event) => {
  const message = event.data;

  switch (message?.type) {
    case 'initAnalysis':
      enqueueRequest(async () => {
        const runtime = await getPffftRuntime();
        initAnalysis(runtime, message.body);
      });
      return;
    case 'requestSpectrogramTiles':
      enqueueRequest(async () => {
        const runtime = await getPffftRuntime();
        await requestSpectrogramTiles(runtime, message.body);
      });
      return;
    case 'cancelGeneration':
      cancelGeneration(message.body?.generation);
      return;
    default:
      return;
  }
};

function createEmptyAnalysisState() {
  return {
    initialized: false,
    samples: null,
    sampleRate: 0,
    duration: 0,
    quality: 'high',
    minFrequency: MIN_FREQUENCY,
    maxFrequency: MAX_FREQUENCY,
    runtimeVariant: null,
    tileCache: new Map(),
    generationStatus: new Map(),
    fftResources: new Map(),
    bandRangeCache: new Map(),
  };
}

function enqueueRequest(task) {
  requestQueue = requestQueue
    .then(task)
    .catch((error) => {
      postError(error);
    });
}

async function getPffftRuntime() {
  if (!pffftRuntimePromise) {
    pffftRuntimePromise = loadPffftRuntime();
  }

  return pffftRuntimePromise;
}

async function loadPffftRuntime() {
  const failures = [];

  for (const loader of [loadSimdRuntime, loadNonSimdRuntime]) {
    try {
      return await loader();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`Unable to initialize PFFFT runtime: ${failures.join(' | ')}`);
}

async function loadSimdRuntime() {
  const module = await PFFFTSimd({
    wasmBinary: wasmBinarySimd,
    locateFile: () => 'pffft-simd.wasm',
  });

  return {
    module,
    variant: 'simd128',
  };
}

async function loadNonSimdRuntime() {
  const module = await PFFFTNonSimd({
    wasmBinary: wasmBinaryNonSimd,
    locateFile: () => 'pffft.wasm',
  });

  return {
    module,
    variant: 'non-simd',
  };
}

function initAnalysis(runtime, options) {
  const samples = new Float32Array(options.samplesBuffer);
  const sampleRate = Number(options.sampleRate);
  const duration = Number(options.duration);
  const quality = normalizeQualityPreset(options.quality);

  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Audio data is empty.');
  }

  disposeFftResources(runtime.module);

  analysisState = {
    initialized: true,
    samples,
    sampleRate,
    duration,
    quality,
    minFrequency: MIN_FREQUENCY,
    maxFrequency: Math.min(MAX_FREQUENCY, sampleRate / 2),
    runtimeVariant: runtime.variant,
    tileCache: new Map(),
    generationStatus: new Map(),
    fftResources: new Map(),
    bandRangeCache: new Map(),
  };

  self.postMessage({
    type: 'analysisInitialized',
    body: {
      duration,
      maxFrequency: analysisState.maxFrequency,
      minFrequency: analysisState.minFrequency,
      quality,
      runtimeVariant: runtime.variant,
      sampleCount: samples.length,
      sampleRate,
    },
  });
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
  if (!analysisState.initialized || !analysisState.samples) {
    throw new Error('Analysis is not initialized.');
  }

  const plan = createRequestPlan(request);
  const existingGenerationStatus = analysisState.generationStatus.get(plan.generation);

  if (existingGenerationStatus?.cancelled) {
    postCancelled(plan);
    return;
  }

  analysisState.generationStatus.set(plan.generation, { cancelled: false });

  if (isGenerationCancelled(plan.generation)) {
    postCancelled(plan);
    return;
  }

  let completedTiles = 0;

  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    if (isGenerationCancelled(plan.generation)) {
      postCancelled(plan);
      return;
    }

    const cacheKey = buildTileCacheKey(plan, tileIndex);
    let tile = analysisState.tileCache.get(cacheKey);
    let fromCache = true;

    if (!tile) {
      tile = analyzeTile(runtime.module, plan, tileIndex, cacheKey);
      analysisState.tileCache.set(cacheKey, tile);
      fromCache = false;
    }

    completedTiles += 1;

    const tileCopy = tile.buffer.slice();

    self.postMessage(
      {
        type: 'spectrogramTile',
        body: {
          columnCount: tile.columnCount,
          completedTiles,
          dprBucket: plan.dprBucket,
          fftSize: plan.fftSize,
          fromCache,
          generation: plan.generation,
          requestKind: plan.requestKind,
          rowCount: tile.rowCount,
          runtimeVariant: analysisState.runtimeVariant,
          tileEnd: tile.tileEnd,
          tileIndex,
          tileKey: cacheKey,
          tileStart: tile.tileStart,
          totalTiles: plan.totalTiles,
          zoomBucket: plan.zoomBucket,
          targetColumns: plan.targetColumns,
          targetRows: plan.rowCount,
          spectrogramBuffer: tileCopy.buffer,
        },
      },
      [tileCopy.buffer],
    );

    await yieldToEventLoop();
  }

  if (isGenerationCancelled(plan.generation)) {
    postCancelled(plan);
    return;
  }

  self.postMessage({
    type: 'spectrogramTilesComplete',
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
      zoomBucket: plan.zoomBucket,
    },
  });
}

function createRequestPlan(request) {
  const preset = QUALITY_PRESETS[analysisState.quality];
  const requestKind = request?.requestKind === 'overview' ? 'overview' : 'visible';
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const requestedStart = Number.isFinite(request?.viewStart) ? Number(request.viewStart) : 0;
  const requestedEnd = Number.isFinite(request?.viewEnd) ? Number(request.viewEnd) : analysisState.duration;
  const viewStart = clamp(requestedStart, 0, analysisState.duration);
  const viewEnd = clamp(Math.max(viewStart + (1 / analysisState.sampleRate), requestedEnd), viewStart + (1 / analysisState.sampleRate), analysisState.duration);
  const pixelWidth = Math.max(1, Math.round(Number(request?.pixelWidth) || 1));
  const pixelHeight = Math.max(1, Math.round(Number(request?.pixelHeight) || 1));
  const dprBucket = Math.max(2, Math.round(Number(request?.dpr) || 2));
  const spanSeconds = Math.max(1 / analysisState.sampleRate, viewEnd - viewStart);
  const spanSamples = spanSeconds * analysisState.sampleRate;
  const samplesPerPixel = spanSamples / Math.max(1, pixelWidth);
  const zoomSelection = selectZoomPolicy(preset, samplesPerPixel);
  const bucketedSamplesPerPixel = quantizeSamplesPerPixel(samplesPerPixel);
  const rowCount = quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier), ROW_BUCKET_SIZE);
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2),
  );
  const secondsPerColumn = Math.max(
    1 / analysisState.sampleRate,
    (bucketedSamplesPerPixel / preset.colsMultiplier) / analysisState.sampleRate,
  );
  const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / analysisState.sampleRate);
  const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
  const endTileIndex = Math.max(
    startTileIndex,
    Math.floor(Math.max(viewStart, viewEnd - (secondsPerColumn * 0.5)) / tileDuration),
  );
  const totalTiles = endTileIndex - startTileIndex + 1;

  return {
    bucketedSamplesPerPixel,
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
    zoomBucket: `${zoomSelection.bucket}-spp${formatBucketNumber(bucketedSamplesPerPixel)}-rows${rowCount}`,
  };
}

function selectZoomPolicy(preset, samplesPerPixel) {
  const [highZoomFft, mediumZoomFft, lowZoomFft] = preset.fftSizes;
  const highZoomThreshold = Math.max(32, highZoomFft / preset.colsMultiplier);
  const mediumZoomThreshold = Math.max(highZoomThreshold * 1.75, mediumZoomFft / preset.colsMultiplier);

  if (samplesPerPixel <= highZoomThreshold) {
    return {
      bucket: 'high',
      fftSize: highZoomFft,
    };
  }

  if (samplesPerPixel <= mediumZoomThreshold) {
    return {
      bucket: 'medium',
      fftSize: mediumZoomFft,
    };
  }

  return {
    bucket: 'low',
    fftSize: lowZoomFft,
  };
}

function analyzeTile(module, plan, tileIndex, cacheKey) {
  const fftResource = getFftResource(module, plan.fftSize);
  const bandRanges = getBandRanges(plan.fftSize, plan.rowCount);
  const tileStart = tileIndex * plan.tileDuration;
  const tileEnd = Math.min(analysisState.duration, tileStart + plan.tileDuration);
  const tileBuffer = new Float32Array(TILE_COLUMN_COUNT * plan.rowCount);
  const powerSpectrum = new Float32Array(Math.max(2, Math.floor(plan.fftSize / 2) + 1));
  const lowFrequencyEnhancement = createLowFrequencyEnhancement(plan, bandRanges);
  const safeTileSpan = Math.max(1 / analysisState.sampleRate, tileEnd - tileStart);

  for (let columnIndex = 0; columnIndex < TILE_COLUMN_COUNT; columnIndex += 1) {
    const centerRatio = TILE_COLUMN_COUNT === 1 ? 0.5 : (columnIndex + 0.5) / TILE_COLUMN_COUNT;
    const centerTime = tileStart + (centerRatio * safeTileSpan);
    const centerSample = Math.round(centerTime * analysisState.sampleRate);
    const windowStart = centerSample - Math.floor(plan.fftSize / 2);

    for (let offset = 0; offset < plan.fftSize; offset += 1) {
      const sourceIndex = windowStart + offset;
      const sample = sourceIndex >= 0 && sourceIndex < analysisState.samples.length
        ? analysisState.samples[sourceIndex]
        : 0;
      fftResource.inputView[offset] = sample * fftResource.window[offset];
    }

    module._pffft_transform_ordered(
      fftResource.setup,
      fftResource.inputPointer,
      fftResource.outputPointer,
      fftResource.workPointer,
      FORWARD_DIRECTION,
    );
    writePowerSpectrum({
      fftSize: plan.fftSize,
      outputView: fftResource.outputView,
      powerSpectrum,
    });

    if (lowFrequencyEnhancement) {
      writeDecimatedFftInput({
        centerSample,
        decimationFactor: lowFrequencyEnhancement.decimationFactor,
        fftResource,
        fftSize: plan.fftSize,
      });
      module._pffft_transform_ordered(
        fftResource.setup,
        fftResource.inputPointer,
        fftResource.outputPointer,
        fftResource.workPointer,
        FORWARD_DIRECTION,
      );
      writePowerSpectrum({
        fftSize: plan.fftSize,
        outputView: fftResource.outputView,
        powerSpectrum: lowFrequencyEnhancement.powerSpectrum,
      });
    }

    writeSpectrogramColumn({
      bandRanges,
      columnOffset: columnIndex,
      lowFrequencyEnhancement,
      powerSpectrum,
      rowCount: plan.rowCount,
      target: tileBuffer,
    });
  }

  return {
    buffer: tileBuffer,
    columnCount: TILE_COLUMN_COUNT,
    rowCount: plan.rowCount,
    tileEnd,
    tileStart,
    key: cacheKey,
  };
}

function createLowFrequencyEnhancement(plan, bandRanges) {
  const preset = QUALITY_PRESETS[analysisState.quality];
  const decimationFactor = Math.max(1, preset.lowFrequencyDecimationFactor || 1);

  if (decimationFactor <= 1) {
    return null;
  }

  const effectiveSampleRate = analysisState.sampleRate / decimationFactor;
  const maximumFrequency = Math.min(
    LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY,
    (effectiveSampleRate / 2) * 0.92,
    analysisState.maxFrequency,
  );

  if (maximumFrequency <= analysisState.minFrequency * 1.25) {
    return null;
  }

  const enhancedBandRanges = createBandRangesForSampleRate({
    fftSize: plan.fftSize,
    maxFrequency: maximumFrequency,
    minFrequency: analysisState.minFrequency,
    rowCount: plan.rowCount,
    sampleRate: effectiveSampleRate,
    template: bandRanges,
  });

  return {
    decimationFactor,
    enhancedBandRanges,
    maxFrequency: maximumFrequency,
    powerSpectrum: new Float32Array(Math.max(2, Math.floor(plan.fftSize / 2) + 1)),
  };
}

function getFftResource(module, fftSize) {
  const existing = analysisState.fftResources.get(fftSize);

  if (existing) {
    return existing;
  }

  const setup = module._pffft_new_setup(fftSize, REAL_TRANSFORM);

  if (!setup) {
    throw new Error(`PFFFT could not initialize for FFT size ${fftSize}.`);
  }

  const inputPointer = module._pffft_aligned_malloc(fftSize * Float32Array.BYTES_PER_ELEMENT);
  const outputPointer = module._pffft_aligned_malloc(fftSize * Float32Array.BYTES_PER_ELEMENT);
  const workPointer = module._pffft_aligned_malloc(fftSize * Float32Array.BYTES_PER_ELEMENT);

  if (!inputPointer || !outputPointer || !workPointer) {
    throw new Error('PFFFT could not allocate aligned working buffers.');
  }

  const resource = {
    fftSize,
    inputPointer,
    inputView: new Float32Array(module.HEAPF32.buffer, inputPointer, fftSize),
    outputPointer,
    outputView: new Float32Array(module.HEAPF32.buffer, outputPointer, fftSize),
    setup,
    window: createHannWindow(fftSize),
    workPointer,
  };

  analysisState.fftResources.set(fftSize, resource);
  return resource;
}

function getBandRanges(fftSize, rowCount) {
  const cacheKey = `${fftSize}:${analysisState.sampleRate}:${rowCount}:${analysisState.maxFrequency}`;
  const existing = analysisState.bandRangeCache.get(cacheKey);

  if (existing) {
    return existing;
  }

  const bandRanges = createLogBandRanges({
    fftSize,
    maxFrequency: analysisState.maxFrequency,
    minFrequency: analysisState.minFrequency,
    rows: rowCount,
    sampleRate: analysisState.sampleRate,
  });

  analysisState.bandRangeCache.set(cacheKey, bandRanges);
  return bandRanges;
}

function disposeFftResources(module) {
  for (const resource of analysisState.fftResources.values()) {
    module._pffft_destroy_setup(resource.setup);
    module._pffft_aligned_free(resource.inputPointer);
    module._pffft_aligned_free(resource.outputPointer);
    module._pffft_aligned_free(resource.workPointer);
  }
}

function createHannWindow(size) {
  const window = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
  }

  return window;
}

function createLogBandRanges({ fftSize, maxFrequency, minFrequency, rows, sampleRate }) {
  const bandRanges = [];
  const nyquist = sampleRate / 2;
  const maximumBin = Math.max(2, Math.floor(fftSize / 2));
  const safeMinFrequency = Math.max(1, minFrequency);
  const safeMaxFrequency = Math.max(safeMinFrequency * 1.01, maxFrequency);

  for (let row = 0; row < rows; row += 1) {
    const startRatio = row / rows;
    const endRatio = (row + 1) / rows;
    const startFrequency = safeMinFrequency * (safeMaxFrequency / safeMinFrequency) ** startRatio;
    const endFrequency = safeMinFrequency * (safeMaxFrequency / safeMinFrequency) ** endRatio;
    const startBin = clamp(Math.floor((startFrequency / nyquist) * maximumBin), 1, maximumBin - 1);
    const endBin = clamp(Math.ceil((endFrequency / nyquist) * maximumBin), startBin + 1, maximumBin);

    bandRanges.push({
      endBin,
      endFrequency,
      startBin,
      startFrequency,
    });
  }

  return bandRanges;
}

function writeSpectrogramColumn({ bandRanges, columnOffset, lowFrequencyEnhancement, powerSpectrum, rowCount, target }) {
  for (let row = 0; row < rowCount; row += 1) {
    const range = bandRanges[row];
    const useLowFrequencyEnhancement = shouldUseLowFrequencyEnhancement(range, lowFrequencyEnhancement);
    const activeRange = useLowFrequencyEnhancement
      ? lowFrequencyEnhancement.enhancedBandRanges[row]
      : range;
    const activePowerSpectrum = useLowFrequencyEnhancement
      ? lowFrequencyEnhancement.powerSpectrum
      : powerSpectrum;
    const { startBin, endBin } = activeRange;
    const bandSize = Math.max(1, endBin - startBin);
    let weightedEnergy = 0;
    let totalWeight = 0;

    for (let bin = startBin; bin < endBin; bin += 1) {
      const position = bandSize === 1 ? 0.5 : (bin - startBin + 0.5) / bandSize;
      const taper = 1 - Math.abs((position * 2) - 1);
      const weight = 0.7 + (taper * 0.3);

      weightedEnergy += activePowerSpectrum[bin] * weight;
      totalWeight += weight;
    }

    const rms = Math.sqrt(weightedEnergy / Math.max(totalWeight, 1e-8));
    const decibels = 20 * Math.log10(rms + 1e-7);
    const normalized = (decibels - MIN_DB) / (MAX_DB - MIN_DB);
    const targetRow = rowCount - row - 1;

    target[(columnOffset * rowCount) + targetRow] = clamp(normalized, 0, 1);
  }
}

function writePowerSpectrum({ fftSize, outputView, powerSpectrum }) {
  const maximumBin = Math.max(2, Math.floor(fftSize / 2));
  const normalizationFactor = (fftSize / 2) ** 2;

  powerSpectrum.fill(0);

  for (let bin = 1; bin < maximumBin; bin += 1) {
    const real = outputView[bin * 2];
    const imaginary = outputView[(bin * 2) + 1];
    powerSpectrum[bin] = ((real * real) + (imaginary * imaginary)) / normalizationFactor;
  }
}

function writeDecimatedFftInput({ centerSample, decimationFactor, fftResource, fftSize }) {
  const decimatedWindowStart = centerSample - Math.floor((fftSize * decimationFactor) / 2);

  for (let offset = 0; offset < fftSize; offset += 1) {
    let sum = 0;

    for (let tap = 0; tap < decimationFactor; tap += 1) {
      const sourceIndex = decimatedWindowStart + (offset * decimationFactor) + tap;
      sum += sourceIndex >= 0 && sourceIndex < analysisState.samples.length
        ? analysisState.samples[sourceIndex]
        : 0;
    }

    fftResource.inputView[offset] = (sum / decimationFactor) * fftResource.window[offset];
  }
}

function createBandRangesForSampleRate({ fftSize, maxFrequency, minFrequency, rowCount, sampleRate, template }) {
  const nyquist = sampleRate / 2;
  const maximumBin = Math.max(2, Math.floor(fftSize / 2));

  return template.slice(0, rowCount).map((range) => {
    const startFrequency = Math.min(
      Math.max(minFrequency, range.startFrequency),
      maxFrequency * 0.999,
    );
    const endFrequency = Math.min(
      maxFrequency,
      Math.max(startFrequency * 1.01, range.endFrequency),
    );
    const startBin = clamp(Math.floor((startFrequency / nyquist) * maximumBin), 1, maximumBin - 1);
    const endBin = clamp(Math.ceil((endFrequency / nyquist) * maximumBin), startBin + 1, maximumBin);

    return {
      endBin,
      endFrequency,
      startBin,
      startFrequency,
    };
  });
}

function shouldUseLowFrequencyEnhancement(range, lowFrequencyEnhancement) {
  return Boolean(lowFrequencyEnhancement) && range.endFrequency <= lowFrequencyEnhancement.maxFrequency;
}

function buildTileCacheKey(plan, tileIndex) {
  return [
    analysisState.quality,
    plan.zoomBucket,
    `tile${tileIndex}`,
    `dpr${plan.dprBucket}`,
  ].join(':');
}

function normalizeQualityPreset(value) {
  return value === 'balanced' || value === 'max' ? value : 'high';
}

function quantizeSamplesPerPixel(samplesPerPixel) {
  const safeValue = Math.max(1, samplesPerPixel);
  const bucketExponent = Math.round(Math.log2(safeValue) * 2) / 2;
  return 2 ** bucketExponent;
}

function quantizeCeil(value, bucketSize) {
  return Math.max(bucketSize, Math.ceil(value / bucketSize) * bucketSize);
}

function formatBucketNumber(value) {
  return String(Math.round(value * 100) / 100).replace('.', '_');
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function postCancelled(plan) {
  self.postMessage({
    type: 'spectrogramTilesCancelled',
    body: {
      generation: plan.generation,
      requestKind: plan.requestKind,
    },
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
