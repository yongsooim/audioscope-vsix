export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const TIME_FRACTION_DIGITS = 2;
const TIME_FRACTION_SCALE = 10 ** TIME_FRACTION_DIGITS;
const ZERO_TIME_TEXT = `0:00.${'0'.repeat(TIME_FRACTION_DIGITS)}`;

function formatClockTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return ZERO_TIME_TEXT;
  }

  const totalFractions = Math.max(0, Math.round(value * TIME_FRACTION_SCALE));
  const totalSeconds = Math.floor(totalFractions / TIME_FRACTION_SCALE);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = hours > 0
    ? Math.floor((totalSeconds % 3600) / 60)
    : Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const fractions = totalFractions % TIME_FRACTION_SCALE;
  const fractionText = String(fractions).padStart(TIME_FRACTION_DIGITS, '0');

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fractionText}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}.${fractionText}`;
}

export function formatTime(value: number): string {
  return formatClockTime(value);
}

export function getNiceTimeStep(rawStepSec: number): number {
  if (!Number.isFinite(rawStepSec) || rawStepSec <= 0) {
    return 0.25;
  }

  const magnitude = 10 ** Math.floor(Math.log10(rawStepSec));
  const normalized = rawStepSec / magnitude;
  const candidates = [1, 2, 2.5, 5, 10];
  const chosen = candidates.find((candidate) => normalized <= candidate) ?? 10;

  return chosen * magnitude;
}

export function formatAxisLabel(seconds: number): string {
  return formatClockTime(seconds);
}
