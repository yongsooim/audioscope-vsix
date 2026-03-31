import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const ffmpegSourceDir = path.join(projectRoot, 'wasm', 'third_party', 'ffmpeg');
const buildRoot = path.join(projectRoot, '.ffmpeg-build');
const outputRoot = path.join(projectRoot, 'dist', 'embedded-tools');
const jobCount = String(Math.max(1, Math.min(8, os.availableParallelism())));

interface ToolSpec {
  buildDirName: string;
  browserModuleOutputBaseName?: string;
  customExecutableSource?: string;
  configureArgs: string[];
  directModuleSource?: string;
  directModuleOutputBaseName?: string;
  name: 'ffmpeg' | 'ffprobe';
  outputs: string[];
}

const sharedConfigureArgs = [
  '--cc=emcc',
  '--cxx=em++',
  '--ar=emar',
  '--ranlib=emranlib',
  '--nm=nm',
  '--target-os=none',
  '--arch=wasm',
  '--enable-cross-compile',
  '--disable-asm',
  '--disable-inline-asm',
  '--disable-doc',
  '--disable-debug',
  '--disable-network',
  '--disable-autodetect',
  '--disable-iconv',
  '--enable-small',
  '--disable-runtime-cpudetect',
  '--disable-pthreads',
  '--disable-w32threads',
  '--disable-os2threads',
  '--disable-avdevice',
  '--disable-ffplay',
  '--disable-everything',
  '--enable-avcodec',
  '--enable-avformat',
  '--enable-avutil',
  '--enable-protocol=file',
  '--enable-demuxer=aac',
  '--enable-demuxer=aiff',
  '--enable-demuxer=flac',
  '--enable-demuxer=mov',
  '--enable-demuxer=mp3',
  '--enable-demuxer=ogg',
  '--enable-demuxer=wav',
  '--enable-decoder=aac',
  '--enable-decoder=alac',
  '--enable-decoder=flac',
  '--enable-decoder=mp3float',
  '--enable-decoder=opus',
  '--enable-decoder=pcm_f32be',
  '--enable-decoder=pcm_f32le',
  '--enable-decoder=pcm_s16be',
  '--enable-decoder=pcm_s16le',
  '--enable-decoder=pcm_s24be',
  '--enable-decoder=pcm_s24le',
  '--enable-decoder=pcm_s32be',
  '--enable-decoder=pcm_s32le',
  '--enable-decoder=pcm_u8',
  '--enable-decoder=vorbis',
  '--enable-parser=aac',
  '--enable-parser=flac',
  '--enable-parser=mpegaudio',
  '--enable-parser=opus',
  '--enable-parser=vorbis',
];

const toolSpecs: ToolSpec[] = [
  {
    buildDirName: 'ffprobe',
    configureArgs: [
      ...sharedConfigureArgs,
      '--disable-ffmpeg',
      '--disable-swresample',
      '--disable-swscale',
      '--disable-avfilter',
      '--enable-ffprobe',
    ],
    name: 'ffprobe',
    outputs: ['ffprobe', 'ffprobe_g.wasm'],
  },
  {
    buildDirName: 'ffmpeg',
    configureArgs: [
      ...sharedConfigureArgs,
      '--disable-ffmpeg',
      '--disable-ffprobe',
      '--enable-swresample',
      '--enable-muxer=wav',
      '--enable-encoder=pcm_f32le',
    ],
    customExecutableSource: path.join(projectRoot, 'wasm', 'embedded', 'ffdecode.c'),
    browserModuleOutputBaseName: 'ffdecode_browser_module',
    directModuleOutputBaseName: 'ffdecode_module',
    directModuleSource: path.join(projectRoot, 'wasm', 'embedded', 'ffdecode_module.c'),
    name: 'ffmpeg',
    outputs: [
      'ffmpeg',
      'ffmpeg.wasm',
      'ffdecode_browser_module.js',
      'ffdecode_browser_module.wasm',
      'ffdecode_module.js',
      'ffdecode_module.wasm',
    ],
  },
];

async function main(): Promise<void> {
  await ensureExecutableOnPath('emconfigure');
  await ensureExecutableOnPath('emmake');

  if (!fs.existsSync(ffmpegSourceDir)) {
    throw new Error('FFmpeg submodule is missing. Run `git submodule update --init --recursive` first.');
  }

  await fsp.mkdir(buildRoot, { recursive: true });
  await fsp.mkdir(outputRoot, { recursive: true });

  const ffmpegRevision = (await capture('git', ['-C', ffmpegSourceDir, 'rev-parse', 'HEAD'])).trim();

  for (const spec of toolSpecs) {
    await buildTool(spec, ffmpegRevision);
  }

  await fsp.writeFile(
    path.join(outputRoot, 'manifest.json'),
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        ffmpegRevision,
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function buildTool(spec: ToolSpec, ffmpegRevision: string): Promise<void> {
  const buildDir = path.join(buildRoot, spec.buildDirName);
  const stampPath = path.join(buildDir, '.stamp.json');
  const nextStamp = JSON.stringify({
    configureArgs: spec.configureArgs,
    ffmpegRevision,
    tool: spec.name,
  });

  const outputsReady = await hasOutputs(buildDir, spec.outputs);
  const previousStamp = await readOptionalFile(stampPath);

  if (!outputsReady || previousStamp !== nextStamp) {
    await fsp.rm(buildDir, { force: true, recursive: true });
    await fsp.mkdir(buildDir, { recursive: true });

    await run('emconfigure', [path.join(ffmpegSourceDir, 'configure'), ...spec.configureArgs], {
      cwd: buildDir,
    });
    await run('emmake', ['make', '-j', jobCount], {
      cwd: buildDir,
    });

    if (spec.customExecutableSource) {
      await buildCustomExecutable(spec, buildDir);
    }

    if (spec.directModuleSource && spec.directModuleOutputBaseName) {
      await buildDirectModule(spec, buildDir);
    }

    if (spec.directModuleSource && spec.browserModuleOutputBaseName) {
      await buildBrowserDirectModule(spec, buildDir);
    }

    await fsp.writeFile(stampPath, nextStamp, 'utf8');
  }

  for (const outputName of spec.outputs) {
    const outputPath = path.join(outputRoot, outputName);
    await fsp.copyFile(path.join(buildDir, outputName), outputPath);
    if (outputName === spec.name) {
      await patchGeneratedLauncher(outputPath);
    }
  }
}

async function hasOutputs(directory: string, outputNames: string[]): Promise<boolean> {
  for (const outputName of outputNames) {
    try {
      await fsp.access(path.join(directory, outputName), fs.constants.R_OK);
    } catch {
      return false;
    }
  }

  return true;
}

async function ensureExecutableOnPath(command: string): Promise<void> {
  await capture(process.platform === 'win32' ? 'where' : 'which', [command]);
}

async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
        return;
      }

      reject(new Error(Buffer.concat(stderrChunks).toString('utf8').trim() || `${command} exited with code ${code}.`));
    });
  });
}

async function run(command: string, args: string[], options: { cwd: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function buildCustomExecutable(spec: ToolSpec, buildDir: string): Promise<void> {
  if (!spec.customExecutableSource) {
    return;
  }

  await run(
    'emcc',
    [
      '-O3',
      '-s',
      'ALLOW_MEMORY_GROWTH=1',
      '-s',
      'FORCE_FILESYSTEM=1',
      '-s',
      'EXIT_RUNTIME=1',
      '-s',
      'ENVIRONMENT=node',
      '-I',
      ffmpegSourceDir,
      '-I',
      buildDir,
      spec.customExecutableSource,
      '-L',
      path.join(buildDir, 'libavformat'),
      '-L',
      path.join(buildDir, 'libavcodec'),
      '-L',
      path.join(buildDir, 'libswresample'),
      '-L',
      path.join(buildDir, 'libavutil'),
      '-lavformat',
      '-lavcodec',
      '-lswresample',
      '-lavutil',
      '-lm',
      '-o',
      path.join(buildDir, spec.name),
    ],
    {
      cwd: buildDir,
    },
  );
}

async function buildDirectModule(spec: ToolSpec, buildDir: string): Promise<void> {
  if (!spec.directModuleSource || !spec.directModuleOutputBaseName) {
    return;
  }

  await run(
    'emcc',
    [
      '-O3',
      '-s',
      'ALLOW_MEMORY_GROWTH=1',
      '-s',
      'FORCE_FILESYSTEM=1',
      '-s',
      'ENVIRONMENT=node',
      '-s',
      'MODULARIZE=1',
      '-s',
      'EXPORT_ES6=0',
      '-s',
      'EXPORT_ALL=1',
      '-s',
      'EXPORT_NAME=createWaveScopeFFDecodeModule',
      '-s',
      'EXPORTED_RUNTIME_METHODS=["FS","ccall","UTF8ToString"]',
      '-s',
      'EXPORTED_FUNCTIONS=["_malloc","_free","_wave_decode_file","_wave_get_output_channel_count","_wave_get_output_sample_rate","_wave_get_output_frame_count","_wave_get_output_channel_ptr","_wave_get_output_channel_byte_length","_wave_clear_decode_output","_wave_get_last_error_ptr","_wave_get_last_error_length"]',
      '-I',
      ffmpegSourceDir,
      '-I',
      buildDir,
      spec.directModuleSource,
      '-L',
      path.join(buildDir, 'libavformat'),
      '-L',
      path.join(buildDir, 'libavcodec'),
      '-L',
      path.join(buildDir, 'libswresample'),
      '-L',
      path.join(buildDir, 'libavutil'),
      '-lavformat',
      '-lavcodec',
      '-lswresample',
      '-lavutil',
      '-lm',
      '-o',
      path.join(buildDir, `${spec.directModuleOutputBaseName}.js`),
    ],
    {
      cwd: buildDir,
    },
  );
}

async function buildBrowserDirectModule(spec: ToolSpec, buildDir: string): Promise<void> {
  if (!spec.directModuleSource || !spec.browserModuleOutputBaseName) {
    return;
  }

  await run(
    'emcc',
    [
      '-O3',
      '-s',
      'ALLOW_MEMORY_GROWTH=1',
      '-s',
      'FORCE_FILESYSTEM=1',
      '-s',
      'ENVIRONMENT=web,worker',
      '-s',
      'MODULARIZE=1',
      '-s',
      'EXPORT_ES6=1',
      '-s',
      'EXPORT_ALL=1',
      '-s',
      'EXPORTED_RUNTIME_METHODS=["FS","ccall","UTF8ToString","stringToUTF8"]',
      '-s',
      'EXPORTED_FUNCTIONS=["_malloc","_free","_wave_decode_file","_wave_get_output_channel_count","_wave_get_output_sample_rate","_wave_get_output_frame_count","_wave_get_output_channel_ptr","_wave_get_output_channel_byte_length","_wave_clear_decode_output","_wave_get_last_error_ptr","_wave_get_last_error_length"]',
      '-I',
      ffmpegSourceDir,
      '-I',
      buildDir,
      spec.directModuleSource,
      '-L',
      path.join(buildDir, 'libavformat'),
      '-L',
      path.join(buildDir, 'libavcodec'),
      '-L',
      path.join(buildDir, 'libswresample'),
      '-L',
      path.join(buildDir, 'libavutil'),
      '-lavformat',
      '-lavcodec',
      '-lswresample',
      '-lavutil',
      '-lm',
      '-o',
      path.join(buildDir, `${spec.browserModuleOutputBaseName}.js`),
    ],
    {
      cwd: buildDir,
    },
  );
}

async function patchGeneratedLauncher(filePath: string): Promise<void> {
  const source = await fsp.readFile(filePath, 'utf8');
  const patched = source
    .replace(
      "var Module = typeof Module != 'undefined' ? Module : {};",
      "var Module = globalThis.__waveScopeModule || (typeof Module != 'undefined' ? Module : {});",
    )
    .replace(
      'var Module=typeof Module!="undefined"?Module:{};',
      'var Module=globalThis.__waveScopeModule||(typeof Module!="undefined"?Module:{});',
    )
    .replace(
      'var FS_createDataFile = (...args) => FS.createDataFile(...args);',
      'var FS_createDataFile = (...args) => FS.createDataFile(...args); Module["FS_createDataFile"] = FS_createDataFile; Module["FS_readFile"] = (...args) => FS.readFile(...args); Module["FS_writeFile"] = (...args) => FS.writeFile(...args);',
    )
    .replace(
      'var FS_createDataFile=(...args)=>FS.createDataFile(...args);',
      'var FS_createDataFile=(...args)=>FS.createDataFile(...args);Module["FS_createDataFile"]=FS_createDataFile;Module["FS_readFile"]=(...args)=>FS.readFile(...args);Module["FS_writeFile"]=(...args)=>FS.writeFile(...args);',
    )
    .replace(
      "Module['FS_createDataFile'] = FS_createDataFile;",
      "Module['FS_createDataFile'] = FS_createDataFile; Module['FS_readFile'] = (...args) => FS.readFile(...args); Module['FS_writeFile'] = (...args) => FS.writeFile(...args);",
    )
    .replace(
      'Module["FS_createDataFile"]=FS_createDataFile;',
      'Module["FS_createDataFile"]=FS_createDataFile;Module["FS_readFile"]=(...args)=>FS.readFile(...args);Module["FS_writeFile"]=(...args)=>FS.writeFile(...args);',
    );

  if (patched !== source) {
    await fsp.writeFile(filePath, patched, 'utf8');
  }
}

await main();
