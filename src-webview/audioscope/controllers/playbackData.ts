import type { PlaybackSession } from '../../transport/audioTransport';

// Upper bound on total decoded samples (summed across channels) we will analyze.
// Beyond this the per-channel PCM copies held by the transport, waveform and
// spectrogram workers multiply into multiple GB and risk an OOM, so the caller
// refuses the file with a message instead of crashing. ~600M samples ≈ a
// 1.7-hour 48kHz stereo file (or ~3.5h mono).
export const MAX_TOTAL_ANALYSIS_SAMPLES = 600_000_000;

export interface DownmixedPcm {
  channelBuffers: ArrayBuffer[];
  monoBuffer: ArrayBuffer;
}

export type DownmixPcm = (
  channelBuffers: ArrayBuffer[],
  sampleCount: number,
  channelCount: number,
) => Promise<DownmixedPcm>;

export async function createPlaybackAnalysisData(
  audioBuffer: AudioBuffer,
  downmixPcm: DownmixPcm,
): Promise<{ monoSamples: Float32Array; playbackSession: PlaybackSession }> {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const channelBuffers: ArrayBuffer[] = [];

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    channelBuffers.push(audioBuffer.getChannelData(channelIndex).slice().buffer);
  }

  return preparePlaybackAnalysisData({
    channelBuffers,
    durationSeconds: audioBuffer.duration,
    numberOfChannels: channelCount,
    sourceLength: audioBuffer.length,
    sourceSampleRate: audioBuffer.sampleRate,
  }, downmixPcm);
}

export async function preparePlaybackAnalysisData(
  playbackSession: PlaybackSession,
  downmixPcm: DownmixPcm,
): Promise<{ monoSamples: Float32Array; playbackSession: PlaybackSession }> {
  if (playbackSession.monoBuffer instanceof ArrayBuffer) {
    return createPlaybackAnalysisDataFromPlaybackSession(playbackSession);
  }

  const downmixed = await downmixPcm(
    playbackSession.channelBuffers,
    Math.max(0, playbackSession.sourceLength),
    Math.max(1, playbackSession.numberOfChannels),
  );

  return createPlaybackAnalysisDataFromPlaybackSession({
    ...playbackSession,
    channelBuffers: downmixed.channelBuffers,
    monoBuffer: downmixed.monoBuffer,
  });
}

export function createPlaybackAnalysisDataFromPlaybackSession(playbackSession: PlaybackSession): {
  monoSamples: Float32Array;
  playbackSession: PlaybackSession;
} {
  const monoBuffer = playbackSession.monoBuffer;

  return {
    // Keep the retained mono buffer available for channel-mode changes. The
    // native ArrayBuffer copy is synchronous, but the per-sample mix now runs
    // entirely in pcmDownmixWorker.
    monoSamples: monoBuffer instanceof ArrayBuffer
      ? new Float32Array(monoBuffer.slice(0))
      : new Float32Array(0),
    playbackSession,
  };
}

export function createPlaybackSessionFromPcmFallback(fallback): PlaybackSession {
  return {
    channelBuffers: fallback.channelBuffers,
    durationSeconds: fallback.sampleRate > 0 ? fallback.frameCount / fallback.sampleRate : 0,
    numberOfChannels: fallback.numberOfChannels,
    sourceLength: fallback.frameCount,
    sourceSampleRate: fallback.sampleRate,
  };
}
