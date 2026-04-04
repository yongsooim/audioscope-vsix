import { clamp, formatAxisLabel, getNiceTimeStep } from '../core/format';
import type {
  TimeRange,
  WaveformAxisSnapshot,
  WaveformAxisTick,
  WaveformDisplayWindowMetrics,
} from '../core/types';

export function cloneTimeRange(range: TimeRange): TimeRange {
  return {
    end: Number(range?.end) || 0,
    start: Number(range?.start) || 0,
  };
}

export function createWaveformAxisSnapshot(
  renderRange: TimeRange,
  renderWidth: number,
  viewportWidth: number,
  visibleSpan = Math.max(0, Number(renderRange?.end) - Number(renderRange?.start)),
): WaveformAxisSnapshot {
  const safeRenderRange = cloneTimeRange(renderRange);
  const safeRenderWidth = Math.max(1, Math.round(renderWidth || 0));
  const span = Math.max(0, safeRenderRange.end - safeRenderRange.start);
  const safeVisibleSpan = Math.max(0, Number(visibleSpan) || 0);

  if (span <= 0 || viewportWidth <= 0) {
    return {
      renderRange: safeRenderRange,
      renderWidth: safeRenderWidth,
      ticks: [],
      viewportWidth,
    };
  }

  const tickCount = Math.max(12, Math.min(28, Math.floor(viewportWidth / 48)));
  const tickStepSpan = safeVisibleSpan > 0 ? safeVisibleSpan : span;
  const step = getNiceTimeStep(tickStepSpan / tickCount);
  const ticks: WaveformAxisTick[] = [];
  const firstTick = Math.ceil(safeRenderRange.start / step) * step;

  for (let tick = firstTick; tick <= safeRenderRange.end + step * 0.25; tick += step) {
    ticks.push({
      align: 'center',
      label: formatAxisLabel(tick),
      positionRatio: (tick - safeRenderRange.start) / span,
      time: Number(tick.toFixed(6)),
    });
  }

  if (ticks.length === 0 || Math.abs(ticks[0].time - safeRenderRange.start) > step * 0.35) {
    ticks.unshift({
      align: 'start',
      label: formatAxisLabel(safeRenderRange.start),
      positionRatio: 0,
      time: safeRenderRange.start,
    });
  }

  const lastTick = ticks[ticks.length - 1];
  if (!lastTick || Math.abs(lastTick.time - safeRenderRange.end) > step * 0.35) {
    ticks.push({
      align: 'end',
      label: formatAxisLabel(safeRenderRange.end),
      positionRatio: 1,
      time: safeRenderRange.end,
    });
  }

  if (ticks.length > 0) {
    ticks[0].align = 'start';
    ticks[ticks.length - 1].align = 'end';
  }

  return {
    renderRange: safeRenderRange,
    renderWidth: safeRenderWidth,
    ticks,
    viewportWidth,
  };
}

export function normalizeWaveformRange(
  range: TimeRange,
  duration: number,
  minVisibleDuration: number,
): TimeRange {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  if (safeDuration <= 0) {
    return { start: 0, end: 0 };
  }

  const safeMinVisibleDuration = Math.max(0.000001, minVisibleDuration);
  const safeStart = Number.isFinite(range.start) ? range.start : 0;
  const safeEnd = Number.isFinite(range.end) ? range.end : safeStart + safeMinVisibleDuration;
  const rawSpan = Math.max(safeMinVisibleDuration, safeEnd - safeStart);
  const nextSpan = clamp(
    rawSpan,
    safeMinVisibleDuration,
    Math.max(safeMinVisibleDuration, safeDuration),
  );
  const maxStart = Math.max(0, safeDuration - nextSpan);
  const nextStart = clamp(safeStart, 0, maxStart);

  return {
    start: nextStart,
    end: nextStart + nextSpan,
  };
}

export function centerWaveformRangeOnTime(
  range: TimeRange,
  timeSeconds: number,
  duration: number,
  minVisibleDuration: number,
): TimeRange {
  const normalizedRange = normalizeWaveformRange(range, duration, minVisibleDuration);
  const span = Math.max(0, normalizedRange.end - normalizedRange.start);

  if (span <= 0 || duration <= 0) {
    return normalizedRange;
  }

  const nextStart = clamp(timeSeconds - span * 0.5, 0, Math.max(0, duration - span));

  return {
    start: nextStart,
    end: nextStart + span,
  };
}

export function expandWaveformRange(
  range: TimeRange,
  duration: number,
  factor: number,
  minVisibleDuration: number,
): TimeRange {
  const normalizedRange = normalizeWaveformRange(range, duration, minVisibleDuration);
  const span = Math.max(0, normalizedRange.end - normalizedRange.start);

  if (span <= 0 || duration <= 0) {
    return normalizedRange;
  }

  const nextSpan = clamp(span * Math.max(1, factor), span, Math.max(span, duration));
  const extraSpan = nextSpan - span;
  const nextStart = clamp(
    normalizedRange.start - extraSpan * 0.5,
    0,
    Math.max(0, duration - nextSpan),
  );

  return {
    start: nextStart,
    end: nextStart + nextSpan,
  };
}

export function snapWaveformRenderRange(
  displayRange: TimeRange,
  candidateRange: TimeRange,
  duration: number,
  renderWidth: number,
  _renderScale: number,
): TimeRange {
  const renderSpan = Math.max(0, candidateRange.end - candidateRange.start);
  const clampedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const maxStart = Math.max(0, clampedDuration - renderSpan);

  if (renderSpan <= 0 || renderWidth <= 0 || clampedDuration <= 0) {
    return candidateRange;
  }

  const lowerBound = clamp(displayRange.end - renderSpan, 0, maxStart);
  const upperBound = clamp(displayRange.start, lowerBound, maxStart);
  const nextStart = clamp(candidateRange.start, lowerBound, upperBound);

  return {
    start: nextStart,
    end: nextStart + renderSpan,
  };
}

export function quantizeWaveformCssOffset(offsetPx: number, renderScale: number): number {
  void renderScale;
  return offsetPx;
}

export function isRangeBuffered(
  targetRange: TimeRange | null | undefined,
  bufferRange: TimeRange | null | undefined,
  marginRatio = 0,
  epsilonSeconds = 0,
): boolean {
  if (
    !targetRange
    || !bufferRange
    || !(targetRange.end > targetRange.start)
    || !(bufferRange.end > bufferRange.start)
  ) {
    return false;
  }

  const targetSpan = targetRange.end - targetRange.start;
  const bufferSpan = bufferRange.end - bufferRange.start;
  const availablePadding = Math.max(0, (bufferSpan - targetSpan) * 0.5);
  const requestedPadding = Math.max(0, bufferSpan * Math.max(0, marginRatio));
  const effectivePadding = Math.min(availablePadding, requestedPadding);

  return targetRange.start >= (bufferRange.start + effectivePadding - epsilonSeconds)
    && targetRange.end <= (bufferRange.end - effectivePadding + epsilonSeconds);
}

export function getWaveformDisplayWindowMetrics(
  displayRange: TimeRange,
  renderRange: TimeRange,
  renderWidth: number,
  viewportWidth: number,
  renderScale: number,
): WaveformDisplayWindowMetrics | null {
  const safeViewportWidth = Math.max(1, Math.round(viewportWidth || 0));
  const safeRenderWidth = Math.max(0, Math.round(renderWidth || 0));
  const safeRenderRange = cloneTimeRange(renderRange);
  const renderSpan = Math.max(0, safeRenderRange.end - safeRenderRange.start);

  if (
    !(displayRange.end > displayRange.start)
    || safeRenderWidth <= 0
    || renderSpan <= 0
    || safeViewportWidth <= 0
  ) {
    return null;
  }

  const secondsPerPixel = renderSpan / safeRenderWidth;

  if (!Number.isFinite(secondsPerPixel) || secondsPerPixel <= 0) {
    return null;
  }

  const maxOffsetPx = Math.max(0, safeRenderWidth - safeViewportWidth);
  const unclampedOffsetPx = (displayRange.start - safeRenderRange.start) / secondsPerPixel;
  const displayOffsetPx = quantizeWaveformCssOffset(
    clamp(unclampedOffsetPx, 0, maxOffsetPx),
    renderScale,
  );
  const displaySpan = safeViewportWidth * secondsPerPixel;
  const displayStart = safeRenderRange.start + (displayOffsetPx * secondsPerPixel);

  return {
    displayOffsetPx,
    displayRange: {
      end: displayStart + displaySpan,
      start: displayStart,
    },
    displayWidth: safeViewportWidth,
    renderRange: safeRenderRange,
    renderSpan,
    renderWidth: safeRenderWidth,
    secondsPerPixel,
    viewportWidth: safeViewportWidth,
  };
}
