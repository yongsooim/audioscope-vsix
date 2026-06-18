import type { PlaybackSession } from '../../transport/audioTransport';

// Upper bound on total decoded samples (summed across channels) we will analyze.
// Beyond this the per-channel PCM copies held by the transport, waveform and
// spectrogram workers multiply into multiple GB and risk an OOM, so the caller
// refuses the file with a message instead of crashing. ~600M samples ≈ a
// 1.7-hour 48kHz stereo file (or ~3.5h mono).
export const MAX_TOTAL_ANALYSIS_SAMPLES = 600_000_000;

// Downmix every channel to a single mono signal. A mono source is copied
// directly (no per-sample accumulation), and oversized files skip the loop
// entirely (the caller refuses them) so a pathologically long file cannot
// freeze the main thread for seconds during the downmix.
function downmixToMono(channelBuffers: ArrayBuffer[], sampleCount: number, channelCount: number): Float32Array {
  if (sampleCount <= 0 || sampleCount * channelCount > MAX_TOTAL_ANALYSIS_SAMPLES) {
    return new Float32Array(0);
  }

  if (channelCount === 1) {
    const buffer = channelBuffers[0];
    return buffer instanceof ArrayBuffer ? new Float32Array(buffer).slice() : new Float32Array(sampleCount);
  }

  const mono = new Float32Array(sampleCount);
  const channelWeight = 1 / channelCount;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const buffer = channelBuffers[channelIndex];
    if (!(buffer instanceof ArrayBuffer)) {
      continue;
    }
    const channelData = new Float32Array(buffer);
    const limit = Math.min(sampleCount, channelData.length);
    for (let sampleIndex = 0; sampleIndex < limit; sampleIndex += 1) {
      mono[sampleIndex] += channelData[sampleIndex] * channelWeight;
    }
  }
  return mono;
}

export function createPlaybackAnalysisData(audioBuffer: AudioBuffer): { monoSamples: Float32Array; playbackSession: PlaybackSession } {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const sampleCount = Math.max(0, audioBuffer.length);
  const channelBuffers: ArrayBuffer[] = [];

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    channelBuffers.push(audioBuffer.getChannelData(channelIndex).slice().buffer);
  }

  return {
    monoSamples: downmixToMono(channelBuffers, sampleCount, channelCount),
    playbackSession: {
      channelBuffers,
      durationSeconds: audioBuffer.duration,
      numberOfChannels: audioBuffer.numberOfChannels,
      sourceLength: audioBuffer.length,
      sourceSampleRate: audioBuffer.sampleRate,
    },
  };
}

export function createPlaybackAnalysisDataFromPlaybackSession(playbackSession: PlaybackSession): {
  monoSamples: Float32Array;
  playbackSession: PlaybackSession;
} {
  const channelCount = Math.max(1, playbackSession.numberOfChannels);
  const sampleCount = Math.max(0, playbackSession.sourceLength);

  return {
    monoSamples: downmixToMono(playbackSession.channelBuffers, sampleCount, channelCount),
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
