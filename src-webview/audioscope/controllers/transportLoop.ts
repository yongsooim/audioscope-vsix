import type { PlaybackSession, AudioTransport } from '../../transport/audioTransport';
import type { PlaybackClockState } from '../../audioEngineProtocol';
import type { AudioscopeElements } from '../core/elements';
import { formatTime } from '../core/format';

interface TransportLoopState {
  audioTransport: AudioTransport | null;
  engineWorker: Worker | null;
  playbackFrame: number;
  playbackRate: number;
  playbackSession: PlaybackSession | null;
  playbackTransportError: string | null;
  playbackTransportKind: string;
}

interface AudioscopeTransportLoopDeps {
  elements: AudioscopeElements;
  frameToSeconds: (frame: number) => number;
  getDurationFrames: () => number;
  getEffectiveDurationSeconds: () => number;
  getSampleRate: () => number;
  renderMediaMetadata: () => void;
  state: TransportLoopState;
  syncPlaybackRateControl: () => void;
}

export function createAudioscopeTransportLoopController({
  elements,
  frameToSeconds,
  getDurationFrames,
  getEffectiveDurationSeconds,
  getSampleRate,
  renderMediaMetadata,
  state,
  syncPlaybackRateControl,
}: AudioscopeTransportLoopDeps) {
  function getPlaybackClockState() {
    return state.audioTransport?.getPlaybackClockState() ?? null;
  }

  function toWorkerClockState(clock: ReturnType<typeof getPlaybackClockState>): PlaybackClockState {
    return clock
      ? {
        currentFrameFloat: clock.currentFrameFloat,
        durationFrames: clock.durationFrames,
        loopEndFrame: clock.loopEndFrame,
        loopStartFrame: clock.loopStartFrame,
        playing: clock.playing,
        sampleRate: clock.sampleRate,
      }
      : {
        currentFrameFloat: 0,
        durationFrames: getDurationFrames(),
        loopEndFrame: null,
        loopStartFrame: null,
        playing: false,
        sampleRate: getSampleRate(),
      };
  }

  function hasPlaybackTransport(): boolean {
    return Boolean(state.audioTransport)
      && (state.playbackTransportKind === 'audio-worklet-copy' || state.playbackTransportKind === 'audio-worklet-stretch')
      && getEffectiveDurationSeconds() > 0;
  }

  function startPlaybackLoop(): void {
    window.cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = window.requestAnimationFrame(() => {
      state.playbackFrame = 0;
      syncTransport();
    });
  }

  function syncTransport(): void {
    const clock = getPlaybackClockState();
    const durationSeconds = getEffectiveDurationSeconds();
    const currentTime = clock && clock.sampleRate > 0
      ? frameToSeconds(Math.round(clock.currentFrameFloat))
      : 0;

    elements.playToggle.disabled = !hasPlaybackTransport();
    elements.playToggle.textContent = state.audioTransport?.isPlaying() ? 'Pause' : 'Play';
    elements.seekBackward.disabled = !hasPlaybackTransport();
    elements.seekForward.disabled = !hasPlaybackTransport();
    elements.playbackRateSelect.disabled = !state.audioTransport;
    elements.playbackRateSelect.value = String(state.playbackRate);
    elements.timeReadout.textContent = `${formatTime(currentTime)} / ${formatTime(durationSeconds)}`;
    syncPlaybackRateControl();

    if (state.engineWorker) {
      state.engineWorker.postMessage({
        type: 'PlaybackClockTick',
        body: toWorkerClockState(clock),
      });
    }

    if (state.audioTransport?.isPlaying()) {
      startPlaybackLoop();
    }
  }

  function setPlaybackPositionFromFrame(frame: number): void {
    if (!state.audioTransport) {
      return;
    }

    state.audioTransport.seek(frameToSeconds(frame));
    syncTransport();
  }

  function seekBy(deltaSeconds: number): void {
    if (!state.audioTransport || !Number.isFinite(deltaSeconds)) {
      return;
    }

    const currentTime = state.audioTransport.getCurrentTime();
    state.audioTransport.seek(currentTime + deltaSeconds);
    syncTransport();
  }

  async function togglePlayback(): Promise<void> {
    if (!state.audioTransport) {
      return;
    }

    if (!state.audioTransport.isPlaying()) {
      try {
        await state.audioTransport.play();
      } catch (error) {
        state.playbackTransportError = error instanceof Error ? error.message : String(error);
        renderMediaMetadata();
      }
    } else {
      state.audioTransport.pause();
    }

    syncTransport();
  }

  return {
    hasPlaybackTransport,
    seekBy,
    setPlaybackPositionFromFrame,
    startPlaybackLoop,
    syncTransport,
    togglePlayback,
  };
}
