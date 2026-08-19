import assert from 'node:assert/strict';
import test from 'node:test';
import type { FrequencyTickUi } from '../src-webview/audioEngineProtocol.ts';
import type { FrequencyAxisTickLayout } from '../src-webview/audioscope/core/frequencyAxisTicks.ts';

const frequencyAxisModule = await import('../src-webview/audioscope/core/frequencyAxisTicks.ts');
const createVisibleFrequencyAxisTicks = frequencyAxisModule.createVisibleFrequencyAxisTicks
  ?? frequencyAxisModule.default?.createVisibleFrequencyAxisTicks;

const ticks: FrequencyTickUi[] = [
  { edge: 'top', frequency: 20_000, label: '20.00 kHz', positionRatio: 0 },
  { edge: 'middle', frequency: 10_000, label: '10.00 kHz', positionRatio: 0.08 },
  { edge: 'middle', frequency: 5_000, label: '5.00 kHz', positionRatio: 0.19 },
  { edge: 'middle', frequency: 2_000, label: '2.00 kHz', positionRatio: 0.31 },
  { edge: 'middle', frequency: 1_000, label: '1.00 kHz', positionRatio: 0.43 },
  { edge: 'middle', frequency: 500, label: '500 Hz', positionRatio: 0.54 },
  { edge: 'middle', frequency: 200, label: '200 Hz', positionRatio: 0.68 },
  { edge: 'middle', frequency: 100, label: '100 Hz', positionRatio: 0.79 },
  { edge: 'middle', frequency: 50, label: '50 Hz', positionRatio: 0.9 },
  { edge: 'bottom', frequency: 20, label: '20 Hz', positionRatio: 1 },
];

function getLabelBounds(tick: FrequencyAxisTickLayout, axisHeightPx: number) {
  const anchor = tick.positionRatio * axisHeightPx;
  if (tick.edge === 'top') {
    return { bottom: anchor + 11, top: anchor };
  }
  if (tick.edge === 'bottom') {
    return { bottom: anchor, top: anchor - 11 };
  }
  return { bottom: anchor + 5.5, top: anchor - 5.5 };
}

test('frequency axis removes only labels that would overlap at short heights', () => {
  const axisHeightPx = 120;
  const visible = createVisibleFrequencyAxisTicks({ axisHeightPx, laneCount: 1, ticks });

  assert.ok(visible.length < ticks.length);
  assert.equal(visible[0]?.edge, 'top');
  assert.equal(visible.at(-1)?.edge, 'bottom');
  for (let index = 1; index < visible.length; index += 1) {
    const previous = getLabelBounds(visible[index - 1], axisHeightPx);
    const current = getLabelBounds(visible[index], axisHeightPx);
    assert.ok(previous.bottom + 5 <= current.top);
  }
});

test('frequency axis keeps the full scale when all labels fit', () => {
  const visible = createVisibleFrequencyAxisTicks({ axisHeightPx: 400, laneCount: 1, ticks });
  assert.equal(visible.length, ticks.length);
});

test('frequency axis shows a single label when even both edges cannot fit', () => {
  const visible = createVisibleFrequencyAxisTicks({ axisHeightPx: 20, laneCount: 1, ticks });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.edge, 'top');
});

test('frequency axis applies the same collision rule across channel lanes', () => {
  const laneTicks = [ticks[0]!, ticks.at(-1)!];
  const axisHeightPx = 40;
  const visible = createVisibleFrequencyAxisTicks({ axisHeightPx, laneCount: 2, ticks: laneTicks });

  for (let index = 1; index < visible.length; index += 1) {
    const previous = getLabelBounds(visible[index - 1], axisHeightPx);
    const current = getLabelBounds(visible[index], axisHeightPx);
    assert.ok(previous.bottom + 5 <= current.top);
  }
});
