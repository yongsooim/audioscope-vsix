import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const preferredPythonCandidates = [
  process.env.EMSDK_PYTHON,
  '/opt/homebrew/bin/python3.11',
  '/opt/homebrew/bin/python3.12',
  '/opt/homebrew/bin/python3.13',
  '/opt/homebrew/bin/python3.14',
].filter(Boolean);
const emsdkPython = preferredPythonCandidates.find((candidate) => fs.existsSync(candidate)) ?? process.env.EMSDK_PYTHON;

const args = [
  path.join(projectRoot, 'native', 'wave_core.c'),
  path.join(projectRoot, 'native', 'third_party', 'pffft', 'pffft.c'),
  '-O3',
  '-I',
  path.join(projectRoot, 'native'),
  '-I',
  path.join(projectRoot, 'native', 'third_party', 'pffft'),
  '-o',
  path.join(projectRoot, 'media', 'wave_core.js'),
  '-s',
  'WASM=1',
  '-s',
  'ALLOW_MEMORY_GROWTH=1',
  '-s',
  'MODULARIZE=1',
  '-s',
  'EXPORT_ES6=1',
  '-s',
  'ENVIRONMENT=web,worker',
  '-s',
  'EXPORTED_FUNCTIONS=["_malloc","_free","_wave_prepare_session","_wave_get_pcm_ptr","_wave_build_waveform_pyramid","_wave_extract_waveform_slice","_wave_render_spectrogram_tile_rgba","_wave_dispose_session"]',
  '-s',
  'EXPORTED_RUNTIME_METHODS=["HEAPF32","HEAPU8"]',
  '-D',
  'PFFFT_SIMD_DISABLE=1',
];

await new Promise((resolve, reject) => {
  const child = spawn('emcc', args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...(emsdkPython ? { EMSDK_PYTHON: emsdkPython } : {}),
    },
    stdio: 'inherit',
  });

  child.on('error', reject);
  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`emcc exited with code ${code}`));
  });
});
