import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputDir = path.join(projectRoot, 'dist', 'webview');

const sharedOutput = {
  dir: outputDir,
  entryFileNames: '[name].js',
  format: 'esm' as const,
  sourcemap: false,
};

const sharedOptions = {
  platform: 'browser' as const,
  logLevel: 'silent' as const,
  write: true,
};

// Main page bundle keeps shared chunks (it stays a normal multi-entry build).
await build({
  ...sharedOptions,
  input: { audioscope: path.join(projectRoot, 'src-webview', 'app.ts') },
  output: sharedOutput,
});

// Each worker is built as its own self-contained single file. This is required
// because VS Code 1.119's webview service worker (PR #311844) does not serve
// resource fetches initiated from blob workers, so any cross-origin module
// import inside a worker now hangs/fails. By inlining everything per worker,
// the worker has no further imports and avoids that broken code path.
const workerEntries: Array<[string, string]> = [
  ['audioEngineWorker', path.join(projectRoot, 'src-webview', 'audioEngineWorker.ts')],
  ['audioAnalysisWorker', path.join(projectRoot, 'src-webview', 'audio-analysis', 'worker.ts')],
  ['embeddedDecodeWorker', path.join(projectRoot, 'src-webview', 'embeddedDecodeWorker.ts')],
  ['interactiveWaveformWorker', path.join(projectRoot, 'src-webview', 'interactive-waveform', 'worker.ts')],
];

for (const [name, entry] of workerEntries) {
  await build({
    ...sharedOptions,
    input: { [name]: entry },
    output: { ...sharedOutput, inlineDynamicImports: true },
  });
}

// AudioWorklet is also a separate entry; keep its own build so it does not
// reach for shared chunks either.
await build({
  ...sharedOptions,
  input: { audioTransportProcessor: path.join(projectRoot, 'src-webview', 'transport', 'audioTransportProcessor.ts') },
  output: { ...sharedOutput, inlineDynamicImports: true },
});
