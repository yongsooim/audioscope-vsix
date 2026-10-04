import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddedPcmDecodeLoudnessPipelinePayload, EmbeddedLoudnessSummaryPayload } from './embeddedMediaTools';
import { isNativeCompatible, type NativeManifest, type NativeRuntime } from './nativePlatform';

export type NativeToolName = 'ffdecode' | 'ffdecode-wav' | 'ffloudness' | 'ffencode' | 'ffprobe';

const nativeDirectory = path.resolve(__dirname, '..', 'dist', 'native-tools', process.platform + '-' + process.arch);
let nativeManifest: NativeManifest | null | undefined;
let nativeRuntime: NativeRuntime | undefined;

export function getNativeManifest(): NativeManifest | null {
  if (nativeManifest === undefined) {
    try {
      nativeManifest = JSON.parse(fs.readFileSync(path.join(nativeDirectory, 'manifest.json'), 'utf8')) as NativeManifest;
    } catch {
      nativeManifest = null;
    }
  }
  return nativeManifest;
}

function getNativeRuntime(): NativeRuntime {
  if (!nativeRuntime) {
    let glibcVersion: string | undefined;
    if (process.platform === 'linux' && process.report?.getReport) {
      const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
      glibcVersion = report.header?.glibcVersionRuntime;
    }
    nativeRuntime = { platform: process.platform, arch: process.arch, kernelRelease: os.release(), glibcVersion };
  }
  return nativeRuntime;
}

export function getNativeExecutablePath(name: NativeToolName): string | null {
  const manifest = getNativeManifest();
  if (!manifest || !isNativeCompatible(manifest, getNativeRuntime())) return null;
  const executable = path.resolve(
    nativeDirectory,
    name + (process.platform === 'win32' ? '.exe' : ''),
  );
  try {
    fs.accessSync(executable, fs.constants.X_OK);
    return executable;
  } catch {
    return null;
  }
}

// Large PCM buffers travel through a temporary file rather than thousands of
// pipe callbacks. The helper announces readiness before measuring loudness.
export async function runNativeDecodeLoudnessPipeline(
  executable: string,
  inputPath: string,
  timeout = 120_000,
): Promise<EmbeddedPcmDecodeLoudnessPipelinePayload> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'audioscope-pcm-'));
  try {
    const pipeline = await startNativeDecode(executable, inputPath, path.join(directory, 'audio.pcm'), timeout);
    const loudnessPromise = pipeline.loudnessPromise.finally(() => fsp.rm(directory, { recursive: true, force: true }));
    void loudnessPromise.catch(() => {});
    return {
      decode: pipeline.decode,
      loudnessPromise,
    };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function startNativeDecode(
  executable: string,
  inputPath: string,
  pcmPath: string,
  timeout: number,
): Promise<EmbeddedPcmDecodeLoudnessPipelinePayload> {
  let resolveLoudness!: (summary: EmbeddedLoudnessSummaryPayload) => void;
  let rejectLoudness!: (error: Error) => void;
  const loudnessPromise = new Promise<EmbeddedLoudnessSummaryPayload>((resolve, reject) => {
    resolveLoudness = resolve;
    rejectLoudness = reject;
  });
  void loudnessPromise.catch(() => {});
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [inputPath, pcmPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const header = Buffer.alloc(16);
    let headerBytes = 0;
    let numberOfChannels = 0;
    let readPromise: Promise<void> | null = null;
    let decodeReady = false;
    let settled = false;
    let stderr = Buffer.alloc(0);
    const summaryChunks: Buffer[] = [];
    const timer = timeout > 0 ? setTimeout(() => fail(new Error('Native decode timed out after ' + timeout + 'ms.')), timeout) : null;

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill('SIGKILL');
      if (decodeReady) rejectLoudness(error);
      else reject(error);
    }

    async function readPcm(): Promise<void> {
      const sampleRate = header.readUInt32LE(4);
      numberOfChannels = header.readUInt32LE(8);
      const frameCount = header.readUInt32LE(12);
      const channelByteLength = frameCount * Float32Array.BYTES_PER_ELEMENT;
      const totalBytes = numberOfChannels * channelByteLength;
      if (header.toString('ascii', 0, 4) !== 'ADP1' || !sampleRate || !numberOfChannels || !frameCount || !Number.isSafeInteger(totalBytes)) {
        throw new Error('Invalid native PCM header.');
      }
      const file = await fsp.open(pcmPath, 'r');
      const channelBuffers: ArrayBuffer[] = [];
      try {
        if ((await file.stat()).size !== totalBytes) throw new Error('Incomplete native PCM output.');
        for (let channel = 0; channel < numberOfChannels; channel++) {
          const buffer = new ArrayBuffer(channelByteLength);
          const bytes = Buffer.from(buffer);
          let position = 0;
          while (position < bytes.length) {
            const result = await file.read(bytes, position, bytes.length - position, channel * channelByteLength + position);
            if (!result.bytesRead) throw new Error('Incomplete native PCM channel.');
            position += result.bytesRead;
          }
          channelBuffers.push(buffer);
        }
      } finally {
        await file.close();
      }
      if (!settled) {
        decodeReady = true;
        resolve({
          decode: { byteLength: totalBytes, sampleRate, numberOfChannels, frameCount, channelBuffers, source: 'ffmpeg' },
          loudnessPromise,
        });
      }
    }

    child.on('error', fail);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-65536);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      let offset = 0;
      if (headerBytes < header.length) {
        const length = Math.min(header.length - headerBytes, chunk.length);
        chunk.copy(header, headerBytes, 0, length);
        offset += length;
        headerBytes += length;
        if (headerBytes === header.length) readPromise = readPcm().catch((error: Error) => fail(error));
      }
      if (offset < chunk.length) summaryChunks.push(chunk.subarray(offset));
    });
    child.on('close', async (code, signal) => {
      if (readPromise) await readPromise;
      if (settled) return;
      if (code !== 0 || signal || !decodeReady) {
        fail(new Error('Native decoder exited (' + (signal || code) + '): ' + stderr.toString('utf8').trim()));
        return;
      }
      try {
        const summary = JSON.parse(Buffer.concat(summaryChunks).toString('utf8')) as EmbeddedLoudnessSummaryPayload;
        if (summary.channelCount !== numberOfChannels) throw new Error('Invalid native loudness summary.');
        settled = true;
        if (timer) clearTimeout(timer);
        resolveLoudness(summary);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
