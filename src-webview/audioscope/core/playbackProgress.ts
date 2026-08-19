import { clamp } from './format';

export const PLAYBACK_FOLLOW_RATIO = 0.5;

interface PlaybackProgressInput {
  currentFrameFloat: number;
  durationFrames: number;
  followCursorLocked: boolean;
  presentedEndFrame: number;
  presentedStartFrame: number;
}

export interface PlaybackProgressSnapshot {
  cursorPercent: number;
  cursorVisible: boolean;
  overviewCurrentPercent: number;
  overviewCurrentVisible: boolean;
}

export function calculatePlaybackProgress({
  currentFrameFloat,
  durationFrames,
  followCursorLocked,
  presentedEndFrame,
  presentedStartFrame,
}: PlaybackProgressInput): PlaybackProgressSnapshot {
  const safeDurationFrames = Math.max(0, Number(durationFrames) || 0);
  const playbackFrame = clamp(
    Number.isFinite(currentFrameFloat) ? currentFrameFloat : 0,
    0,
    safeDurationFrames,
  );
  const spanFrames = Math.max(0, presentedEndFrame - presentedStartFrame);
  const cursorPercent = spanFrames > 0
    ? followCursorLocked
      // The worker's grid-snapped range and the main-thread playback clock can be a
      // fraction of a frame apart. Keep that remainder out of the centered playhead
      // so zoomed follow playback cannot wobble around the follow anchor.
      ? PLAYBACK_FOLLOW_RATIO * 100
      : clamp(((playbackFrame - presentedStartFrame) / spanFrames) * 100, 0, 100)
    : 0;

  return {
    cursorPercent,
    cursorVisible: spanFrames > 0
      && (
        followCursorLocked
        || (playbackFrame >= presentedStartFrame && playbackFrame <= presentedEndFrame)
      ),
    overviewCurrentPercent: safeDurationFrames > 0
      ? clamp((playbackFrame / safeDurationFrames) * 100, 0, 100)
      : 0,
    overviewCurrentVisible: safeDurationFrames > 0,
  };
}
