import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

await build({
  input: {
    audioPreview: path.join(projectRoot, 'src-webview', 'audioPreview.ts'),
    audioAnalysisWorker: path.join(projectRoot, 'src-webview', 'audioAnalysisWorker.ts'),
    interactiveWaveformWorker: path.join(projectRoot, 'src-webview', 'interactiveWaveformWorker.ts'),
  },
  output: {
    dir: path.join(projectRoot, 'media'),
    entryFileNames: '[name].js',
    format: 'esm',
    sourcemap: false,
  },
  platform: 'browser',
  logLevel: 'silent',
  write: true,
});
