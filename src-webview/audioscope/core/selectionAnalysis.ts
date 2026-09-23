import { getWindowValue, type SpectrogramWindowFunction } from '../../windowShared';

const MAX_SPECTRUM_WINDOWS = 64;
const MAX_CLIPPING_POSITIONS = 32;
const CLIPPING_THRESHOLD = 0.999;
const SPECTRUM_FLOOR_DB = -160;

export interface SelectionAnalysisInput {
  pcm: Float32Array;
  sampleRate: number;
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
  clippingSampleCount: number;
  clippingFrames: number[]; // First frame of each near-full-scale run, capped at 32.
  frequenciesHz: Float32Array;
  levelsDb: Float32Array; // Averaged one-sided power, referenced to a full-scale sine.
  spectrumWindowCount: number;
}

/** Analyze exact sample statistics and a bounded number of evenly spread FFT windows. */
export function analyzeSelection(input: SelectionAnalysisInput): SelectionAnalysisResult {
  const { pcm, sampleRate, fftSize, windowFunction } = input;
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) {
    throw new RangeError('sampleRate must be positive');
  }
  if (!Number.isInteger(fftSize) || fftSize < 16 || fftSize > 32_768 || (fftSize & (fftSize - 1)) !== 0) {
    throw new RangeError('fftSize must be a power of two between 16 and 32768');
  }

  const startFrame = Math.max(0, Math.min(pcm.length, Math.round(input.startFrame)));
  const endFrame = Math.max(startFrame, Math.min(pcm.length, Math.round(input.endFrame)));
  const sampleCount = endFrame - startFrame;
  const binCount = fftSize / 2 + 1;
  const frequenciesHz = new Float32Array(binCount);
  const levelsDb = new Float32Array(binCount);
  levelsDb.fill(SPECTRUM_FLOOR_DB);
  for (let bin = 0; bin < binCount; bin += 1) {
    frequenciesHz[bin] = (bin * sampleRate) / fftSize;
  }

  let peakAmplitude = 0;
  let peakFrame: number | null = null;
  let sum = 0;
  let sumSquares = 0;
  let clippingSampleCount = 0;
  let inClippingRun = false;
  const clippingFrames: number[] = [];
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const value = pcm[frame];
    const amplitude = Math.abs(value);
    if (peakFrame === null || amplitude > peakAmplitude) {
      peakAmplitude = amplitude;
      peakFrame = frame;
    }
    sum += value;
    sumSquares += value * value;
    if (amplitude >= CLIPPING_THRESHOLD) {
      clippingSampleCount += 1;
      if (!inClippingRun && clippingFrames.length < MAX_CLIPPING_POSITIONS) {
        clippingFrames.push(frame);
      }
      inClippingRun = true;
    } else {
      inClippingRun = false;
    }
  }

  const result: SelectionAnalysisResult = {
    startFrame,
    endFrame,
    sampleCount,
    peakAmplitude,
    peakFrame,
    rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
    dcOffset: sampleCount > 0 ? sum / sampleCount : 0,
    clippingSampleCount,
    clippingFrames,
    frequenciesHz,
    levelsDb,
    spectrumWindowCount: 0,
  };
  if (sampleCount === 0) {
    return result;
  }

  const windowLength = Math.min(sampleCount, fftSize);
  const lastWindowStart = endFrame - windowLength;
  const windowCount = windowLength < fftSize || lastWindowStart === startFrame
    ? 1
    : Math.min(MAX_SPECTRUM_WINDOWS, Math.max(2, Math.ceil(sampleCount / (fftSize / 2))));
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const power = new Float64Array(binCount);
  const windowValues = new Float64Array(windowLength);
  let windowSum = 0;
  for (let index = 0; index < windowLength; index += 1) {
    // A one/two-sample Hann or Blackman window has zero coherent gain.
    const weight = windowLength < 3 ? 1 : getWindowValue(windowFunction, index, windowLength);
    windowValues[index] = weight;
    windowSum += weight;
  }

  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    const windowStart = windowCount === 1
      ? startFrame
      : startFrame + Math.round(((lastWindowStart - startFrame) * windowIndex) / (windowCount - 1));
    real.fill(0);
    imaginary.fill(0);
    for (let index = 0; index < windowLength; index += 1) {
      real[index] = pcm[windowStart + index] * windowValues[index];
    }
    fftInPlace(real, imaginary);
    for (let bin = 0; bin < binCount; bin += 1) {
      const sideScale = bin === 0 || bin === fftSize / 2 ? 1 : 2;
      const normalizedReal = (real[bin] * sideScale) / windowSum;
      const normalizedImaginary = (imaginary[bin] * sideScale) / windowSum;
      power[bin] += normalizedReal * normalizedReal + normalizedImaginary * normalizedImaginary;
    }
  }
  for (let bin = 0; bin < binCount; bin += 1) {
    levelsDb[bin] = Math.max(SPECTRUM_FLOOR_DB, 10 * Math.log10(power[bin] / windowCount));
  }
  result.spectrumWindowCount = windowCount;
  return result;
}

function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let span = 2; span <= size; span *= 2) {
    const half = span / 2;
    const angle = (-2 * Math.PI) / span;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += span) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * rotationReal - imaginary[odd] * rotationImaginary;
        const oddImaginary = real[odd] * rotationImaginary + imaginary[odd] * rotationReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextRotationReal = rotationReal * stepReal - rotationImaginary * stepImaginary;
        rotationImaginary = rotationReal * stepImaginary + rotationImaginary * stepReal;
        rotationReal = nextRotationReal;
      }
    }
  }
}
