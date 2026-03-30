const exportedFunctionNames = [
  'malloc',
  'free',
  'wave_dispose_session',
  'wave_prepare_session',
  'wave_get_pcm_ptr',
  'wave_measure_loudness_summary',
  'wave_build_waveform_pyramid',
  'wave_extract_waveform_slice',
  'wave_render_spectrogram_tile_rgba',
] as const;

type ExportedFunctionName = (typeof exportedFunctionNames)[number];

type WaveCoreExportedFunction = (...args: number[]) => number;

type WaveCoreWasmExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
} & Record<ExportedFunctionName, WaveCoreExportedFunction>;

export interface WaveCoreModule {
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  _free(pointer: number): number;
  _malloc(byteLength: number): number;
  _wave_build_waveform_pyramid(): number;
  _wave_dispose_session(): number;
  _wave_extract_waveform_slice(viewStart: number, viewEnd: number, columnCount: number, outputPointer: number): number;
  _wave_get_pcm_ptr(): number;
  _wave_measure_loudness_summary(outputPointer: number): number;
  _wave_prepare_session(sampleCount: number, sampleRate: number, duration: number): number;
  _wave_render_spectrogram_tile_rgba(
    tileStart: number,
    tileEnd: number,
    columnCount: number,
    rowCount: number,
    fftSize: number,
    decimationFactor: number,
    minFrequency: number,
    maxFrequency: number,
    analysisType: number,
    frequencyScale: number,
    outputPointer: number,
  ): number;
  memory: WebAssembly.Memory;
}

export interface WaveCoreRuntime {
  module: WaveCoreModule;
  variant: string;
}

const wasmCandidates = [
  {
    url: new URL('../wasm/wave_core_simd.wasm', import.meta.url),
    variant: 'wave-core-wasm-simd',
  },
  {
    url: new URL('../wasm/wave_core_fallback.wasm', import.meta.url),
    variant: 'wave-core-wasm-fallback',
  },
];

let runtimePromise: Promise<WaveCoreRuntime> | null = null;

export async function loadWaveCoreRuntime() {
  if (!runtimePromise) {
    runtimePromise = instantiateWaveCoreRuntime();
  }

  return runtimePromise;
}

async function instantiateWaveCoreRuntime() {
  const errors: string[] = [];

  for (const candidate of wasmCandidates) {
    try {
      const instance = await instantiateWasm(candidate.url);
      return {
        module: createModuleFacade(instance.exports as WaveCoreWasmExports),
        variant: candidate.variant,
      };
    } catch (error) {
      errors.push(`${candidate.variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to load wave core runtime. ${errors.join(' | ')}`);
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
