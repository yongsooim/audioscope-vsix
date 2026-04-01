import type { AudioscopeElements } from '../core/elements';

interface AudioscopeBindingsDeps {
  applyViewportSplit: (force?: boolean) => void;
  attachResizeObservers?: () => void;
  beginSelectionDrag: (event: PointerEvent, targetElement: HTMLElement) => void;
  beginViewportSplitDrag: (event: PointerEvent) => void;
  bindLoopHandle: (handleElement: HTMLElement, edge: 'start' | 'end', targetElement: HTMLElement) => void;
  closePlaybackRateMenu: (options?: { restoreFocus?: boolean }) => void;
  elements: AudioscopeElements;
  endViewportSplitDrag: (event: PointerEvent, cancelled?: boolean) => void;
  focusPlaybackRateOption: (index: number) => void;
  getEffectiveDuration: () => number;
  getPlaybackRateOptionButtons: () => HTMLButtonElement[];
  getSpectrogramCanvasTargetSize: () => { pixelHeight: number; pixelWidth: number };
  getWaveformRange: () => { start: number; end: number };
  getWaveformViewportSize: () => { width: number; height: number };
  handleSharedViewportWheel: (event: WheelEvent, targetElement: HTMLElement) => void;
  handleViewportSplitterKeydown: (event: KeyboardEvent) => void;
  hasPlaybackTransport: () => boolean;
  hideSpectrogramHoverTooltip: () => void;
  hideTimelineHoverTooltip: () => void;
  hideWaveformHoverTooltip: () => void;
  initializeKeyboardFocus?: () => void;
  isInteractiveElementTarget: (target: EventTarget | null) => boolean;
  isPlaybackRateUiTarget: (target: EventTarget | null) => boolean;
  movePlaybackRateFocus: (direction: number) => void;
  normalizePlaybackRateSelection: (value: unknown) => number;
  normalizeSpectrogramAnalysisType: (value: unknown) => string;
  normalizeSpectrogramFftSize: (value: unknown) => number;
  normalizeSpectrogramFrequencyScale: (value: unknown) => string;
  normalizeSpectrogramOverlapRatio: (value: unknown) => number;
  openPlaybackRateMenu: (options?: { focusSelected?: boolean }) => void;
  positionPlaybackRateMenu: () => void;
  queueVisibleSpectrogramRequest: (options?: { force?: boolean }) => void;
  refreshSpectrogramAnalysisConfig: () => void;
  renderMediaMetadata: () => void;
  renderSpectrogramMeta: () => void;
  renderSpectrogramScale: () => void;
  renderWaveformUi: (options?: { syncSpectrogram?: boolean }) => void;
  releaseSelectionDrag: (event: PointerEvent, targetElement: HTMLElement, cancelled?: boolean) => void;
  requestOverviewSpectrogram: (options?: { force?: boolean }) => void;
  resetSpectrogramCanvasTransform: () => void;
  resetViewportSplit: () => void;
  resetWaveformZoom: () => void;
  resizeWaveformCanvasSurface: (width: number, height: number) => void;
  scheduleSpectrogramRender: (options?: { force?: boolean }) => void;
  seekBy: (deltaSeconds: number) => void;
  setFollowPlaybackEnabled: (enabled: boolean) => void;
  setMediaMetadataDetailOpen: (open: boolean) => void;
  setPlaybackPosition: (timeSeconds: number, options?: { sync?: boolean }) => void;
  state: any;
  syncTransport: () => void;
  syncWaveformView: (options?: { force?: boolean }) => Promise<void>;
  togglePlayback: () => Promise<void>;
  togglePlaybackRateMenu: () => void;
  updateMediaMetadataDetailPosition: () => void;
  updateSelectionDrag: (event: PointerEvent, targetElement: HTMLElement) => void;
  updateSpectrogramHoverTooltip: (event: PointerEvent) => void;
  updateTimelineHoverTooltip: (event: PointerEvent) => void;
  updateViewportSplitDrag: (event: PointerEvent) => void;
  updateWaveformHoverTooltip: (event: PointerEvent) => void;
  vscode: { postMessage: (message: unknown) => void };
  zoomWaveformIn: () => void;
  zoomWaveformOut: () => void;
}

export function createAudioscopeBindingsController({
  applyViewportSplit,
  beginSelectionDrag,
  beginViewportSplitDrag,
  bindLoopHandle,
  closePlaybackRateMenu,
  elements,
  endViewportSplitDrag,
  focusPlaybackRateOption,
  getEffectiveDuration,
  getPlaybackRateOptionButtons,
  getSpectrogramCanvasTargetSize,
  getWaveformRange,
  getWaveformViewportSize,
  handleSharedViewportWheel,
  handleViewportSplitterKeydown,
  hasPlaybackTransport,
  hideSpectrogramHoverTooltip,
  hideTimelineHoverTooltip,
  hideWaveformHoverTooltip,
  isInteractiveElementTarget,
  isPlaybackRateUiTarget,
  movePlaybackRateFocus,
  normalizePlaybackRateSelection,
  normalizeSpectrogramAnalysisType,
  normalizeSpectrogramFftSize,
  normalizeSpectrogramFrequencyScale,
  normalizeSpectrogramOverlapRatio,
  openPlaybackRateMenu,
  positionPlaybackRateMenu,
  queueVisibleSpectrogramRequest,
  refreshSpectrogramAnalysisConfig,
  renderMediaMetadata,
  renderSpectrogramMeta,
  renderSpectrogramScale,
  renderWaveformUi,
  releaseSelectionDrag,
  requestOverviewSpectrogram,
  resetSpectrogramCanvasTransform,
  resetViewportSplit,
  resetWaveformZoom,
  resizeWaveformCanvasSurface,
  scheduleSpectrogramRender,
  seekBy,
  setFollowPlaybackEnabled,
  setMediaMetadataDetailOpen,
  setPlaybackPosition,
  state,
  syncTransport,
  syncWaveformView,
  togglePlayback,
  togglePlaybackRateMenu,
  updateMediaMetadataDetailPosition,
  updateSelectionDrag,
  updateSpectrogramHoverTooltip,
  updateTimelineHoverTooltip,
  updateViewportSplitDrag,
  updateWaveformHoverTooltip,
  vscode,
  zoomWaveformIn,
  zoomWaveformOut,
}: AudioscopeBindingsDeps) {
  function initializeKeyboardFocus() {
    document.body.tabIndex = -1;

    const focusKeyboardSurface = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      window.focus();

      if (document.activeElement !== document.body) {
        document.body.focus({ preventScroll: true });
      }
    };

    queueMicrotask(focusKeyboardSurface);
    window.requestAnimationFrame(focusKeyboardSurface);
    window.setTimeout(focusKeyboardSurface, 120);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        window.requestAnimationFrame(focusKeyboardSurface);
      }
    });
  }

  function attachGlobalKeyboardShortcuts() {
    window.addEventListener('keydown', (event) => {
      if (!hasPlaybackTransport() || event.defaultPrevented) {
        return;
      }

      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        seekBy(-5);
        return;
      }

      if (event.code === 'ArrowRight') {
        event.preventDefault();
        seekBy(5);
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        void togglePlayback();
        return;
      }

      if (event.code === 'KeyF' && !event.repeat) {
        event.preventDefault();
        setFollowPlaybackEnabled(!state.followPlayback);
        return;
      }

      if (isInteractiveElementTarget(event.target)) {
        return;
      }

      if (event.code === 'Minus') {
        event.preventDefault();
        zoomWaveformOut();
        return;
      }

      if (event.code === 'Equal') {
        event.preventDefault();
        zoomWaveformIn();
      }
    }, { capture: true });
  }

  function attachUiEvents() {
    elements.mediaMetadataPanel?.addEventListener('mouseenter', () => {
      setMediaMetadataDetailOpen(true);
    });
    elements.mediaMetadataPanel?.addEventListener('mouseleave', () => {
      setMediaMetadataDetailOpen(false);
    });
    elements.mediaMetadataPanel?.addEventListener('focusin', () => {
      setMediaMetadataDetailOpen(true);
    });
    elements.mediaMetadataPanel?.addEventListener('focusout', (event) => {
      if (event.relatedTarget instanceof Node && elements.mediaMetadataPanel?.contains(event.relatedTarget)) {
        return;
      }

      setMediaMetadataDetailOpen(false);
    });
    elements.mediaMetadataDetail?.addEventListener('click', (event) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      const link = target.closest('[data-external-url]');

      if (!(link instanceof HTMLAnchorElement)) {
        return;
      }

      const url = link.dataset.externalUrl;

      if (!url) {
        return;
      }

      event.preventDefault();
      vscode.postMessage({
        type: 'openExternal',
        body: {
          url,
        },
      });
    });
    elements.waveToolbar?.addEventListener('scroll', () => {
      updateMediaMetadataDetailPosition();
    }, { passive: true });
    window.addEventListener('resize', () => {
      updateMediaMetadataDetailPosition();
      closePlaybackRateMenu();
      positionPlaybackRateMenu();
    });

    elements.viewportSplitter?.addEventListener('pointerdown', (event) => {
      beginViewportSplitDrag(event);
    });
    elements.viewportSplitter?.addEventListener('pointermove', (event) => {
      updateViewportSplitDrag(event);
    });
    elements.viewportSplitter?.addEventListener('pointerup', (event) => {
      endViewportSplitDrag(event);
    });
    elements.viewportSplitter?.addEventListener('pointercancel', (event) => {
      endViewportSplitDrag(event, true);
    });
    elements.viewportSplitter?.addEventListener('dblclick', () => {
      resetViewportSplit();
    });
    elements.viewportSplitter?.addEventListener('keydown', (event) => {
      handleViewportSplitterKeydown(event);
    });

    elements.spectrogramTypeSelect?.addEventListener('change', () => {
      state.spectrogramRenderConfig.analysisType = normalizeSpectrogramAnalysisType(elements.spectrogramTypeSelect.value);
      renderSpectrogramScale();
      renderSpectrogramMeta();
      refreshSpectrogramAnalysisConfig();
    });

    elements.spectrogramFftSelect?.addEventListener('change', () => {
      state.spectrogramRenderConfig.fftSize = normalizeSpectrogramFftSize(elements.spectrogramFftSelect.value);
      renderSpectrogramMeta();
      refreshSpectrogramAnalysisConfig();
    });

    elements.spectrogramOverlapSelect?.addEventListener('change', () => {
      state.spectrogramRenderConfig.overlapRatio = normalizeSpectrogramOverlapRatio(elements.spectrogramOverlapSelect.value);
      renderSpectrogramMeta();
      refreshSpectrogramAnalysisConfig();
    });

    elements.spectrogramScaleSelect?.addEventListener('change', () => {
      state.spectrogramRenderConfig.frequencyScale = normalizeSpectrogramFrequencyScale(elements.spectrogramScaleSelect.value);
      renderSpectrogramScale();
      renderSpectrogramMeta();
      refreshSpectrogramAnalysisConfig();
    });

    elements.seekBackward.addEventListener('click', () => {
      seekBy(-5);
    });
    elements.playToggle.addEventListener('click', () => {
      void togglePlayback();
    });
    elements.seekForward.addEventListener('click', () => {
      seekBy(5);
    });
    elements.playbackRateButton.addEventListener('click', () => {
      togglePlaybackRateMenu();
    });
    elements.playbackRateButton.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.code === 'ArrowDown' || event.code === 'Enter' || event.code === 'Space') {
        event.preventDefault();
        openPlaybackRateMenu();
        return;
      }

      if (event.code === 'ArrowUp') {
        event.preventDefault();
        openPlaybackRateMenu();
        const buttons = getPlaybackRateOptionButtons();
        focusPlaybackRateOption(Math.max(0, buttons.length - 1));
        return;
      }

      if (event.code === 'Escape') {
        event.preventDefault();
        closePlaybackRateMenu();
      }
    });
    elements.playbackRateMenu.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.code === 'Escape') {
        event.preventDefault();
        closePlaybackRateMenu({ restoreFocus: true });
        return;
      }

      if (event.code === 'ArrowDown') {
        event.preventDefault();
        movePlaybackRateFocus(1);
        return;
      }

      if (event.code === 'ArrowUp') {
        event.preventDefault();
        movePlaybackRateFocus(-1);
        return;
      }

      if (event.code === 'Home') {
        event.preventDefault();
        focusPlaybackRateOption(0);
        return;
      }

      if (event.code === 'End') {
        event.preventDefault();
        focusPlaybackRateOption(getPlaybackRateOptionButtons().length - 1);
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (isPlaybackRateUiTarget(event.target)) {
        return;
      }

      closePlaybackRateMenu();
    }, true);
    document.addEventListener('focusin', (event) => {
      if (isPlaybackRateUiTarget(event.target)) {
        return;
      }

      closePlaybackRateMenu();
    });
    elements.playbackRateSelect.addEventListener('change', () => {
      const nextRate = normalizePlaybackRateSelection(elements.playbackRateSelect.value);
      state.playbackRate = nextRate;
      state.audioTransport?.setPlaybackRate(nextRate);
      renderMediaMetadata();
      syncTransport();
    });
    elements.timeline.addEventListener('input', () => {
      if (!hasPlaybackTransport()) {
        return;
      }

      const progress = Number(elements.timeline.value);
      const duration = getEffectiveDuration();

      if (!Number.isFinite(duration) || duration <= 0) {
        return;
      }

      setPlaybackPosition(progress * duration);
    });
    elements.waveformOverview.addEventListener('pointermove', (event) => {
      updateTimelineHoverTooltip(event);
    });
    elements.waveformOverview.addEventListener('pointerleave', () => {
      hideTimelineHoverTooltip();
    });
    elements.waveformOverview.addEventListener('pointercancel', () => {
      hideTimelineHoverTooltip();
    });

    elements.waveZoomOut.addEventListener('click', () => {
      zoomWaveformOut();
    });
    elements.waveZoomReset.addEventListener('click', () => {
      resetWaveformZoom();
    });
    elements.waveZoomIn.addEventListener('click', () => {
      zoomWaveformIn();
    });
    elements.waveFollow.addEventListener('change', () => {
      setFollowPlaybackEnabled(elements.waveFollow.checked);
    });
    elements.waveClearLoop.addEventListener('click', () => {
      state.loopRange = null;
      state.selectionDraft = null;
      state.audioTransport?.setLoop(null);
      renderWaveformUi();
      syncTransport();
    });

    elements.waveformViewport.addEventListener('wheel', (event) => {
      handleSharedViewportWheel(event, elements.waveformViewport);
    }, { passive: false });

    elements.waveformHitTarget.addEventListener('pointerdown', (event) => {
      const duration = getEffectiveDuration();
      const range = getWaveformRange();

      if (!hasPlaybackTransport() || duration <= 0 || range.end <= range.start) {
        return;
      }

      beginSelectionDrag(event, elements.waveformHitTarget);
    });

    elements.waveformHitTarget.addEventListener('pointermove', (event) => {
      updateWaveformHoverTooltip(event);
      updateSelectionDrag(event, elements.waveformHitTarget);
    });
    elements.waveformHitTarget.addEventListener('pointerleave', () => {
      hideWaveformHoverTooltip();
    });

    const releaseWaveformPointer = (event) => {
      releaseSelectionDrag(event, elements.waveformHitTarget);
    };

    elements.waveformHitTarget.addEventListener('pointerup', releaseWaveformPointer);
    elements.waveformHitTarget.addEventListener('pointercancel', (event) => {
      hideWaveformHoverTooltip();
      releaseSelectionDrag(event, elements.waveformHitTarget, true);
    });

    bindLoopHandle(elements.waveformLoopStart, 'start', elements.waveformHitTarget);
    bindLoopHandle(elements.waveformLoopEnd, 'end', elements.waveformHitTarget);
    bindLoopHandle(elements.spectrogramLoopStart, 'start', elements.spectrogramHitTarget);
    bindLoopHandle(elements.spectrogramLoopEnd, 'end', elements.spectrogramHitTarget);

    elements.spectrogramHitTarget.addEventListener('pointerdown', (event) => {
      const duration = getEffectiveDuration();
      const range = getWaveformRange();

      if (!hasPlaybackTransport() || duration <= 0 || range.end <= range.start) {
        return;
      }

      beginSelectionDrag(event, elements.spectrogramHitTarget);
    });

    elements.spectrogramHitTarget.addEventListener('pointermove', (event) => {
      updateSpectrogramHoverTooltip(event);
      updateSelectionDrag(event, elements.spectrogramHitTarget);
    });
    elements.spectrogramHitTarget.addEventListener('pointerleave', () => {
      hideSpectrogramHoverTooltip();
    });

    elements.spectrogramHitTarget.addEventListener('pointerup', (event) => {
      releaseSelectionDrag(event, elements.spectrogramHitTarget);
    });

    elements.spectrogramHitTarget.addEventListener('pointercancel', (event) => {
      hideSpectrogramHoverTooltip();
      releaseSelectionDrag(event, elements.spectrogramHitTarget, true);
    });

    elements.spectrogramHitTarget.addEventListener('wheel', (event) => {
      handleSharedViewportWheel(event, elements.spectrogramHitTarget);
    }, { passive: false });

    elements.spectrogramHitTarget.addEventListener('dblclick', () => {
      void togglePlayback();
    });
  }

  function attachResizeObservers() {
    const resizeObserver = new ResizeObserver(() => {
      applyViewportSplit();
      const { height, width } = getWaveformViewportSize();
      const { pixelHeight, pixelWidth } = getSpectrogramCanvasTargetSize();
      const overviewWidth = Math.max(1, elements.waveformOverview.clientWidth);
      const waveformViewportResized =
        state.observedWaveformViewportWidth !== width
        || state.observedWaveformViewportHeight !== height;
      const spectrogramSurfaceResized =
        state.observedSpectrogramPixelWidth !== pixelWidth
        || state.observedSpectrogramPixelHeight !== pixelHeight;
      const overviewWidthResized = state.observedOverviewWidth !== overviewWidth;
      const dimensionsUnchanged =
        !waveformViewportResized
        && !spectrogramSurfaceResized
        && !overviewWidthResized;

      if (dimensionsUnchanged) {
        return;
      }

      state.observedWaveformViewportWidth = width;
      state.observedWaveformViewportHeight = height;
      state.observedSpectrogramPixelWidth = pixelWidth;
      state.observedSpectrogramPixelHeight = pixelHeight;
      state.observedOverviewWidth = overviewWidth;
      resizeWaveformCanvasSurface(width, height);

      if (state.analysisWorker && spectrogramSurfaceResized) {
        state.analysisWorker.postMessage({
          type: 'resizeCanvas',
          body: {
            pixelHeight,
            pixelWidth,
          },
        });
      }

      renderWaveformUi({ syncSpectrogram: spectrogramSurfaceResized });
      void syncWaveformView({ force: waveformViewportResized });
      renderSpectrogramScale();
      resetSpectrogramCanvasTransform();

      if (spectrogramSurfaceResized || overviewWidthResized) {
        requestOverviewSpectrogram({ force: true });
      }

      if (spectrogramSurfaceResized) {
        queueVisibleSpectrogramRequest({ force: true });
        scheduleSpectrogramRender({ force: true });
      }
    });

    resizeObserver.observe(document.body);
    resizeObserver.observe(elements.viewport);
    resizeObserver.observe(elements.waveformViewport);
    resizeObserver.observe(elements.waveformOverview);
  }

  return {
    attachGlobalKeyboardShortcuts,
    attachResizeObservers,
    attachUiEvents,
    initializeKeyboardFocus,
  };
}
