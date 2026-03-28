import PFFFTNonSimd from '../node_modules/@echogarden/pffft-wasm/dist/non-simd/pffft.js';
import wasmBinaryNonSimd from '../node_modules/@echogarden/pffft-wasm/dist/non-simd/pffft.wasm';
import PFFFTSimd from '../node_modules/@echogarden/pffft-wasm/dist/simd/pffft.js';
import wasmBinarySimd from '../node_modules/@echogarden/pffft-wasm/dist/simd/pffft.wasm';

const FORWARD_DIRECTION = 0;
const REAL_TRANSFORM = 0;
const MIN_FREQUENCY = 40;
const MAX_FREQUENCY = 12000;
const MIN_DB = -92;
const MAX_DB = -12;

let pffftRuntimePromise = null;

self.onmessage = async (event) => {
  const message = event.data;

  if (message?.type !== 'analyze') {
    return;
  }

  try {
    const runtime = await getPffftRuntime();
    analyze(runtime, message.body);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: 'error',
      body: { message: text },
    });
  }
};

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

function analyze(runtime, options) {
  const { module, variant } = runtime;
  const samples = new Float32Array(options.samplesBuffer);
  const sampleCount = samples.length;
  const fftSize = options.fftSize;
  const spectrogramColumns = options.spectrogramColumns;
  const spectrogramRows = options.spectrogramRows;
  const duration = options.duration;
  const sampleRate = options.sampleRate;

  if (!sampleCount || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Audio data is empty.');
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

  const inputView = new Float32Array(module.HEAPF32.buffer, inputPointer, fftSize);
  const outputView = new Float32Array(module.HEAPF32.buffer, outputPointer, fftSize);
  const window = createHannWindow(fftSize);
  const bandRanges = createLogBandRanges({
    fftSize,
    sampleRate,
    rows: spectrogramRows,
    minFrequency: MIN_FREQUENCY,
    maxFrequency: Math.min(MAX_FREQUENCY, sampleRate / 2),
  });

  const batchSize = Math.max(8, Math.min(32, Math.ceil(spectrogramColumns / 36)));

  try {
    for (let columnStart = 0; columnStart < spectrogramColumns; columnStart += batchSize) {
      const columnCount = Math.min(batchSize, spectrogramColumns - columnStart);
      const spectrogramBatch = new Float32Array(columnCount * spectrogramRows);

      for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
        const columnIndex = columnStart + columnOffset;
        const centerRatio = spectrogramColumns === 1 ? 0.5 : columnIndex / (spectrogramColumns - 1);
        const centerSample = Math.round(centerRatio * (sampleCount - 1));
        const windowStart = centerSample - Math.floor(fftSize / 2);

        for (let offset = 0; offset < fftSize; offset += 1) {
          const sourceIndex = windowStart + offset;
          const sample = sourceIndex >= 0 && sourceIndex < sampleCount ? samples[sourceIndex] : 0;
          inputView[offset] = sample * window[offset];
        }

        module._pffft_transform_ordered(setup, inputPointer, outputPointer, workPointer, FORWARD_DIRECTION);
        writeSpectrogramColumn({
          target: spectrogramBatch,
          columnOffset,
          outputView,
          rowCount: spectrogramRows,
          bandRanges,
          fftSize,
        });
      }

      self.postMessage(
        {
          type: 'analysisBatch',
          body: {
            columnStart,
            columnCount,
            progress: Math.min(1, (columnStart + columnCount) / spectrogramColumns),
            duration,
            runtimeVariant: variant,
            spectrogramRows,
            spectrogramColumns,
            spectrogramBuffer: spectrogramBatch.buffer,
          },
        },
        [spectrogramBatch.buffer],
      );
    }

    self.postMessage({
      type: 'analysisComplete',
      body: {
        duration,
        runtimeVariant: variant,
      },
    });
  } finally {
    module._pffft_destroy_setup(setup);
    module._pffft_aligned_free(inputPointer);
    module._pffft_aligned_free(outputPointer);
    module._pffft_aligned_free(workPointer);
  }
}

function createHannWindow(size) {
  const window = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
  }

  return window;
}

function createLogBandRanges({ fftSize, sampleRate, rows, minFrequency, maxFrequency }) {
  const bandRanges = [];
  const nyquist = sampleRate / 2;
  const maximumBin = Math.max(1, Math.floor(fftSize / 2) - 1);
  const safeMinFrequency = Math.max(1, minFrequency);
  const safeMaxFrequency = Math.max(safeMinFrequency * 1.01, maxFrequency);

  for (let row = 0; row < rows; row += 1) {
    const startRatio = row / rows;
    const endRatio = (row + 1) / rows;
    const startFrequency = safeMinFrequency * (safeMaxFrequency / safeMinFrequency) ** startRatio;
    const endFrequency = safeMinFrequency * (safeMaxFrequency / safeMinFrequency) ** endRatio;

    const startBin = clamp(Math.floor((startFrequency / nyquist) * maximumBin), 1, maximumBin);
    const endBin = clamp(Math.ceil((endFrequency / nyquist) * maximumBin), startBin + 1, maximumBin + 1);

    bandRanges.push([startBin, endBin]);
  }

  return bandRanges;
}

function writeSpectrogramColumn({ target, columnOffset, outputView, rowCount, bandRanges, fftSize }) {
  for (let row = 0; row < rowCount; row += 1) {
    const [startBin, endBin] = bandRanges[row];
    let peak = 0;

    for (let bin = startBin; bin < endBin; bin += 1) {
      const real = outputView[bin * 2];
      const imaginary = outputView[bin * 2 + 1];
      const magnitude = Math.hypot(real, imaginary) / (fftSize / 2);

      if (magnitude > peak) {
        peak = magnitude;
      }
    }

    const decibels = 20 * Math.log10(peak + 1e-7);
    const normalized = (decibels - MIN_DB) / (MAX_DB - MIN_DB);
    const targetRow = rowCount - row - 1;

    target[(columnOffset * rowCount) + targetRow] = clamp(normalized, 0, 1);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
