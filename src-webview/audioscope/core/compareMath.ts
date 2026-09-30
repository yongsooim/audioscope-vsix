// Signal math for compare views: resampling B onto A's rate, estimating the
// offset between them, least-squares gain matching and null-test statistics.
// Pure functions so the compare worker stays thin and this stays testable.

// Freshly allocated PCM, so .buffer is a transferable ArrayBuffer.
type Pcm = Float32Array<ArrayBuffer>;

const RESAMPLE_HALF_TAPS = 16;
const RESAMPLE_PHASES = 1024;
const OFFSET_ANALYSIS_RATE = 4000;
const OFFSET_ANALYSIS_SECONDS = 60;
const OFFSET_REFINE_SAMPLES = 65536;

export interface OffsetEstimate {
  // A[n] ~ B[n + offsetSamples]; positive means B starts later than A.
  offsetSamples: number;
  // Normalized correlation at the chosen offset (0..1).
  confidence: number;
}

export interface CompareStats {
  correlation: number;
  nullDepthDb: number | null;
  peakDiffDbfs: number | null;
  rmsADbfs: number | null;
  rmsBDbfs: number | null;
  rmsDiffDbfs: number | null;
}

function blackman(position: number): number {
  // position in [-1, 1]
  const x = (position + 1) * 0.5;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

function buildResampleKernel(cutoff: number): Float32Array {
  const taps = RESAMPLE_HALF_TAPS * 2;
  const table = new Float32Array((RESAMPLE_PHASES + 1) * taps);
  for (let phase = 0; phase <= RESAMPLE_PHASES; phase += 1) {
    const fraction = phase / RESAMPLE_PHASES;
    let sum = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const distance = tap - (RESAMPLE_HALF_TAPS - 1) - fraction;
      const argument = distance * cutoff;
      const sinc = Math.abs(argument) < 1e-9 ? 1 : Math.sin(Math.PI * argument) / (Math.PI * argument);
      const value = sinc * blackman(distance / RESAMPLE_HALF_TAPS);
      table[phase * taps + tap] = value;
      sum += value;
    }
    // Unity DC gain per phase.
    for (let tap = 0; tap < taps; tap += 1) {
      table[phase * taps + tap] /= sum || 1;
    }
  }
  return table;
}

export function resampleChannel(input: Float32Array, fromRate: number, toRate: number): Pcm {
  if (!(fromRate > 0) || !(toRate > 0) || fromRate === toRate || input.length === 0) {
    return input.slice();
  }

  const ratio = toRate / fromRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);
  const kernel = buildResampleKernel(Math.min(1, ratio));
  const taps = RESAMPLE_HALF_TAPS * 2;
  const lastIndex = input.length - 1;

  for (let index = 0; index < outputLength; index += 1) {
    const position = index / ratio;
    const base = Math.floor(position);
    const phase = Math.round((position - base) * RESAMPLE_PHASES);
    const kernelOffset = phase * taps;
    const firstSample = base - (RESAMPLE_HALF_TAPS - 1);
    let sum = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const sampleIndex = firstSample + tap;
      if (sampleIndex >= 0 && sampleIndex <= lastIndex) {
        sum += input[sampleIndex] * kernel[kernelOffset + tap];
      }
    }
    output[index] = sum;
  }

  return output;
}

export function downmixToMono(channels: Float32Array[], length: number): Pcm {
  const mono = new Float32Array(length);
  if (channels.length === 0) {
    return mono;
  }

  const weight = 1 / channels.length;
  for (const channel of channels) {
    const limit = Math.min(length, channel.length);
    for (let index = 0; index < limit; index += 1) {
      mono[index] += channel[index] * weight;
    }
  }
  return mono;
}

function decimate(input: Float32Array, factor: number, maxLength: number): Float32Array {
  const length = Math.min(maxLength, Math.floor(input.length / factor));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    const start = index * factor;
    for (let tap = 0; tap < factor; tap += 1) {
      sum += input[start + tap];
    }
    output[index] = sum / factor;
  }
  return output;
}

// In-place iterative radix-2 FFT; re/im length must be a power of two.
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const size = re.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) {
      reversed ^= bit;
    }
    reversed ^= bit;
    if (index < reversed) {
      [re[index], re[reversed]] = [re[reversed], re[index]];
      [im[index], im[reversed]] = [im[reversed], im[index]];
    }
  }

  for (let span = 2; span <= size; span <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / span;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    const half = span >> 1;
    for (let start = 0; start < size; start += span) {
      let twiddleRe = 1;
      let twiddleIm = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const evenIndex = start + offset;
        const oddIndex = evenIndex + half;
        const oddRe = re[oddIndex] * twiddleRe - im[oddIndex] * twiddleIm;
        const oddIm = re[oddIndex] * twiddleIm + im[oddIndex] * twiddleRe;
        re[oddIndex] = re[evenIndex] - oddRe;
        im[oddIndex] = im[evenIndex] - oddIm;
        re[evenIndex] += oddRe;
        im[evenIndex] += oddIm;
        const nextRe = twiddleRe * stepRe - twiddleIm * stepIm;
        twiddleIm = twiddleRe * stepIm + twiddleIm * stepRe;
        twiddleRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      re[index] /= size;
      im[index] /= size;
    }
  }
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) {
    size <<= 1;
  }
  return size;
}

// c[k] = sum_n a[n] * b[n + k] for |k| <= maxLag, via FFT.
function crossCorrelate(a: Float32Array, b: Float32Array, maxLag: number): { lag: number; value: number } {
  const size = nextPowerOfTwo(a.length + b.length);
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(a);
  bRe.set(b);
  fft(aRe, aIm);
  fft(bRe, bIm);
  for (let index = 0; index < size; index += 1) {
    // conj(A) * B
    const re = aRe[index] * bRe[index] + aIm[index] * bIm[index];
    const im = aRe[index] * bIm[index] - aIm[index] * bRe[index];
    aRe[index] = re;
    aIm[index] = im;
  }
  fft(aRe, aIm, true);

  let bestLag = 0;
  let bestValue = -Infinity;
  const limit = Math.min(maxLag, size / 2 - 1);
  for (let lag = -limit; lag <= limit; lag += 1) {
    const value = aRe[lag >= 0 ? lag : size + lag];
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  return { lag: bestLag, value: bestValue };
}

function findLoudestSegmentStart(signal: Float32Array, segmentLength: number, searchLength: number): number {
  const blockLength = Math.max(1, Math.floor(segmentLength / 4));
  const limit = Math.max(0, Math.min(signal.length, searchLength) - segmentLength);
  let bestStart = 0;
  let bestEnergy = -1;
  for (let start = 0; start <= limit; start += blockLength) {
    let energy = 0;
    for (let index = start; index < start + segmentLength; index += 1) {
      energy += signal[index] * signal[index];
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }
  return bestStart;
}

function correlationAt(a: Float32Array, b: Float32Array, lag: number, start: number, length: number): number {
  let dot = 0;
  let energyA = 0;
  let energyB = 0;
  const end = Math.min(a.length, start + length);
  for (let index = start; index < end; index += 1) {
    const other = index + lag;
    const valueB = other >= 0 && other < b.length ? b[other] : 0;
    dot += a[index] * valueB;
    energyA += a[index] * a[index];
    energyB += valueB * valueB;
  }
  const norm = Math.sqrt(energyA * energyB);
  return norm > 0 ? dot / norm : 0;
}

export function estimateOffset(
  monoA: Float32Array,
  monoB: Float32Array,
  sampleRate: number,
  maxLagSeconds = 2,
): OffsetEstimate {
  if (monoA.length === 0 || monoB.length === 0 || !(sampleRate > 0)) {
    return { confidence: 0, offsetSamples: 0 };
  }

  const factor = Math.max(1, Math.floor(sampleRate / OFFSET_ANALYSIS_RATE));
  const analysisLength = Math.ceil((OFFSET_ANALYSIS_SECONDS * sampleRate) / factor);
  const coarseA = decimate(monoA, factor, analysisLength);
  const coarseB = decimate(monoB, factor, analysisLength);
  const maxCoarseLag = Math.ceil((maxLagSeconds * sampleRate) / factor);
  const coarse = coarseA.length > 0 && coarseB.length > 0
    ? crossCorrelate(coarseA, coarseB, maxCoarseLag).lag * factor
    : 0;

  const segmentLength = Math.min(OFFSET_REFINE_SAMPLES, monoA.length);
  const segmentStart = findLoudestSegmentStart(monoA, segmentLength, OFFSET_ANALYSIS_SECONDS * sampleRate);
  let bestLag = coarse;
  let bestCorrelation = -Infinity;
  for (let lag = coarse - 2 * factor; lag <= coarse + 2 * factor; lag += 1) {
    const value = correlationAt(monoA, monoB, lag, segmentStart, segmentLength);
    if (value > bestCorrelation) {
      bestCorrelation = value;
      bestLag = lag;
    }
  }

  return {
    confidence: Math.max(0, bestCorrelation),
    offsetSamples: bestLag,
  };
}

// B'[n] = B[n + offset], zero outside B.
export function alignChannel(channel: Float32Array, offsetSamples: number, length: number, gain = 1): Pcm {
  const output = new Float32Array(length);
  const start = Math.max(0, -offsetSamples);
  const end = Math.min(length, channel.length - offsetSamples);
  for (let index = start; index < end; index += 1) {
    output[index] = channel[index + offsetSamples] * gain;
  }
  return output;
}

export function padChannel(channel: Float32Array, length: number): Pcm {
  if (channel.length === length) {
    return channel.slice();
  }
  const output = new Float32Array(length);
  output.set(channel.subarray(0, Math.min(length, channel.length)));
  return output;
}

// Least-squares gain g minimizing |A - g * B|^2.
export function fitGain(monoA: Float32Array, monoB: Float32Array): number {
  let dot = 0;
  let energyB = 0;
  const length = Math.min(monoA.length, monoB.length);
  for (let index = 0; index < length; index += 1) {
    dot += monoA[index] * monoB[index];
    energyB += monoB[index] * monoB[index];
  }
  const gain = energyB > 0 ? dot / energyB : 1;
  return Number.isFinite(gain) && gain > 0 ? gain : 1;
}

export function subtractChannels(a: Float32Array, b: Float32Array): Pcm {
  const output = new Float32Array(a.length);
  for (let index = 0; index < a.length; index += 1) {
    output[index] = a[index] - (b[index] ?? 0);
  }
  return output;
}

function toDbfs(value: number): number | null {
  return value > 0 ? 20 * Math.log10(value) : null;
}

export function computeCompareStats(monoA: Float32Array, monoB: Float32Array, monoDiff: Float32Array): CompareStats {
  let energyA = 0;
  let energyB = 0;
  let energyDiff = 0;
  let dot = 0;
  let peakDiff = 0;
  const length = monoDiff.length;
  for (let index = 0; index < length; index += 1) {
    const a = monoA[index] ?? 0;
    const b = monoB[index] ?? 0;
    const diff = monoDiff[index];
    energyA += a * a;
    energyB += b * b;
    energyDiff += diff * diff;
    dot += a * b;
    peakDiff = Math.max(peakDiff, Math.abs(diff));
  }

  const safeLength = Math.max(1, length);
  const rmsA = Math.sqrt(energyA / safeLength);
  const rmsDiff = Math.sqrt(energyDiff / safeLength);
  const rmsADbfs = toDbfs(rmsA);
  const rmsDiffDbfs = toDbfs(rmsDiff);
  const norm = Math.sqrt(energyA * energyB);

  return {
    correlation: norm > 0 ? dot / norm : 0,
    nullDepthDb: rmsADbfs !== null
      ? (rmsDiffDbfs !== null ? rmsADbfs - rmsDiffDbfs : Number.POSITIVE_INFINITY)
      : null,
    peakDiffDbfs: toDbfs(peakDiff),
    rmsADbfs,
    rmsBDbfs: toDbfs(Math.sqrt(energyB / safeLength)),
    rmsDiffDbfs,
  };
}
