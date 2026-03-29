import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

await build({
  entryPoints: [
    path.join(projectRoot, 'src-webview', 'audioPreview.ts'),
    path.join(projectRoot, 'src-webview', 'audioAnalysisWorker.ts'),
    path.join(projectRoot, 'src-webview', 'interactiveWaveformWorker.ts'),
  ],
  outdir: path.join(projectRoot, 'media'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  entryNames: '[name]',
  sourcemap: false,
  logLevel: 'silent',
});
