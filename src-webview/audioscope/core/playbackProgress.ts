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
  // Always the true position, even while following. The view origin is quantized to
  // whole device columns (waveformColumnGrid), so pinning the playhead to exactly
  // PLAYBACK_FOLLOW_RATIO would push that sub-column remainder onto the image and
  // make it slide unevenly. The playhead absorbs it instead: it sits within half a
  // device pixel of the follow ratio, which no one can see, and the waveform under
  // it translates rigidly.
  const cursorPercent = spanFrames > 0
    ? clamp(((playbackFrame - presentedStartFrame) / spanFrames) * 100, 0, 100)
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
