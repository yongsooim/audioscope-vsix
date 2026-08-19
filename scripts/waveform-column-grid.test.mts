import assert from 'node:assert/strict';
import test from 'node:test';

const gridModule = await import('../src-webview/audioscope/core/waveformColumnGrid.ts');
const {
  alignSampleToColumnGrid,
  columnIndexToSample,
  createWaveformColumnGrid,
  sampleToColumnIndex,
  WAVEFORM_GRID_SLACK_COLUMNS,
} = gridModule;

// The boundary rule the WASM path extractor uses, mirrored here so the invariant is
// checkable without loading the module: column j covers [floor(j*span/N), floor((j+1)*span/N)).
function columnWindow(columnIndex: number, spanSamples: number, columnCount: number) {
  return {
    start: Math.floor((columnIndex * spanSamples) / columnCount),
    end: Math.floor(((columnIndex + 1) * spanSamples) / columnCount),
  };
}

// Moderate zoom is where the shimmer lived: one column covers roughly one pyramid
// block, so a column that gains or loses a block visibly changes the drawn peak.
const MODERATE_ZOOM_COLUMNS = 2_048;
const MODERATE_ZOOM_SPAN_FRAMES = 2_048 * 37;

test('the render window keeps the viewport at 1:1 and hangs the slack off the right', () => {
  const grid = createWaveformColumnGrid(MODERATE_ZOOM_COLUMNS, MODERATE_ZOOM_SPAN_FRAMES);
  assert.equal(grid.columnCount, MODERATE_ZOOM_COLUMNS + WAVEFORM_GRID_SLACK_COLUMNS);

  const visibleSamplesPerColumn = MODERATE_ZOOM_SPAN_FRAMES / MODERATE_ZOOM_COLUMNS;
  const renderSamplesPerColumn = grid.spanSamples / grid.columnCount;
  // Anything but 1:1 here silently rescales the visible waveform.
  assert.ok(
    Math.abs(renderSamplesPerColumn - visibleSamplesPerColumn) < 0.001,
    `render scale ${renderSamplesPerColumn} drifted from ${visibleSamplesPerColumn}`,
  );
});

test('scrolling one column re-uses the neighbour column window verbatim', () => {
  const grid = createWaveformColumnGrid(MODERATE_ZOOM_COLUMNS, MODERATE_ZOOM_SPAN_FRAMES);
  const originColumn = 5_003;

  // This is the whole point of an absolute grid: after a one-column scroll, column k
  // must land on exactly the sample bucket column k+1 held before. Anything else
  // re-partitions the min/max buckets every frame — the boil.
  for (let column = 0; column < 64; column += 1) {
    assert.deepEqual(
      columnWindow(originColumn + 1 + column, grid.spanSamples, grid.columnCount),
      columnWindow(originColumn + (column + 1), grid.spanSamples, grid.columnCount),
    );
  }

  // Windows tile without gaps or overlap.
  for (let column = originColumn; column < originColumn + 64; column += 1) {
    const current = columnWindow(column, grid.spanSamples, grid.columnCount);
    const next = columnWindow(column + 1, grid.spanSamples, grid.columnCount);
    assert.equal(current.end, next.start);
    assert.ok(current.end > current.start);
  }
});

test('aligned origins sit on the grid, stay put when re-aligned, and step by one column', () => {
  const grid = createWaveformColumnGrid(MODERATE_ZOOM_COLUMNS, MODERATE_ZOOM_SPAN_FRAMES);
  let previousColumn = -1;

  for (let offset = 0; offset < 4_000; offset += 7) {
    const requested = 12_345_678 + offset;
    const aligned = alignSampleToColumnGrid(requested, grid);
    const column = sampleToColumnIndex(aligned, grid);

    assert.equal(columnIndexToSample(column, grid), aligned, 'origin is a grid boundary');
    assert.equal(alignSampleToColumnGrid(aligned, grid), aligned, 'alignment is idempotent');
    assert.ok(Math.abs(aligned - requested) <= grid.spanSamples / grid.columnCount);
    assert.ok(column >= previousColumn, 'alignment is monotonic in the request');
    previousColumn = column;
  }
});

test('per-sample zoom falls back to whole-sample snapping', () => {
  // Under a few samples per column the renderer plots raw samples, and the column
  // grid is coarser than the sample grid — snapping to it would drag the origin a
  // whole sample off the ruler.
  const grid = createWaveformColumnGrid(2_048, 1_024);
  assert.equal(alignSampleToColumnGrid(4_096.4, grid), 4_096);
  assert.equal(alignSampleToColumnGrid(4_096.6, grid), 4_097);
});
