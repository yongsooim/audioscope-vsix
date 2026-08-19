import type { FrequencyTickUi } from '../../audioEngineProtocol';

const FREQUENCY_LABEL_HEIGHT_PX = 11;
const FREQUENCY_LABEL_GAP_PX = 5;

export interface FrequencyAxisTickLayout {
  edge: 'bottom' | 'middle' | 'top';
  lane: number;
  positionRatio: number;
  tickIndex: number;
}

interface FrequencyAxisTickCandidate extends FrequencyAxisTickLayout {
  bottomPx: number;
  topPx: number;
}

export function createVisibleFrequencyAxisTicks({
  axisHeightPx,
  laneCount,
  ticks,
}: {
  axisHeightPx: number;
  laneCount: number;
  ticks: FrequencyTickUi[];
}): FrequencyAxisTickLayout[] {
  if (!(axisHeightPx > 0) || laneCount <= 0 || ticks.length === 0) {
    return [];
  }

  const candidates: FrequencyAxisTickCandidate[] = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    for (const [tickIndex, tick] of ticks.entries()) {
      // Adjacent lanes share this boundary; render one label there, not two.
      if (tick.edge === 'bottom' && lane < laneCount - 1) {
        continue;
      }

      const positionRatio = (lane + tick.positionRatio) / laneCount;
      const positionPx = positionRatio * axisHeightPx;
      const edge = tick.edge === 'top' && lane === 0
        ? 'top'
        : tick.edge === 'bottom' && lane === laneCount - 1
          ? 'bottom'
          : 'middle';
      const topPx = edge === 'top'
        ? positionPx
        : edge === 'bottom'
          ? positionPx - FREQUENCY_LABEL_HEIGHT_PX
          : positionPx - (FREQUENCY_LABEL_HEIGHT_PX / 2);

      candidates.push({
        bottomPx: topPx + FREQUENCY_LABEL_HEIGHT_PX,
        edge,
        lane,
        positionRatio,
        tickIndex,
        topPx,
      });
    }
  }

  candidates.sort((left, right) => left.positionRatio - right.positionRatio);
  const first = candidates[0];
  const last = candidates[candidates.length - 1];
  if (!first || !last || first === last) {
    return first ? [first] : [];
  }

  // If even both edge labels cannot fit, one honest label is better than overlap.
  if (first.bottomPx + FREQUENCY_LABEL_GAP_PX > last.topPx) {
    return [first];
  }

  const visible = [first];
  let previous = first;
  for (const candidate of candidates.slice(1, -1)) {
    if (
      candidate.topPx >= previous.bottomPx + FREQUENCY_LABEL_GAP_PX
      && candidate.bottomPx + FREQUENCY_LABEL_GAP_PX <= last.topPx
    ) {
      visible.push(candidate);
      previous = candidate;
    }
  }
  visible.push(last);
  return visible;
}
