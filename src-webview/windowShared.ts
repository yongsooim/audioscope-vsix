export type SpectrogramWindowFunction = 'blackman' | 'hamming' | 'hann' | 'rectangular';

export const SPECTROGRAM_WINDOW_FUNCTION_OPTIONS: SpectrogramWindowFunction[] = [
  'hann',
  'hamming',
  'blackman',
  'rectangular',
];

export const WINDOW_FUNCTION_CODES: Record<SpectrogramWindowFunction, number> = {
  hann: 0,
  hamming: 1,
  blackman: 2,
  rectangular: 3,
};

export function normalizeSpectrogramWindowFunction(value: unknown): SpectrogramWindowFunction {
  return value === 'hamming' || value === 'blackman' || value === 'rectangular' ? value : 'hann';
}

export function getWindowFunctionLabel(value: SpectrogramWindowFunction): string {
  switch (value) {
    case 'hamming':
      return 'Hamming';
    case 'blackman':
      return 'Blackman';
    case 'rectangular':
      return 'Rectangular';
    default:
      return 'Hann';
  }
}

export function getWindowValue(
  windowFunction: SpectrogramWindowFunction,
  index: number,
  size: number,
): number {
  const safeSize = Math.max(1, Math.round(size));
  if (safeSize <= 1 || windowFunction === 'rectangular') {
    return 1;
  }

  const denominator = Math.max(1, safeSize - 1);
  const phase = (Math.PI * 2 * index) / denominator;

  switch (windowFunction) {
    case 'hamming':
      return 0.54 - (0.46 * Math.cos(phase));
    case 'blackman':
      return 0.42 - (0.5 * Math.cos(phase)) + (0.08 * Math.cos(phase * 2));
    default:
      return windowFunction === 'hann'
        ? 0.5 - (0.5 * Math.cos(phase))
        : 1;
  }
}
