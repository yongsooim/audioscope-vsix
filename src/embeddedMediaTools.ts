import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
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
const virtualOutputPath = process.argv[7] || '/output.wav';

globalThis.__audioscopeModule = {
  arguments: toolArgs,
  preRun: [() => {
    const data = inputHostPath ? fs.readFileSync(inputHostPath) : fs.readFileSync(0);
    globalThis.__audioscopeModule.FS_writeFile(virtualInputPath, data);
  }],
  postRun: outputMode === 'stdout-binary' ? [() => {
    try {
      const data = globalThis.__audioscopeModule.FS_readFile(virtualOutputPath);
      process.stdout.write(Buffer.from(data));
    } catch {
      // Preserve the tool's original stderr/exit code when output was not produced.
    }
  }] : outputHostPath ? [() => {
    try {
      const data = globalThis.__audioscopeModule.FS_readFile(virtualOutputPath);
      fs.writeFileSync(outputHostPath, Buffer.from(data));
    } catch {
      // Preserve the tool's original stderr/exit code when output was not produced.
    }
  }] : [],
};

require(toolPath);
`;

type EmbeddedToolName = 'ffmpeg' | 'ffprobe';

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
const DIRECT_DECODE_WORKER_PATH = path.join(__dirname, 'embeddedDecodeWorkerThread.js');
const LOUDNESS_EXECUTABLE_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffloudness');
const LOUDNESS_EXECUTABLE_WASM_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffloudness.wasm');

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
  return fs.existsSync(DIRECT_DECODE_MODULE_PATH)
    && fs.existsSync(DIRECT_DECODE_WASM_PATH)
    && fs.existsSync(DIRECT_DECODE_WORKER_PATH);
}

function hasLoudnessExecutable(): boolean {
  return fs.existsSync(LOUDNESS_EXECUTABLE_PATH) && fs.existsSync(LOUDNESS_EXECUTABLE_WASM_PATH);
}

interface DecodeWorkerMessage {
  body?: Record<string, unknown>;
  requestId?: number;
  type?: 'decodeReady' | 'loudnessReady' | 'runtimeReady' | 'taskError';
}

interface DecodeWorkerInput {
  fileExtension: string;
  hostPath: string | null;
  inputBytes: ArrayBuffer | null;
}

interface PendingDecodeWorkerRequest {
  complete(): void;
  loudnessPromise: Promise<EmbeddedLoudnessSummaryPayload>;
  pipelineResolved: boolean;
  rejectLoudness(error: unknown): void;
  rejectPipeline(error: unknown): void;
  resolveLoudness(value: EmbeddedLoudnessSummaryPayload): void;
  resolvePipeline(value: EmbeddedPcmDecodeLoudnessPipelinePayload): void;
}

let nextDecodeWorkerRequestId = 1;

class BackgroundDecodeWorker {
  private pendingRequests = new Map<number, PendingDecodeWorkerRequest>();
  private queueTail = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  private readyReject: ((error: unknown) => void) | null = null;
  private readyRequestId = 0;
  private readyResolve: (() => void) | null = null;
  private worker: Worker | null = null;
  public queuedTaskCount = 0;

  public prewarm(): Promise<void> {
    return this.ensureWorker().then(() => {
      this.unrefIfIdle();
    });
  }

  public enqueue(input: DecodeWorkerInput): Promise<EmbeddedPcmDecodeLoudnessPipelinePayload> {
    let resolvePipeline!: (value: EmbeddedPcmDecodeLoudnessPipelinePayload) => void;
    let rejectPipeline!: (error: unknown) => void;
    let resolveLoudness!: (value: EmbeddedLoudnessSummaryPayload) => void;
    let rejectLoudness!: (error: unknown) => void;
    const loudnessPromise = new Promise<EmbeddedLoudnessSummaryPayload>((resolve, reject) => {
      resolveLoudness = resolve;
      rejectLoudness = reject;
    });
    const pipelinePromise = new Promise<EmbeddedPcmDecodeLoudnessPipelinePayload>((resolve, reject) => {
      resolvePipeline = resolve;
      rejectPipeline = reject;
    });

    this.queuedTaskCount += 1;
    this.worker?.ref();
    const queued = this.queueTail.then(async () => {
      try {
        await this.ensureWorker();
        await this.dispatch(input, {
          complete: () => {},
          loudnessPromise,
          pipelineResolved: false,
          rejectLoudness,
          rejectPipeline,
          resolveLoudness,
          resolvePipeline,
        });
      } catch (error) {
        rejectPipeline(error);
      } finally {
        this.queuedTaskCount -= 1;
        this.unrefIfIdle();
      }
    });
    this.queueTail = queued.catch(() => {});

    return pipelinePromise;
  }

  private ensureWorker(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    const worker = new Worker(DIRECT_DECODE_WORKER_PATH);
    this.worker = worker;
    this.readyRequestId = nextDecodeWorkerRequestId++;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.on('message', (message: DecodeWorkerMessage) => this.handleMessage(message));
    worker.on('error', (error) => this.handleWorkerFailure(worker, error));
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.handleWorkerFailure(worker, new Error(`Embedded decode worker exited with code ${code}.`));
      }
    });
    worker.postMessage({
      type: 'prewarm',
      requestId: this.readyRequestId,
      body: {
        modulePath: DIRECT_DECODE_MODULE_PATH,
        wasmPath: DIRECT_DECODE_WASM_PATH,
      },
    });
    return this.readyPromise;
  }

  private unrefIfIdle(): void {
    if (this.queuedTaskCount === 0) {
      this.worker?.unref();
    }
  }

  private dispatch(input: DecodeWorkerInput, callbacks: PendingDecodeWorkerRequest): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error('Embedded decode worker is unavailable.'));
    }

    const requestId = nextDecodeWorkerRequestId++;
    return new Promise<void>((complete) => {
      callbacks.complete = complete;
      this.pendingRequests.set(requestId, callbacks);
      try {
        const transferList = input.inputBytes ? [input.inputBytes] : [];
        worker.postMessage({
          type: 'decode',
          requestId,
          body: {
            ...input,
            modulePath: DIRECT_DECODE_MODULE_PATH,
            wasmPath: DIRECT_DECODE_WASM_PATH,
          },
        }, transferList);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        complete();
        callbacks.rejectPipeline(error);
      }
    });
  }

  private handleMessage(message: DecodeWorkerMessage): void {
    const requestId = Number(message?.requestId) || 0;
    if (requestId === this.readyRequestId) {
      if (message.type === 'runtimeReady') {
        this.readyResolve?.();
      } else if (message.type === 'taskError') {
        this.readyReject?.(new Error(String(message.body?.message || 'Embedded decode worker failed to initialize.')));
        this.resetWorker();
      }
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    if (message.type === 'decodeReady') {
      const channelBuffers = Array.isArray(message.body?.channelBuffers)
        ? message.body.channelBuffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
        : [];
      const decode: EmbeddedPcmDecodePayload = {
        byteLength: Number(message.body?.byteLength) || 0,
        channelBuffers,
        frameCount: Number(message.body?.frameCount) || 0,
        numberOfChannels: Number(message.body?.numberOfChannels) || channelBuffers.length,
        sampleRate: Number(message.body?.sampleRate) || 0,
        source: 'ffmpeg',
      };
      pending.pipelineResolved = true;
      pending.resolvePipeline({ decode, loudnessPromise: pending.loudnessPromise });
      return;
    }

    if (message.type === 'loudnessReady') {
      pending.resolveLoudness(message.body as unknown as EmbeddedLoudnessSummaryPayload);
      this.finishRequest(requestId, pending);
      return;
    }

    if (message.type === 'taskError') {
      const error = new Error(String(message.body?.message || 'Embedded decode worker failed.'));
      if (pending.pipelineResolved) {
        pending.rejectLoudness(error);
      } else {
        pending.rejectPipeline(error);
      }
      this.finishRequest(requestId, pending);
    }
  }

  private finishRequest(requestId: number, pending: PendingDecodeWorkerRequest): void {
    this.pendingRequests.delete(requestId);
    pending.complete();
  }

  private handleWorkerFailure(worker: Worker, error: unknown): void {
    if (this.worker !== worker) {
      return;
    }

    this.readyReject?.(error);
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.pipelineResolved) {
        pending.rejectLoudness(error);
      } else {
        pending.rejectPipeline(error);
      }
      this.finishRequest(requestId, pending);
    }
    this.resetWorker();
  }

  private resetWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.readyRequestId = 0;
    this.readyResolve = null;
    this.readyReject = null;
    void worker?.terminate();
  }
}

const decodeWorkerPool = Array.from(
  { length: Math.max(1, Math.min(2, os.availableParallelism() - 1)) },
  () => new BackgroundDecodeWorker(),
);

function selectDecodeWorker(): BackgroundDecodeWorker {
  return decodeWorkerPool.reduce((selected, candidate) => (
    candidate.queuedTaskCount < selected.queuedTaskCount ? candidate : selected
  ));
}

export async function prewarmEmbeddedDirectDecodeModule(): Promise<void> {
  if (!hasDirectDecodeModule()) {
    return;
  }

  await Promise.all(decodeWorkerPool.map((worker) => worker.prewarm()));
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

const FFENCODE_EXECUTABLE_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffencode');
const FFENCODE_EXECUTABLE_WASM_PATH = path.join(EMBEDDED_TOOL_DIRECTORY, 'ffencode.wasm');

export type EmbeddedExportFormat = 'flac' | 'm4a' | 'mp3' | 'wav';

export async function runEmbeddedFfencodeExport(
  resource: vscode.Uri,
  targetPath: string,
  format: EmbeddedExportFormat,
  startSeconds: number,
  endSeconds: number,
  timeout: number,
): Promise<void> {
  if (!fs.existsSync(FFENCODE_EXECUTABLE_PATH) || !fs.existsSync(FFENCODE_EXECUTABLE_WASM_PATH)) {
    throw new Error('ffencode.wasm is unavailable. Rebuild or reinstall audioscope to restore exporting.');
  }

  const preparedInput = await prepareToolInput(resource);
  const virtualInputPath = `/input${path.extname(preparedInput.hostPath || resource.path) || '.bin'}`;
  const virtualOutputPath = `/output.${format}`;

  await spawnProcessAsync(
    process.execPath,
    [
      '-e',
      EMBEDDED_TOOL_RUNNER_SOURCE,
      FFENCODE_EXECUTABLE_PATH,
      preparedInput.hostPath ?? '',
      targetPath,
      virtualInputPath,
      JSON.stringify([
        virtualInputPath,
        virtualOutputPath,
        format,
        startSeconds.toFixed(6),
        endSeconds.toFixed(6),
      ]),
      'none',
      virtualOutputPath,
    ],
    {
      stdinData: preparedInput.stdinData,
      timeout,
    },
  );

  const exported = await fsp.stat(targetPath).catch(() => null);
  if (!exported || exported.size <= 0) {
    throw new Error('ffencode did not produce an output file.');
  }
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

export async function runEmbeddedFfmpegDecodeLoudnessPipeline(
  resource: vscode.Uri,
): Promise<EmbeddedPcmDecodeLoudnessPipelinePayload> {
  if (!hasDirectDecodeModule()) {
    throw new Error('Background FFmpeg decode worker is unavailable.');
  }

  const hostPath = await getCliReadablePath(resource);
  const inputBytes = hostPath ? null : copyToArrayBuffer(await readResourceBytes(resource));
  return selectDecodeWorker().enqueue({
    fileExtension: path.extname(resource.path).replace(/^\./u, '') || 'bin',
    hostPath,
    inputBytes,
  });
}
