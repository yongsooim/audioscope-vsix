export const DISPLAY_MIN_DPR = 2;
export const TILE_COLUMN_COUNT = 256;
export const WAVEFORM_SLOT_COUNT = 8;
export const SPECTROGRAM_SLOT_COUNT = 12;
export const CONTROL_INTS = 128;

export const CONTROL_INDEX = {
  sessionVersion: 0,
  attached: 1,
  waveformSlotBase: 16,
  spectrogramSlotBase: 48,
};

export function createControlState() {
  const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CONTROL_INTS);
  return {
    sab,
    view: new Int32Array(sab),
  };
}

export function getWaveformSlotLength(maxColumns) {
  return maxColumns * 2;
}

export function getWaveformArenaByteLength(maxColumns, slotCount = WAVEFORM_SLOT_COUNT) {
  return Float32Array.BYTES_PER_ELEMENT * getWaveformSlotLength(maxColumns) * slotCount;
}

export function getWaveformSlotView(waveformSab, maxColumns, slotId) {
  const slotLength = getWaveformSlotLength(maxColumns);
  const byteOffset = Float32Array.BYTES_PER_ELEMENT * slotLength * slotId;
  return new Float32Array(waveformSab, byteOffset, slotLength);
}

export function getSpectrogramSlotByteLength(maxColumns, maxRows) {
  return maxColumns * maxRows * 4;
}

export function getSpectrogramArenaByteLength(maxColumns, maxRows, slotCount = SPECTROGRAM_SLOT_COUNT) {
  return getSpectrogramSlotByteLength(maxColumns, maxRows) * slotCount;
}

export function getSpectrogramSlotView(spectrogramSab, maxColumns, maxRows, slotId, width, height) {
  const maxSlotBytes = getSpectrogramSlotByteLength(maxColumns, maxRows);
  const byteOffset = maxSlotBytes * slotId;
  return new Uint8ClampedArray(spectrogramSab, byteOffset, width * height * 4);
}

export function markWaveformSlotReady(controlView, slotId, sequence) {
  Atomics.store(controlView, CONTROL_INDEX.waveformSlotBase + slotId, sequence);
}

export function readWaveformSlotSequence(controlView, slotId) {
  return Atomics.load(controlView, CONTROL_INDEX.waveformSlotBase + slotId);
}

export function markSpectrogramSlotReady(controlView, slotId, sequence) {
  Atomics.store(controlView, CONTROL_INDEX.spectrogramSlotBase + slotId, sequence);
}

export function readSpectrogramSlotSequence(controlView, slotId) {
  return Atomics.load(controlView, CONTROL_INDEX.spectrogramSlotBase + slotId);
}

export function quantizeCeil(value, bucketSize) {
  return Math.max(bucketSize, Math.ceil(value / bucketSize) * bucketSize);
}

export function quantizeSamplesPerPixel(samplesPerPixel) {
  const safeValue = Math.max(1, samplesPerPixel);
  const bucketExponent = Math.round(Math.log2(safeValue) * 2) / 2;
  return 2 ** bucketExponent;
}

export function formatBucketNumber(value) {
  return String(Math.round(value * 100) / 100).replace('.', '_');
}
