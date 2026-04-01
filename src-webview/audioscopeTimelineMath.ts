import { clamp } from './audioscopeFormat';
import type { TimelineViewportSnapshot, TimeRange } from './audioscopeTypes';

export function createTimelineViewportSnapshot(
  duration: number,
  currentTime: number,
  displayRange: TimeRange | null | undefined,
  isPlayable: boolean,
): TimelineViewportSnapshot {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeCurrentTime = safeDuration > 0 && Number.isFinite(currentTime)
    ? clamp(currentTime, 0, safeDuration)
    : 0;

  if (safeDuration <= 0) {
    return {
      currentRatio: 0,
      currentTime: safeCurrentTime,
      duration: 0,
      isPlayable: false,
      viewportEndRatio: 1,
      viewportRange: { start: 0, end: 0 },
      viewportStartRatio: 0,
    };
  }

  const nextRange = normalizeTimelineViewportRange(displayRange, safeDuration);
  const viewportStartRatio = clamp(nextRange.start / safeDuration, 0, 1);
  const viewportEndRatio = clamp(nextRange.end / safeDuration, viewportStartRatio, 1);

  return {
    currentRatio: clamp(safeCurrentTime / safeDuration, 0, 1),
    currentTime: safeCurrentTime,
    duration: safeDuration,
    isPlayable: Boolean(isPlayable),
    viewportEndRatio,
    viewportRange: nextRange,
    viewportStartRatio,
  };
}

function normalizeTimelineViewportRange(
  displayRange: TimeRange | null | undefined,
  duration: number,
): TimeRange {
  const rawStart = Number(displayRange?.start);
  const rawEnd = Number(displayRange?.end);

  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart) {
    return {
      start: 0,
      end: duration,
    };
  }

  const start = clamp(rawStart, 0, duration);
  const end = clamp(rawEnd, start, duration);

  if (end <= start) {
    return {
      start: 0,
      end: duration,
    };
  }

  return { start, end };
}
