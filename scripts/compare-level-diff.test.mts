import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECTROGRAM = 0;
const LOG_SCALE = 0;
const HANN = 0;

// The scripts tsconfig has no DOM lib, so declare the one WebAssembly entry used.
declare const WebAssembly: {
  instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: { exports: unknown } }>;
};

type Exports = Record<string, (...args: number[]) => number> & { memory: { buffer: ArrayBuffer } };

async function loadCore(): Promise<Exports> {
  const wasmPath = path.join(projectRoot, 'dist', 'wasm', 'wasm_core_simd.wasm');
  assert.equal(fs.existsSync(wasmPath), true, `Missing build artifact: ${wasmPath}`);
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
  return instance.exports as unknown as Exports;
}

function tone(length: number, sampleRate: number, amplitude: number): Float32Array {
  return Float32Array.from({ length }, (_, index) => amplitude * Math.sin((2 * Math.PI * 1000 * index) / sampleRate));
}

// Renders one 16-column level-difference chunk with A in the session and B as
// the reference, returning the RGBA bytes.
function renderLevelDiff(core: Exports, a: Float32Array, b: Float32Array, sampleRate: number): Uint8Array {
  const sampleCount = a.length;
  assert.equal(core.wave_prepare_session(sampleCount, sampleRate, sampleCount / sampleRate), 1);
  new Float32Array(core.memory.buffer, core.wave_get_pcm_ptr(), sampleCount).set(a);
  const referencePointer = core.wave_prepare_reference(sampleCount);
  assert.ok(referencePointer > 0);
  new Float32Array(core.memory.buffer, referencePointer, sampleCount).set(b);

  const columns = 16;
  const rows = 64;
  const output = core.malloc(columns * rows * 4);
  const ok = core.wave_render_spectrogram_level_diff_tile_rgba(
    0, sampleCount, 0, columns, columns, rows, 0, 2048, 1,
    20, sampleRate / 2, SPECTROGRAM, LOG_SCALE, -100, 12, HANN, output,
  );
  assert.equal(ok, 1);
  const rgba = new Uint8Array(core.memory.buffer, output, columns * rows * 4).slice();
  core.free(output);
  return rgba;
}

function brightestPixel(rgba: Uint8Array): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0];
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset] + rgba[offset + 1] + rgba[offset + 2] > best[0] + best[1] + best[2]) {
      best = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
    }
  }
  return best;
}

test('identical A and B render the neutral level-difference color', async () => {
  const core = await loadCore();
  const signal = tone(32768, 48000, 0.5);
  const [r, g, b] = brightestPixel(renderLevelDiff(core, signal, signal, 48000));
  assert.ok(r <= 30 && g <= 30 && b <= 40, `expected neutral, got ${r},${g},${b}`);
});

test('a louder A reads warm and a louder B reads cool', async () => {
  const core = await loadCore();
  const loud = tone(32768, 48000, 0.5);
  const quiet = tone(32768, 48000, 0.125);

  const [warmR, , warmB] = brightestPixel(renderLevelDiff(core, loud, quiet, 48000));
  assert.ok(warmR > 200 && warmR > warmB, `A louder: ${warmR},${warmB}`);

  const [coolR, , coolB] = brightestPixel(renderLevelDiff(core, quiet, loud, 48000));
  assert.ok(coolB > 200 && coolB > coolR, `B louder: ${coolR},${coolB}`);
});

test('swapping the reference in and out leaves the session samples intact', async () => {
  const core = await loadCore();
  const a = tone(4096, 48000, 0.5);
  const b = tone(4096, 48000, 0.25);
  renderLevelDiff(core, a, b, 48000);
  const session = new Float32Array(core.memory.buffer, core.wave_get_pcm_ptr(), a.length);
  assert.equal(session[100], a[100]);
});
