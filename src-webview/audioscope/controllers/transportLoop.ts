import { formatTime } from '../core/format';
import type { AudioscopeElements } from '../core/elements';

interface AudioscopeTransportLoopDeps {
  applyWaveformPlaybackTime: (timeSeconds: number, range?: any) => void;
  closePlaybackRateMenu: (options?: { restoreFocus?: boolean }) => void;
  elements: AudioscopeElements;
  getDisplayedWaveformRange: (desiredDisplayRange?: any) => any;
  getEffectiveDuration: () => number;
  getWaveformRange: (playbackTime?: number | null, smoothFollowPlaybackActive?: boolean) => any;
  isSmoothFollowPlaybackActive: (currentTime?: number, isPlaying?: boolean) => boolean;
  refreshWaveformHoverPresentation: (options?: { displayRange?: any }) => void;
  renderMediaMetadata: () => void;
  renderTransportTimelineOverview: (options?: {
    currentTime?: number;
    displayRange?: any;
    duration?: number;
    isPlayable?: boolean;
  }) => void;
  state: any;
  syncFollowView: (timeSeconds: number, range?: any, smoothFollowPlaybackActive?: boolean) => void;
  syncPlaybackRateControl: () => void;
}

export function createAudioscopeTransportLoopController({
  applyWaveformPlaybackTime,
  closePlaybackRateMenu,
  elements,
  getDisplayedWaveformRange,
  getEffectiveDuration,
  getWaveformRange,
  isSmoothFollowPlaybackActive,
  refreshWaveformHoverPresentation,
  renderMediaMetadata,
  renderTransportTimelineOverview,
  state,
  syncFollowView,
  syncPlaybackRateControl,
}: AudioscopeTransportLoopDeps) {
  function hasPlaybackTransport() {
    return Boolean(state.audioTransport)
      && (
        state.playbackTransportKind === 'audio-worklet-copy'
        || state.playbackTransportKind === 'audio-worklet-stretch'
      )
      && getEffectiveDuration() > 0;
  }

  function isPlaybackActive() {
    return state.audioTransport?.isPlaying() === true;
  }

  function getCurrentPlaybackTime() {
    const duration = getEffectiveDuration();
    const currentTime = Number(state.audioTransport?.getCurrentTime());
    return Math.min(duration || 0, Math.max(0, currentTime));
  }

  function startPlaybackLoop() {
    window.cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = window.requestAnimationFrame(() => {
      state.playbackFrame = 0;
      syncTransport();
    });
  }

  function syncTransport() {
    const duration = getEffectiveDuration();
    const hasSession = Boolean(state.audioTransport) && Number.isFinite(duration) && duration > 0;
    const isPlayable = hasPlaybackTransport() && Number.isFinite(duration) && duration > 0;
    const playbackActive = isPlayable && state.audioTransport?.isPlaying() === true;
    const currentTime = isPlayable ? getCurrentPlaybackTime() : 0;
    const smoothFollowPlaybackActive = isSmoothFollowPlaybackActive(currentTime, playbackActive);
    const viewportRange = getWaveformRange(currentTime, smoothFollowPlaybackActive);

    elements.playToggle.disabled = !hasPlaybackTransport();
    elements.playToggle.textContent = playbackActive ? 'Pause' : 'Play';
    elements.seekBackward.disabled = !isPlayable;
    elements.seekForward.disabled = !isPlayable;
    elements.playbackRateSelect.disabled = !hasSession;
    elements.playbackRateSelect.value = String(state.playbackRate);
    if (!hasSession) {
      closePlaybackRateMenu();
    }
    syncPlaybackRateControl();
    elements.timeReadout.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

    syncFollowView(currentTime, viewportRange, smoothFollowPlaybackActive);
    const groundTruthRange = getWaveformRange(currentTime, smoothFollowPlaybackActive);
    const presentedRange = getDisplayedWaveformRange(groundTruthRange);

    if (!smoothFollowPlaybackActive) {
      refreshWaveformHoverPresentation({ displayRange: presentedRange });
    }

    applyWaveformPlaybackTime(currentTime, presentedRange);
    renderTransportTimelineOverview({
      currentTime,
      displayRange: presentedRange,
      duration,
      isPlayable,
    });

    if (playbackActive && !state.playbackFrame) {
      startPlaybackLoop();
    }
  }

  function setPlaybackPosition(timeSeconds, { sync = true } = {}) {
    if (!state.audioTransport) {
      return;
    }

    const duration = getEffectiveDuration();

    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(timeSeconds)) {
      return;
    }

    const nextTime = Math.min(duration, Math.max(0, timeSeconds));
    state.audioTransport.seek(nextTime);

    if (sync) {
      syncTransport();
    }
  }

  async function togglePlayback() {
    if (!state.audioTransport) {
      return;
    }

    if (!state.audioTransport.isPlaying()) {
      try {
        await state.audioTransport.play();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.playbackTransportError = message;
        renderMediaMetadata();
      }

      syncTransport();
      return;
    }

    state.audioTransport.pause();
    syncTransport();
  }

  function seekBy(deltaSeconds) {
    if (!state.audioTransport || !Number.isFinite(deltaSeconds)) {
      return;
    }

    setPlaybackPosition(getCurrentPlaybackTime() + deltaSeconds);
  }

  return {
    getCurrentPlaybackTime,
    hasPlaybackTransport,
    isPlaybackActive,
    seekBy,
    setPlaybackPosition,
    startPlaybackLoop,
    syncTransport,
    togglePlayback,
  };
}
