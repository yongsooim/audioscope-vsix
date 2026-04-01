export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0:00';
  }

  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
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
  const totalTenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(totalTenths / 600);
  const secondsPart = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;

  return `${minutes}:${String(secondsPart).padStart(2, '0')}:${tenths}`;
}
