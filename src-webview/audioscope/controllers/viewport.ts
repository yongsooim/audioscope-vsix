import type { SetViewportIntentMessage, SurfaceKind } from '../../audioEngineProtocol';
import type { AudioscopeElements } from '../core/elements';
import { clamp } from '../core/format';

interface ViewportControllerState {
  analysisWorker: Worker | null;
  observedOverviewWidth: number;
  observedSpectrogramPixelHeight: number;
  observedSpectrogramPixelWidth: number;
  observedWaveformViewportHeight: number;
  observedWaveformViewportWidth: number;
  viewportSplitRatio: number;
  waveformWorker: Worker | null;
}

interface AudioscopeViewportControllerDeps {
  defaultViewportSplitRatio: number;
  displayPixelRatio: number;
  elements: AudioscopeElements;
  getDurationFrames: () => number;
  refreshHoveredSampleInfos: () => void;
  getSpectrogramCanvasTargetSize: () => { pixelHeight: number; pixelWidth: number };
  getWaveformViewportSize: () => { height: number; width: number };
  requestWaveformRender: () => void;
  scheduleSpectrogramRender: (options?: { force?: boolean }) => void;
  sendViewportIntent: (body: SetViewportIntentMessage['body']) => void;
  splitterFallbackSizePx: number;
  state: ViewportControllerState;
  viewportRatioMax: number;
  viewportRatioMin: number;
}

export function createAudioscopeViewportController({
  defaultViewportSplitRatio,
  displayPixelRatio,
  elements,
  getDurationFrames,
  refreshHoveredSampleInfos,
  getSpectrogramCanvasTargetSize,
  getWaveformViewportSize,
  requestWaveformRender,
  scheduleSpectrogramRender,
  sendViewportIntent,
  splitterFallbackSizePx,
  state,
  viewportRatioMax,
  viewportRatioMin,
}: AudioscopeViewportControllerDeps) {
  function normalizeViewportSplitRatio(value: number): number {
    if (!Number.isFinite(value)) {
      return defaultViewportSplitRatio;
    }

    return clamp(value, viewportRatioMin, viewportRatioMax);
  }

  function getNumericStyleSize(element: HTMLElement | null | undefined, propertyName: string, fallback = 0): number {
    if (!element) {
      return fallback;
    }

    const computedValue = Number.parseFloat(window.getComputedStyle(element)[propertyName]);
    return Number.isFinite(computedValue) ? computedValue : fallback;
  }

  function getViewportSplitterSize(): number {
    return Math.max(
      1,
      elements.viewportSplitter?.offsetHeight
        || getNumericStyleSize(elements.viewportSplitter, 'minHeight', splitterFallbackSizePx),
    );
  }

  function getWavePanelChromeHeight(): number {
    return Math.max(0, elements.waveToolbar?.offsetHeight || 0) + Math.max(0, elements.waveformAxis?.offsetHeight || 0);
  }

  function applyViewportSplit(force = false): void {
    const splitterSize = getViewportSplitterSize();
    const wavePanelChromeHeight = getWavePanelChromeHeight();
    const availableHeight = Math.max(0, elements.viewport.clientHeight - splitterSize - wavePanelChromeHeight);

    if (availableHeight <= 0) {
      const nextTemplate = `${wavePanelChromeHeight}px ${splitterSize}px 0px`;
      if (force || elements.viewport.style.gridTemplateRows !== nextTemplate) {
        elements.viewport.style.gridTemplateRows = nextTemplate;
      }
      return;
    }

    const desiredWaveHeight = availableHeight * normalizeViewportSplitRatio(state.viewportSplitRatio);
    const waveHeight = Math.round(clamp(desiredWaveHeight, 0, availableHeight));
    const spectrogramHeight = Math.max(0, availableHeight - waveHeight);
    const nextTemplate = `${wavePanelChromeHeight + waveHeight}px ${splitterSize}px ${spectrogramHeight}px`;

    if (!force && elements.viewport.style.gridTemplateRows === nextTemplate) {
      return;
    }

    elements.viewport.style.gridTemplateRows = nextTemplate;
  }

  function updateViewportSplitRatioFromClientY(clientY: number): void {
    const splitterSize = getViewportSplitterSize();
    const wavePanelChromeHeight = getWavePanelChromeHeight();
    const viewportRect = elements.viewport.getBoundingClientRect();
    const availableHeight = Math.max(0, viewportRect.height - splitterSize - wavePanelChromeHeight);
    if (availableHeight <= 0) {
      return;
    }

    const proposedWaveHeight = clamp(
      clientY - viewportRect.top - wavePanelChromeHeight - splitterSize / 2,
      0,
      availableHeight,
    );
    state.viewportSplitRatio = normalizeViewportSplitRatio(proposedWaveHeight / availableHeight);
    applyViewportSplit(true);
  }

  function handleViewportWheel(event: WheelEvent, surface: SurfaceKind, target: HTMLElement): void {
    if (getDurationFrames() <= 0) {
      return;
    }

    event.preventDefault();
    const rect = target.getBoundingClientRect();
    sendViewportIntent({
      deltaMode: event.deltaMode,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      kind: 'wheel',
      pointerRatioX: rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5,
      surface,
    });
  }

  function attachResizeObservers(): void {
    const resizeObserver = new ResizeObserver(() => {
      applyViewportSplit();
      const waveformSize = getWaveformViewportSize();
      const spectrogramSize = getSpectrogramCanvasTargetSize();
      const overviewWidth = Math.max(1, elements.waveformOverview.clientWidth);

      const changed =
        state.observedWaveformViewportWidth !== waveformSize.width
        || state.observedWaveformViewportHeight !== waveformSize.height
        || state.observedSpectrogramPixelWidth !== spectrogramSize.pixelWidth
        || state.observedSpectrogramPixelHeight !== spectrogramSize.pixelHeight
        || state.observedOverviewWidth !== overviewWidth;

      if (!changed) {
        return;
      }

      state.observedWaveformViewportWidth = waveformSize.width;
      state.observedWaveformViewportHeight = waveformSize.height;
      state.observedSpectrogramPixelWidth = spectrogramSize.pixelWidth;
      state.observedSpectrogramPixelHeight = spectrogramSize.pixelHeight;
      state.observedOverviewWidth = overviewWidth;

      sendViewportIntent({
        kind: 'resize',
        spectrogramPixelHeight: spectrogramSize.pixelHeight,
        spectrogramPixelWidth: spectrogramSize.pixelWidth,
        waveformHeightCssPx: waveformSize.height,
        waveformRenderScale: displayPixelRatio,
        waveformWidthCssPx: waveformSize.width,
      });

      if (state.analysisWorker) {
        state.analysisWorker.postMessage({
          type: 'resizeCanvas',
          body: {
            pixelHeight: spectrogramSize.pixelHeight,
            pixelWidth: spectrogramSize.pixelWidth,
          },
        });
        scheduleSpectrogramRender({ force: true });
      }

      if (state.waveformWorker) {
        state.waveformWorker.postMessage({
          type: 'resizeCanvas',
          body: {
            height: waveformSize.height,
            renderScale: displayPixelRatio,
            width: waveformSize.width,
          },
        });
        requestWaveformRender();
      }

      refreshHoveredSampleInfos();
    });

    resizeObserver.observe(document.body);
    resizeObserver.observe(elements.viewport);
    resizeObserver.observe(elements.waveformViewport);
    resizeObserver.observe(elements.waveformOverview);
  }

  return {
    applyViewportSplit,
    attachResizeObservers,
    handleViewportWheel,
    updateViewportSplitRatioFromClientY,
  };
}
