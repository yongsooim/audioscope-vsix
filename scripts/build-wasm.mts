import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const distRoot = path.join(projectRoot, 'dist', 'wasm');

const commonCompileArgs = [
  'build-exe',
  path.join(projectRoot, 'src-wasm', 'wasm_core.zig'),
  '-target',
  'wasm32-freestanding',
  '-O',
  'ReleaseFast',
  '-fstrip',
  '-fno-entry',
  '-rdynamic',
  '--export-memory',
  '--stack',
  '1048576',
  '--initial-memory=8388608',
  '-I',
  path.join(projectRoot, 'src-wasm', 'freestanding', 'include'),
  '-I',
  path.join(projectRoot, 'src-wasm', 'third_party', 'pffft'),
  '-I',
  path.join(projectRoot, 'src-wasm', 'third_party', 'libebur128', 'ebur128'),
];

const commonCFlags = [
  '-std=c11',
  '-O3',
  '-DNDEBUG',
  '-ffast-math',
  '-fno-math-errno',
  '-ffunction-sections',
  '-fdata-sections',
];

const cSources = [
  path.join(projectRoot, 'src-wasm', 'third_party', 'pffft', 'pffft.c'),
  path.join(projectRoot, 'src-wasm', 'third_party', 'libebur128', 'ebur128', 'ebur128.c'),
];

const variants = [
  {
    artifactName: 'wasm_core_simd.wasm',
    cFlags: [...commonCFlags, '-msimd128'],
    cpu: 'generic+simd128',
  },
  {
    artifactName: 'wasm_core_fallback.wasm',
    cFlags: [...commonCFlags, '-DPFFFT_SIMD_DISABLE=1'],
    cpu: 'generic',
  },
] as const;

async function main(): Promise<void> {
  await fs.mkdir(distRoot, { recursive: true });

  for (const variant of variants) {
    const outputPath = path.join(distRoot, variant.artifactName);
    await run('zig', [
      ...commonCompileArgs,
      '-mcpu',
      variant.cpu,
      '-cflags',
      ...variant.cFlags,
      '--',
      ...cSources,
      `-femit-bin=${outputPath}`,
    ]);
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      reject(new Error(`Failed to launch ${command}: ${getErrorMessage(error)}`));
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
