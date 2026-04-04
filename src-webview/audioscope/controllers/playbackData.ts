import type { PlaybackSession } from '../../transport/audioTransport';

export function createPlaybackAnalysisData(audioBuffer: AudioBuffer): { monoSamples: Float32Array; playbackSession: PlaybackSession } {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const sampleCount = Math.max(0, audioBuffer.length);
  const channelBuffers: ArrayBuffer[] = [];
  const mono = new Float32Array(sampleCount);
  const channelWeight = 1 / channelCount;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    channelBuffers.push(channelData.slice().buffer);

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      mono[sampleIndex] += (channelData[sampleIndex] ?? 0) * channelWeight;
    }
  }

  return {
    monoSamples: mono,
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
  const mono = new Float32Array(sampleCount);
  const channelWeight = 1 / channelCount;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelBuffer = playbackSession.channelBuffers[channelIndex];

    if (!(channelBuffer instanceof ArrayBuffer)) {
      continue;
    }

    const channelData = new Float32Array(channelBuffer);

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      mono[sampleIndex] += (channelData[sampleIndex] ?? 0) * channelWeight;
    }
  }

  return {
    monoSamples: mono,
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
