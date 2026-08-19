// One absolute column grid, shared by the engine worker (viewport geometry), the
// main thread (canvas placement) and the waveform worker (path extraction).
//
// Grid column j covers samples [floor(j * span / columns), floor((j+1) * span / columns)).
// Indexing by an ABSOLUTE column index — instead of walking an accumulator from the
// current view start — is what kills the follow-mode shimmer: a column's sample
// window depends only on where it sits in the file, so scrolling by one column makes
// column k inherit column k+1's window verbatim. The picture then translates rigidly
// instead of re-partitioning its min/max buckets (and popping between neighbouring
// peaks) on every frame. It matters most at moderate zoom, where one column covers
// roughly one pyramid block and gaining/losing a block swings the drawn peak.
//
// Everything here stays in whole samples and stays reproducible: the same absolute
// column index must yield bit-identical boundaries on every frame, which is a
// stronger requirement than being exactly right.

// Below this the renderer plots individual samples instead of column min/max
// envelopes, so there are no buckets to keep stable — and the column grid has grown
// coarser than the sample grid. Lives here because the grid's alignment rule keys
// off it; the renderer imports it back.
export const RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL = 4;

// Extra columns rendered past the right edge of the viewport. They give the
// compositor real pixels to slide in while a re-render is still in flight, so the
// waveform keeps moving at display rate even when the worker misses a frame.
// ponytail: fixed budget (~6% of a 2048-column surface). If a slow machine still
// runs past it the translate just clamps (today's behaviour); scale it with
// columns-per-second if that ever shows up.
export const WAVEFORM_GRID_SLACK_COLUMNS = 128;

export interface WaveformColumnGrid {
  // Total columns rendered: the viewport plus the off-screen slack.
  columnCount: number;
  // Samples covered by columnCount columns. Constant for a given zoom + surface,
  // which is what keeps the grid stable while the view scrolls.
  spanSamples: number;
}

export function getWaveformColumnCount(widthCssPx: number, renderScale: number): number {
  return Math.max(1, Math.round(Math.max(1, widthCssPx) * Math.max(1, renderScale)));
}

// CSS width of the waveform canvas: the viewport plus the slack columns. Every
// initCanvas/resizeCanvas/render request has to agree on this, or the backing store
// and the element's CSS width disagree and the browser scales the image.
export function getWaveformRenderWidthCssPx(widthCssPx: number, renderScale: number): number {
  const scale = Math.max(1, renderScale);
  return (getWaveformColumnCount(widthCssPx, scale) + WAVEFORM_GRID_SLACK_COLUMNS) / scale;
}

export function createWaveformColumnGrid(
  visibleColumnCount: number,
  visibleSpanSamples: number,
): WaveformColumnGrid {
  const visibleColumns = Math.max(1, Math.round(visibleColumnCount));
  const columnCount = visibleColumns + WAVEFORM_GRID_SLACK_COLUMNS;
  const visibleSpan = Math.max(1, Math.round(visibleSpanSamples));
  return {
    columnCount,
    // Same samples-per-column as the viewport, extended over the slack. Keeping this
    // ratio exact is what makes the visible half of the canvas a 1:1 image of the
    // viewport; inflating it would silently rescale the waveform.
    spanSamples: Math.max(1, Math.round((visibleSpan * columnCount) / visibleColumns)),
  };
}

export function columnIndexToSample(columnIndex: number, grid: WaveformColumnGrid): number {
  return Math.floor((columnIndex * grid.spanSamples) / grid.columnCount);
}

export function sampleToColumnIndex(sampleFrame: number, grid: WaveformColumnGrid): number {
  return Math.round((sampleFrame * grid.columnCount) / grid.spanSamples);
}

// Snaps a view origin onto the grid. The dropped remainder is under one device
// column, keeping the waveform buckets stable while the follow playhead remains
// fixed at its center anchor.
//
// Once a column holds only a couple of samples the renderer plots raw samples and
// there is nothing to re-bucket, while the column grid becomes coarser than the
// sample grid and would start dragging the origin a whole sample off. Snap to whole
// samples there instead — that is the finer of the two grids, and it is what
// frame-locks the image at per-sample zoom.
export function alignSampleToColumnGrid(sampleFrame: number, grid: WaveformColumnGrid): number {
  if (!Number.isFinite(sampleFrame)) {
    return 0;
  }
  if (grid.spanSamples < grid.columnCount * RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL) {
    return Math.round(sampleFrame);
  }
  return columnIndexToSample(sampleToColumnIndex(sampleFrame, grid), grid);
}
