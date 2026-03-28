import createWaveCoreModule from '../media/wave_core.js';

let runtimePromise = null;

export async function loadWaveCoreRuntime() {
  if (!runtimePromise) {
    runtimePromise = createWaveCoreModule({
      locateFile: (path) => new URL(path, import.meta.url).toString(),
    }).then((module) => ({
      module,
      variant: 'wave-core-wasm',
    }));
  }

  return runtimePromise;
}
