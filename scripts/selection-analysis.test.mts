import assert from 'node:assert/strict';
import test from 'node:test';

const analysisModule = await import('../src-webview/audioscope/core/selectionAnalysis.ts');
const analyzeSelection = analysisModule.analyzeSelection ?? analysisModule.default?.analyzeSelection;

test('a selected pure tone reports its frequency and full-scale referenced level', () => {
  const sampleRate = 8192;
  const pcm = Float32Array.from({ length: 4096 }, (_, frame) => 0.5 * Math.sin((2 * Math.PI * 1024 * frame) / sampleRate));
  const result = analyzeSelection({
    pcm,
    sampleRate,
    startFrame: 1024,
    endFrame: 3072,
    fftSize: 1024,
    windowFunction: 'hann',
  });

  const strongestBin = result.levelsDb.indexOf(Math.max(...result.levelsDb));
  assert.equal(result.frequenciesHz[strongestBin], 1024);
  assert.ok(Math.abs(result.levelsDb[strongestBin] + 6.0206) < 0.01);
  assert.ok(Math.abs(result.rms - Math.sqrt(0.125)) < 1e-6);
  assert.ok(Math.abs(result.dcOffset) < 1e-6);
  assert.equal(result.sampleCount, 2048);
});

test('sample statistics and clipping positions honor the exclusive selection end', () => {
  const pcm = Float32Array.from([0.75, 0, 1, 1, 0, -1, 0, 0.5, -0.5, 0.75]);
  const result = analyzeSelection({
    pcm,
    sampleRate: 8000,
    startFrame: 1,
    endFrame: 9,
    fftSize: 16,
    windowFunction: 'rectangular',
  });

  assert.equal(result.sampleCount, 8);
  assert.equal(result.peakAmplitude, 1);
  assert.equal(result.peakFrame, 2);
  assert.equal(result.dcOffset, 0.125);
  assert.ok(Math.abs(result.rms - Math.sqrt(3.5 / 8)) < 1e-6);
  assert.equal(result.clippingSampleCount, 3);
  assert.deepEqual(result.clippingFrames, [2, 5]);
  assert.equal(result.spectrumWindowCount, 1);
});

test('a selection shorter than the FFT still returns finite spectrum bins', () => {
  const result = analyzeSelection({
    pcm: Float32Array.from([1, -1]),
    sampleRate: 8000,
    startFrame: 0,
    endFrame: 2,
    fftSize: 1024,
    windowFunction: 'hann',
  });

  assert.equal(result.spectrumWindowCount, 1);
  assert.ok(result.levelsDb.every(Number.isFinite));
});

test('long selections use no more than 64 evenly spread FFT windows', () => {
  const pcm = new Float32Array(100_000);
  for (let frame = 0; frame < 1024; frame += 1) {
    pcm[frame] = 0.5 * Math.sin((2 * Math.PI * 16 * frame) / 1024);
    pcm[pcm.length - 1024 + frame] = 0.5 * Math.sin((2 * Math.PI * 32 * frame) / 1024);
  }
  const result = analyzeSelection({
    pcm,
    sampleRate: 8000,
    startFrame: 0,
    endFrame: pcm.length,
    fftSize: 1024,
    windowFunction: 'hamming',
  });

  assert.equal(result.spectrumWindowCount, 64);
  assert.equal(result.peakAmplitude, 0.5);
  assert.equal(result.sampleCount, pcm.length);
  assert.equal(result.frequenciesHz.length, 513);
  assert.equal(result.levelsDb.length, 513);
  assert.ok(result.levelsDb[16] > -30, 'the first FFT window includes the start of the selection');
  assert.ok(result.levelsDb[32] > -30, 'the last FFT window includes the end of the selection');
});
