import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mediaTools, nativeTools, resourceFor, withBackend, setNativeDecodingForTest } from './media-tools-harness.mts';

const root = path.resolve(import.meta.dirname, '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audioscope native test-'));
const input = path.join(directory, '오디오 ; $sample.wav');
const sampleRate = 48_000;
const channels = 6;
const frames = sampleRate * 4;
const wav = Buffer.alloc(44 + frames * channels * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(channels, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * channels * 2, 28);
wav.writeUInt16LE(channels * 2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let frame = 0; frame < frames; frame++) {
  for (let channel = 0; channel < channels; channel++) {
    const amplitude = frame < sampleRate * 2 ? 0.2 : 0.4;
    const value = Math.sin(frame * 2 * Math.PI * (211 + channel * 37) / sampleRate) * amplitude;
    wav.writeInt16LE(Math.round(value * 32767), 44 + (frame * channels + channel) * 2);
  }
}
await fs.writeFile(input, wav);
test.after(() => fs.rm(directory, { recursive: true, force: true }));

async function decode(file: string, backend: 'native' | 'wasm') {
  return withBackend(backend, async () => {
    const pipeline = await mediaTools.runEmbeddedFfmpegDecodeLoudnessPipeline(resourceFor(file));
    return { decode: pipeline.decode, summary: await pipeline.loudnessPromise };
  });
}

test('native PCM preserves every channel and sample; loudness agrees with WASM', async () => {
  await withBackend('native', async () => assert.equal(mediaTools.getEmbeddedExecutableStatusSync('ffmpeg').backend, 'native'));
  const native = await decode(input, 'native');
  const wasm = await decode(input, 'wasm');
  assert.equal(native.decode.sampleRate, sampleRate);
  assert.equal(native.decode.numberOfChannels, channels);
  assert.equal(native.decode.frameCount, frames);
  assert.deepEqual(native.decode.channelBuffers.map((buffer) => Buffer.from(buffer)), wasm.decode.channelBuffers.map((buffer) => Buffer.from(buffer)));
  for (const key of ['integratedLufs', 'loudnessRangeLu', 'samplePeakDbfs', 'truePeakDbtp'] as const) {
    assert.ok(Math.abs(native.summary[key]! - wasm.summary[key]!) <= 0.01,
      key + ' native=' + native.summary[key] + ' wasm=' + wasm.summary[key]);
  }
  assert.equal(native.summary.channelLayout, wasm.summary.channelLayout);
});

test('native ffprobe and standalone loudness retain the WASM metadata contract', async () => {
  const read = (backend: 'native' | 'wasm') => withBackend(backend, async () => ({
    metadata: JSON.parse(await mediaTools.runEmbeddedFfprobe(resourceFor(input), 30_000)),
    loudness: await mediaTools.runEmbeddedFfmpegMeasureLoudness(resourceFor(input), 30_000),
  }));
  const native = await read('native');
  const wasm = await read('wasm');
  for (const key of ['codec_name', 'sample_rate', 'channels', 'channel_layout', 'duration']) {
    assert.equal(native.metadata.streams[0][key], wasm.metadata.streams[0][key], key);
  }
  assert.ok(Math.abs(native.loudness.integratedLufs! - wasm.loudness.integratedLufs!) < 0.01,
    JSON.stringify({ native: native.loudness, wasm: wasm.loudness }));
  assert.ok(Math.abs(native.loudness.truePeakDbtp! - wasm.loudness.truePeakDbtp!) < 0.01,
    JSON.stringify({ native: native.loudness, wasm: wasm.loudness }));
});

test('native WAV/FLAC selections retain sample-accurate boundaries and contents', async () => {
  const start = 0.375013;
  const end = 1.234568;
  const expectedFrames = Math.round(end * sampleRate) - Math.round(start * sampleRate);
  for (const format of ['wav', 'flac'] as const) {
    const nativeFile = path.join(directory, 'native.' + format);
    const wasmFile = path.join(directory, 'wasm.' + format);
    for (const [backend, file] of [['native', nativeFile], ['wasm', wasmFile]] as const) {
      await withBackend(backend, () => mediaTools.runEmbeddedFfencodeExport(resourceFor(input), file, format, start, end, 30_000));
    }
    const native = await decode(nativeFile, 'native');
    const wasm = await decode(wasmFile, 'wasm');
    assert.equal(native.decode.frameCount, expectedFrames);
    assert.equal(wasm.decode.frameCount, expectedFrames);
    assert.deepEqual(native.decode.channelBuffers.map((buffer) => Buffer.from(buffer)), wasm.decode.channelBuffers.map((buffer) => Buffer.from(buffer)));
  }
});

test('native AAC/MP3 exports decode with the expected sample rate and channel limits', async () => {
  for (const format of ['m4a', 'mp3'] as const) {
    const dimensions = [];
    for (const backend of ['native', 'wasm'] as const) {
      const file = path.join(directory, backend + '.' + format);
      await withBackend(backend, () => mediaTools.runEmbeddedFfencodeExport(resourceFor(input), file, format, 0.25, 2.75, 30_000));
      const result = await decode(file, backend);
      assert.equal(result.decode.sampleRate, sampleRate);
      assert.equal(result.decode.numberOfChannels, format === 'mp3' ? 2 : channels);
      assert.ok(Number.isFinite(result.summary.integratedLufs));
      dimensions.push(result.decode.frameCount);
    }
    assert.equal(dimensions[0], dimensions[1]);
  }
});

test('non-file resources use a temporary native input without losing PCM', async () => {
  const resource: any = { fsPath: '', path: '/virtual.wav', bytes: wav };
  const result = await withBackend('native', async () => {
    const pipeline = await mediaTools.runEmbeddedFfmpegDecodeLoudnessPipeline(resource);
    await pipeline.loudnessPromise;
    return pipeline.decode;
  });
  assert.equal(result.frameCount, frames);
  assert.equal(result.numberOfChannels, channels);
});

test('native execution failure falls back to the packaged WASM decoder', async () => {
  const restoreDecoding = setNativeDecodingForTest(true);
  const original = nativeTools.getNativeExecutablePath;
  const originalWarn = console.warn;
  let warnings = 0;
  nativeTools.getNativeExecutablePath = (name) => name === 'ffdecode' ? path.join(directory, 'missing-executable') : original(name);
  console.warn = () => warnings++;
  try {
    const pipeline = await mediaTools.runEmbeddedFfmpegDecodeLoudnessPipeline(resourceFor(input));
    await pipeline.loudnessPromise;
    assert.equal(pipeline.decode.frameCount, frames);
    assert.equal(warnings, 1);
  } finally {
    restoreDecoding();
    nativeTools.getNativeExecutablePath = original;
    console.warn = originalWarn;
  }
});

test('native helper errors after PCM delivery reject loudness without discarding audio', async () => {
  const helper = path.join(directory, 'partial.cjs');
  await fs.writeFile(helper, [
    'const header = Buffer.alloc(16); header.write("ADP1");',
    'header.writeUInt32LE(48000,4); header.writeUInt32LE(1,8); header.writeUInt32LE(4,12);',
    'require("node:fs").writeFileSync(process.argv[2], Buffer.alloc(16)); process.stdout.write(header);',
    'setTimeout(() => process.exit(1), 50);',
  ].join('\n'));
  const pipeline = await nativeTools.runNativeDecodeLoudnessPipeline(process.execPath, helper, 5_000);
  assert.equal(pipeline.decode.frameCount, 4);
  await assert.rejects(pipeline.loudnessPromise, /exited/u);
});

test('native probe, export, WAV decode, and standalone loudness failures use WASM', async () => {
  const restoreDecoding = setNativeDecodingForTest(true);
  const original = nativeTools.getNativeExecutablePath;
  const originalWarn = console.warn;
  let warnings = 0;
  nativeTools.getNativeExecutablePath = () => path.join(directory, 'missing-executable');
  console.warn = () => warnings++;
  try {
    const resource = resourceFor(input);
    const metadata = JSON.parse(await mediaTools.runEmbeddedFfprobe(resource, 30_000));
    assert.equal(metadata.streams[0].channels, channels);
    const summary = await mediaTools.runEmbeddedFfmpegMeasureLoudness(resource, 30_000);
    assert.ok(Number.isFinite(summary.integratedLufs));
    const decoded = await mediaTools.runEmbeddedFfmpegDecodeToWav(resource, 30_000);
    assert.ok(decoded.byteLength > 44);
    const target = path.join(directory, 'fallback.wav');
    await mediaTools.runEmbeddedFfencodeExport(resource, target, 'wav', 0.25, 1.25, 30_000);
    assert.ok((await fs.stat(target)).size > 44);
    assert.equal(warnings, 4);
  } finally {
    restoreDecoding();
    nativeTools.getNativeExecutablePath = original;
    console.warn = originalWarn;
  }
});

test('release defaults keep decode/loudness in WASM while metadata and export use native', async () => {
  const original = nativeTools.getNativeExecutablePath;
  const requested: string[] = [];
  nativeTools.getNativeExecutablePath = (name) => {
    requested.push(name);
    return original(name);
  };
  try {
    assert.equal(mediaTools.getEmbeddedExecutableStatusSync('ffmpeg').backend, 'bundled');
    assert.equal(mediaTools.getEmbeddedExecutableStatusSync('ffprobe').backend, 'native');
    const pipeline = await mediaTools.runEmbeddedFfmpegDecodeLoudnessPipeline(resourceFor(input));
    await pipeline.loudnessPromise;
    await mediaTools.runEmbeddedFfprobe(resourceFor(input), 30_000);
    await mediaTools.runEmbeddedFfencodeExport(resourceFor(input), path.join(directory, 'hybrid.wav'), 'wav', 0.25, 1.25, 30_000);
    assert.equal(requested.includes('ffdecode'), false);
    assert.equal(requested.includes('ffloudness'), false);
    assert.ok(requested.includes('ffprobe'));
    assert.ok(requested.includes('ffencode'));
  } finally {
    nativeTools.getNativeExecutablePath = original;
  }
});
test('native helper timeout terminates the subprocess', async () => {
  const helper = path.join(directory, 'timeout.cjs');
  await fs.writeFile(helper, 'setInterval(() => {}, 1000);');
  await assert.rejects(nativeTools.runNativeDecodeLoudnessPipeline(process.execPath, helper, 50), /timed out/u);
});

test('native timeout after PCM delivery rejects loudness and removes temporary PCM', async () => {
  const helper = path.join(directory, 'late-timeout.cjs');
  const marker = path.join(directory, 'pcm-path.txt');
  await fs.writeFile(helper, [
    'const fs = require("node:fs");',
    'const header = Buffer.alloc(16); header.write("ADP1");',
    'header.writeUInt32LE(48000,4); header.writeUInt32LE(1,8); header.writeUInt32LE(4,12);',
    'fs.writeFileSync(process.argv[2], Buffer.alloc(16));',
    'fs.writeFileSync(' + JSON.stringify(marker) + ', process.argv[2]);',
    'process.stdout.write(header); setInterval(() => {}, 1000);',
  ].join('\n'));
  const pipeline = await nativeTools.runNativeDecodeLoudnessPipeline(process.execPath, helper, 2_000);
  assert.equal(pipeline.decode.frameCount, 4);
  await assert.rejects(pipeline.loudnessPromise, /timed out/u);
  const pcm = await fs.readFile(marker, 'utf8');
  await assert.rejects(fs.stat(path.dirname(pcm)), { code: 'ENOENT' });
});
