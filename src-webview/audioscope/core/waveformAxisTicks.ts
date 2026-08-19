import type { FrameAxisTick } from '../../audioEngineProtocol';
import { clamp, formatAxisLabel, getNiceTimeStep } from './format';

const AXIS_LABEL_CHARACTER_WIDTH_PX = 6.25;
const AXIS_LABEL_GAP_PX = 10;
const AXIS_TICK_TARGET_SPACING_PX = 76;

interface WaveformAxisTickInput {
  durationFrames: number;
  endFrame: number;
  renderWidthPx: number;
  sampleRate: number;
  startFrame: number;
}

function getLabelWidthPx(label: string): number {
  return Math.ceil(label.length * AXIS_LABEL_CHARACTER_WIDTH_PX);
}

function getLabelBoundsPx(tick: FrameAxisTick, renderWidthPx: number): { left: number; right: number } {
  const anchorX = clamp(tick.positionRatio, 0, 1) * renderWidthPx;
  const width = getLabelWidthPx(tick.label);
  if (tick.align === 'start') {
    return { left: anchorX, right: anchorX + width };
  }
  if (tick.align === 'end') {
    return { left: anchorX - width, right: anchorX };
  }
  return { left: anchorX - width * 0.5, right: anchorX + width * 0.5 };
}

export function createWaveformAxisTicks({
  durationFrames,
  endFrame,
  renderWidthPx,
  sampleRate,
  startFrame,
}: WaveformAxisTickInput): FrameAxisTick[] {
  const spanFrames = Math.max(0, endFrame - startFrame);
  const safeRenderWidthPx = Math.max(1, renderWidthPx);
  if (!(sampleRate > 0) || !(spanFrames > 0)) {
    return [];
  }

  const startSeconds = startFrame / sampleRate;
  const endSeconds = endFrame / sampleRate;
  const spanSeconds = endSeconds - startSeconds;
  const targetTickCount = Math.max(1, Math.min(28, Math.floor(safeRenderWidthPx / AXIS_TICK_TARGET_SPACING_PX)));
  const step = getNiceTimeStep(spanSeconds / targetTickCount);
  const startTick: FrameAxisTick = {
    align: 'start',
    frame: startFrame,
    label: formatAxisLabel(startSeconds),
    positionRatio: 0,
  };
  const endTick: FrameAxisTick = {
    align: 'end',
    frame: endFrame,
    label: formatAxisLabel(endSeconds),
    positionRatio: 1,
  };
  const startBounds = getLabelBoundsPx(startTick, safeRenderWidthPx);
  const endBounds = getLabelBoundsPx(endTick, safeRenderWidthPx);
  const ticks: FrameAxisTick[] = [];
  let previousRight = 0;

  // The exact end time owns the right edge. Keep the start only when both endpoint
  // labels fit; on extremely narrow views the end remains the single useful anchor.
  if (startBounds.right + AXIS_LABEL_GAP_PX <= endBounds.left) {
    ticks.push(startTick);
    previousRight = startBounds.right;
  }

  const firstTick = Math.ceil(startSeconds / step) * step;
  for (let tickSeconds = firstTick; tickSeconds < endSeconds; tickSeconds += step) {
    const frame = clamp(Math.round(tickSeconds * sampleRate), 0, durationFrames);
    if (frame <= startFrame || frame >= endFrame) {
      continue;
    }

    const tick: FrameAxisTick = {
      align: 'center',
      frame,
      label: formatAxisLabel(frame / sampleRate),
      positionRatio: (frame - startFrame) / spanFrames,
    };
    const bounds = getLabelBoundsPx(tick, safeRenderWidthPx);
    if (
      bounds.left < previousRight + AXIS_LABEL_GAP_PX
      || bounds.right + AXIS_LABEL_GAP_PX > endBounds.left
    ) {
      continue;
    }

    ticks.push(tick);
    previousRight = bounds.right;
  }

  ticks.push(endTick);
  return ticks;
}
