import type { PlaybackSession, AudioTransport } from '../../transport/audioTransport';
import type { ViewportUiState } from '../../audioEngineProtocol';
import type { AudioscopeElements } from '../core/elements';

interface LifecycleState {
  analysis: unknown | null;
  analysisOverviewRefreshPending: boolean;
  analysisRuntimeReadyPromise: Promise<void> | null;
  analysisWorker: Worker | null;
  analysisWorkerBootstrapUrl: string | null;
  audioTransport: AudioTransport | null;
  deferredAuxiliaryLoadsLoadToken: number;
  engineSurfacesPosted: boolean;
  engineUiState: ViewportUiState | null;
  engineWorker: Worker | null;
  engineWorkerBootstrapUrl: string | null;
  waveformWorker: Worker | null;
  waveformWorkerBootstrapUrl: string | null;
  followPlayback: boolean;
  hoverState: {
    spectrogram: unknown | null;
    waveform: unknown | null;
  };
  initialWaveformReadyLoadToken: number;
  lastAppliedTransportCommandSerial: number;
  lastSyncedSpectrogramDisplay: unknown | null;
  loopHandleDrag: unknown | null;
  playbackFrame: number;
  playbackSession: PlaybackSession | null;
  pendingAnalysisSession: unknown | null;
  resolveAnalysisRuntimeReady: (() => void) | null;
  selectionDrag: unknown | null;
  spectrogramCanvas: HTMLCanvasElement | null;
  spectrogramConfigApplyTimer: number | null;
  spectrogramConfigPersistPending: boolean;
  spectrogramDefaultsPersistTimer: number | null;
  spectrogramFrame: number;
  spectrogramRenderForcePending: boolean;
  spectrogramSurfaceResetPromise: Promise<void> | null;
  spectrogramSurfaceReadyPromise: Promise<void> | null;
  waveformCanvas: HTMLCanvasElement | null;
  waveformSurfaceReadyPromise: Promise<void> | null;
  waveformViewport: unknown;
}

interface AudioscopeLifecycleControllerDeps {
  createInitialWaveformViewportState: () => unknown;
  elements: AudioscopeElements;
  hideSurfaceHoverTooltip: (tooltipElement: HTMLElement) => void;
  hideWaveformSampleMarker: () => void;
  renderSpectrogramMeta: () => void;
  renderSpectrogramScale: () => void;
  renderWaveformUi: () => void;
  state: LifecycleState;
}

export function createAudioscopeLifecycleController({
  createInitialWaveformViewportState,
  elements,
  hideSurfaceHoverTooltip,
  hideWaveformSampleMarker,
  renderSpectrogramMeta,
  renderSpectrogramScale,
  renderWaveformUi,
  state,
}: AudioscopeLifecycleControllerDeps) {
  function disposeEngineWorker(): void {
    if (state.engineWorker) {
      state.engineWorker.terminate();
      state.engineWorker = null;
    }

    if (state.engineWorkerBootstrapUrl) {
      URL.revokeObjectURL(state.engineWorkerBootstrapUrl);
      state.engineWorkerBootstrapUrl = null;
    }
  }

  function disposeWaveformWorker(): void {
    if (state.waveformWorker) {
      state.waveformWorker.postMessage({ type: 'disposeSession' });
      state.waveformWorker.terminate();
      state.waveformWorker = null;
    }

    if (state.waveformWorkerBootstrapUrl) {
      URL.revokeObjectURL(state.waveformWorkerBootstrapUrl);
      state.waveformWorkerBootstrapUrl = null;
    }
  }

  function disposeAnalysisWorker(): void {
    if (state.analysisWorker) {
      state.analysisWorker.postMessage({ type: 'disposeSession' });
      state.analysisWorker.terminate();
      state.analysisWorker = null;
    }

    state.analysisRuntimeReadyPromise = null;
    state.resolveAnalysisRuntimeReady = null;
    state.analysis = null;
    state.spectrogramSurfaceResetPromise = null;
    window.cancelAnimationFrame(state.spectrogramFrame);
    state.spectrogramFrame = 0;
    state.spectrogramRenderForcePending = false;

    if (state.spectrogramConfigApplyTimer) {
      window.clearTimeout(state.spectrogramConfigApplyTimer);
      state.spectrogramConfigApplyTimer = null;
    }

    state.spectrogramConfigPersistPending = false;

    if (state.analysisWorkerBootstrapUrl) {
      URL.revokeObjectURL(state.analysisWorkerBootstrapUrl);
      state.analysisWorkerBootstrapUrl = null;
    }
  }

  function resetEngineWorkerSession(): void {
    state.engineWorker?.postMessage({ type: 'DisposeSession' });
  }

  function resetWaveformWorkerSession(): void {
    state.waveformWorker?.postMessage({ type: 'dispose' });
  }

  function resetAnalysisWorkerSession(): void {
    state.analysisWorker?.postMessage({ type: 'disposeSession' });
  }

  function destroySession(): void {
    if (state.spectrogramDefaultsPersistTimer) {
      window.clearTimeout(state.spectrogramDefaultsPersistTimer);
      state.spectrogramDefaultsPersistTimer = null;
    }

    if (state.spectrogramConfigApplyTimer) {
      window.clearTimeout(state.spectrogramConfigApplyTimer);
      state.spectrogramConfigApplyTimer = null;
    }

    state.spectrogramConfigPersistPending = false;
    window.cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = 0;
    window.cancelAnimationFrame(state.spectrogramFrame);
    state.spectrogramFrame = 0;
    state.spectrogramRenderForcePending = false;
    state.analysisOverviewRefreshPending = false;
    state.analysis = null;
    state.pendingAnalysisSession = null;
    state.initialWaveformReadyLoadToken = 0;
    state.deferredAuxiliaryLoadsLoadToken = 0;
    state.selectionDrag = null;
    state.loopHandleDrag = null;
    state.engineUiState = null;
    state.lastSyncedSpectrogramDisplay = null;
    state.hoverState.waveform = null;
    state.hoverState.spectrogram = null;
    state.lastAppliedTransportCommandSerial = 0;
    hideSurfaceHoverTooltip(elements.waveformHoverTooltip);
    hideSurfaceHoverTooltip(elements.spectrogramHoverTooltip);
    hideWaveformSampleMarker();
    resetAnalysisWorkerSession();
    resetEngineWorkerSession();
    resetWaveformWorkerSession();

    const audioTransport = state.audioTransport;
    state.audioTransport = null;
    void audioTransport?.dispose();

    state.playbackSession = null;
    state.waveformCanvas = null;
    state.spectrogramCanvas = null;
    state.waveformSurfaceReadyPromise = null;
    state.spectrogramSurfaceReadyPromise = null;
    state.engineSurfacesPosted = false;
    state.waveformViewport = createInitialWaveformViewportState();
    state.followPlayback = false;
    renderWaveformUi();
    renderSpectrogramScale();
    renderSpectrogramMeta();
  }

  return {
    destroySession,
    disposeAnalysisWorker,
    disposeEngineWorker,
    disposeWaveformWorker,
  };
}
