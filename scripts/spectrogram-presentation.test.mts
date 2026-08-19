import assert from 'node:assert/strict';
import test from 'node:test';

const presentationModule = await import('../src-webview/audio-analysis/presentationGeometry.ts');
const getTilePresentationGeometry = presentationModule.getTilePresentationGeometry
  ?? presentationModule.default?.getTilePresentationGeometry;

const tile = {
  columnCount: 100,
  complete: true,
  renderedColumns: 100,
  tileEndSample: 1_000,
  tileStartSample: 0,
};

test('spectrogram follow advances through sub-column source positions continuously', () => {
  const first = getTilePresentationGeometry(tile, {
    endSampleExact: 900,
    startSampleExact: 100,
  }, 800);
  const next = getTilePresentationGeometry(tile, {
    endSampleExact: 901,
    startSampleExact: 101,
  }, 800);

  assert.ok(first);
  assert.ok(next);
  assert.equal(first.destinationX, 0);
  assert.equal(next.destinationX, 0);
  assert.equal(first.destinationWidthPx, 800);
  assert.equal(next.destinationWidthPx, 800);
  assert.ok(Math.abs(first.sourceX - 10) < 1e-9);
  assert.ok(Math.abs(next.sourceX - 10.1) < 1e-9);
  assert.ok(Math.abs(first.sourceWidth - 80) < 1e-9);
  assert.ok(Math.abs(next.sourceWidth - 80) < 1e-9);
});

test('fractional spectrogram crops keep adjacent tile edges seamless', () => {
  const displayRange = {
    endSampleExact: 1_500.25,
    startSampleExact: 500.25,
  };
  const left = getTilePresentationGeometry(tile, displayRange, 1_000);
  const right = getTilePresentationGeometry({
    ...tile,
    tileEndSample: 2_000,
    tileStartSample: 1_000,
  }, displayRange, 1_000);

  assert.ok(left);
  assert.ok(right);
  assert.equal(left.destinationX + left.destinationWidthPx, right.destinationX);
  assert.equal(right.destinationX + right.destinationWidthPx, 1_000);
});
