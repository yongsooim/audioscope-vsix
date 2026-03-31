let decodeModulePromise = null;
let decodeModuleScriptUrl = '';
let decodeModuleWasmUrl = '';

function postDebugTimelineEvent(label, detail = '') {
  self.postMessage({
    type: 'debugTimelineEvent',
    body: {
      event: {
        detail,
        label,
        source: 'decode-worker',
        timeMs: Date.now(),
      },
    },
  });
}

function readErrorMessage(module) {
  const pointer = module._wave_get_last_error_ptr?.() ?? 0;
  const length = module._wave_get_last_error_length?.() ?? 0;

  if (!pointer || length <= 0 || typeof module.UTF8ToString !== 'function') {
    return 'Embedded decode worker failed.';
  }

  return module.UTF8ToString(pointer, length) || 'Embedded decode worker failed.';
}

async function ensureDecodeModule() {
  if (!decodeModuleScriptUrl || !decodeModuleWasmUrl) {
    throw new Error('Embedded decode worker module URLs are missing.');
  }

  if (!decodeModulePromise) {
    postDebugTimelineEvent('decode-worker.module.load.start', decodeModuleScriptUrl);
    decodeModulePromise = import(decodeModuleScriptUrl)
      .then(async (moduleRecord) => {
        const createModule = typeof moduleRecord?.default === 'function'
          ? moduleRecord.default
          : null;

        if (!createModule) {
          throw new Error('Embedded decode worker module factory is unavailable.');
        }

        const module = await createModule({
          locateFile: () => decodeModuleWasmUrl,
          noInitialRun: true,
        });
        postDebugTimelineEvent('decode-worker.module.load.done');
        return module;
      })
      .catch((error) => {
        decodeModulePromise = null;
        throw error;
      });
  }

  return decodeModulePromise;
}

self.onmessage = async (event) => {
  const message = event.data ?? {};

  try {
    switch (message.type) {
      case 'bootstrapRuntime':
        decodeModuleScriptUrl = typeof message.body?.moduleUrl === 'string' ? message.body.moduleUrl : '';
        decodeModuleWasmUrl = typeof message.body?.wasmUrl === 'string' ? message.body.wasmUrl : '';
        self.postMessage({
          type: 'runtimeReady',
        });
        return;
      case 'prewarmDecodeModule':
        await ensureDecodeModule();
        self.postMessage({
          type: 'prewarmReady',
          body: {
            loadToken: Number(message.body?.loadToken) || 0,
          },
        });
        return;
      case 'decodeAudioData':
        await handleDecodeRequest(message.body ?? {});
        return;
      case 'dispose':
        decodeModulePromise = null;
        decodeModuleScriptUrl = '';
        decodeModuleWasmUrl = '';
        return;
      default:
        return;
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      body: {
        loadToken: Number(message.body?.loadToken) || 0,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

async function handleDecodeRequest(body) {
  const module = await ensureDecodeModule();
  const loadToken = Number(body?.loadToken) || 0;
  const fileExtension = typeof body?.fileExtension === 'string' && body.fileExtension.length > 0
    ? body.fileExtension
    : 'bin';
  const inputBytes = body?.audioBytes;
  const virtualInputPath = `/input.${fileExtension}`;

  if (!(inputBytes instanceof ArrayBuffer)) {
    throw new Error('Embedded decode worker did not receive audio bytes.');
  }

  postDebugTimelineEvent('decode-worker.decode.start', `bytes=${inputBytes.byteLength}`);
  module.FS.writeFile(virtualInputPath, new Uint8Array(inputBytes));

  const pathPointer = module._malloc(virtualInputPath.length + 1);
  module.stringToUTF8(virtualInputPath, pathPointer, virtualInputPath.length + 1);
  const decodeResult = module._wave_decode_file(pathPointer);
  module._free(pathPointer);

  if (decodeResult !== 0) {
    const errorMessage = readErrorMessage(module);
    try {
      module.FS.unlink(virtualInputPath);
    } catch {}
    try {
      module._wave_clear_decode_output();
    } catch {}
    self.postMessage({
      type: 'decodeError',
      body: {
        loadToken,
        message: errorMessage,
      },
    });
    return;
  }

  const numberOfChannels = Math.max(0, module._wave_get_output_channel_count());
  const frameCount = Math.max(0, module._wave_get_output_frame_count());
  const sampleRate = Math.max(1, module._wave_get_output_sample_rate());
  const channelByteLength = Math.max(0, module._wave_get_output_channel_byte_length());
  const channelBuffers = [];

  postDebugTimelineEvent('decode-worker.decode.done', `channels=${numberOfChannels} frames=${frameCount} rate=${sampleRate}`);
  postDebugTimelineEvent('decode-worker.copyout.start', `bytes=${channelByteLength * numberOfChannels}`);

  for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
    const pointer = module._wave_get_output_channel_ptr(channelIndex);

    if (!pointer || channelByteLength <= 0) {
      throw new Error(`Embedded decode worker returned an invalid channel buffer at index ${channelIndex}.`);
    }

    const copiedBytes = module.HEAPU8.slice(pointer, pointer + channelByteLength);
    channelBuffers.push(copiedBytes.buffer);
  }

  postDebugTimelineEvent('decode-worker.copyout.done', `bytes=${channelByteLength * numberOfChannels}`);

  try {
    module.FS.unlink(virtualInputPath);
  } catch {}
  try {
    module._wave_clear_decode_output();
  } catch {}

  self.postMessage({
    type: 'decodeReady',
    body: {
      loadToken,
      byteLength: channelByteLength * numberOfChannels,
      channelBuffers,
      frameCount,
      kind: 'pcm',
      numberOfChannels,
      sampleRate,
      source: 'ffmpeg',
    },
  }, channelBuffers);
}
