import {
  alignChannel,
  computeCompareStats,
  downmixToMono,
  estimateOffset,
  fitGain,
  padChannel,
  resampleChannel,
  subtractChannels,
  type CompareStats,
} from './audioscope/core/compareMath';

interface CompareSourceBody {
  channelBuffers: ArrayBuffer[];
  sampleRate: number;
}

interface ComputeRequestBody {
  a?: CompareSourceBody;
  b?: CompareSourceBody;
  gainMatch?: boolean;
  // Keeps the timeline length fixed across recomputes (the engine viewport is
  // sized to it); omitted on the first request.
  length?: number;
  // null = use the auto-detected offset.
  offsetSamples?: number | null;
  requestId?: number;
}

export interface CompareComputedBody {
  aChannels: ArrayBuffer[];
  appliedGain: number;
  autoOffsetSamples: number;
  bChannels: ArrayBuffer[];
  bSourceSampleRate: number;
  confidence: number;
  diffChannels: ArrayBuffer[];
  fitGain: number;
  length: number;
  monoA: ArrayBuffer;
  monoB: ArrayBuffer;
  monoDiff: ArrayBuffer;
  offsetSamples: number;
  requestId: number;
  sampleRate: number;
  stats: CompareStats;
}

// Kept across requests so nudging the offset or toggling gain match does not
// resample B or re-run the correlation.
let prepared: {
  aChannels: Float32Array[];
  autoOffsetSamples: number;
  bChannels: Float32Array[];
  bSourceSampleRate: number;
  confidence: number;
  monoA: Float32Array;
  monoB: Float32Array;
  sampleRate: number;
} | null = null;

function prepare(a: CompareSourceBody, b: CompareSourceBody): void {
  const sampleRate = Math.max(1, Number(a.sampleRate) || 1);
  const bSourceSampleRate = Math.max(1, Number(b.sampleRate) || sampleRate);
  const aChannels = a.channelBuffers.map((buffer) => new Float32Array(buffer));
  const bChannels = b.channelBuffers
    .map((buffer) => new Float32Array(buffer))
    .map((channel) => resampleChannel(channel, bSourceSampleRate, sampleRate));
  const aLength = aChannels[0]?.length ?? 0;
  const bLength = bChannels[0]?.length ?? 0;
  const monoA = downmixToMono(aChannels, aLength);
  const monoB = downmixToMono(bChannels, bLength);
  const estimate = estimateOffset(monoA, monoB, sampleRate);

  prepared = {
    aChannels,
    autoOffsetSamples: estimate.offsetSamples,
    bChannels,
    bSourceSampleRate,
    confidence: estimate.confidence,
    monoA,
    monoB,
    sampleRate,
  };
}

function compute(
  requestId: number,
  offsetOverride: number | null,
  gainMatch: boolean,
  lengthOverride: number | null,
): CompareComputedBody {
  if (!prepared) {
    throw new Error('Compare sources are not prepared.');
  }

  const offsetSamples = offsetOverride === null ? prepared.autoOffsetSamples : Math.trunc(offsetOverride);
  const aLength = prepared.aChannels[0]?.length ?? 0;
  const bLength = prepared.bChannels[0]?.length ?? 0;
  const length = lengthOverride ?? Math.max(1, aLength, bLength - offsetSamples);

  const monoA = padChannel(prepared.monoA, length);
  const unityMonoB = alignChannel(prepared.monoB, offsetSamples, length);
  const gain = fitGain(monoA, unityMonoB);
  const appliedGain = gainMatch ? gain : 1;
  const monoB = appliedGain === 1 ? unityMonoB : alignChannel(prepared.monoB, offsetSamples, length, appliedGain);
  const monoDiff = subtractChannels(monoA, monoB);

  const aChannels = prepared.aChannels.map((channel) => padChannel(channel, length));
  const bChannels = prepared.bChannels.map((channel) => alignChannel(channel, offsetSamples, length, appliedGain));
  // Per-channel residual when the layouts match; otherwise the mono residual.
  const diffChannels = aChannels.length === bChannels.length
    ? aChannels.map((channel, index) => subtractChannels(channel, bChannels[index]))
    : [monoDiff.slice()];

  return {
    aChannels: aChannels.map((channel) => channel.buffer),
    appliedGain,
    autoOffsetSamples: prepared.autoOffsetSamples,
    bChannels: bChannels.map((channel) => channel.buffer),
    bSourceSampleRate: prepared.bSourceSampleRate,
    confidence: prepared.confidence,
    diffChannels: diffChannels.map((channel) => channel.buffer),
    fitGain: gain,
    length,
    monoA: monoA.buffer,
    monoB: monoB.buffer,
    monoDiff: monoDiff.buffer,
    offsetSamples,
    requestId,
    sampleRate: prepared.sampleRate,
    stats: computeCompareStats(monoA, monoB, monoDiff),
  };
}

self.onmessage = (event: MessageEvent<{ body?: ComputeRequestBody; type?: string }>): void => {
  if (event.data?.type !== 'compute') {
    return;
  }

  const body = event.data.body ?? {};
  const requestId = Math.max(0, Math.trunc(Number(body.requestId) || 0));

  try {
    if (body.a && body.b) {
      prepare(body.a, body.b);
    }

    const offset = Number.isFinite(body.offsetSamples) ? Number(body.offsetSamples) : null;
    const length = Number(body.length) > 0 ? Math.trunc(Number(body.length)) : null;
    const result = compute(requestId, offset, Boolean(body.gainMatch), length);
    self.postMessage({ type: 'computed', body: result }, [
      ...result.aChannels,
      ...result.bChannels,
      ...result.diffChannels,
      result.monoA,
      result.monoB,
      result.monoDiff,
    ]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      body: { message: error instanceof Error ? error.message : String(error), requestId },
    });
  }
};
