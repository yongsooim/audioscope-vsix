const exportedFunctionNames = [
  'malloc',
  'free',
  'wave_dispose_session',
  'wave_prepare_session',
  'wave_get_pcm_ptr',
  'wave_begin_waveform_pyramid_build',
  'wave_build_waveform_pyramid',
  'wave_build_waveform_pyramid_step',
  'wave_extract_waveform_peaks',
  'wave_extract_waveform_path_points',
  'wave_extract_waveform_slice',
  'wave_plan_waveform_follow_render',
  'wave_plan_spectrogram_follow_render',
  'wave_sample_analysis_value_at_frame',
  'wave_sample_mfcc_value_at_frame',
  'wave_render_spectrogram_tile_rgba',
] as const;

type ExportedFunctionName = (typeof exportedFunctionNames)[number];

type WaveCoreExportedFunction = (...args: number[]) => number;

type WaveCoreWasmExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
} & Record<ExportedFunctionName, WaveCoreExportedFunction>;

export interface WaveCoreModule {
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  HEAPU8: Uint8Array;
  _free(pointer: number): number;
  _malloc(byteLength: number): number;
  _wave_begin_waveform_pyramid_build(): number;
  _wave_build_waveform_pyramid(): number;
  _wave_build_waveform_pyramid_step(maxBlocks: number): number;
  _wave_dispose_session(): number;
  _wave_extract_waveform_peaks(
    viewStart: number,
    viewEnd: number,
    columnCount: number,
    outputPointer: number,
    metaOutputPointer: number,
  ): number;
  _wave_extract_waveform_path_points(
    viewStart: number,
    viewEnd: number,
    columnCount: number,
    outputPointer: number,
    metaOutputPointer: number,
  ): number;
  _wave_extract_waveform_slice(
    viewStart: number,
    viewEnd: number,
    columnCount: number,
    outputPointer: number,
    metaOutputPointer: number,
  ): number;
  _wave_get_pcm_ptr(): number;
  _wave_plan_spectrogram_follow_render(
    displayStart: number,
    displayEnd: number,
    duration: number,
    pixelWidth: number,
    bufferFactor: number,
    outputPointer: number,
  ): number;
  _wave_plan_waveform_follow_render(
    displayStart: number,
    displayEnd: number,
    duration: number,
    displayWidth: number,
    renderScale: number,
    preferredStart: number,
    preferredEnd: number,
    preferredValid: number,
    bufferFactor: number,
    marginRatio: number,
    epsilon: number,
    outputPointer: number,
  ): number;
  _wave_sample_analysis_value_at_frame(
    centerSample: number,
    rowIndex: number,
    rowCount: number,
    melBandCount: number,
    fftSize: number,
    decimationFactor: number,
    minFrequency: number,
    maxFrequency: number,
    analysisType: number,
    frequencyScale: number,
    scalogramOmega0: number,
    windowFunction: number,
    outputPointer: number,
  ): number;
  _wave_sample_mfcc_value_at_frame(
    centerSample: number,
    coefficientIndex: number,
    coefficientCount: number,
    melBandCount: number,
    fftSize: number,
    minFrequency: number,
    maxFrequency: number,
    windowFunction: number,
  ): number;
  _wave_prepare_session(sampleCount: number, sampleRate: number, duration: number): number;
  _wave_render_spectrogram_tile_rgba(
    tileStartSample: number,
    tileSampleSpan: number,
    columnOffset: number,
    totalColumnCount: number,
    columnCount: number,
    rowCount: number,
    melBandCount: number,
    fftSize: number,
    decimationFactor: number,
    minFrequency: number,
    maxFrequency: number,
    analysisType: number,
    frequencyScale: number,
    distributionGamma: number,
    minDecibels: number,
    maxDecibels: number,
    scalogramOmega0: number,
    windowFunction: number,
    outputPointer: number,
  ): number;
  memory: WebAssembly.Memory;
}

export interface WaveCoreRuntime {
  module: WaveCoreModule;
  variant: string;
}

function assertHeapRange(bufferByteLength: number, byteOffset: number, byteLength: number): void {
  if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > bufferByteLength) {
    throw new RangeError(
      `WaveCore heap view out of bounds: offset=${byteOffset} length=${byteLength} bufferBytes=${bufferByteLength}`,
    );
  }
}

export function heapF32View(module: WaveCoreModule, pointer: number, length: number): Float32Array {
  assertHeapRange(module.HEAPF32.buffer.byteLength, pointer, length * Float32Array.BYTES_PER_ELEMENT);
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}

export function heapF64View(module: WaveCoreModule, pointer: number, length: number): Float64Array {
  assertHeapRange(module.HEAPF64.buffer.byteLength, pointer, length * Float64Array.BYTES_PER_ELEMENT);
  return new Float64Array(module.HEAPF64.buffer, pointer, length);
}

export function heapU8View(module: WaveCoreModule, pointer: number, length: number): Uint8Array {
  assertHeapRange(module.HEAPU8.buffer.byteLength, pointer, length);
  return new Uint8Array(module.HEAPU8.buffer, pointer, length);
}

export interface WaveCoreWasmBytes {
  simd?: ArrayBuffer | Uint8Array | null;
  fallback?: ArrayBuffer | Uint8Array | null;
}

// Build the URL lazily so the module can still be evaluated when
// import.meta.url is a blob: URL (which cannot resolve a relative path).
// In that case the bytes-based loading path is used instead and these URLs
// are never constructed.
function resolveWasmUrl(relativePath: string): URL | null {
  try {
    return new URL(relativePath, import.meta.url);
  } catch {
    return null;
  }
}

const wasmCandidateSpecs: Array<{ relativePath: string; variant: string }> = [
  { relativePath: '../wasm/wasm_core_simd.wasm', variant: 'wasm-core-wasm-simd' },
  { relativePath: '../wasm/wasm_core_fallback.wasm', variant: 'wasm-core-wasm-fallback' },
];

let runtimePromise: Promise<WaveCoreRuntime> | null = null;

// Workers cannot fetch webview resources directly under VS Code 1.119+ (the
// service worker no longer serves blob-worker-originated fetches). When the
// host pre-fetches the wasm bytes and forwards them, we instantiate from the
// bytes in-process; otherwise we fall back to the legacy URL-based path.
export async function loadWaveCoreRuntime(bytes?: WaveCoreWasmBytes | null) {
  if (!runtimePromise) {
    runtimePromise = instantiateWaveCoreRuntime(bytes ?? null);
  }

  return runtimePromise;
}

async function instantiateWaveCoreRuntime(bytes: WaveCoreWasmBytes | null): Promise<WaveCoreRuntime> {
  const errors: string[] = [];

  for (const spec of wasmCandidateSpecs) {
    const wasmBytes = spec.variant === 'wasm-core-wasm-simd' ? bytes?.simd ?? null : bytes?.fallback ?? null;
    try {
      let instance: WebAssembly.Instance;
      if (wasmBytes) {
        instance = await instantiateWasmFromBytes(wasmBytes);
      } else {
        const url = resolveWasmUrl(spec.relativePath);
        if (!url) {
          throw new Error('No wasm bytes provided and import.meta.url cannot resolve the wasm asset path.');
        }
        instance = await instantiateWasm(url);
      }
      return {
        module: createModuleFacade(instance.exports as WaveCoreWasmExports),
        variant: spec.variant,
      };
    } catch (error) {
      errors.push(`${spec.variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to load wave core runtime. ${errors.join(' | ')}`);
}

async function instantiateWasmFromBytes(bytes: ArrayBuffer | Uint8Array): Promise<WebAssembly.Instance> {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  const result = await WebAssembly.instantiate(copy, {});
  return result.instance;
}

async function instantiateWasm(url: URL): Promise<WebAssembly.Instance> {
  const response = await fetch(url, { credentials: 'same-origin' });

  if (!response.ok) {
    throw new Error(`Unable to fetch ${url.pathname}: ${response.status}`);
  }

  const imports: WebAssembly.Imports = {};

  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      const { instance } = await WebAssembly.instantiateStreaming(response, imports);
      return instance;
    } catch {
      // Some webview environments serve wasm with a non-wasm MIME type.
    }
  }

  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance;
}

function createModuleFacade(exports: WaveCoreWasmExports): WaveCoreModule {
  const module = {} as WaveCoreModule;
  let currentBuffer: ArrayBuffer | null = null;

  const refreshViews = () => {
    const memory = exports.memory;

    if (!memory) {
      throw new Error('Wave core memory export is missing.');
    }

    if (currentBuffer === memory.buffer) {
      return;
    }

    currentBuffer = memory.buffer;
    module.HEAPU8 = new Uint8Array(currentBuffer);
    module.HEAPF32 = new Float32Array(currentBuffer);
    module.HEAPF64 = new Float64Array(currentBuffer);
  };

  refreshViews();
  module.memory = exports.memory;
  const moduleRecord = module as unknown as Record<string, WaveCoreExportedFunction>;

  for (const name of exportedFunctionNames) {
    const fn = exports[name];

    if (typeof fn !== 'function') {
      throw new Error(`Wave core export "${name}" is missing.`);
    }

    moduleRecord[`_${name}`] = (...args: number[]) => {
      const result = fn(...args);
      refreshViews();
      return result;
    };
  }

  return module;
}
