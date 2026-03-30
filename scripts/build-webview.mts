import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

await build({
  input: {
    waveScope: path.join(projectRoot, 'src-webview', 'waveScope.ts'),
    audioAnalysisWorker: path.join(projectRoot, 'src-webview', 'audioAnalysisWorker.ts'),
    interactiveWaveformWorker: path.join(projectRoot, 'src-webview', 'interactiveWaveformWorker.ts'),
  },
  output: {
    dir: path.join(projectRoot, 'dist', 'webview'),
    entryFileNames: '[name].js',
    format: 'esm',
    sourcemap: false,
  },
  platform: 'browser',
  logLevel: 'silent',
  write: true,
});
