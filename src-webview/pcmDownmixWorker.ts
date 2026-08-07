interface DownmixRequestBody {
  channelBuffers?: ArrayBuffer[];
  channelCount?: number;
  maxTotalSamples?: number;
  sampleCount?: number;
}

self.onmessage = (event: MessageEvent<{ body?: DownmixRequestBody; type?: string }>): void => {
  if (event.data?.type !== 'downmixPcm') {
    return;
  }

  const body = event.data.body;
  const channelBuffers = Array.isArray(body?.channelBuffers)
    ? body.channelBuffers.filter((buffer) => buffer instanceof ArrayBuffer)
    : [];
  const channelCount = Math.max(1, Math.trunc(Number(body?.channelCount) || channelBuffers.length || 0));
  const sampleCount = Math.max(0, Math.trunc(Number(body?.sampleCount) || 0));
  const maxTotalSamples = Math.max(0, Math.trunc(Number(body?.maxTotalSamples) || 0));

  if (channelBuffers.length === 0) {
    self.postMessage({ type: 'error', body: { message: 'PCM downmix worker received no channel buffers.' } });
    return;
  }

  const monoSamples = sampleCount <= 0 || sampleCount * channelCount > maxTotalSamples
    ? new Float32Array(0)
    : downmixToMono(channelBuffers, sampleCount, channelCount);

  self.postMessage({
    type: 'downmixReady',
    body: {
      channelBuffers,
      monoBuffer: monoSamples.buffer,
    },
  }, [...channelBuffers, monoSamples.buffer]);
};

function downmixToMono(channelBuffers: ArrayBuffer[], sampleCount: number, channelCount: number): Float32Array {
  if (channelCount === 1) {
    return new Float32Array(channelBuffers[0]).slice(0, sampleCount);
  }

  const monoSamples = new Float32Array(sampleCount);
  const channelWeight = 1 / channelCount;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = new Float32Array(channelBuffers[channelIndex]);
    const limit = Math.min(sampleCount, channelData.length);

    for (let sampleIndex = 0; sampleIndex < limit; sampleIndex += 1) {
      monoSamples[sampleIndex] += channelData[sampleIndex] * channelWeight;
    }
  }

  return monoSamples;
}
