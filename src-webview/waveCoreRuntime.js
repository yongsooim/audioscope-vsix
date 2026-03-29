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
];

const wasmCandidates = [
  {
    url: new URL('../media/wave_core_simd.wasm', import.meta.url),
    variant: 'wave-core-wasm-simd',
  },
  {
    url: new URL('../media/wave_core_fallback.wasm', import.meta.url),
    variant: 'wave-core-wasm-fallback',
  },
];

let runtimePromise = null;

export async function loadWaveCoreRuntime() {
  if (!runtimePromise) {
    runtimePromise = instantiateWaveCoreRuntime();
  }

  return runtimePromise;
}

async function instantiateWaveCoreRuntime() {
  const errors = [];

  for (const candidate of wasmCandidates) {
    try {
      const instance = await instantiateWasm(candidate.url);
      return {
        module: createModuleFacade(instance.exports),
        variant: candidate.variant,
      };
    } catch (error) {
      errors.push(`${candidate.variant}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to load wave core runtime. ${errors.join(' | ')}`);
}

async function instantiateWasm(url) {
  const response = await fetch(url, { credentials: 'same-origin' });

  if (!response.ok) {
    throw new Error(`Unable to fetch ${url.pathname}: ${response.status}`);
  }

  const imports = {};

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

function createModuleFacade(exports) {
  const module = {};
  let currentBuffer = null;

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

  for (const name of exportedFunctionNames) {
    const fn = exports[name];

    if (typeof fn !== 'function') {
      throw new Error(`Wave core export "${name}" is missing.`);
    }

    module[`_${name}`] = (...args) => {
      const result = fn(...args);
      refreshViews();
      return result;
    };
  }

  return module;
}
