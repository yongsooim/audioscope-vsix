import assert from 'node:assert/strict';
import test from 'node:test';

const compareMath = await import('../src-webview/audioscope/core/compareMath.ts');
const {
  alignChannel,
  computeCompareStats,
  estimateOffset,
  fitGain,
  resampleChannel,
  subtractChannels,
} = compareMath;

function noiseBurst(length: number, seed: number): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, (_, index) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    const envelope = index % 4410 < 2200 ? 1 : 0.2;
    return ((state / 0xffffffff) * 2 - 1) * 0.4 * envelope;
  });
}

test('the offset estimate recovers a delayed copy to the sample', () => {
  const sampleRate = 44100;
  const a = noiseBurst(sampleRate * 3, 7);
  for (const delay of [0, 1, 1105, 2112, -523]) {
    const b = new Float32Array(a.length + Math.max(0, delay));
    for (let index = 0; index < a.length; index += 1) {
      const target = index + delay;
      if (target >= 0 && target < b.length) {
        b[target] = a[index];
      }
    }
    const estimate = estimateOffset(a, b, sampleRate);
    assert.equal(estimate.offsetSamples, delay, `delay ${delay}`);
    assert.ok(estimate.confidence > 0.99, `confidence ${estimate.confidence}`);
  }
});

test('aligning by the estimated offset and matching gain nulls a scaled copy', () => {
  const sampleRate = 48000;
  const a = noiseBurst(sampleRate * 2, 11);
  const delay = 777;
  const b = new Float32Array(a.length + delay);
  for (let index = 0; index < a.length; index += 1) {
    b[index + delay] = a[index] * 0.5;
  }

  const { offsetSamples } = estimateOffset(a, b, sampleRate);
  const aligned = alignChannel(b, offsetSamples, a.length);
  const gain = fitGain(a, aligned);
  assert.ok(Math.abs(gain - 2) < 1e-4, `gain ${gain}`);

  const matched = alignChannel(b, offsetSamples, a.length, gain);
  const stats = computeCompareStats(a, matched, subtractChannels(a, matched));
  assert.ok(stats.correlation > 0.9999, `correlation ${stats.correlation}`);
  assert.ok((stats.nullDepthDb ?? 0) > 80, `null depth ${stats.nullDepthDb}`);
});

test('resampling keeps a tone at the same frequency and level', () => {
  const fromRate = 44100;
  const toRate = 48000;
  const frequency = 1000;
  const input = Float32Array.from({ length: fromRate }, (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / fromRate));
  const output = resampleChannel(input, fromRate, toRate);
  assert.equal(output.length, toRate);

  const reference = Float32Array.from({ length: toRate }, (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / toRate));
  const start = 1000;
  const end = toRate - 1000;
  let errorEnergy = 0;
  let signalEnergy = 0;
  for (let index = start; index < end; index += 1) {
    errorEnergy += (output[index] - reference[index]) ** 2;
    signalEnergy += reference[index] ** 2;
  }
  const snrDb = 10 * Math.log10(signalEnergy / errorEnergy);
  assert.ok(snrDb > 60, `resample SNR ${snrDb.toFixed(1)} dB`);
});

test('stats report an identical pair as a perfect null', () => {
  const a = noiseBurst(1000, 3);
  const stats = computeCompareStats(a, a, subtractChannels(a, a));
  assert.equal(stats.rmsDiffDbfs, null);
  assert.equal(stats.nullDepthDb, Number.POSITIVE_INFINITY);
  assert.ok(stats.correlation > 0.999999);
});
