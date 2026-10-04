import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { audioCodecConfigureArgs } from './audio-codec-config.mts';
import { createRequire } from 'node:module';
import type { NativeTarget } from '../src/nativePlatform.ts';
const { inspectNativeBinary, versionAtLeast } = createRequire(import.meta.url)('../src/nativePlatform.ts') as typeof import('../src/nativePlatform.ts');

const projectRoot = path.resolve(import.meta.dirname, '..');
const sourceDir = path.join(projectRoot, 'src-wasm', 'third_party', 'ffmpeg');
const target = process.platform + '-' + process.arch;
const buildRoot = path.join(projectRoot, '.ffmpeg-build', 'native-' + target);
const buildDir = path.join(buildRoot, 'ffmpeg');
const prefix = path.join(buildRoot, 'prefix');
const outputDir = path.join(projectRoot, '.artifacts', 'native-tools', target);
const liveDir = path.join(projectRoot, 'dist', 'native-tools', target);
const nativeFlags = process.platform === 'darwin' ? ['-mmacosx-version-min=12.0'] : [];
const ebur128Flags = target === 'darwin-arm64' ? ['-fno-slp-vectorize'] : [];
const nativePath = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
const compiler = process.env.CC || 'cc';
const extension = process.platform === 'win32' ? '.exe' : '';
const jobs = String(Math.max(1, Math.min(8, os.availableParallelism())));
const lameVersion = '3.100';
const lameSha256 = 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e';
const lamePrefix = path.join(buildRoot, 'lame-prefix');

async function run(command: string, args: string[], cwd = buildRoot, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    // MSYS2 translates POSIX paths in pkg-config output for native Windows compilers.
    const compileOnWindows = process.platform === 'win32' && command === compiler;
    const executable = compileOnWindows ? 'sh' : command;
    const commandArgs = compileOnWindows ? ['-c', 'exec "$@"', 'audioscope-cc', command, ...args] : args;
    const child = spawn(executable, commandArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(command + ' exited with code ' + code + '\n' + Buffer.concat(stderr).toString('utf8').slice(-8000)));
    });
  });
}

async function hashFile(file: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}

async function ensureLame(): Promise<void> {
  const stampPath = path.join(lamePrefix, '.stamp.json');
  const stamp = JSON.stringify({ lameVersion, lameSha256, compiler, nativeFlags });
  if (fs.existsSync(path.join(lamePrefix, 'lib', 'libmp3lame.a'))
      && await fsp.readFile(stampPath, 'utf8').catch(() => '') === stamp) return;
  await fsp.rm(lamePrefix, { recursive: true, force: true });
  await fsp.rm(path.join(buildRoot, 'lame-' + lameVersion), { recursive: true, force: true });
  const tarball = path.join(projectRoot, '.ffmpeg-build', 'lame-' + lameVersion + '.tar.gz');
  if (!fs.existsSync(tarball) || await hashFile(tarball) !== lameSha256) {
    const url = 'https://downloads.sourceforge.net/project/lame/lame/' + lameVersion + '/lame-' + lameVersion + '.tar.gz';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Unable to download LAME: ' + response.status);
    await fsp.writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  }
  if (await hashFile(tarball) !== lameSha256) throw new Error('LAME checksum mismatch.');
  await run('tar', [...(process.platform === 'win32' ? ['--force-local'] : []), '-xzf', nativePath(tarball)]);
  const lameSource = path.join(buildRoot, 'lame-' + lameVersion);
  console.log('Building native LAME (' + target + ')…');
  await run('sh', [
    nativePath(path.join(lameSource, 'configure')), '--prefix=' + nativePath(lamePrefix),
    ...(process.platform === 'win32' ? ['--host=' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64') + '-w64-mingw32'] : []),
    '--disable-shared', '--enable-static', '--disable-frontend',
    '--disable-analyzer-hooks', '--disable-gtktest', '--disable-decoder',
    'CC=' + compiler, 'CFLAGS=' + ['-O3', ...nativeFlags].join(' '),
  ], lameSource);
  await run('make', ['-j', jobs, 'install'], lameSource);
  await fsp.writeFile(stampPath, stamp);
}

async function main(): Promise<void> {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    throw new Error('Native media tools are not supported on ' + target + '; use the WASM build.');
  }
  await fsp.mkdir(buildRoot, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });
  await ensureLame();
  const revision = (await run('git', ['-C', sourceDir, 'rev-parse', 'HEAD'])).trim();
  const configureArgs = [
    '--prefix=' + nativePath(prefix), '--cc=' + compiler,
    '--disable-shared', '--enable-static', '--enable-pic',
    '--disable-doc', '--disable-debug', '--disable-network',
    '--disable-autodetect', '--disable-iconv', '--disable-avdevice',
    '--disable-ffmpeg', '--disable-ffplay', '--disable-everything',
    ...(process.platform === 'win32' ? [
      '--target-os=mingw32', '--arch=' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64'),
      '--enable-w32threads', '--disable-pthreads',
    ] : []),
    ...audioCodecConfigureArgs,
    '--enable-ffprobe', '--enable-swresample', '--enable-swscale',
    '--enable-avfilter', '--enable-filter=ebur128',
    '--enable-muxer=wav,flac,ipod,mp3',
    '--enable-encoder=pcm_f32le,pcm_s16le,flac,aac,libmp3lame',
    '--enable-libmp3lame',
    '--extra-cflags=' + ['-O3', ...nativeFlags, '-I' + nativePath(path.join(lamePrefix, 'include'))].join(' '),
    '--extra-ldflags=' + [...nativeFlags, '-L' + nativePath(path.join(lamePrefix, 'lib')),
      ...(process.platform === 'win32' ? ['-static', '-static-libgcc'] : [])].join(' '),
  ];
  const stamp = JSON.stringify({ revision, configureArgs, lameSha256, ebur128Flags });
  const stampPath = path.join(buildDir, '.stamp.json');
  const previous = await fsp.readFile(stampPath, 'utf8').catch(() => '');
  if (previous !== stamp || !fs.existsSync(path.join(prefix, 'lib', 'libavcodec.a'))) {
    console.log('Building native FFmpeg (' + target + ')…');
    await fsp.rm(buildDir, { recursive: true, force: true });
    await fsp.mkdir(buildDir, { recursive: true });
    await run('sh', [nativePath(path.join(sourceDir, 'configure')), ...configureArgs], buildDir);
    if (ebur128Flags.length) {
      await fsp.appendFile(path.join(buildDir, 'ffbuild', 'config.mak'),
        '\nlibavfilter/f_ebur128.o: CFLAGS += ' + ebur128Flags.join(' ') + '\n');
    }
    await run('make', ['-j', jobs, 'install'], buildDir);
    await fsp.writeFile(stampPath, stamp);
  }
  const env = {
    ...process.env,
    PKG_CONFIG_PATH: nativePath(path.join(prefix, 'lib', 'pkgconfig')) + path.delimiter + (process.env.PKG_CONFIG_PATH || ''),
  };
  const linkFlags = (await run('pkg-config', [
    '--static', '--libs', 'libavfilter', 'libavformat', 'libavcodec',
    'libswresample', 'libswscale', 'libavutil',
  ], buildRoot, env)).trim().split(/\s+/u);
  const tools = [
    ['ffdecode', 'ffdecode_native.c'],
    ['ffdecode-wav', 'ffdecode.c'],
    ['ffloudness', 'ffloudness.c'],
    ['ffencode', 'ffencode.c'],
  ];
  const embeddedDir = path.join(projectRoot, 'src-wasm', 'embedded');
  for (const [name, file] of tools) {
    await run(compiler, [
      '-O3', ...nativeFlags, '-I', nativePath(prefix) + '/include', '-I', nativePath(sourceDir), '-I', nativePath(buildDir),
      '-Dmain=audioscope_main', '-include', nativePath(path.join(embeddedDir, 'native_io.h')),
      nativePath(path.join(embeddedDir, file)), nativePath(path.join(embeddedDir, 'native_main.c')),
      '-L', nativePath(path.join(lamePrefix, 'lib')), ...linkFlags,
      ...(process.platform === 'win32' ? ['-lshell32', '-static', '-static-libgcc'] : []),
      '-o', nativePath(path.join(outputDir, name + extension)),
    ]);
  }
  await fsp.copyFile(path.join(prefix, 'bin', 'ffprobe' + extension), path.join(outputDir, 'ffprobe' + extension));
  for (const name of ['ffprobe', ...tools.map(([name]) => name)]) {
    await fsp.chmod(path.join(outputDir, name + extension), 0o755);
  }
  const sha256: Record<string, string> = {};
  let minimumGlibcVersion: string | undefined;
  for (const name of ['ffprobe', ...tools.map(([name]) => name)]) {
    const file = path.join(outputDir, name + extension);
    const bytes = await fsp.readFile(file);
    const info = inspectNativeBinary(bytes);
    if (info.target !== target) throw new Error('Binary architecture mismatch: ' + name + ' is ' + info.target);
    if (process.platform === 'darwin' && info.minimumMacOS !== '12.0.0') {
      throw new Error('Unexpected macOS deployment target: ' + name + ' ' + info.minimumMacOS);
    }
    sha256[name + extension] = createHash('sha256').update(bytes).digest('hex');
    if (process.platform === 'win32') {
      const imports = await run(compiler === 'clang' ? 'llvm-objdump' : 'objdump', ['-p', file]);
      const dependencies = [...imports.matchAll(/DLL Name:\s*(\S+)/gu)].map((match) => match[1].toLowerCase());
      if (!dependencies.length) throw new Error('Unable to inspect Windows dependencies: ' + name);
      for (const dependency of dependencies) {
        if (!/^(?:kernel32|advapi32|shell32|user32|ole32|ws2_32|bcrypt|msvcrt|ucrtbase)\.dll$/u.test(dependency)
            && !/^api-ms-win-crt-[a-z0-9-]+\.dll$/u.test(dependency)) {
          throw new Error('Unbundled Windows runtime dependency: ' + name + ' ' + dependency);
        }
      }
    }
    if (process.platform === 'linux') {
      const versions = [...(await run('readelf', ['--version-info', file])).matchAll(/GLIBC_(\d+\.\d+)/gu)].map((match) => match[1]);
      for (const version of versions) {
        if (!minimumGlibcVersion || versionAtLeast(version, minimumGlibcVersion)) minimumGlibcVersion = version;
      }
    }
  }
  if (process.platform === 'linux' && !minimumGlibcVersion) throw new Error('Unable to determine required glibc version.');
  const sourceSha256: Record<string, string> = {};
  for (const name of ['ffdecode.c', 'ffdecode_module.c', 'ffdecode_native.c', 'ffloudness.c', 'ffencode.c',
    'loudness_graph.h', 'native_io.h', 'native_main.c']) {
    sourceSha256[name] = await hashFile(path.join(embeddedDir, name));
  }
  await fsp.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
    schema: 1, target: target as NativeTarget, ffmpegRevision: revision, compiler,
    builtAt: new Date().toISOString(), configureArgs, sha256, sourceSha256,
    ebur128Flags,
    minimumKernelRelease: process.platform === 'darwin' ? '21.0.0' : process.platform === 'win32' ? '10.0.0' : undefined,
    minimumGlibcVersion,
  }, null, 2) + '\n');
  await fsp.rm(liveDir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(liveDir), { recursive: true });
  await fsp.cp(outputDir, liveDir, { recursive: true });
  console.log('Native media tools ready: ' + path.relative(projectRoot, outputDir));
}

await main();
