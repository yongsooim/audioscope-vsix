import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DebugTimelineEventPayload } from './debugTimeline';

const EMBEDDED_TOOL_DIRECTORY = path.resolve(__dirname, '..', 'dist', 'embedded-tools');
const EMBEDDED_MANIFEST_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'manifest.json');
const EXEC_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const EMBEDDED_TOOL_RUNNER_SOURCE = String.raw`
const fs = require('node:fs');
const toolPath = process.argv[1];
const inputHostPath = process.argv[2];
const outputHostPath = process.argv[3];
const virtualInputPath = process.argv[4];
const toolArgs = JSON.parse(process.argv[5]);

globalThis.__audioscopeModule = {
  arguments: toolArgs,
  preRun: [() => {
    const data = fs.readFileSync(inputHostPath);
    globalThis.__audioscopeModule.FS_writeFile(virtualInputPath, data);
  }],
  postRun: outputHostPath ? [() => {
    try {
      const data = globalThis.__audioscopeModule.FS_readFile('/output.wav');
      fs.writeFileSync(outputHostPath, Buffer.from(data));
    } catch {
      // Preserve the tool's original stderr/exit code when output was not produced.
    }
  }] : [],
};

require(toolPath);
`;

type EmbeddedToolName = 'ffmpeg' | 'ffprobe';

interface DirectDecodeModule {
  FS: {
    unlink(path: string): void;
    writeFile(path: string, data: Uint8Array | Buffer): void;
  };
  HEAPU8: Uint8Array;
  _free(pointer: number): void;
  _malloc(byteLength: number): number;
  _wave_clear_decode_output(): void;
  _wave_decode_file(pathPointer: number): number;
  _wave_get_last_error_length(): number;
  _wave_get_last_error_ptr(): number;
  _wave_get_output_channel_byte_length(): number;
  _wave_get_output_channel_count(): number;
  _wave_get_output_channel_ptr(channelIndex: number): number;
  _wave_get_output_frame_count(): number;
  _wave_get_output_sample_rate(): number;
}

interface DirectDecodeModuleFactory {
  (options?: Record<string, unknown>): Promise<DirectDecodeModule>;
}

interface EmbeddedToolManifest {
  builtAt?: string;
  ffmpegRevision?: string;
}

export interface EmbeddedExecutableStatus {
  available: boolean;
  backend: 'bundled';
  command: string;
  path: string | null;
  version: string | null;
}

interface PreparedResourceHandle {
  cleanup: () => Promise<void>;
  inputPath: string;
  tempDirectoryPath: string;
}

export interface EmbeddedPcmDecodePayload {
  byteLength: number;
  channelBuffers: ArrayBuffer[];
  frameCount: number;
  numberOfChannels: number;
  sampleRate: number;
  source: 'ffmpeg';
}

export interface EmbeddedLoudnessSummaryPayload {
  channelCount: number | null;
  channelLayout: string | null;
  integratedLufs: number | null;
  integratedThresholdLufs: number | null;
  loudnessRangeLu: number | null;
  lraHighLufs: number | null;
  lraLowLufs: number | null;
  rangeThresholdLufs: number | null;
  samplePeakDbfs: number | null;
  truePeakDbtp: number | null;
}

const DIRECT_DECODE_MODULE_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffdecode_module.js');
const DIRECT_DECODE_WASM_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffdecode_module.wasm');
const LOUDNESS_EXECUTABLE_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffloudness');
const LOUDNESS_EXECUTABLE_WASM_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffloudness.wasm');

let directDecodeModulePromise: Promise<DirectDecodeModule> | null = null;
let directDecodeQueue = Promise.resolve();
let manifestCache: EmbeddedToolManifest | null | undefined;

function getEmbeddedScriptPath(toolName: EmbeddedToolName): string {
  return path.join(EMBEDDED_TOOL_DIRECTORY, toolName);
}

function getEmbeddedWasmPath(toolName: EmbeddedToolName): string {
  return path.join(
    EMBEDDED_TOOL_DIRECTORY,
    toolName === 'ffmpeg' ? 'ffmpeg.wasm' : 'ffprobe_g.wasm',
  );
}

function readEmbeddedManifestSync(): EmbeddedToolManifest | null {
  if (manifestCache !== undefined) {
    return manifestCache;
  }

  try {
    manifestCache = JSON.parse(fs.readFileSync(EMBEDDED_MANIFEST_PATH, 'utf8')) as EmbeddedToolManifest;
  } catch {
    manifestCache = null;
  }

  return manifestCache;
}

function formatEmbeddedVersion(toolName: EmbeddedToolName): string {
  const manifest = readEmbeddedManifestSync();
  const revision = manifest?.ffmpegRevision?.slice(0, 7);

  return revision
    ? `wasm (${toolName} @ ${revision})`
    : 'wasm';
}

export function getEmbeddedExecutableStatusSync(toolName: EmbeddedToolName): EmbeddedExecutableStatus {
  const scriptPath = getEmbeddedScriptPath(toolName);
  const wasmPath = getEmbeddedWasmPath(toolName);
  const available = fs.existsSync(scriptPath) && fs.existsSync(wasmPath);

  return {
    available,
    backend: 'bundled',
    command: `${toolName}.wasm`,
    path: available ? scriptPath : null,
    version: available ? formatEmbeddedVersion(toolName) : null,
  };
}

async function prepareResourceHandle(resource: vscode.Uri): Promise<PreparedResourceHandle> {
  const tempDirectoryPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'audioscope-embedded-'));

  if (resource.scheme === 'file') {
    return {
      cleanup: async () => {
        await fsp.rm(tempDirectoryPath, { force: true, recursive: true });
      },
      inputPath: resource.fsPath,
      tempDirectoryPath,
    };
  }

  const bytes = await vscode.workspace.fs.readFile(resource);
  const extension = path.extname(resource.path) || '.bin';
  const inputPath = path.join(tempDirectoryPath, `input${extension}`);
  await fsp.writeFile(inputPath, Buffer.from(bytes));

  return {
    cleanup: async () => {
      await fsp.rm(tempDirectoryPath, { force: true, recursive: true });
    },
    inputPath,
    tempDirectoryPath,
  };
}

function getExecErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return String(error);
}

function hasDirectDecodeModule(): boolean {
  return fs.existsSync(DIRECT_DECODE_MODULE_PATH) && fs.existsSync(DIRECT_DECODE_WASM_PATH);
}

function hasLoudnessExecutable(): boolean {
  return fs.existsSync(LOUDNESS_EXECUTABLE_PATH) && fs.existsSync(LOUDNESS_EXECUTABLE_WASM_PATH);
}

async function loadDirectDecodeModule(): Promise<DirectDecodeModule> {
  if (!directDecodeModulePromise) {
    const requiredModule = require(DIRECT_DECODE_MODULE_PATH) as DirectDecodeModuleFactory | { default?: DirectDecodeModuleFactory };
    const factory = typeof requiredModule === 'function'
      ? requiredModule
      : requiredModule.default;

    if (typeof factory !== 'function') {
      throw new Error('Embedded direct FFmpeg decode module factory is unavailable.');
    }

    directDecodeModulePromise = factory({
      locateFile: (fileName: string) => path.join(EMBEDDED_TOOL_DIRECTORY, fileName),
      noInitialRun: true,
    });
  }

  return directDecodeModulePromise;
}

function allocateUtf8(module: DirectDecodeModule, value: string): number {
  const encoded = Buffer.from(`${value}\0`, 'utf8');
  const pointer = module._malloc(encoded.byteLength);
  module.HEAPU8.set(encoded, pointer);
  return pointer;
}

function readUtf8(module: DirectDecodeModule, pointer: number, byteLength: number): string {
  if (!pointer || byteLength <= 0) {
    return '';
  }

  return Buffer.from(module.HEAPU8.slice(pointer, pointer + byteLength)).toString('utf8').replace(/\0+$/u, '');
}

function enqueueDirectDecodeTask<T>(task: () => Promise<T>): Promise<T> {
  const nextTask = directDecodeQueue.then(task, task);
  directDecodeQueue = nextTask.then(() => undefined, () => undefined);
  return nextTask;
}

function execFileAsync(command: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          stderr: stderr ?? '',
          stdout: stdout ?? '',
        });
      },
    );
  });
}

export async function runEmbeddedFfprobe(resource: vscode.Uri, timeout: number): Promise<string> {
  const toolStatus = getEmbeddedExecutableStatusSync('ffprobe');

  if (!toolStatus.available || !toolStatus.path) {
    throw new Error('ffprobe.wasm is unavailable.');
  }

  const resourceHandle = await prepareResourceHandle(resource);
  const virtualInputPath = `/input${path.extname(resourceHandle.inputPath) || '.bin'}`;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '-e',
        EMBEDDED_TOOL_RUNNER_SOURCE,
        toolStatus.path,
        resourceHandle.inputPath,
        '',
        virtualInputPath,
        JSON.stringify([
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          '-show_chapters',
          virtualInputPath,
        ]),
      ],
      timeout,
    );

    return stdout;
  } finally {
    await resourceHandle.cleanup();
  }
}

export async function runEmbeddedFfmpegDecodeToWav(
  resource: vscode.Uri,
  timeout: number,
  onDebugTimelineEvent?: (event: DebugTimelineEventPayload) => void | Promise<void>,
): Promise<{ audioBuffer: ArrayBuffer; byteLength: number; mimeType: 'audio/wav' }> {
  const toolStatus = getEmbeddedExecutableStatusSync('ffmpeg');

  if (!toolStatus.available || !toolStatus.path) {
    throw new Error('ffmpeg.wasm is unavailable.');
  }

  const emitDebugTimelineEvent = (label: string, detail?: string): void => {
    void onDebugTimelineEvent?.({
      detail,
      label,
      source: 'host',
      timeMs: Date.now(),
    });
  };
  const resourceHandle = await prepareResourceHandle(resource);
  const outputPath = path.join(resourceHandle.tempDirectoryPath, 'output.wav');
  const virtualInputPath = `/input${path.extname(resourceHandle.inputPath) || '.bin'}`;

  emitDebugTimelineEvent('host.decodeFallback.ffmpeg.embedded.spawn.start', toolStatus.path);

  try {
    await execFileAsync(
      process.execPath,
      [
        '-e',
        EMBEDDED_TOOL_RUNNER_SOURCE,
        toolStatus.path,
        resourceHandle.inputPath,
        outputPath,
        virtualInputPath,
        JSON.stringify([
          virtualInputPath,
          '/output.wav',
        ]),
      ],
      timeout,
    );

    const wavBuffer = await fsp.readFile(outputPath);
    emitDebugTimelineEvent('host.decodeFallback.ffmpeg.embedded.output.ready', `bytes=${wavBuffer.byteLength}`);
    const arrayBuffer = wavBuffer.buffer.slice(
      wavBuffer.byteOffset,
      wavBuffer.byteOffset + wavBuffer.byteLength,
    );

    return {
      audioBuffer: arrayBuffer,
      byteLength: wavBuffer.byteLength,
      mimeType: 'audio/wav',
    };
  } catch (error) {
    emitDebugTimelineEvent('host.decodeFallback.ffmpeg.embedded.error', getExecErrorMessage(error));
    throw error;
  } finally {
    await resourceHandle.cleanup();
  }
}

export async function runEmbeddedFfmpegMeasureLoudness(
  resource: vscode.Uri,
  timeout: number,
): Promise<EmbeddedLoudnessSummaryPayload> {
  if (!hasLoudnessExecutable()) {
    throw new Error('ffloudness.wasm is unavailable.');
  }

  const resourceHandle = await prepareResourceHandle(resource);
  const virtualInputPath = `/input${path.extname(resourceHandle.inputPath) || '.bin'}`;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '-e',
        EMBEDDED_TOOL_RUNNER_SOURCE,
        LOUDNESS_EXECUTABLE_PATH,
        resourceHandle.inputPath,
        '',
        virtualInputPath,
        JSON.stringify([
          virtualInputPath,
        ]),
      ],
      timeout,
    );

    try {
      return JSON.parse(stdout) as EmbeddedLoudnessSummaryPayload;
    } catch (error) {
      throw new Error(`ffloudness returned invalid JSON: ${getExecErrorMessage(error)}`);
    }
  } finally {
    await resourceHandle.cleanup();
  }
}

export async function runEmbeddedFfmpegDecodeToPcm(
  resource: vscode.Uri,
  onDebugTimelineEvent?: (event: DebugTimelineEventPayload) => void | Promise<void>,
): Promise<EmbeddedPcmDecodePayload> {
  if (!hasDirectDecodeModule()) {
    throw new Error('Direct FFmpeg decode module is unavailable.');
  }

  return enqueueDirectDecodeTask(async () => {
    const emitDebugTimelineEvent = (label: string, detail?: string): void => {
      void onDebugTimelineEvent?.({
        detail,
        label,
        source: 'host',
        timeMs: Date.now(),
      });
    };
    const resourceHandle = await prepareResourceHandle(resource);
    const module = await loadDirectDecodeModule();
    const virtualInputPath = `/input${path.extname(resourceHandle.inputPath) || '.bin'}`;

    emitDebugTimelineEvent('host.decodeFallback.ffmpeg.embedded.module.start', DIRECT_DECODE_MODULE_PATH);

    try {
      module.FS.writeFile(virtualInputPath, await fsp.readFile(resourceHandle.inputPath));
      const pathPointer = allocateUtf8(module, virtualInputPath);
      const decodeResult = module._wave_decode_file(pathPointer);
      module._free(pathPointer);

      if (decodeResult !== 0) {
        throw new Error(readUtf8(
          module,
          module._wave_get_last_error_ptr(),
          module._wave_get_last_error_length(),
        ) || 'Direct FFmpeg decode failed.');
      }

      const channelCount = Math.max(0, module._wave_get_output_channel_count());
      const frameCount = Math.max(0, module._wave_get_output_frame_count());
      const sampleRate = Math.max(1, module._wave_get_output_sample_rate());
      const channelByteLength = Math.max(0, module._wave_get_output_channel_byte_length());
      const channelBuffers: ArrayBuffer[] = [];

      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channelPointer = module._wave_get_output_channel_ptr(channelIndex);
        if (!channelPointer || channelByteLength <= 0) {
          throw new Error(`Embedded direct FFmpeg decode returned an invalid channel buffer at index ${channelIndex}.`);
        }

        const copiedBytes = module.HEAPU8.slice(channelPointer, channelPointer + channelByteLength);
        channelBuffers.push(copiedBytes.buffer);
      }

      emitDebugTimelineEvent(
        'host.decodeFallback.ffmpeg.embedded.module.ready',
        `channels=${channelCount} frames=${frameCount} rate=${sampleRate}`,
      );

      return {
        byteLength: channelBuffers.reduce((total, buffer) => total + buffer.byteLength, 0),
        channelBuffers,
        frameCount,
        numberOfChannels: channelCount,
        sampleRate,
        source: 'ffmpeg',
      };
    } catch (error) {
      emitDebugTimelineEvent('host.decodeFallback.ffmpeg.embedded.module.error', getExecErrorMessage(error));
      throw error;
    } finally {
      try {
        module._wave_clear_decode_output();
      } catch {}
      try {
        module.FS.unlink(virtualInputPath);
      } catch {}
      await resourceHandle.cleanup();
    }
  });
}
