export const DISPLAY_MIN_DPR = 2;
export const TILE_COLUMN_COUNT = 256;

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
