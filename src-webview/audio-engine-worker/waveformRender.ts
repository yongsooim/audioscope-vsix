import type { WaveformPlotMode } from '../audioEngineProtocol';
import {
  WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
  WAVEFORM_BOTTOM_PADDING_PX,
  WAVEFORM_TOP_PADDING_PX,
} from '../interactive-waveform/geometry';

const CENTER_LINE_ALPHA = 0.14;
const RAW_SAMPLE_MARKER_FILL = 'rgba(248, 250, 252, 0.94)';
const RAW_SAMPLE_MARKER_MIN_CSS_PIXELS_PER_SAMPLE = 7.5;
const RAW_SAMPLE_MARKER_RADIUS_CSS_PX = 1.5;
const SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 20;
const SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 28;
const SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
const SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
const SYMMETRIC_ENVELOPE_GAIN = 0.76;
const WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 0.9;
const WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 1.15;

export interface RepresentativeSampleCache {
  bucketCount: number;
  bucketSize: number;
  bucketStartIndex: number;
  sampleIndices: Int32Array;
  sampleValues: Float32Array;
}

interface SampleXTransform {
  maxX: number;
  xOffset: number;
  xScale: number;
}

interface RepresentativeSampleCacheMeta {
  bucketCount: number;
  bucketEndIndex: number;
  bucketSize: number;
  bucketStartIndex: number;
}

export function clearWaveformSurface(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawWaveformEnvelope(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  peaks: Float32Array,
  columnCount: number,
  heightCssPx: number,
  renderScale: number,
  color: string,
): void {
  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(WAVEFORM_TOP_PADDING_PX * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((heightCssPx - WAVEFORM_BOTTOM_PADDING_PX) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.fillStyle = color;

  const drawColumns = Math.min(columnCount, deviceWidth);
  for (let x = 0; x < drawColumns; x += 1) {
    const symmetricPeak = clamp(peaks[x] ?? 0, 0, 1) * SYMMETRIC_ENVELOPE_GAIN;
    const top = clamp(Math.round(midY - symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    const bottom = clamp(Math.round(midY + symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
  }
}

export function getRepresentativeSampleCacheCapacity(
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
): number {
  const { bucketCount } = getRepresentativeSampleCacheMeta(sampleStartFrame, visibleSampleCount, drawColumns);
  return Math.max(1, bucketCount);
}

export function fillRepresentativeSampleCache(
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
  sampleIndices: Int32Array,
  sampleValues: Float32Array,
): RepresentativeSampleCache {
  const meta = getRepresentativeSampleCacheMeta(sampleStartFrame, visibleSampleCount, drawColumns);

  if (sampleIndices.length < meta.bucketCount || sampleValues.length < meta.bucketCount) {
    throw new Error('Representative sample cache capacity is insufficient.');
  }

  let writeIndex = 0;
  for (let bucketIndex = meta.bucketStartIndex; bucketIndex < meta.bucketEndIndex; bucketIndex += 1) {
    const samplePoint = pickRepresentativeSamplePoint(samples, bucketIndex * meta.bucketSize, bucketIndex * meta.bucketSize + meta.bucketSize);
    if (!samplePoint) {
      continue;
    }

    sampleIndices[writeIndex] = samplePoint.sampleIndex;
    sampleValues[writeIndex] = samplePoint.sampleValue;
    writeIndex += 1;
  }

  return {
    bucketCount: writeIndex,
    bucketSize: meta.bucketSize,
    bucketStartIndex: meta.bucketStartIndex,
    sampleIndices,
    sampleValues,
  };
}

export function drawRepresentativeSamplePlot(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  samples: Float32Array,
  color: string,
  pixelsPerSample: number,
  sampleStartFrame: number,
  visibleSampleCount: number,
  visibleSampleSpan: number,
  heightCssPx: number,
  renderScale: number,
  representativeCache: RepresentativeSampleCache | null = null,
): void {
  const drawColumns = Math.max(1, canvas.width);
  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(WAVEFORM_TOP_PADDING_PX * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((heightCssPx - WAVEFORM_BOTTOM_PADDING_PX) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;
  const sampleXTransform = getSampleXTransform(sampleStartFrame, visibleSampleSpan, drawColumns);
  const resolvedRepresentativeCache = representativeCache ?? createRepresentativeSampleCache(
    samples,
    sampleStartFrame,
    visibleSampleCount,
    drawColumns,
  );
  const startValue = getInterpolatedSample(samples, sampleStartFrame);
  const endValue = getInterpolatedSample(samples, sampleStartFrame + visibleSampleSpan);

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  forEachRepresentativeDrawPoint(
    resolvedRepresentativeCache,
    sampleXTransform,
    startValue,
    endValue,
    (x, sampleValue, pointIndex) => {
      const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
      if (pointIndex === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    },
  );
  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, renderScale * 1.1);
    context.beginPath();
    forEachRepresentativeDrawPoint(
      resolvedRepresentativeCache,
      sampleXTransform,
      startValue,
      endValue,
      (x, sampleValue) => {
        const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
        context.rect(
          Math.round(x - pointSize * 0.5),
          Math.round(y - pointSize * 0.5),
          Math.max(1, Math.round(pointSize)),
          Math.max(1, Math.round(pointSize)),
        );
      },
    );
    context.fill();
  }
}

export function drawRawSamplePlot(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  samples: Float32Array,
  color: string,
  pixelsPerSample: number,
  sampleStartFrame: number,
  visibleSampleSpan: number,
  heightCssPx: number,
  renderScale: number,
): void {
  const drawColumns = Math.max(1, canvas.width);
  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(WAVEFORM_TOP_PADDING_PX * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((heightCssPx - WAVEFORM_BOTTOM_PADDING_PX) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartFrame));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartFrame + visibleSampleSpan));
  const sampleXTransform = getSampleXTransform(sampleStartFrame, visibleSampleSpan, drawColumns);

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  const startY = clamp(midY - getInterpolatedSample(samples, sampleStartFrame) * amplitudeHeight, chartTop, chartBottom);
  context.moveTo(0, startY);

  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getSampleX(sampleIndex, sampleXTransform);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.lineTo(x, y);
  }

  const endY = clamp(
    midY - getInterpolatedSample(samples, sampleStartFrame + visibleSampleSpan) * amplitudeHeight,
    chartTop,
    chartBottom,
  );
  context.lineTo(sampleXTransform.maxX, endY);
  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    if (pixelsPerSample / Math.max(1, renderScale) >= RAW_SAMPLE_MARKER_MIN_CSS_PIXELS_PER_SAMPLE) {
      drawRawSampleMarkers(
        context,
        samples,
        sampleStartFrame,
        visibleSampleSpan,
        sampleXTransform,
        midY,
        amplitudeHeight,
        chartTop,
        chartBottom,
        renderScale,
      );
      return;
    }

    const pointSize = Math.max(1.5, renderScale * 1.1);
    context.beginPath();
    for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
      const x = getSampleX(sampleIndex, sampleXTransform);
      const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
      const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
      context.rect(
        Math.round(x - pointSize * 0.5),
        Math.round(y - pointSize * 0.5),
        Math.max(1, Math.round(pointSize)),
        Math.max(1, Math.round(pointSize)),
      );
    }
    context.fill();
  }
}

export function resolveWaveformPlotMode(
  previousPlotMode: WaveformPlotMode,
  samplesPerPixel: number,
  hasSampleData: boolean,
): WaveformPlotMode {
  if (!hasSampleData) {
    return 'envelope';
  }

  if (previousPlotMode === 'raw') {
    if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL) {
      return 'raw';
    }
    return samplesPerPixel <= SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (previousPlotMode === 'sample') {
    if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
      return 'raw';
    }
    return samplesPerPixel <= SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
  }

  if (samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL) {
    return 'raw';
  }

  return samplesPerPixel <= SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL ? 'sample' : 'envelope';
}

export function pickRepresentativeSamplePoint(
  samples: Float32Array,
  startPosition: number,
  endPosition: number,
): { sampleIndex: number; sampleValue: number } | null {
  if (samples.length === 0) {
    return null;
  }

  const maxSampleIndex = samples.length - 1;
  const safeStart = clamp(Math.floor(startPosition), 0, maxSampleIndex);
  const safeEndExclusive = clamp(Math.max(safeStart + 1, Math.ceil(endPosition)), safeStart + 1, samples.length);
  const targetCenter = clamp((startPosition + Math.max(startPosition, endPosition - 1)) * 0.5, 0, maxSampleIndex);
  let minValue = 1;
  let maxValue = -1;

  for (let sampleIndex = safeStart; sampleIndex < safeEndExclusive; sampleIndex += 1) {
    const value = clamp(samples[sampleIndex] ?? 0, -1, 1);
    minValue = Math.min(minValue, value);
    maxValue = Math.max(maxValue, value);
  }

  const targetValue = Math.abs(maxValue - minValue) <= 1e-6
    ? clamp(samples[Math.round(targetCenter)] ?? 0, -1, 1)
    : clamp((minValue + maxValue) * 0.5, -1, 1);

  let bestIndex = safeStart;
  let bestValue = clamp(samples[safeStart] ?? 0, -1, 1);
  let bestScore = Number.POSITIVE_INFINITY;
  const rangeSpan = Math.max(1, safeEndExclusive - safeStart);

  for (let sampleIndex = safeStart; sampleIndex < safeEndExclusive; sampleIndex += 1) {
    const value = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const score = Math.abs(value - targetValue) + (Math.abs(sampleIndex - targetCenter) / rangeSpan);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = sampleIndex;
      bestValue = value;
    }
  }

  return {
    sampleIndex: bestIndex,
    sampleValue: bestValue,
  };
}

export function getWaveformMarkerYRatio(heightCssPx: number, sampleValue: number): number {
  const safeHeightCssPx = Math.max(1, heightCssPx);
  const chartTopPx = WAVEFORM_TOP_PADDING_PX;
  const chartBottomPx = Math.max(chartTopPx + 1, safeHeightCssPx - WAVEFORM_BOTTOM_PADDING_PX);
  const chartHeightPx = Math.max(1, chartBottomPx - chartTopPx);
  const midYPx = chartTopPx + chartHeightPx * 0.5;
  const yPx = clamp(
    midYPx - sampleValue * chartHeightPx * WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
    chartTopPx,
    chartBottomPx,
  );
  return clamp01(yPx / safeHeightCssPx);
}

export function formatSampleOrdinal(sampleNumber: number): string {
  return Number.isFinite(sampleNumber) && sampleNumber > 0
    ? Math.round(sampleNumber).toLocaleString()
    : '0';
}

export function formatSampleValue(sampleValue: number): string {
  const normalized = Math.abs(sampleValue) < 0.00005 ? 0 : sampleValue;
  return normalized.toFixed(6).replace(/(?:\.0+|(\.\d*?[1-9]))0+$/, '$1');
}

export function formatMfccValue(value: number): string {
  const normalized = Math.abs(value) < 0.00005 ? 0 : value;
  return normalized.toFixed(4).replace(/(?:\.0+|(\.\d*?[1-9]))0+$/, '$1');
}

function drawRawSampleMarkers(
  context: OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleSpan: number,
  sampleXTransform: SampleXTransform,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
  renderScale: number,
): void {
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartFrame));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartFrame + visibleSampleSpan));
  if (lastSampleIndex < firstSampleIndex) {
    return;
  }

  const radius = Math.max(1, RAW_SAMPLE_MARKER_RADIUS_CSS_PX * renderScale);
  context.save();
  context.fillStyle = RAW_SAMPLE_MARKER_FILL;
  context.beginPath();
  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getSampleX(sampleIndex, sampleXTransform);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.moveTo(x + radius, y);
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
  context.fill();
  context.restore();
}

function getRepresentativeSampleCacheMeta(
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
): RepresentativeSampleCacheMeta {
  const bucketSize = Math.max(1, Math.round(visibleSampleCount / Math.max(1, drawColumns)));
  const bucketStartIndex = Math.floor(sampleStartFrame / bucketSize);
  const bucketEndIndex = Math.ceil((sampleStartFrame + visibleSampleCount) / bucketSize);

  return {
    bucketCount: Math.max(0, bucketEndIndex - bucketStartIndex),
    bucketEndIndex,
    bucketSize,
    bucketStartIndex,
  };
}

function createRepresentativeSampleCache(
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
): RepresentativeSampleCache {
  const capacity = getRepresentativeSampleCacheCapacity(sampleStartFrame, visibleSampleCount, drawColumns);
  return fillRepresentativeSampleCache(
    samples,
    sampleStartFrame,
    visibleSampleCount,
    drawColumns,
    new Int32Array(capacity),
    new Float32Array(capacity),
  );
}

function getSampleXTransform(sampleStartFrame: number, visibleSampleSpan: number, drawColumns: number): SampleXTransform {
  const maxX = Math.max(0, drawColumns - 1);
  if (maxX <= 0 || visibleSampleSpan <= 0) {
    return { maxX, xOffset: 0, xScale: 0 };
  }

  const xScale = maxX / visibleSampleSpan;
  return {
    maxX,
    xOffset: -(sampleStartFrame * xScale),
    xScale,
  };
}

function getSampleX(samplePosition: number, sampleXTransform: SampleXTransform): number {
  if (sampleXTransform.maxX <= 0 || sampleXTransform.xScale <= 0) {
    return 0;
  }

  return clamp(samplePosition * sampleXTransform.xScale + sampleXTransform.xOffset, 0, sampleXTransform.maxX);
}

function forEachRepresentativeDrawPoint(
  representativeCache: RepresentativeSampleCache,
  sampleXTransform: SampleXTransform,
  startValue: number,
  endValue: number,
  visit: (x: number, sampleValue: number, pointIndex: number) => void,
): void {
  let hasPendingPoint = false;
  let pendingX = 0;
  let pendingValue = 0;
  let pointIndex = 0;

  const flushPendingPoint = (): void => {
    if (!hasPendingPoint) {
      return;
    }

    visit(pendingX, pendingValue, pointIndex);
    pointIndex += 1;
    hasPendingPoint = false;
  };

  const pushPoint = (x: number, sampleValue: number): void => {
    const normalizedValue = clamp(sampleValue ?? 0, -1, 1);

    if (hasPendingPoint && Math.abs(pendingX - x) <= 0.01) {
      if (Math.abs(normalizedValue) >= Math.abs(pendingValue)) {
        pendingValue = normalizedValue;
      }
      return;
    }

    flushPendingPoint();
    pendingX = x;
    pendingValue = normalizedValue;
    hasPendingPoint = true;
  };

  pushPoint(0, startValue);

  for (let pointOffset = 0; pointOffset < representativeCache.bucketCount; pointOffset += 1) {
    pushPoint(
      getSampleX(representativeCache.sampleIndices[pointOffset] ?? 0, sampleXTransform),
      representativeCache.sampleValues[pointOffset] ?? 0,
    );
  }

  pushPoint(sampleXTransform.maxX, endValue);
  flushPendingPoint();
}

function getInterpolatedSample(samples: Float32Array, position: number): number {
  const index = Math.floor(position);
  const nextIndex = Math.min(samples.length - 1, index + 1);
  const fraction = position - index;
  const a = clamp(samples[index] ?? 0, -1, 1);
  const b = clamp(samples[nextIndex] ?? 0, -1, 1);
  return a + (b - a) * fraction;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}
