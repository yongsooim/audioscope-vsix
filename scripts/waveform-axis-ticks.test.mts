import assert from 'node:assert/strict';
import test from 'node:test';

const axisTicksModule = await import('../src-webview/audioscope/core/waveformAxisTicks.ts');
const createWaveformAxisTicks = axisTicksModule.createWaveformAxisTicks
  ?? axisTicksModule.default?.createWaveformAxisTicks;

const LABEL_CHARACTER_WIDTH_PX = 6.25;
const LABEL_GAP_PX = 10;

function getLabelBounds(tick: { align: string; label: string; positionRatio: number }, width: number) {
  const anchor = tick.positionRatio * width;
  const labelWidth = Math.ceil(tick.label.length * LABEL_CHARACTER_WIDTH_PX);
  if (tick.align === 'start') {
    return { left: anchor, right: anchor + labelWidth };
  }
  if (tick.align === 'end') {
    return { left: anchor - labelWidth, right: anchor };
  }
  return { left: anchor - labelWidth * 0.5, right: anchor + labelWidth * 0.5 };
}

test('waveform axis labels keep a visible gap at dense zoom levels', () => {
  const width = 420;
  const ticks = createWaveformAxisTicks({
    durationFrames: 12_561,
    endFrame: 12_561,
    renderWidthPx: width,
    sampleRate: 100,
    startFrame: 10_250,
  });

  for (let index = 1; index < ticks.length; index += 1) {
    const previous = getLabelBounds(ticks[index - 1], width);
    const current = getLabelBounds(ticks[index], width);
    assert.ok(
      previous.right + LABEL_GAP_PX <= current.left,
      `${ticks[index - 1].label} overlaps ${ticks[index].label}`,
    );
  }
});

test('waveform axis reserves the right edge for the exact end time', () => {
  const ticks = createWaveformAxisTicks({
    durationFrames: 12_561,
    endFrame: 12_561,
    renderWidthPx: 816,
    sampleRate: 100,
    startFrame: 10_250,
  });
  const endTick = ticks.at(-1);

  assert.ok(endTick);
  assert.equal(endTick.align, 'end');
  assert.equal(endTick.frame, 12_561);
  assert.equal(endTick.label, '2:05.61');
  assert.equal(endTick.positionRatio, 1);
  assert.equal(ticks.filter((tick: { align: string }) => tick.align === 'end').length, 1);
});
