import * as fs from 'node:fs';
import { parentPort } from 'node:worker_threads';

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

interface WorkerRequest {
  body?: {
    fileExtension?: string;
    hostPath?: string | null;
    inputBytes?: ArrayBuffer | null;
    modulePath?: string;
    wasmPath?: string;
  };
  requestId?: number;
  type?: 'decode' | 'prewarm';
}

let modulePromise: Promise<DirectDecodeModule> | null = null;
let modulePath = '';
let wasmPath = '';
let decodeLogMessages: string[] = [];

function postMessage(message: unknown, transferList: ArrayBuffer[] = []): void {
  parentPort?.postMessage(message, transferList);
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

function normalizeLoudnessValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readLoudnessSummary(module: DirectDecodeModule, channelCount: number): Record<string, unknown> {
  const channelLayout = readUtf8(
    module,
    module._wave_get_output_channel_layout_ptr(),
    module._wave_get_output_channel_layout_length(),
  ).trim();
  const thresholdMatches = [...decodeLogMessages.join('\n').matchAll(/Threshold:\s+(-?\d+(?:\.\d+)?) LUFS/gu)];

  return {
    channelCount: channelCount > 0 ? channelCount : null,
    channelLayout: channelLayout || null,
    integratedLufs: normalizeLoudnessValue(module._wave_get_loudness_integrated_lufs()),
    integratedThresholdLufs: normalizeLoudnessValue(thresholdMatches[0] ? Number(thresholdMatches[0][1]) : null),
    loudnessRangeLu: normalizeLoudnessValue(module._wave_get_loudness_range_lu()),
    lraHighLufs: normalizeLoudnessValue(module._wave_get_loudness_lra_high_lufs()),
    lraLowLufs: normalizeLoudnessValue(module._wave_get_loudness_lra_low_lufs()),
    rangeThresholdLufs: normalizeLoudnessValue(thresholdMatches[1] ? Number(thresholdMatches[1][1]) : null),
    samplePeakDbfs: normalizeLoudnessValue(module._wave_get_loudness_sample_peak_dbfs()),
    truePeakDbtp: normalizeLoudnessValue(module._wave_get_loudness_true_peak_dbtp()),
  };
}

async function getModule(options: WorkerRequest['body']): Promise<DirectDecodeModule> {
  modulePath = options?.modulePath || modulePath;
  wasmPath = options?.wasmPath || wasmPath;

  if (!modulePath || !wasmPath) {
    throw new Error('Embedded decode worker module paths are missing.');
  }

  if (!modulePromise) {
    const requiredModule = require(modulePath) as DirectDecodeModuleFactory | { default?: DirectDecodeModuleFactory };
    const factory = typeof requiredModule === 'function' ? requiredModule : requiredModule.default;
    if (typeof factory !== 'function') {
      throw new Error('Embedded decode worker module factory is unavailable.');
    }

    modulePromise = factory({
      locateFile: () => wasmPath,
      noInitialRun: true,
      print: () => {},
      printErr: (message: unknown) => {
        decodeLogMessages.push(String(message ?? ''));
      },
    }).catch((error) => {
      modulePromise = null;
      throw error;
    });
  }

  return modulePromise;
}

async function decode(requestId: number, options: WorkerRequest['body']): Promise<void> {
  const module = await getModule(options);
  const fileExtension = typeof options?.fileExtension === 'string' && options.fileExtension.length > 0
    ? options.fileExtension
    : 'bin';
  const virtualInputPath = `/input-${requestId}.${fileExtension}`;
  const inputBytes = options?.hostPath
    ? fs.readFileSync(options.hostPath)
    : options?.inputBytes instanceof ArrayBuffer
      ? new Uint8Array(options.inputBytes)
      : null;

  if (!inputBytes) {
    throw new Error('Embedded decode worker received no audio input.');
  }

  decodeLogMessages = [];
  let decodeReady = false;

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
      ) || 'Embedded FFmpeg decode failed.');
    }

    const numberOfChannels = Math.max(0, module._wave_get_output_channel_count());
    const frameCount = Math.max(0, module._wave_get_output_frame_count());
    const sampleRate = Math.max(1, module._wave_get_output_sample_rate());
    const channelByteLength = Math.max(0, module._wave_get_output_channel_byte_length());
    const channelBuffers: ArrayBuffer[] = [];

    for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
      const pointer = module._wave_get_output_channel_ptr(channelIndex);
      if (!pointer || channelByteLength <= 0) {
        throw new Error(`Embedded FFmpeg decode returned an invalid channel buffer at index ${channelIndex}.`);
      }
      channelBuffers.push(module.HEAPU8.slice(pointer, pointer + channelByteLength).buffer);
    }

    postMessage({
      type: 'decodeReady',
      requestId,
      body: {
        byteLength: channelByteLength * numberOfChannels,
        channelBuffers,
        frameCount,
        numberOfChannels,
        sampleRate,
        source: 'ffmpeg',
      },
    }, channelBuffers);
    decodeReady = true;

    await new Promise<void>((resolve) => setImmediate(resolve));
    const loudnessResult = module._wave_measure_loudness_from_decoded_output();
    if (loudnessResult !== 0) {
      throw new Error(readUtf8(
        module,
        module._wave_get_last_error_ptr(),
        module._wave_get_last_error_length(),
      ) || 'Embedded FFmpeg loudness analysis failed.');
    }

    postMessage({
      type: 'loudnessReady',
      requestId,
      body: readLoudnessSummary(module, numberOfChannels),
    });
  } catch (error) {
    postMessage({
      type: 'taskError',
      requestId,
      body: {
        message: error instanceof Error ? error.message : String(error),
        phase: decodeReady ? 'loudness' : 'decode',
      },
    });
  } finally {
    try {
      module._wave_clear_decode_output();
    } catch {}
    try {
      module.FS.unlink(virtualInputPath);
    } catch {}
  }
}

parentPort?.on('message', (message: WorkerRequest) => {
  const requestId = Number(message?.requestId) || 0;

  if (message?.type === 'prewarm') {
    void getModule(message.body)
      .then(() => postMessage({ type: 'runtimeReady', requestId }))
      .catch((error) => postMessage({
        type: 'taskError',
        requestId,
        body: {
          message: error instanceof Error ? error.message : String(error),
          phase: 'prewarm',
        },
      }));
    return;
  }

  if (message?.type === 'decode') {
    void decode(requestId, message.body);
  }
});
