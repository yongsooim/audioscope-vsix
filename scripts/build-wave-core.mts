import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const freestandingIncludeDirectory = path.join(projectRoot, 'native', 'freestanding', 'include');
const pffftDirectory = path.join(projectRoot, 'native', 'third_party', 'pffft');
const libebur128Directory = path.join(projectRoot, 'native', 'third_party', 'libebur128');
const libebur128IncludeDirectory = path.join(libebur128Directory, 'ebur128');
const pffftSourcePath = path.join(pffftDirectory, 'pffft.c');
const ebur128SourcePath = path.join(libebur128IncludeDirectory, 'ebur128.c');

try {
  await fs.access(pffftSourcePath);
} catch {
  throw new Error(
    'Missing native/third_party/pffft/pffft.c. Run `git submodule update --init --recursive` before building.',
  );
}

try {
  await fs.access(ebur128SourcePath);
} catch {
  throw new Error(
    'Missing native/third_party/libebur128/ebur128/ebur128.c. Run `git submodule update --init --recursive` before building.',
  );
}

await Promise.all([
  fs.rm(path.join(projectRoot, 'media', 'wave_core.js'), { force: true }),
  fs.rm(path.join(projectRoot, 'media', 'wave_core.wasm'), { force: true }),
  fs.rm(path.join(projectRoot, 'media', 'wave_core_simd.wasm'), { force: true }),
  fs.rm(path.join(projectRoot, 'media', 'wave_core_fallback.wasm'), { force: true }),
]);

const zigCommonArgs = [
  'build-exe',
  path.join(projectRoot, 'native', 'wave_core.zig'),
  '-target',
  'wasm32-freestanding',
  '-O',
  'ReleaseFast',
  '-fno-entry',
  '-rdynamic',
  '--export-memory',
  '-fstrip',
  '--stack',
  `${1024 * 1024}`,
  `--initial-memory=${8 * 1024 * 1024}`,
];

const cCommonArgs = [
  '-target',
  'wasm32-freestanding',
  '-std=c11',
  '-O3',
  '-DNDEBUG',
  '-ffast-math',
  '-fno-math-errno',
  '-ffunction-sections',
  '-fdata-sections',
  '-I',
  freestandingIncludeDirectory,
  '-I',
  pffftDirectory,
  '-I',
  libebur128IncludeDirectory,
];

const buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-core-build-'));

try {
  await buildWaveCore({
    buildDirectory,
    name: 'wave_core_simd.wasm',
    mcpu: 'generic+simd128',
    pffftArgs: ['-msimd128'],
    objectName: 'pffft_simd.o',
  });

  await buildWaveCore({
    buildDirectory,
    name: 'wave_core_fallback.wasm',
    mcpu: 'generic',
    pffftArgs: ['-DPFFFT_SIMD_DISABLE=1'],
    objectName: 'pffft_fallback.o',
  });
} finally {
  await fs.rm(buildDirectory, { recursive: true, force: true });
}

async function buildWaveCore({ buildDirectory, name, mcpu, pffftArgs, objectName }) {
  const objectPath = path.join(buildDirectory, objectName);
  const ebur128ObjectPath = path.join(buildDirectory, `${path.parse(name).name}_ebur128.o`);

  await runCommand('zig', [
    'cc',
    ...cCommonArgs,
    ...pffftArgs,
    '-c',
    pffftSourcePath,
    '-o',
    objectPath,
  ]);

  await runCommand('zig', [
    'cc',
    ...cCommonArgs,
    '-c',
    ebur128SourcePath,
    '-o',
    ebur128ObjectPath,
  ]);

  const args = [
    ...zigCommonArgs,
    objectPath,
    ebur128ObjectPath,
    '-mcpu',
    mcpu,
    '-femit-bin=' + path.join(projectRoot, 'media', name),
  ];

  await runCommand('zig', args, `zig build for ${name}`);
}

async function runCommand(command, args, label = `${command} ${args.join(' ')}`) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} exited with code ${code}`));
    });
  });
}
