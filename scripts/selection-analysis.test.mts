import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Load the browser module dynamically; it is typechecked by tsconfig.webview.json.
const analysisModulePath = '../src-webview/audioscope/core/selectionAnalysis.ts';
const analysisModule: any = await import(analysisModulePath);
declare const WebAssembly: {
  instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: { exports: Record<string, unknown> } }>;
};
type SelectionInput = { startFrame: number; endFrame: number; fftSize: number; windowFunction: string };
const analyzeSessionSelection = analysisModule.analyzeSelection ?? analysisModule.default?.analyzeSelection;

for (const variant of ['simd', 'fallback']) {
  const wasmPath = path.resolve(import.meta.dirname, '../dist/wasm', `wasm_core_${variant}.wasm`);
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
  const exports = instance.exports;
  const memory = exports.memory as { buffer: ArrayBuffer; grow(pages: number): number };
  // Use live heap getters because pooled FFT allocations may grow the memory.
  const module: any = {
    memory,
    get HEAPF32() { return new Float32Array(memory.buffer); },
    get HEAPF64() { return new Float64Array(memory.buffer); },
    get HEAPU8() { return new Uint8Array(memory.buffer); },
    ...Object.fromEntries(Object.entries(exports).filter(([, value]) => typeof value === 'function')
      .map(([name, value]) => [`_${name}`, value])),
  };
  const selectionTest = (name: string, run: () => void) => test(`${variant}: ${name}`, run);
  const analyzeSelection = (input: SelectionInput & { pcm: Float32Array; sampleRate: number }) => {
    const sampleCount = Math.max(1, input.pcm.length);
    assert.equal(module._wave_prepare_session(sampleCount, input.sampleRate, sampleCount / input.sampleRate), 1);
    new Float32Array(memory.buffer, module._wave_get_pcm_ptr(), sampleCount).set(input.pcm);
    return analyzeSessionSelection(module, input);
  };

  selectionTest('a selected pure tone reports its frequency and full-scale referenced level', () => {
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
    assert.equal(result.dominantFrequencyHz, 1024);
    assert.notEqual(result.spectralCentroidHz, null);
    assert.notEqual(result.crestFactorDb, null);
    assert.ok(Math.abs(result.spectralCentroidHz! - 1024) < 0.1);
    assert.ok(Math.abs(result.crestFactorDb! - 3.0103) < 0.001);
    assert.equal(result.clippingRatio, 0);
  });

  selectionTest('sample statistics and clipping positions honor the exclusive selection end', () => {
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
    assert.equal(result.clippingRatio, 3 / 8);
    assert.equal(result.zeroCrossingRate, 3 / 7);
    assert.deepEqual(result.clippingFrames, [2, 5]);
    assert.equal(result.spectrumWindowCount, 1);
  });

  selectionTest('silence and empty selections have no invented spectral or crest measurements', () => {
    for (const sampleCount of [0, 1, 4096]) {
      const result = analyzeSelection({
        pcm: new Float32Array(sampleCount), sampleRate: 8000, startFrame: 0,
        endFrame: sampleCount, fftSize: 1024, windowFunction: 'hann',
      });
      assert.equal(result.crestFactorDb, null);
      assert.equal(result.dominantFrequencyHz, null);
      assert.equal(result.spectralCentroidHz, null);
      assert.equal(result.zeroCrossingRate, 0);
      assert.equal(result.clippingRatio, 0);
    }
  });

  selectionTest('spectral centroid weights energy, including DC and the Nyquist bin', () => {
    const sampleRate = 1024;
    const pcm = Float32Array.from({ length: 1024 }, (_, frame) =>
      0.25 + 0.5 * Math.cos(2 * Math.PI * 128 * frame / sampleRate) + 0.125 * (-1) ** frame);
    const result = analyzeSelection({
      pcm, sampleRate, startFrame: 0, endFrame: pcm.length, fftSize: 1024, windowFunction: 'rectangular',
    });
    const dcEnergy = 0.25 ** 2;
    const toneEnergy = 0.5 ** 2 / 2;
    const nyquistEnergy = 0.125 ** 2;
    const expected = (128 * toneEnergy + 512 * nyquistEnergy) / (dcEnergy + toneEnergy + nyquistEnergy);
    assert.notEqual(result.spectralCentroidHz, null);
    assert.ok(Math.abs(result.spectralCentroidHz! - expected) < 0.001);
    assert.equal(result.dominantFrequencyHz, 128);
  });

  selectionTest('zero crossing rate excludes samples outside the selection and counts zeros as nonnegative', () => {
    const result = analyzeSelection({
      pcm: Float32Array.from([-1, 1, 0, -1, 0, 1, -1]), sampleRate: 8000,
      startFrame: 1, endFrame: 6, fftSize: 16, windowFunction: 'rectangular',
    });
    assert.equal(result.zeroCrossingRate, 2 / 4);
  });

  selectionTest('time-domain metrics include isolated peaks anywhere in a long selection', () => {
    const pcm = new Float32Array(100_000);
    pcm[53_017] = 1;
    const result = analyzeSelection({
      pcm, sampleRate: 8000, startFrame: 0, endFrame: pcm.length, fftSize: 1024, windowFunction: 'hann',
    });
    assert.equal(result.clippingRatio, 1 / pcm.length);
    assert.equal(result.crestFactorDb, 50);
    assert.equal(result.peakFrame, 53_017);
  });

  selectionTest('a selection shorter than the FFT still returns finite spectrum bins', () => {
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

  selectionTest('long selections use no more than 64 evenly spread FFT windows', () => {
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

  selectionTest('selection analysis shares FFT resources without changing PCM or rendered tiles', () => {
    const sampleRate = 8192;
    const pcm = Float32Array.from({ length: 8192 }, (_, frame) => 0.5 * Math.sin(2 * Math.PI * 1024 * frame / sampleRate));
    const full = { pcm, sampleRate, startFrame: 0, endFrame: pcm.length, fftSize: 1024, windowFunction: 'hann' as const };
    const initial = analyzeSelection(full);
    const pcmPointer = module._wave_get_pcm_ptr();
    const output = module._malloc(4 * 32 * 4);
    const render = () => {
      assert.equal(module._wave_render_spectrogram_tile_rgba(
        0, pcm.length, 0, 4, 4, 32, 0, 1024, 1, 20, sampleRate / 2, 0, 1, 1, -100, 0, 6, 0, output,
      ), 1);
      return new Uint8Array(memory.buffer, output, 4 * 32 * 4).slice();
    };
    try {
      const before = render();
      const short = { ...full, startFrame: 51, endFrame: 80 };
      analyzeSessionSelection(module, short);
      const warmHeapSize = memory.buffer.byteLength;
      for (let index = 0; index < 30; index += 1) {
        analyzeSessionSelection(module, short);
        assert.deepEqual(analyzeSessionSelection(module, full), initial);
      }
      assert.equal(memory.buffer.byteLength, warmHeapSize, 'repeated selections reuse scratch allocations');
      assert.equal(module._wave_get_pcm_ptr(), pcmPointer);
      assert.deepEqual(new Float32Array(memory.buffer, pcmPointer, pcm.length), pcm);
      assert.deepEqual(render(), before, 'short selection windows must not overwrite the spectrogram window');
    } finally {
      module._free(output);
      module._wave_dispose_session();
    }
  });

  selectionTest('selection output remains valid after heap growth and session replacement', () => {
    const input = { pcm: Float32Array.from([1, -1, 0.5, -0.5]), sampleRate: 8000,
      startFrame: 0, endFrame: 4, fftSize: 32, windowFunction: 'rectangular' as const };
    const result = analyzeSelection(input);
    const bins = result.levelsDb.slice();
    memory.grow(1);
    analyzeSelection({ ...input, pcm: new Float32Array(4) });
    assert.equal(result.peakAmplitude, 1);
    assert.deepEqual(result.clippingFrames, [0]);
    assert.deepEqual(result.levelsDb, bins);
  });

  selectionTest('selection bounds are clamped and absent sessions report an error', () => {
    const input = { pcm: Float32Array.from([1, -0.5, 0, 0.5]), sampleRate: 8000,
      startFrame: -20, endFrame: 100, fftSize: 32, windowFunction: 'hann' };
    const full = analyzeSelection(input);
    assert.equal(full.startFrame, 0);
    assert.equal(full.endFrame, 4);
    const empty = analyzeSessionSelection(module, { ...input, startFrame: 3, endFrame: 1 });
    assert.equal(empty.sampleCount, 0);
    assert.equal(empty.peakFrame, null);
    assert.throws(() => analyzeSessionSelection(module, { ...input, startFrame: NaN }), /finite/);
    module._wave_dispose_session();
    assert.throws(() => analyzeSessionSelection(module, input), /active audio selection/);
  });

  selectionTest('constant signals have zero crest factor despite accumulated rounding', () => {
    const result = analyzeSelection({
      pcm: new Float32Array(100_000).fill(0.1), sampleRate: 48000,
      startFrame: 0, endFrame: 100_000, fftSize: 4096, windowFunction: 'rectangular',
    });
    assert.notEqual(result.crestFactorDb, null);
    assert.ok(Math.abs(result.crestFactorDb) < 1e-8);
    assert.equal(result.dominantFrequencyHz, 0);
  });
}
