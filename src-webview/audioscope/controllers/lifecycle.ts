import {
  createExternalToolStatusState,
  createLoudnessSummaryState,
  createMediaMetadataState,
} from './media';
import type { AudioscopeElements } from '../core/elements';

interface AudioscopeLifecycleDeps {
  cancelDeferredAnalysis: () => void;
  embeddedMediaToolsGuidance: string;
  elements: AudioscopeElements;
  hideSpectrogramHoverTooltip: () => void;
  hideWaveformHoverTooltip: () => void;
  renderLoudnessSummary: () => void;
  renderMediaMetadata: () => void;
  renderSpectrogramMeta: () => void;
  renderWaveformUi: () => void;
  replaceWaveformBitmap: (bitmap: ImageBitmap | null) => void;
  resetSpectrogramCanvasTransform: () => void;
  setWaveformDisplaySnapshot: (snapshot: any) => void;
  state: any;
  syncWaveformLegacyStateFromSnapshot: (snapshot: any) => void;
}

export function createAudioscopeLifecycleController({
  cancelDeferredAnalysis,
  embeddedMediaToolsGuidance,
  elements,
  hideSpectrogramHoverTooltip,
  hideWaveformHoverTooltip,
  renderLoudnessSummary,
  renderMediaMetadata,
  renderSpectrogramMeta,
  renderWaveformUi,
  replaceWaveformBitmap,
  resetSpectrogramCanvasTransform,
  setWaveformDisplaySnapshot,
  state,
  syncWaveformLegacyStateFromSnapshot,
}: AudioscopeLifecycleDeps) {
  function disposeAnalysisWorker() {
    if (state.analysisWorker) {
      state.analysisWorker.postMessage({ type: 'disposeSession' });
      state.analysisWorker.terminate();
      state.analysisWorker = null;
    }

    state.analysisRuntimeReadyPromise = null;
    state.resolveAnalysisRuntimeReady = null;

    if (state.analysisWorkerBootstrapUrl) {
      URL.revokeObjectURL(state.analysisWorkerBootstrapUrl);
      state.analysisWorkerBootstrapUrl = null;
    }
  }

  function disposeSpectrogramSurface() {
    const replacement = document.createElement('canvas');
    replacement.id = 'spectrogram';
    replacement.className = 'spectrogram-canvas';
    replacement.setAttribute('aria-label', 'Spectrogram');
    elements.spectrogram.replaceWith(replacement);
    elements.spectrogram = replacement;
    resetSpectrogramCanvasTransform();
  }

  function disposeWaveformRenderer() {
    if (state.waveformWorker) {
      state.waveformWorker.postMessage({ type: 'dispose' });
      state.waveformWorker.terminate();
      state.waveformWorker = null;
    }

    state.waveformRuntimeReadyPromise = null;
    state.resolveWaveformRuntimeReady = null;
    if (state.waveformWorkerBootstrapUrl) {
      URL.revokeObjectURL(state.waveformWorkerBootstrapUrl);
      state.waveformWorkerBootstrapUrl = null;
    }

    replaceWaveformBitmap(null);
    state.waveformDisplaySnapshot = null;
    state.waveformCanvas = null;
    state.waveformCanvasContext = null;
    state.waveformPendingRequest = null;
    syncWaveformLegacyStateFromSnapshot(null);
    elements.waveformCanvasHost.replaceChildren();
    elements.waveformCanvasHost.style.width = '100%';
    elements.waveformCanvasHost.style.transform = 'translate3d(0px, 0, 0)';
    elements.waveformAxis.replaceChildren();
  }

  function destroySession() {
    window.cancelAnimationFrame(state.playbackFrame);
    window.cancelAnimationFrame(state.waveformFrame);
    window.cancelAnimationFrame(state.spectrogramFrame);
    window.cancelAnimationFrame(state.spectrogramRequestFrame);
    state.playbackFrame = 0;
    state.waveformFrame = 0;
    state.spectrogramFrame = 0;
    state.spectrogramRequestFrame = 0;
    state.waveformRenderForcePending = false;
    state.waveformRenderRequestOptions = null;
    state.spectrogramRenderForcePending = false;

    cancelDeferredAnalysis();
    if (state.sourceFetchController) {
      state.sourceFetchController.abort();
      state.sourceFetchController = null;
    }

    state.rejectDecodeFallback?.(new Error('Decode request was cancelled.'));

    disposeAnalysisWorker();
    disposeWaveformRenderer();
    disposeSpectrogramSurface();

    const audioTransport = state.audioTransport;
    state.audioTransport = null;
    void audioTransport?.dispose();

    state.waveformRequestGeneration = 0;
    state.waveformPendingRequest = null;
    setWaveformDisplaySnapshot(null);
    state.playbackSession = null;
    state.waveformSamples = null;
    state.externalTools = createExternalToolStatusState(embeddedMediaToolsGuidance);
    state.mediaMetadata = createMediaMetadataState('idle');
    state.mediaMetadataDetailOpen = false;
    state.playbackSourceKind = 'native';
    state.playbackTransportKind = 'unavailable';
    state.playbackTransportError = null;
    state.analysisSourceKind = 'native';
    state.decodeFallbackLoadToken = 0;
    state.decodeFallbackPromise = null;
    state.decodeFallbackResult = null;
    state.decodeFallbackError = null;
    state.resolveDecodeFallback = null;
    state.rejectDecodeFallback = null;
    state.waveformViewRange = { start: 0, end: 0 };
    state.waveformHoverClientPoint = null;
    state.waveformSeekPointerId = null;
    state.selectionDrag = null;
    state.selectionDraft = null;
    state.loopHandleDrag = null;
    state.loopRange = null;
    state.analysisStartedForLoadToken = 0;
    state.sessionVersion = 0;
    state.analysis = null;
    state.loudness = createLoudnessSummaryState('idle');
    state.waveformSurfaceReadyPromise = null;
    state.spectrogramSurfaceReadyPromise = null;
    hideWaveformHoverTooltip();
    hideSpectrogramHoverTooltip();
    renderWaveformUi();
    renderSpectrogramMeta();
    renderLoudnessSummary();
    renderMediaMetadata();
  }

  return {
    destroySession,
    disposeAnalysisWorker,
    disposeSpectrogramSurface,
    disposeWaveformRenderer,
  };
}
