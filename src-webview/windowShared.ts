export type SpectrogramWindowFunction = 'blackman' | 'hamming' | 'hann' | 'rectangular';

export const WINDOW_FUNCTION_CODES: Record<SpectrogramWindowFunction, number> = {
  hann: 0,
  hamming: 1,
  blackman: 2,
  rectangular: 3,
};

export function normalizeSpectrogramWindowFunction(value: unknown): SpectrogramWindowFunction {
  return value === 'hamming' || value === 'blackman' || value === 'rectangular' ? value : 'hann';
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

// Coherent-gain power normalization. A pure tone peaks at (Σ window)/2 in the
// one-sided magnitude spectrum, so dividing power by (Σw/2)² makes the displayed
// dB independent of the window choice (a window with lower coherent gain no
// longer reads quieter). A rectangular window (Σw = N) reduces to the original
// 1/(N/2)². Memoized per (window, size); the Zig analysis core mirrors this.
const windowPowerScaleCache = new Map<string, number>();
export function getWindowCoherentPowerScale(
  windowFunction: SpectrogramWindowFunction,
  fftSize: number,
): number {
  const size = Math.max(1, Math.round(fftSize));
  const cacheKey = `${windowFunction}:${size}`;
  const cached = windowPowerScaleCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let windowSum = 0;
  for (let index = 0; index < size; index += 1) {
    windowSum += getWindowValue(windowFunction, index, size);
  }

  const halfWindowSum = windowSum * 0.5;
  const halfFftSize = Math.max(1, size / 2);
  const scale = halfWindowSum > 0
    ? 1 / (halfWindowSum * halfWindowSum)
    : 1 / (halfFftSize * halfFftSize);
  windowPowerScaleCache.set(cacheKey, scale);
  return scale;
}
