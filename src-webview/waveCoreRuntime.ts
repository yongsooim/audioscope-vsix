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
    tileStart: number,
    tileEnd: number,
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

export interface WaveformFollowRenderPlan {
  end: number;
  start: number;
  width: number;
}

export interface SpectrogramFollowRenderPlan {
  end: number;
  pixelWidth: number;
  start: number;
}

export interface WaveformFollowRenderPlanOptions {
  bufferFactor: number;
  displayEnd: number;
  displayStart: number;
  displayWidth: number;
  duration: number;
  epsilon: number;
  marginRatio: number;
  preferredEnd?: number | null;
  preferredStart?: number | null;
  renderScale: number;
}

export interface SpectrogramFollowRenderPlanOptions {
  bufferFactor: number;
  displayEnd: number;
  displayStart: number;
  duration: number;
  pixelWidth: number;
}

export interface WaveDisplayPlanner {
  dispose(): void;
  planSpectrogramFollowRender(options: SpectrogramFollowRenderPlanOptions): SpectrogramFollowRenderPlan | null;
  planWaveformFollowRender(options: WaveformFollowRenderPlanOptions): WaveformFollowRenderPlan | null;
}

const plannerOutputValueCount = 3;
const plannerOutputByteLength = plannerOutputValueCount * Float64Array.BYTES_PER_ELEMENT;

const wasmCandidates = [
  {
    url: new URL('../wasm/wasm_core_simd.wasm', import.meta.url),
    variant: 'wasm-core-wasm-simd',
  },
  {
    url: new URL('../wasm/wasm_core_fallback.wasm', import.meta.url),
    variant: 'wasm-core-wasm-fallback',
  },
];

let runtimePromise: Promise<WaveCoreRuntime> | null = null;

export async function loadWaveCoreRuntime() {
  if (!runtimePromise) {
    runtimePromise = instantiateWaveCoreRuntime();
  }

  return runtimePromise;
}

export function createWaveDisplayPlanner(module: WaveCoreModule): WaveDisplayPlanner {
  const outputPointer = module._malloc(plannerOutputByteLength);

  if (!outputPointer) {
    throw new Error('Unable to allocate wave display planner output buffer.');
  }

  const outputOffset = Math.floor(outputPointer / Float64Array.BYTES_PER_ELEMENT);
  let disposed = false;

  const readOutput = () => {
    const heap = module.HEAPF64;
    return {
      end: Number(heap[outputOffset + 1] ?? 0),
      start: Number(heap[outputOffset] ?? 0),
      width: Math.max(1, Math.round(Number(heap[outputOffset + 2] ?? 1))),
    };
  };

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      module._free(outputPointer);
    },
    planSpectrogramFollowRender(options) {
      if (disposed) {
        return null;
      }

      const ok = module._wave_plan_spectrogram_follow_render(
        Number(options.displayStart) || 0,
        Number(options.displayEnd) || 0,
        Number(options.duration) || 0,
        Math.max(1, Math.round(Number(options.pixelWidth) || 1)),
        Number(options.bufferFactor) || 1,
        outputPointer,
      );

      if (!ok) {
        return null;
      }

      const result = readOutput();
      return {
        end: result.end,
        pixelWidth: result.width,
        start: result.start,
      };
    },
    planWaveformFollowRender(options) {
      if (disposed) {
        return null;
      }

      const preferredStart = Number(options.preferredStart);
      const preferredEnd = Number(options.preferredEnd);
      const preferredValid = Number.isFinite(preferredStart)
        && Number.isFinite(preferredEnd)
        && preferredEnd > preferredStart;
      const ok = module._wave_plan_waveform_follow_render(
        Number(options.displayStart) || 0,
        Number(options.displayEnd) || 0,
        Number(options.duration) || 0,
        Math.max(1, Math.round(Number(options.displayWidth) || 1)),
        Math.max(1, Number(options.renderScale) || 1),
        preferredValid ? preferredStart : 0,
        preferredValid ? preferredEnd : 0,
        preferredValid ? 1 : 0,
        Number(options.bufferFactor) || 1,
        Number(options.marginRatio) || 0,
        Number(options.epsilon) || 0,
        outputPointer,
      );

      if (!ok) {
        return null;
      }

      return readOutput();
    },
  };
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
