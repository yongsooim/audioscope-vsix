import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

await build({
  entryPoints: [
    path.join(projectRoot, 'src-webview', 'audioAnalysisWorker.js'),
    path.join(projectRoot, 'src-webview', 'interactiveWaveformWorker.js'),
  ],
  outdir: path.join(projectRoot, 'media'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  entryNames: '[name]',
  sourcemap: false,
  external: ['module'],
  loader: {
    '.wasm': 'binary',
  },
  logLevel: 'silent',
});
