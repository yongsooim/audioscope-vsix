import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

await build({
  input: {
    audioscope: path.join(projectRoot, 'src-webview', 'app.ts'),
    audioEngineWorker: path.join(projectRoot, 'src-webview', 'audioEngineWorker.ts'),
    audioAnalysisWorker: path.join(projectRoot, 'src-webview', 'audio-analysis', 'worker.ts'),
    embeddedDecodeWorker: path.join(projectRoot, 'src-webview', 'embeddedDecodeWorker.ts'),
    interactiveWaveformWorker: path.join(projectRoot, 'src-webview', 'interactive-waveform', 'worker.ts'),
    audioTransportProcessor: path.join(projectRoot, 'src-webview', 'transport', 'audioTransportProcessor.ts'),
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
