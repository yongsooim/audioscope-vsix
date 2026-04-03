export const CHROMA_BIN_COUNT = 12;
export const CQT_DEFAULT_BINS_PER_OCTAVE = 36;
export const CQT_DEFAULT_FMIN = 32.70319566257483;
export const CHROMA_PITCH_CLASS_LABELS = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function positiveModulo(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

function getWrappedChromaDistance(source: number, target: number, chromaBinCount: number): number {
  const delta = Math.abs(source - target);
  return Math.min(delta, chromaBinCount - delta);
}

export function getChromaLabel(chromaIndex: number): string {
  return CHROMA_PITCH_CLASS_LABELS[positiveModulo(Math.round(chromaIndex), CHROMA_BIN_COUNT)] ?? 'C';
}

export function getChromaBinAtPosition(positionRatio: number, chromaBinCount = CHROMA_BIN_COUNT): number {
  const normalized = 1 - clamp01(positionRatio);
  return Math.min(chromaBinCount - 1, Math.max(0, Math.round(normalized * (chromaBinCount - 1))));
}

export function normalizeChromaColumn(values: Float32Array): Float32Array {
  let maximumValue = 0;
  for (let index = 0; index < values.length; index += 1) {
    maximumValue = Math.max(maximumValue, Math.abs(values[index] ?? 0));
  }

  if (maximumValue <= 1e-8) {
    values.fill(0);
    return values;
  }

  for (let index = 0; index < values.length; index += 1) {
    values[index] = (values[index] ?? 0) / maximumValue;
  }

  return values;
}

export function buildConstantQFrequencies(
  maximumFrequency: number,
  {
    binsPerOctave = CQT_DEFAULT_BINS_PER_OCTAVE,
    fmin = CQT_DEFAULT_FMIN,
  }: {
    binsPerOctave?: number;
    fmin?: number;
  } = {},
): Float32Array {
  const safeBinsPerOctave = Math.max(CHROMA_BIN_COUNT, Math.round(binsPerOctave));
  const safeFmin = Math.max(1, fmin);
  const safeMaximumFrequency = Math.max(safeFmin * 1.01, maximumFrequency);
  const octaveSpan = Math.max(0, Math.log2(safeMaximumFrequency / safeFmin));
  const binCount = Math.max(1, Math.floor(octaveSpan * safeBinsPerOctave) + 1);
  const frequencies = new Float32Array(binCount);

  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    frequencies[binIndex] = safeFmin * (2 ** (binIndex / safeBinsPerOctave));
  }

  return frequencies;
}

export function buildCqtChromaAssignments(
  binCount: number,
  {
    binsPerOctave = CQT_DEFAULT_BINS_PER_OCTAVE,
    chromaBinCount = CHROMA_BIN_COUNT,
  }: {
    binsPerOctave?: number;
    chromaBinCount?: number;
  } = {},
): Uint32Array {
  const safeBinCount = Math.max(1, Math.floor(binCount));
  const safeBinsPerOctave = Math.max(chromaBinCount, Math.round(binsPerOctave));
  const binsPerChroma = Math.max(1, Math.round(safeBinsPerOctave / chromaBinCount));
  const assignments = new Uint32Array(safeBinCount);

  for (let binIndex = 0; binIndex < safeBinCount; binIndex += 1) {
    const octaveIndex = positiveModulo(binIndex, safeBinsPerOctave);
    assignments[binIndex] = Math.min(
      chromaBinCount - 1,
      Math.floor(octaveIndex / binsPerChroma),
    );
  }

  return assignments;
}
