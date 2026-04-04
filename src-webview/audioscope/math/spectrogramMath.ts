import { clamp } from '../core/format';

const MIXED_FREQUENCY_PIVOT_HZ = 1000;
const MIXED_FREQUENCY_PIVOT_POSITION = 0.5;
const SLANEY_MEL_FREQUENCY_MIN = 0;
const SLANEY_MEL_FREQUENCY_STEP = 200 / 3;
const SLANEY_MEL_LOG_REGION_START_HZ = 1000;
const SLANEY_MEL_LOG_REGION_START_MEL = (SLANEY_MEL_LOG_REGION_START_HZ - SLANEY_MEL_FREQUENCY_MIN) / SLANEY_MEL_FREQUENCY_STEP;
const SLANEY_MEL_LOG_STEP = Math.log(6.4) / 27;

export function buildLinearFrequencyTicks(
  minFrequency: number,
  maxFrequency: number,
  tickCount: number,
): number[] {
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const roughStep = Math.max(1, (safeMax - safeMin) / Math.max(1, tickCount - 1));
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  let multiplier = 1;

  if (normalized > 5) {
    multiplier = 10;
  } else if (normalized > 2) {
    multiplier = 5;
  } else if (normalized > 1) {
    multiplier = 2;
  }

  const step = multiplier * magnitude;
  const ticks = [safeMax, safeMin];
  let value = Math.ceil(safeMin / step) * step;

  while (value < safeMax) {
    if (value > safeMin && value < safeMax) {
      ticks.push(value);
    }
    value += step;
  }

  return [...new Set(ticks.map((tick) => Math.round(tick)))]
    .filter((tick) => tick >= safeMin && tick <= safeMax)
    .sort((left, right) => right - left);
}

export function buildLogFrequencyTicks(
  minFrequency: number,
  maxFrequency: number,
): number[] {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const multipliers = [1, 2, 5];
  const ticks: number[] = [];
  const minExponent = Math.floor(Math.log10(safeMin));
  const maxExponent = Math.ceil(Math.log10(safeMax));

  for (let exponent = minExponent; exponent <= maxExponent; exponent += 1) {
    const magnitude = 10 ** exponent;

    for (const multiplier of multipliers) {
      const tick = multiplier * magnitude;
      if (tick >= safeMin && tick <= safeMax) {
        ticks.push(Math.round(tick));
      }
    }
  }

  return [...new Set(ticks)]
    .filter((tick) => tick >= safeMin && tick <= safeMax)
    .sort((left, right) => right - left);
}

export function getLinearFrequencyPosition(frequency: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const current = clamp(frequency, safeMin, safeMax);

  return 1 - ((current - safeMin) / (safeMax - safeMin));
}

export function getFrequencyAtLinearPosition(position: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const ratio = 1 - clamp(position, 0, 1);

  return safeMin + ratio * (safeMax - safeMin);
}

export function getLogFrequencyPosition(frequency: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const start = Math.log(safeMin);
  const end = Math.log(safeMax);
  const current = Math.log(clamp(frequency, safeMin, safeMax));

  return 1 - ((current - start) / (end - start));
}

export function getFrequencyAtLogPosition(position: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const start = Math.log(safeMin);
  const end = Math.log(safeMax);
  const ratio = 1 - clamp(position, 0, 1);

  return Math.exp(start + ratio * (end - start));
}

function getMixedFrequencyPivot(minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  return clamp(MIXED_FREQUENCY_PIVOT_HZ, safeMin, safeMax);
}

export function getMixedFrequencyPosition(frequency: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const pivot = getMixedFrequencyPivot(safeMin, safeMax);
  const current = clamp(frequency, safeMin, safeMax);

  if (current <= pivot || pivot >= safeMax) {
    const lowerRatio = pivot <= safeMin
      ? 1
      : (current - safeMin) / Math.max(1e-9, pivot - safeMin);
    return 1 - (lowerRatio * MIXED_FREQUENCY_PIVOT_POSITION);
  }

  const start = Math.log(pivot);
  const end = Math.log(safeMax);
  const currentLog = Math.log(current);
  const upperRatio = (currentLog - start) / Math.max(1e-9, end - start);
  return (1 - MIXED_FREQUENCY_PIVOT_POSITION) * (1 - upperRatio);
}

export function getFrequencyAtMixedPosition(position: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(1, minFrequency);
  const safeMax = Math.max(safeMin * 1.01, maxFrequency);
  const pivot = getMixedFrequencyPivot(safeMin, safeMax);
  const clampedPosition = clamp(position, 0, 1);

  if (clampedPosition >= (1 - MIXED_FREQUENCY_PIVOT_POSITION) || pivot >= safeMax) {
    const lowerRatio = 1 - (clampedPosition / Math.max(1e-9, MIXED_FREQUENCY_PIVOT_POSITION));
    return safeMin + (pivot - safeMin) * clamp(lowerRatio, 0, 1);
  }

  const upperRatio = 1 - (clampedPosition / Math.max(1e-9, 1 - MIXED_FREQUENCY_PIVOT_POSITION));
  const start = Math.log(pivot);
  const end = Math.log(safeMax);
  return Math.exp(start + clamp(upperRatio, 0, 1) * (end - start));
}

function frequencyToMel(frequency: number): number {
  const safeFrequency = Math.max(0, frequency);

  if (safeFrequency < SLANEY_MEL_LOG_REGION_START_HZ) {
    return (safeFrequency - SLANEY_MEL_FREQUENCY_MIN) / SLANEY_MEL_FREQUENCY_STEP;
  }

  return SLANEY_MEL_LOG_REGION_START_MEL
    + (Math.log(safeFrequency / SLANEY_MEL_LOG_REGION_START_HZ) / SLANEY_MEL_LOG_STEP);
}

function melToFrequency(melValue: number): number {
  if (melValue < SLANEY_MEL_LOG_REGION_START_MEL) {
    return SLANEY_MEL_FREQUENCY_MIN + (SLANEY_MEL_FREQUENCY_STEP * melValue);
  }

  return SLANEY_MEL_LOG_REGION_START_HZ
    * Math.exp(SLANEY_MEL_LOG_STEP * (melValue - SLANEY_MEL_LOG_REGION_START_MEL));
}

export function getMelFrequencyPosition(frequency: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const start = frequencyToMel(safeMin);
  const end = frequencyToMel(safeMax);
  const current = frequencyToMel(clamp(frequency, safeMin, safeMax));

  return 1 - ((current - start) / (end - start));
}

export function getFrequencyAtMelPosition(position: number, minFrequency: number, maxFrequency: number): number {
  const safeMin = Math.max(0, minFrequency);
  const safeMax = Math.max(safeMin + 1, maxFrequency);
  const start = frequencyToMel(safeMin);
  const end = frequencyToMel(safeMax);
  const ratio = 1 - clamp(position, 0, 1);

  return melToFrequency(start + ratio * (end - start));
}

export function formatFrequencyLabel(frequency: number): string {
  if (frequency >= 1000) {
    const kiloHertz = frequency / 1000;
    const rounded = Number.isInteger(kiloHertz) ? String(kiloHertz) : kiloHertz.toFixed(1);
    return `${rounded} kHz`;
  }

  return `${Math.round(frequency)} Hz`;
}
