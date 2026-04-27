import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EMBEDDED_TOOL_DIRECTORY = path.resolve(__dirname, '..', 'dist', 'embedded-tools');
const EMBEDDED_MANIFEST_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'manifest.json');
const EMBEDDED_TOOL_RUNNER_SOURCE = String.raw`
const fs = require('node:fs');
const toolPath = process.argv[1];
const inputHostPath = process.argv[2];
const outputHostPath = process.argv[3];
const virtualInputPath = process.argv[4];
const toolArgs = JSON.parse(process.argv[5]);
const outputMode = process.argv[6] || 'none';

globalThis.__audioscopeModule = {
  arguments: toolArgs,
  preRun: [() => {
    const data = inputHostPath ? fs.readFileSync(inputHostPath) : fs.readFileSync(0);
    globalThis.__audioscopeModule.FS_writeFile(virtualInputPath, data);
  }],
  postRun: outputMode === 'stdout-binary' ? [() => {
    try {
      const data = globalThis.__audioscopeModule.FS_readFile('/output.wav');
      process.stdout.write(Buffer.from(data));
    } catch {
      // Preserve the tool's original stderr/exit code when output was not produced.
    }
  }] : outputHostPath ? [() => {
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
  _wave_decode_file_with_loudness(pathPointer: number): number;
  _wave_measure_loudness_from_decoded_output(): number;
  _wave_get_last_error_length(): number;
  _wave_get_last_error_ptr(): number;
  _wave_get_output_channel_byte_length(): number;
  _wave_get_output_channel_count(): number;
  _wave_get_output_channel_layout_length(): number;
  _wave_get_output_channel_layout_ptr(): number;
  _wave_get_output_channel_ptr(channelIndex: number): number;
  _wave_get_output_frame_count(): number;
  _wave_get_loudness_integrated_lufs(): number;
  _wave_get_loudness_integrated_threshold_lufs(): number;
  _wave_get_loudness_lra_high_lufs(): number;
  _wave_get_loudness_lra_low_lufs(): number;
  _wave_get_loudness_range_lu(): number;
  _wave_get_loudness_range_threshold_lufs(): number;
  _wave_get_loudness_sample_peak_dbfs(): number;
  _wave_get_loudness_true_peak_dbtp(): number;
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

interface PreparedToolInput {
  hostPath: string | null;
  stdinData: Uint8Array | Buffer | null;
}

export interface EmbeddedPcmDecodePayload {
  byteLength: number;
  channelBuffers: ArrayBuffer[];
  frameCount: number;
  numberOfChannels: number;
  sampleRate: number;
  source: 'ffmpeg';
}

export interface EmbeddedPcmDecodeWithLoudnessPayload {
  decode: EmbeddedPcmDecodePayload;
  loudness: EmbeddedLoudnessSummaryPayload;
}

export interface EmbeddedPcmDecodeLoudnessPipelinePayload {
  decode: EmbeddedPcmDecodePayload;
  loudnessPromise: Promise<EmbeddedLoudnessSummaryPayload>;
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
let directDecodeLogMessages: string[] = [];

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

function getCliReadablePathCandidate(resource: vscode.Uri): string | null {
  return typeof resource.fsPath === 'string' && resource.fsPath.trim().length > 0
    ? resource.fsPath
    : null;
}

async function getCliReadablePath(resource: vscode.Uri): Promise<string | null> {
  const candidate = getCliReadablePathCandidate(resource);

  if (!candidate) {
    return null;
  }

  try {
    await fsp.access(candidate, fs.constants.R_OK);
    return candidate;
  } catch {
    return null;
  }
}

async function prepareToolInput(resource: vscode.Uri): Promise<PreparedToolInput> {
  const hostPath = await getCliReadablePath(resource);

  if (hostPath) {
    return {
      hostPath,
      stdinData: null,
    };
  }

  return {
    hostPath: null,
    stdinData: await vscode.workspace.fs.readFile(resource),
  };
}

async function readResourceBytes(resource: vscode.Uri): Promise<Uint8Array | Buffer> {
  const hostPath = await getCliReadablePath(resource);

  if (hostPath) {
    return fsp.readFile(hostPath);
  }

  return vscode.workspace.fs.readFile(resource);
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
      print: () => {},
      printErr: (message: unknown) => {
        directDecodeLogMessages.push(String(message ?? ''));
      },
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

function copyToArrayBuffer(bytes: Uint8Array | Buffer): ArrayBuffer {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return ownedBytes.buffer;
}

function spawnProcessAsync(
  command: string,
  args: string[],
  {
    stdinData = null,
    timeout,
  }: {
    stdinData?: Uint8Array | Buffer | null;
    timeout: number;
  },
): Promise<{ stderr: Buffer; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let didTimeout = false;
    let settled = false;
    let timeoutId: NodeJS.Timeout | null = null;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      callback();
    };

    child.stdout.on('data', (chunk: Buffer | Uint8Array | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | Uint8Array | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on('close', (code, signal) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);

        if (code === 0 && signal === null && !didTimeout) {
          resolve({ stderr, stdout });
          return;
        }

        const stderrText = stderr.toString('utf8').trim();
        const reason = didTimeout
          ? `Command timed out after ${timeout}ms`
          : signal
            ? `Command exited with signal ${signal}`
            : `Command exited with code ${code ?? 'unknown'}`;
        reject(new Error(stderrText ? `${reason}: ${stderrText}` : reason));
      });
    });

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        didTimeout = true;
        child.kill('SIGKILL');
      }, timeout);
    }

    if (stdinData && stdinData.byteLength > 0) {
      child.stdin.end(Buffer.isBuffer(stdinData) ? stdinData : Buffer.from(stdinData));
      return;
    }

    child.stdin.end();
  });
}

export async function runEmbeddedFfprobe(resource: vscode.Uri, timeout: number): Promise<string> {
  const toolStatus = getEmbeddedExecutableStatusSync('ffprobe');

  if (!toolStatus.available || !toolStatus.path) {
    throw new Error('ffprobe.wasm is unavailable.');
  }

  const preparedInput = await prepareToolInput(resource);
  const virtualInputPath = `/input${path.extname(preparedInput.hostPath || resource.path) || '.bin'}`;
  const { stdout } = await spawnProcessAsync(
    process.execPath,
    [
      '-e',
      EMBEDDED_TOOL_RUNNER_SOURCE,
      toolStatus.path,
      preparedInput.hostPath ?? '',
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
      'none',
    ],
    {
      stdinData: preparedInput.stdinData,
      timeout,
    },
  );

  return stdout.toString('utf8');
}

export async function runEmbeddedFfmpegDecodeToWav(
  resource: vscode.Uri,
  timeout: number,
): Promise<{ audioBuffer: ArrayBuffer; byteLength: number; mimeType: 'audio/wav' }> {
  const toolStatus = getEmbeddedExecutableStatusSync('ffmpeg');

  if (!toolStatus.available || !toolStatus.path) {
    throw new Error('ffmpeg.wasm is unavailable.');
  }

  const preparedInput = await prepareToolInput(resource);
  const virtualInputPath = `/input${path.extname(preparedInput.hostPath || resource.path) || '.bin'}`;
  const { stdout } = await spawnProcessAsync(
    process.execPath,
    [
      '-e',
      EMBEDDED_TOOL_RUNNER_SOURCE,
      toolStatus.path,
      preparedInput.hostPath ?? '',
      '',
      virtualInputPath,
      JSON.stringify([
        virtualInputPath,
        '/output.wav',
      ]),
      'stdout-binary',
    ],
    {
      stdinData: preparedInput.stdinData,
      timeout,
    },
  );

  if (stdout.byteLength <= 0) {
    throw new Error('ffmpeg did not produce WAV output.');
  }

  return {
    audioBuffer: copyToArrayBuffer(stdout),
    byteLength: stdout.byteLength,
    mimeType: 'audio/wav',
  };
}

export async function runEmbeddedFfmpegMeasureLoudness(
  resource: vscode.Uri,
  timeout: number,
): Promise<EmbeddedLoudnessSummaryPayload> {
  if (!hasLoudnessExecutable()) {
    throw new Error('ffloudness.wasm is unavailable.');
  }

  const preparedInput = await prepareToolInput(resource);
  const virtualInputPath = `/input${path.extname(preparedInput.hostPath || resource.path) || '.bin'}`;
  const { stdout } = await spawnProcessAsync(
    process.execPath,
    [
      '-e',
      EMBEDDED_TOOL_RUNNER_SOURCE,
      LOUDNESS_EXECUTABLE_PATH,
      preparedInput.hostPath ?? '',
      '',
      virtualInputPath,
      JSON.stringify([
        virtualInputPath,
      ]),
      'none',
    ],
    {
      stdinData: preparedInput.stdinData,
      timeout,
    },
  );
  const outputText = stdout.toString('utf8');

  try {
    return JSON.parse(outputText) as EmbeddedLoudnessSummaryPayload;
  } catch (error) {
    throw new Error(`ffloudness returned invalid JSON: ${getExecErrorMessage(error)}`);
  }
}

export async function runEmbeddedFfmpegDecodeToPcm(
  resource: vscode.Uri,
): Promise<EmbeddedPcmDecodePayload> {
  const result = await runEmbeddedDirectDecode(resource);
  return result.decode;
}

export async function startEmbeddedFfmpegDecodeToPcmWithDeferredLoudness(
  resource: vscode.Uri,
): Promise<EmbeddedPcmDecodeLoudnessPipelinePayload> {
  if (!hasDirectDecodeModule()) {
    throw new Error('Direct FFmpeg decode module is unavailable.');
  }

  let decodeResolved = false;
  let resolveDecode: ((value: EmbeddedPcmDecodePayload) => void) | null = null;
  let rejectDecode: ((reason?: unknown) => void) | null = null;
  let resolveLoudness: ((value: EmbeddedLoudnessSummaryPayload) => void) | null = null;
  let rejectLoudness: ((reason?: unknown) => void) | null = null;
  const decodePromise = new Promise<EmbeddedPcmDecodePayload>((resolve, reject) => {
    resolveDecode = resolve;
    rejectDecode = reject;
  });
  const loudnessPromise = new Promise<EmbeddedLoudnessSummaryPayload>((resolve, reject) => {
    resolveLoudness = resolve;
    rejectLoudness = reject;
  });

  void enqueueDirectDecodeTask(async () => {
    const module = await loadDirectDecodeModule();
    const inputBytes = await readResourceBytes(resource);
    const virtualInputPath = `/input${path.extname(resource.path) || '.bin'}`;
    directDecodeLogMessages = [];

    try {
      module.FS.writeFile(virtualInputPath, inputBytes);
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

      const decode = readDirectDecodePayload(module);
      decodeResolved = true;
      resolveDecode?.(decode);

      directDecodeLogMessages = [];
      const loudnessResult = module._wave_measure_loudness_from_decoded_output();
      if (loudnessResult !== 0) {
        throw new Error(readUtf8(
          module,
          module._wave_get_last_error_ptr(),
          module._wave_get_last_error_length(),
        ) || 'Direct FFmpeg loudness analysis failed.');
      }

      resolveLoudness?.(readDirectDecodeLoudnessSummary(module, decode.numberOfChannels));
    } catch (error) {
      if (!decodeResolved) {
        rejectDecode?.(error);
      }
      rejectLoudness?.(error);
    } finally {
      try {
        module._wave_clear_decode_output();
      } catch {}
      try {
        module.FS.unlink(virtualInputPath);
      } catch {}
    }
  });

  return {
    decode: await decodePromise,
    loudnessPromise,
  };
}

export async function runEmbeddedFfmpegDecodeToPcmWithLoudness(
  resource: vscode.Uri,
): Promise<EmbeddedPcmDecodeWithLoudnessPayload> {
  const result = await runEmbeddedDirectDecode(resource, true);
  return result;
}

async function runEmbeddedDirectDecode(
  resource: vscode.Uri,
  withLoudness = false,
): Promise<EmbeddedPcmDecodeWithLoudnessPayload> {
  if (!hasDirectDecodeModule()) {
    throw new Error('Direct FFmpeg decode module is unavailable.');
  }

  return enqueueDirectDecodeTask(async () => {
    const module = await loadDirectDecodeModule();
    const inputBytes = await readResourceBytes(resource);
    const virtualInputPath = `/input${path.extname(resource.path) || '.bin'}`;
    directDecodeLogMessages = [];

    try {
      module.FS.writeFile(virtualInputPath, inputBytes);
      const pathPointer = allocateUtf8(module, virtualInputPath);
      const decodeResult = withLoudness
        ? module._wave_decode_file_with_loudness(pathPointer)
        : module._wave_decode_file(pathPointer);
      module._free(pathPointer);

      if (decodeResult !== 0) {
        throw new Error(readUtf8(
          module,
          module._wave_get_last_error_ptr(),
          module._wave_get_last_error_length(),
        ) || 'Direct FFmpeg decode failed.');
      }

      const decode = readDirectDecodePayload(module);

      return {
        decode,
        loudness: readDirectDecodeLoudnessSummary(module, decode.numberOfChannels),
      };
    } catch (error) {
      throw error;
    } finally {
      try {
        module._wave_clear_decode_output();
      } catch {}
      try {
        module.FS.unlink(virtualInputPath);
      } catch {}
    }
  });
}

function readDirectDecodePayload(module: DirectDecodeModule): EmbeddedPcmDecodePayload {
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

  return {
    byteLength: channelBuffers.reduce((total, buffer) => total + buffer.byteLength, 0),
    channelBuffers,
    frameCount,
    numberOfChannels: channelCount,
    sampleRate,
    source: 'ffmpeg',
  };
}

function normalizeDirectDecodeLoudnessValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readDirectDecodeLoudnessSummary(
  module: DirectDecodeModule,
  channelCount: number,
): EmbeddedLoudnessSummaryPayload {
  const channelLayoutPointer = module._wave_get_output_channel_layout_ptr();
  const channelLayoutLength = module._wave_get_output_channel_layout_length();
  const channelLayout = channelLayoutPointer && channelLayoutLength > 0
    ? readUtf8(module, channelLayoutPointer, channelLayoutLength)
    : '';

  const thresholdMatches = [...directDecodeLogMessages.join('\n').matchAll(/Threshold:\s+(-?\d+(?:\.\d+)?) LUFS/gu)];
  const integratedThresholdLufs = thresholdMatches[0] ? Number(thresholdMatches[0][1]) : null;
  const rangeThresholdLufs = thresholdMatches[1] ? Number(thresholdMatches[1][1]) : null;

  return {
    channelCount: channelCount > 0 ? channelCount : null,
    channelLayout: channelLayout.trim().length > 0 ? channelLayout.trim() : null,
    integratedLufs: normalizeDirectDecodeLoudnessValue(module._wave_get_loudness_integrated_lufs()),
    integratedThresholdLufs: normalizeDirectDecodeLoudnessValue(integratedThresholdLufs),
    loudnessRangeLu: normalizeDirectDecodeLoudnessValue(module._wave_get_loudness_range_lu()),
    lraHighLufs: normalizeDirectDecodeLoudnessValue(module._wave_get_loudness_lra_high_lufs()),
    lraLowLufs: normalizeDirectDecodeLoudnessValue(module._wave_get_loudness_lra_low_lufs()),
    rangeThresholdLufs: normalizeDirectDecodeLoudnessValue(rangeThresholdLufs),
    samplePeakDbfs: normalizeDirectDecodeLoudnessValue(module._wave_get_loudness_sample_peak_dbfs()),
    truePeakDbtp: normalizeDirectDecodeLoudnessValue(module._wave_get_loudness_true_peak_dbtp()),
  };
}
