import { heapF32View, heapF64View, type WaveCoreModule } from '../../waveCoreRuntime';
import { WINDOW_FUNCTION_CODES, type SpectrogramWindowFunction } from '../../windowShared';

// Matches the Result ABI in wasm_core/selection_analysis.zig.
const METRIC_COUNT = 15;
const MAX_CLIPPING_POSITIONS = 32;
const HEADER_BYTES = (METRIC_COUNT + MAX_CLIPPING_POSITIONS) * Float64Array.BYTES_PER_ELEMENT;

export interface SelectionAnalysisInput {
  startFrame: number;
  endFrame: number; // Exclusive.
  fftSize: number;
  windowFunction: SpectrogramWindowFunction;
}

export interface SelectionAnalysisResult {
  startFrame: number;
  endFrame: number;
  sampleCount: number;
  peakAmplitude: number;
  peakFrame: number | null;
  rms: number;
  dcOffset: number;
  crestFactorDb: number | null; // Undefined for silence.
  zeroCrossingRate: number; // Sign changes per adjacent sample pair; zero is nonnegative.
  clippingSampleCount: number;
  clippingRatio: number;
  clippingFrames: number[]; // First frame of each near-full-scale run, capped at 32.
  frequenciesHz: Float32Array;
  levelsDb: Float32Array; // Averaged one-sided power, referenced to a full-scale sine.
  spectrumWindowCount: number;
  dominantFrequencyHz: number | null;
  spectralCentroidHz: number | null; // One-sided energy-weighted centroid, including DC.
}

/** Analyze the active WASM session; only the small result buffers leave the heap. */
export function analyzeSelection(module: WaveCoreModule, input: SelectionAnalysisInput): SelectionAnalysisResult {
  const { startFrame, endFrame, fftSize, windowFunction } = input;
  if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) {
    throw new RangeError('Selection bounds must be finite');
  }
  if (!Number.isInteger(fftSize) || fftSize < 16 || fftSize > 32_768 || (fftSize & (fftSize - 1)) !== 0) {
    throw new RangeError('fftSize must be a power of two between 16 and 32768');
  }
  const binCount = fftSize / 2 + 1;
  const pointer = module._malloc(HEADER_BYTES + binCount * Float32Array.BYTES_PER_ELEMENT * 2);
  if (!pointer) {
    throw new Error('Unable to allocate selection analysis output');
  }
  try {
    if (!module._wave_analyze_selection(startFrame, endFrame, fftSize, WINDOW_FUNCTION_CODES[windowFunction], pointer)) {
      throw new Error('Unable to analyze the active audio selection');
    }
    // Read views after the call: FFT resource allocation can grow WASM memory.
    const metrics = heapF64View(module, pointer, METRIC_COUNT + MAX_CLIPPING_POSITIONS);
    const frequenciesPointer = pointer + HEADER_BYTES;
    return {
      startFrame: metrics[0],
      endFrame: metrics[1],
      sampleCount: metrics[2],
      peakAmplitude: metrics[3],
      peakFrame: metrics[4] < 0 ? null : metrics[4],
      rms: metrics[5],
      dcOffset: metrics[6],
      crestFactorDb: metrics[7] < 0 ? null : metrics[7],
      zeroCrossingRate: metrics[8],
      clippingSampleCount: metrics[9],
      clippingRatio: metrics[10],
      clippingFrames: Array.from(metrics.subarray(METRIC_COUNT, METRIC_COUNT + metrics[11])),
      spectrumWindowCount: metrics[12],
      dominantFrequencyHz: metrics[13] < 0 ? null : metrics[13],
      spectralCentroidHz: metrics[14] < 0 ? null : metrics[14],
      frequenciesHz: heapF32View(module, frequenciesPointer, binCount).slice(),
      levelsDb: heapF32View(module, frequenciesPointer + binCount * Float32Array.BYTES_PER_ELEMENT, binCount).slice(),
    };
  } finally {
    module._free(pointer);
  }
}
