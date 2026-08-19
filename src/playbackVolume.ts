export const MAX_PLAYBACK_BOOST_DB = 12;
export const MAX_PLAYBACK_VOLUME = 10 ** (MAX_PLAYBACK_BOOST_DB / 20);
export const PLAYBACK_VOLUME_SLIDER_MAX = 2;

export function normalizePlaybackVolume(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(MAX_PLAYBACK_VOLUME, Math.max(0, numeric))
    : 1;
}

export function snapPlaybackVolume(value: unknown): number {
  const normalized = normalizePlaybackVolume(value);
  return Math.abs(normalized - 1) <= 0.020_001 ? 1 : normalized;
}

export function playbackVolumeToDecibels(value: unknown): number {
  const normalized = normalizePlaybackVolume(value);
  return normalized > 0 ? 20 * Math.log10(normalized) : Number.NEGATIVE_INFINITY;
}

export function playbackVolumeToSliderValue(value: unknown): number {
  const normalized = normalizePlaybackVolume(value);
  if (normalized <= 1) {
    return normalized;
  }
  return 1 + (playbackVolumeToDecibels(normalized) / MAX_PLAYBACK_BOOST_DB);
}

export function playbackVolumeFromSliderValue(value: unknown): number {
  const numeric = Number(value);
  const sliderValue = Number.isFinite(numeric)
    ? Math.min(PLAYBACK_VOLUME_SLIDER_MAX, Math.max(0, numeric))
    : 1;
  if (Math.abs(sliderValue - 1) <= 0.020_001) {
    return 1;
  }
  if (sliderValue <= 1) {
    return sliderValue;
  }
  const boostDb = (sliderValue - 1) * MAX_PLAYBACK_BOOST_DB;
  return 10 ** (boostDb / 20);
}
