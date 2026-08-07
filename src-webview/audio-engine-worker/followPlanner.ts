export interface WaveformFollowRenderPlanInput {
  bufferFactor: number;
  displayEndSeconds: number;
  displayStartSeconds: number;
  displayWidth: number;
  durationSeconds: number;
  epsilonSeconds: number;
  marginRatio: number;
  preferredEndSeconds: number;
  preferredStartSeconds: number;
  preferredValid: boolean;
  renderScale: number;
}

export interface WaveformFollowRenderPlan {
  endSeconds: number;
  renderWidth: number;
  startSeconds: number;
}

interface TimeRange {
  end: number;
  start: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDisplayRange(start: number, end: number, duration: number): TimeRange {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (safeDuration <= 0) {
    return { end: 0, start: 0 };
  }

  const safeStart = Number.isFinite(start) ? start : 0;
  const safeEnd = Number.isFinite(end) ? end : safeDuration;
  const normalizedStart = clamp(safeStart, 0, safeDuration);
  const normalizedEnd = clamp(safeEnd, normalizedStart, safeDuration);
  return normalizedEnd > normalizedStart
    ? { end: normalizedEnd, start: normalizedStart }
    : { end: safeDuration, start: 0 };
}

function expandRange(range: TimeRange, duration: number, factor: number): TimeRange {
  const normalized = normalizeDisplayRange(range.start, range.end, duration);
  const span = Math.max(0, normalized.end - normalized.start);
  if (span <= 0 || duration <= 0) {
    return normalized;
  }

  const expandedSpan = clamp(
    span * Math.max(1, factor),
    span,
    Math.max(span, duration),
  );
  const expandedStart = clamp(
    normalized.start - (expandedSpan - span) * 0.5,
    0,
    Math.max(0, duration - expandedSpan),
  );
  return { end: expandedStart + expandedSpan, start: expandedStart };
}

function getRenderColumnCount(renderWidth: number, renderScale: number): number {
  const scaledWidth = Math.round(renderWidth * Math.max(1, renderScale));
  return scaledWidth > 0 ? scaledWidth : renderWidth > 0 ? renderWidth : 1;
}

function getBufferedRenderWidth(displayWidth: number, visibleSpan: number, bufferedRange: TimeRange): number {
  const safeDisplayWidth = displayWidth > 0 ? displayWidth : 1;
  const bufferedSpan = Math.max(0, bufferedRange.end - bufferedRange.start);
  if (visibleSpan <= 0 || bufferedSpan <= 0) {
    return safeDisplayWidth;
  }

  return Math.max(
    safeDisplayWidth,
    Math.ceil(safeDisplayWidth * (bufferedSpan / visibleSpan)),
  );
}

function snapRenderRange(
  displayRange: TimeRange,
  candidateRange: TimeRange,
  duration: number,
  renderWidth: number,
  renderScale: number,
): TimeRange {
  const renderSpan = Math.max(0, candidateRange.end - candidateRange.start);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (renderSpan <= 0 || renderWidth <= 0 || safeDuration <= 0) {
    return candidateRange;
  }

  const secondsPerColumn = renderSpan / getRenderColumnCount(renderWidth, renderScale);
  if (!Number.isFinite(secondsPerColumn) || secondsPerColumn <= 0) {
    return candidateRange;
  }

  const maxStart = Math.max(0, safeDuration - renderSpan);
  const lowerBound = clamp(displayRange.end - renderSpan, 0, maxStart);
  const upperBound = clamp(displayRange.start, lowerBound, maxStart);
  const snappedStart = Math.round(candidateRange.start / secondsPerColumn) * secondsPerColumn;
  const start = clamp(snappedStart, lowerBound, upperBound);
  return { end: start + renderSpan, start };
}

function getStableRenderRange(
  displayRange: TimeRange,
  duration: number,
  renderWidth: number,
  renderScale: number,
  preferredRange: TimeRange,
  preferredValid: boolean,
  bufferFactor: number,
  marginRatio: number,
  epsilon: number,
): TimeRange {
  const expandedRange = expandRange(displayRange, duration, bufferFactor);
  const renderSpan = Math.max(0, expandedRange.end - expandedRange.start);
  if (!preferredValid || renderSpan <= 0 || duration <= 0 || renderWidth <= 0) {
    return snapRenderRange(displayRange, expandedRange, duration, renderWidth, renderScale);
  }

  const preferredSpan = preferredRange.end - preferredRange.start;
  if (Math.abs(preferredSpan - renderSpan) > Math.max(epsilon, renderSpan * 0.001)) {
    return snapRenderRange(displayRange, expandedRange, duration, renderWidth, renderScale);
  }

  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  const maxStart = Math.max(0, duration - renderSpan);
  const availablePadding = Math.max(0, (renderSpan - visibleSpan) * 0.5);
  const requestedPadding = Math.max(0, renderSpan * Math.max(0, marginRatio));
  const effectivePadding = Math.min(availablePadding, requestedPadding);
  const lowerBound = clamp(displayRange.end - renderSpan + effectivePadding, 0, maxStart);
  const upperBound = clamp(displayRange.start - effectivePadding, lowerBound, maxStart);
  const secondsPerColumn = renderSpan / getRenderColumnCount(renderWidth, renderScale);
  const unclampedStart = clamp(preferredRange.start, lowerBound, upperBound);
  const snappedStart = Number.isFinite(secondsPerColumn) && secondsPerColumn > 0
    ? Math.round(unclampedStart / secondsPerColumn) * secondsPerColumn
    : unclampedStart;
  const start = clamp(snappedStart, lowerBound, upperBound);
  return { end: start + renderSpan, start };
}

export function planWaveformFollowRender(
  input: WaveformFollowRenderPlanInput,
): WaveformFollowRenderPlan | null {
  const displayRange = normalizeDisplayRange(
    input.displayStartSeconds,
    input.displayEndSeconds,
    input.durationSeconds,
  );
  const visibleSpan = Math.max(0, displayRange.end - displayRange.start);
  if (input.durationSeconds <= 0 || visibleSpan <= 0 || input.displayWidth <= 0) {
    return null;
  }

  const expandedRange = expandRange(displayRange, input.durationSeconds, input.bufferFactor);
  const renderWidth = getBufferedRenderWidth(input.displayWidth, visibleSpan, expandedRange);
  const renderRange = getStableRenderRange(
    displayRange,
    input.durationSeconds,
    renderWidth,
    input.renderScale,
    {
      end: input.preferredEndSeconds,
      start: input.preferredStartSeconds,
    },
    input.preferredValid && input.preferredEndSeconds > input.preferredStartSeconds,
    input.bufferFactor,
    input.marginRatio,
    input.epsilonSeconds,
  );

  return {
    endSeconds: renderRange.end,
    renderWidth,
    startSeconds: renderRange.start,
  };
}
