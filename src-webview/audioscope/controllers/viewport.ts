import { clamp } from '../core/format';
import type { AudioscopeElements } from '../core/elements';

interface AudioscopeViewportControllerDeps {
  defaultViewportSplitRatio: number;
  disableFollowPlayback: () => void;
  elements: AudioscopeElements;
  getCurrentPlaybackTime: () => number;
  getEffectiveDuration: () => number;
  getInteractiveWaveformRange: () => { start: number; end: number };
  getMinVisibleDuration: (duration: number) => number;
  getTimeAtViewportClientX: (
    clientX: number,
    targetElement: HTMLElement,
    range?: { start: number; end: number },
  ) => number;
  getViewportPointerRatio: (clientX: number, targetElement: HTMLElement) => number;
  splitterFallbackSizePx: number;
  state: any;
  updateWaveformViewRange: (
    updater: (current: { start: number; end: number }) => { start: number; end: number },
    options?: { animateZoom?: boolean },
  ) => void;
  viewportRatioMax: number;
  viewportRatioMin: number;
  viewportSplitStep: number;
  waveformZoomStepFactor: number;
}

export function createAudioscopeViewportController({
  defaultViewportSplitRatio,
  disableFollowPlayback,
  elements,
  getCurrentPlaybackTime,
  getEffectiveDuration,
  getInteractiveWaveformRange,
  getMinVisibleDuration,
  getTimeAtViewportClientX,
  getViewportPointerRatio,
  splitterFallbackSizePx,
  state,
  updateWaveformViewRange,
  viewportRatioMax,
  viewportRatioMin,
  viewportSplitStep,
  waveformZoomStepFactor,
}: AudioscopeViewportControllerDeps) {
  function normalizeViewportSplitRatio(value) {
    if (!Number.isFinite(value)) {
      return defaultViewportSplitRatio;
    }

    return clamp(value, viewportRatioMin, viewportRatioMax);
  }

  function getNumericStyleSize(element, propertyName, fallback = 0) {
    if (!element) {
      return fallback;
    }

    const computedValue = Number.parseFloat(window.getComputedStyle(element)[propertyName]);
    return Number.isFinite(computedValue) ? computedValue : fallback;
  }

  function getViewportSplitterSize() {
    return Math.max(
      1,
      elements.viewportSplitter?.offsetHeight
        || getNumericStyleSize(elements.viewportSplitter, 'minHeight', splitterFallbackSizePx),
    );
  }

  function getWavePanelChromeHeight() {
    const toolbarHeight = Math.max(0, elements.waveToolbar?.offsetHeight || 0);
    const axisHeight = Math.max(0, elements.waveformAxis?.offsetHeight || 0);
    return toolbarHeight + axisHeight;
  }

  function resolveViewportPanelHeights(availableHeight, ratio = state.viewportSplitRatio) {
    const safeAvailableHeight = Math.max(0, availableHeight);

    if (safeAvailableHeight <= 0) {
      return { waveHeight: 0, spectrogramHeight: 0 };
    }

    const desiredWaveHeight = safeAvailableHeight * normalizeViewportSplitRatio(ratio);
    const waveHeight = Math.round(clamp(desiredWaveHeight, 0, safeAvailableHeight));

    return {
      waveHeight,
      spectrogramHeight: Math.max(0, safeAvailableHeight - waveHeight),
    };
  }

  function updateViewportSplitterAccessibility(waveHeight, availableHeight) {
    if (!elements.viewportSplitter) {
      return;
    }

    const wavePercentage = availableHeight > 0
      ? Math.round((waveHeight / availableHeight) * 100)
      : Math.round(state.viewportSplitRatio * 100);
    const spectrogramPercentage = Math.max(0, 100 - wavePercentage);

    elements.viewportSplitter.setAttribute('aria-valuenow', String(wavePercentage));
    elements.viewportSplitter.setAttribute(
      'aria-valuetext',
      `Waveform ${wavePercentage}%, spectrogram ${spectrogramPercentage}%`,
    );
  }

  function applyViewportSplit(force = false) {
    if (!elements.viewport || !elements.viewportSplitter) {
      return;
    }

    const splitterSize = getViewportSplitterSize();
    const wavePanelChromeHeight = getWavePanelChromeHeight();
    const availableHeight = Math.max(0, elements.viewport.clientHeight - splitterSize - wavePanelChromeHeight);

    if (availableHeight <= 0) {
      const nextTemplate = `${wavePanelChromeHeight}px ${splitterSize}px 0px`;

      if (force || elements.viewport.style.gridTemplateRows !== nextTemplate) {
        elements.viewport.style.gridTemplateRows = nextTemplate;
      }
      updateViewportSplitterAccessibility(0, 0);
      return;
    }

    const { waveHeight, spectrogramHeight } = resolveViewportPanelHeights(availableHeight);
    const nextTemplate = `${wavePanelChromeHeight + waveHeight}px ${splitterSize}px ${spectrogramHeight}px`;

    if (!force && elements.viewport.style.gridTemplateRows === nextTemplate) {
      updateViewportSplitterAccessibility(waveHeight, availableHeight);
      return;
    }

    elements.viewport.style.gridTemplateRows = nextTemplate;
    updateViewportSplitterAccessibility(waveHeight, availableHeight);
  }

  function setViewportSplitRatio(ratio, force = false) {
    const nextRatio = normalizeViewportSplitRatio(ratio);
    const ratioChanged = Math.abs(state.viewportSplitRatio - nextRatio) > 0.001;

    state.viewportSplitRatio = nextRatio;

    if (ratioChanged || force) {
      applyViewportSplit(force);
    }
  }

  function updateViewportSplitRatioFromClientY(clientY) {
    if (!elements.viewport) {
      return;
    }

    const splitterSize = getViewportSplitterSize();
    const wavePanelChromeHeight = getWavePanelChromeHeight();
    const viewportRect = elements.viewport.getBoundingClientRect();
    const availableHeight = Math.max(0, viewportRect.height - splitterSize - wavePanelChromeHeight);

    if (availableHeight <= 0) {
      return;
    }

    const proposedWaveHeight = clamp(
      clientY - viewportRect.top - wavePanelChromeHeight - (splitterSize / 2),
      0,
      availableHeight,
    );
    const { waveHeight } = resolveViewportPanelHeights(availableHeight, proposedWaveHeight / availableHeight);
    setViewportSplitRatio(waveHeight / availableHeight, true);
  }

  function beginViewportSplitDrag(event) {
    if (!elements.viewportSplitter) {
      return;
    }

    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    event.preventDefault();
    elements.viewportSplitter.dataset.dragging = 'true';
    elements.viewportSplitter.setPointerCapture(event.pointerId);
    state.viewportResizeDrag = { pointerId: event.pointerId };
    updateViewportSplitRatioFromClientY(event.clientY);
  }

  function updateViewportSplitDrag(event) {
    const dragState = state.viewportResizeDrag;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    updateViewportSplitRatioFromClientY(event.clientY);
  }

  function endViewportSplitDrag(event, cancelled = false) {
    const dragState = state.viewportResizeDrag;

    if (!dragState || dragState.pointerId !== event.pointerId || !elements.viewportSplitter) {
      return;
    }

    if (elements.viewportSplitter.hasPointerCapture?.(event.pointerId)) {
      elements.viewportSplitter.releasePointerCapture(event.pointerId);
    }

    delete elements.viewportSplitter.dataset.dragging;
    state.viewportResizeDrag = null;

    if (!cancelled) {
      updateViewportSplitRatioFromClientY(event.clientY);
    }
  }

  function resetViewportSplit() {
    setViewportSplitRatio(defaultViewportSplitRatio, true);
  }

  function handleViewportSplitterKeydown(event) {
    if (event.defaultPrevented) {
      return;
    }

    let nextRatio = null;

    if (event.key === 'ArrowUp') {
      nextRatio = state.viewportSplitRatio - viewportSplitStep;
    } else if (event.key === 'ArrowDown') {
      nextRatio = state.viewportSplitRatio + viewportSplitStep;
    } else if (event.key === 'Home') {
      nextRatio = viewportRatioMin;
    } else if (event.key === 'End') {
      nextRatio = viewportRatioMax;
    } else if (event.key === 'Enter' || event.key === ' ') {
      nextRatio = defaultViewportSplitRatio;
    }

    if (nextRatio === null) {
      return;
    }

    event.preventDefault();
    setViewportSplitRatio(nextRatio, true);
  }

  function handleSharedViewportWheel(event, targetElement) {
    const duration = getEffectiveDuration();
    const range = getInteractiveWaveformRange();
    const span = range.end - range.start;
    const rect = targetElement.getBoundingClientRect();
    const width = rect.width;

    if (duration <= 0 || span <= 0 || width <= 0) {
      return;
    }

    event.preventDefault();

    const deltaScale =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? width
          : 1;
    const deltaX = event.deltaX * deltaScale;
    const deltaY = event.deltaY * deltaScale;
    const horizontalMagnitude = Math.abs(deltaX);
    const verticalMagnitude = Math.abs(deltaY);
    const intent = verticalMagnitude >= horizontalMagnitude ? 'zoom' : 'pan';
    const shouldPreserveFollowZoom = state.followPlayback && intent === 'zoom' && verticalMagnitude > 0.01;
    const pointerRatio = getViewportPointerRatio(event.clientX, targetElement);
    const currentPlaybackTime = getCurrentPlaybackTime();
    const anchorTime = shouldPreserveFollowZoom && Number.isFinite(currentPlaybackTime)
      ? clamp(currentPlaybackTime, 0, duration)
      : getTimeAtViewportClientX(event.clientX, targetElement, range);

    if (intent === 'pan' && horizontalMagnitude > 0.01) {
      disableFollowPlayback();
    }

    updateWaveformViewRange((current) => {
      const currentSpan = Math.max(getMinVisibleDuration(duration), current.end - current.start);
      let nextSpan = currentSpan;
      let nextStart = current.start;

      if (intent === 'zoom' && verticalMagnitude > 0.01) {
        const zoomScale = Math.pow(waveformZoomStepFactor, deltaY / 180);
        nextSpan = clamp(
          nextSpan * zoomScale,
          getMinVisibleDuration(duration),
          Math.max(getMinVisibleDuration(duration), duration),
        );

        if (Math.abs(nextSpan - currentSpan) <= 1e-9) {
          return current;
        }

        const anchorRatio = shouldPreserveFollowZoom
          ? clamp((anchorTime - current.start) / currentSpan, 0, 1)
          : pointerRatio;

        nextStart = anchorTime - nextSpan * anchorRatio;
      }

      if (intent === 'pan' && horizontalMagnitude > 0.01) {
        const secondsPerPixel = nextSpan / Math.max(1, width);
        nextStart += deltaX * secondsPerPixel;
      }

      return {
        start: nextStart,
        end: nextStart + nextSpan,
      };
    }, {
      animateZoom: intent === 'zoom' && verticalMagnitude > 0.01,
    });
  }

  return {
    applyViewportSplit,
    beginViewportSplitDrag,
    endViewportSplitDrag,
    handleSharedViewportWheel,
    handleViewportSplitterKeydown,
    resetViewportSplit,
    updateViewportSplitDrag,
  };
}
