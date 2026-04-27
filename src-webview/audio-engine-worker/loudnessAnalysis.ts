// EBU R128 / ITU-R BS.1770 loudness analysis.
// Computes per-block momentary (400ms) and short-term (3s) loudness in LUFS.

const LOUDNESS_BLOCK_SECONDS = 0.1;
const MOMENTARY_WINDOW_SECONDS = 0.4;
const SHORT_TERM_WINDOW_SECONDS = 3.0;
const LOUDNESS_FLOOR_LUFS = -100;

export interface LoudnessData {
  momentary: Float32Array;
  shortTerm: Float32Array;
  truePeak: Float32Array;
  blockCount: number;
  blockSamples: number;
  sampleRate: number;
  peakMomentaryLufs: number;
  peakShortTermLufs: number;
  peakTruePeakDb: number;
  integratedLufs: number;
}

// K-weighting pre-filter (high shelf) coefficients for 48kHz reference.
// Derived from ITU-R BS.1770 Table 1.
function computePreFilterCoefficients(sampleRate: number): {
  b0: number; b1: number; b2: number; a1: number; a2: number;
} {
  const Vh = 1.584893192;
  const Vb = Math.sqrt(Vh);
  const f0 = 1681.974450955533;
  const Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / sampleRate);
  const K2 = K * K;
  const denominator = 1 + K / Q + K2;
  return {
    b0: (Vh + Vb * K / Q + K2) / denominator,
    b1: 2 * (K2 - Vh) / denominator,
    b2: (Vh - Vb * K / Q + K2) / denominator,
    a1: 2 * (K2 - 1) / denominator,
    a2: (1 - K / Q + K2) / denominator,
  };
}

// RLB weighting (high-pass) coefficients.
function computeRlbCoefficients(sampleRate: number): {
  b0: number; b1: number; b2: number; a1: number; a2: number;
} {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan(Math.PI * f0 / sampleRate);
  const K2 = K * K;
  const denominator = 1 + K / Q + K2;
  return {
    b0: 1 / denominator,
    b1: -2 / denominator,
    b2: 1 / denominator,
    a1: 2 * (K2 - 1) / denominator,
    a2: (1 - K / Q + K2) / denominator,
  };
}

function applyBiquad(
  input: Float32Array,
  b0: number, b1: number, b2: number,
  a1: number, a2: number,
): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return output;
}

export function computeLoudnessData(pcm: Float32Array, sampleRate: number): LoudnessData {
  // Apply K-weighting: pre-filter then RLB.
  const pre = computePreFilterCoefficients(sampleRate);
  const rlb = computeRlbCoefficients(sampleRate);
  const stage1 = applyBiquad(pcm, pre.b0, pre.b1, pre.b2, pre.a1, pre.a2);
  const kWeighted = applyBiquad(stage1, rlb.b0, rlb.b1, rlb.b2, rlb.a1, rlb.a2);

  const blockSamples = Math.max(1, Math.round(sampleRate * LOUDNESS_BLOCK_SECONDS));
  const blockCount = Math.max(1, Math.ceil(kWeighted.length / blockSamples));

  // Mean square per block.
  const blockPower = new Float64Array(blockCount);
  for (let i = 0; i < blockCount; i++) {
    const start = i * blockSamples;
    const end = Math.min(start + blockSamples, kWeighted.length);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += kWeighted[j] * kWeighted[j];
    }
    blockPower[i] = sum / (end - start);
  }

  const momentaryWindowBlocks = Math.max(1, Math.round(MOMENTARY_WINDOW_SECONDS / LOUDNESS_BLOCK_SECONDS));
  const shortTermWindowBlocks = Math.max(1, Math.round(SHORT_TERM_WINDOW_SECONDS / LOUDNESS_BLOCK_SECONDS));

  const momentary = new Float32Array(blockCount);
  const shortTerm = new Float32Array(blockCount);

  // Running sum for momentary window.
  let momentarySum = 0;
  for (let i = 0; i < blockCount; i++) {
    momentarySum += blockPower[i];
    if (i >= momentaryWindowBlocks) {
      momentarySum -= blockPower[i - momentaryWindowBlocks];
    }
    const count = Math.min(i + 1, momentaryWindowBlocks);
    const meanSquare = momentarySum / count;
    momentary[i] = meanSquare > 1e-20 ? -0.691 + 10 * Math.log10(meanSquare) : LOUDNESS_FLOOR_LUFS;
  }

  // Running sum for short-term window.
  let shortTermSum = 0;
  for (let i = 0; i < blockCount; i++) {
    shortTermSum += blockPower[i];
    if (i >= shortTermWindowBlocks) {
      shortTermSum -= blockPower[i - shortTermWindowBlocks];
    }
    const count = Math.min(i + 1, shortTermWindowBlocks);
    const meanSquare = shortTermSum / count;
    shortTerm[i] = meanSquare > 1e-20 ? -0.691 + 10 * Math.log10(meanSquare) : LOUDNESS_FLOOR_LUFS;
  }

  let peakMomentaryLufs = LOUDNESS_FLOOR_LUFS;
  let peakShortTermLufs = LOUDNESS_FLOOR_LUFS;
  for (let i = 0; i < blockCount; i++) {
    if (momentary[i] > peakMomentaryLufs) { peakMomentaryLufs = momentary[i]; }
    if (shortTerm[i] > peakShortTermLufs) { peakShortTermLufs = shortTerm[i]; }
  }

  // Per-block sample peak in dBFS.
  const truePeak = new Float32Array(blockCount);
  let peakTruePeakDb = LOUDNESS_FLOOR_LUFS;
  for (let i = 0; i < blockCount; i++) {
    const start = i * blockSamples;
    const end = Math.min(start + blockSamples, pcm.length);
    let maxAbs = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(pcm[j]);
      if (abs > maxAbs) { maxAbs = abs; }
    }
    const db = maxAbs > 1e-20 ? 20 * Math.log10(maxAbs) : LOUDNESS_FLOOR_LUFS;
    truePeak[i] = db;
    if (db > peakTruePeakDb) { peakTruePeakDb = db; }
  }

  // EBU R128 gated integrated loudness.
  const absoluteGateDb = -70;
  let ungatedPowerSum = 0;
  let ungatedCount = 0;
  for (let i = 0; i < blockCount; i++) {
    if (momentary[i] > absoluteGateDb) {
      ungatedPowerSum += Math.pow(10, (momentary[i] + 0.691) / 10);
      ungatedCount++;
    }
  }

  let integratedLufs = LOUDNESS_FLOOR_LUFS;
  if (ungatedCount > 0) {
    const relativeGateDb = -0.691 + 10 * Math.log10(ungatedPowerSum / ungatedCount) - 10;
    let gatedPowerSum = 0;
    let gatedCount = 0;
    for (let i = 0; i < blockCount; i++) {
      if (momentary[i] > absoluteGateDb && momentary[i] > relativeGateDb) {
        gatedPowerSum += Math.pow(10, (momentary[i] + 0.691) / 10);
        gatedCount++;
      }
    }
    if (gatedCount > 0) {
      integratedLufs = -0.691 + 10 * Math.log10(gatedPowerSum / gatedCount);
    }
  }

  return {
    momentary, shortTerm, truePeak, blockCount, blockSamples, sampleRate,
    peakMomentaryLufs, peakShortTermLufs, peakTruePeakDb, integratedLufs,
  };
}
