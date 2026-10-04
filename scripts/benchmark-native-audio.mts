import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mediaTools, nativeTools, resourceFor, withBackend } from './media-tools-harness.mts';

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, 'benchmarks', 'native-audio');
const runs = Number(process.env.AUDIOSCOPE_BENCHMARK_RUNS || 5);
const initialLoadAverage = os.loadavg();
assert.ok(Number.isInteger(runs) && runs > 0);
assert.ok(nativeTools.getNativeExecutablePath('ffdecode'), 'Run bun run compile first.');
await fs.mkdir(directory, { recursive: true });

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

async function pipeline(file: string) {
  const start = performance.now();
  const result = await mediaTools.runEmbeddedFfmpegDecodeLoudnessPipeline(resourceFor(file));
  const decodeMs = performance.now() - start;
  const loudness = await result.loudnessPromise;
  return { decode: result.decode, loudness, decodeMs, totalMs: performance.now() - start };
}

function compareResults(native: Awaited<ReturnType<typeof pipeline>>, wasm: Awaited<ReturnType<typeof pipeline>>) {
  for (const key of ['sampleRate', 'numberOfChannels', 'frameCount'] as const) {
    assert.equal(native.decode[key], wasm.decode[key], key);
  }
  let maxPcmError = 0;
  for (let channel = 0; channel < native.decode.numberOfChannels; channel++) {
    const a = new Float32Array(native.decode.channelBuffers[channel]);
    const b = new Float32Array(wasm.decode.channelBuffers[channel]);
    for (let index = 0; index < a.length; index++) maxPcmError = Math.max(maxPcmError, Math.abs(a[index] - b[index]));
  }
  assert.ok(maxPcmError <= 0.00001, 'PCM mismatch: ' + maxPcmError);
  const loudnessDifferences: Record<string, number> = {};
  for (const key of ['integratedLufs', 'loudnessRangeLu', 'truePeakDbtp', 'samplePeakDbfs'] as const) {
    const a = native.loudness[key];
    const b = wasm.loudness[key];
    assert.equal(a === null, b === null, key);
    if (a !== null && b !== null) {
      const difference = Math.abs(a - b);
      loudnessDifferences[key] = difference;
      assert.ok(difference <= 0.01, key + ' mismatch: ' + difference);
    }
  }
  return { maxPcmError, loudnessDifferences };
}

// Lossless fixtures contain the same first two minutes decoded from the bundled
// M4A. Fixture generation is outside all timing measurements.
const original = path.join(root, 'exampleFiles', 'sample-full.m4a');
for (const format of ['wav', 'flac'] as const) {
  const file = path.join(directory, 'music-120s.' + format);
  await withBackend('native', () => mediaTools.runEmbeddedFfencodeExport(resourceFor(original), file, format, 0, 120, 120_000));
}
await withBackend('wasm', () => mediaTools.prewarmEmbeddedDirectDecodeModule());
const files = [
  path.join(root, 'exampleFiles', 'Go, With or Without Me.mp3'),
  original,
  path.join(directory, 'music-120s.flac'),
  path.join(directory, 'music-120s.wav'),
  path.join(root, 'exampleFiles', 'sample-tone.wav'),
];
const metrics = ['decodeMs', 'totalMs', 'probeMs', 'exportWavMs', 'exportMp3Ms'] as const;
const results = [];
for (const file of files) {
  console.log('Validating ' + path.basename(file) + '…');
  const nativeValidation = await withBackend('native', () => pipeline(file));
  const wasmValidation = await withBackend('wasm', () => pipeline(file));
  const parity = compareResults(nativeValidation, wasmValidation);
  const duration = nativeValidation.decode.frameCount / nativeValidation.decode.sampleRate;
  const start = duration > 30 ? 17.25 : 0.125;
  const end = Math.min(duration, start + 15);
  const samples: Record<'native' | 'wasm', Array<Record<typeof metrics[number], number>>> = { native: [], wasm: [] };
  // Alternate backend order to reduce bias from filesystem caches and heating.
  for (let iteration = 0; iteration < runs; iteration++) {
    const order = iteration % 2 ? ['wasm', 'native'] as const : ['native', 'wasm'] as const;
    for (const backend of order) {
      await withBackend(backend, async () => {
        const resource = resourceFor(file);
        const probe = await timed(() => mediaTools.runEmbeddedFfprobe(resource, 30_000));
        assert.equal(JSON.parse(probe.value).streams[0].sample_rate, String(nativeValidation.decode.sampleRate));
        const decoded = await pipeline(file);
        const wav = await timed(() => mediaTools.runEmbeddedFfencodeExport(
          resource, path.join(directory, 'export-' + backend + '.wav'), 'wav', start, end, 120_000,
        ));
        const mp3 = await timed(() => mediaTools.runEmbeddedFfencodeExport(
          resource, path.join(directory, 'export-' + backend + '.mp3'), 'mp3', start, end, 120_000,
        ));
        samples[backend].push({
          decodeMs: decoded.decodeMs, totalMs: decoded.totalMs, probeMs: probe.ms,
          exportWavMs: wav.ms, exportMp3Ms: mp3.ms,
        });
      });
    }
    console.log('  round ' + (iteration + 1) + '/' + runs);
  }
  const medians = Object.fromEntries(metrics.map((metric) => [metric, {
    nativeMs: median(samples.native.map((sample) => sample[metric])),
    wasmMs: median(samples.wasm.map((sample) => sample[metric])),
    speedup: median(samples.wasm.map((sample) => sample[metric])) / median(samples.native.map((sample) => sample[metric])),
  }]));
  results.push({
    file: path.relative(root, file),
    sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'),
    durationSeconds: duration, sampleRate: nativeValidation.decode.sampleRate,
    channels: nativeValidation.decode.numberOfChannels, frameCount: nativeValidation.decode.frameCount,
    exportRangeSeconds: [start, end], parity, samples, medians,
  });
  console.log(JSON.stringify({ file: path.basename(file), medians }));
}
const nativeManifest = JSON.parse(await fs.readFile(path.join(root, 'dist', 'native-tools', process.platform + '-' + process.arch, 'manifest.json'), 'utf8'));
const wasmManifest = JSON.parse(await fs.readFile(path.join(root, 'dist', 'embedded-tools', 'manifest.json'), 'utf8'));
assert.equal(nativeManifest.ffmpegRevision, wasmManifest.ffmpegRevision);
const report = {
  measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, memoryGiB: os.totalmem() / 1024 ** 3,
  initialLoadAverage, finalLoadAverage: os.loadavg(),
  node: process.version, ffmpegRevision: nativeManifest.ffmpegRevision, runs,
  nativeDecoderThreads: 'auto (thread_count=0); codec-dependent',
  nativeConfigureArgs: nativeManifest.configureArgs,
  method: 'Production host entry points; warmed WASM worker pool; fresh native process per request; one validation/warm-up per input; alternating serial runs; includes input reads, temporary PCM file delivery/cleanup for native, and channel buffers delivered to the host; excludes Webview rendering and fixture generation. Probe/export start fresh processes for both backends. Medians in milliseconds. Other applications were not stopped.',
  results,
};
await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const csv = ['file,duration_seconds,metric,native_ms,wasm_ms,speedup'];
for (const result of results) {
  for (const metric of metrics) {
    const value = result.medians[metric] as { nativeMs: number; wasmMs: number; speedup: number };
    csv.push([JSON.stringify(path.basename(result.file)), result.durationSeconds.toFixed(3), metric,
      value.nativeMs.toFixed(3), value.wasmMs.toFixed(3), value.speedup.toFixed(3)].join(','));
  }
}
await fs.writeFile(path.join(directory, 'results.csv'), csv.join('\n') + '\n');
console.log('Reports: ' + directory);
