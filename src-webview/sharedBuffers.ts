export const DISPLAY_MIN_DPR = 1;
export const TILE_COLUMN_COUNT = 256;

export function quantizeCeil(value, bucketSize) {
  return Math.max(bucketSize, Math.ceil(value / bucketSize) * bucketSize);
}
