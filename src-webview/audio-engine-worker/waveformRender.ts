import type { WaveformPlotMode } from '../audioEngineProtocol';
import {
  WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
  WAVEFORM_BOTTOM_PADDING_PX,
  WAVEFORM_TOP_PADDING_PX,
} from '../interactive-waveform/geometry';

const CENTER_LINE_ALPHA = 0.14;
const CLIPPING_GUIDE_ALPHA = 0.08;
const RAW_SAMPLE_MARKER_FILL = 'rgba(248, 250, 252, 0.94)';
const RAW_SAMPLE_MARKER_MIN_CSS_PIXELS_PER_SAMPLE = 7.5;
const RAW_SAMPLE_MARKER_RADIUS_CSS_PX = 1.5;
const RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL = 4;
const SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 24;
const SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 32;
const SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
const SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
const SAMPLE_TO_RAW_BLEND_END_SAMPLES_PER_PIXEL = 1.65;
const SAMPLE_TO_RAW_BLEND_START_SAMPLES_PER_PIXEL = 0.8;
const SYMMETRIC_ENVELOPE_GAIN = 1;
const WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 8;
const WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 12;

export interface RepresentativeSampleCache {
  bucketCount: number;
  bucketSize: number;
  bucketStartIndex: number;
  sampleIndices: Int32Array;
  sampleValues: Float32Array;
}

export interface RawDisplayCache {
  bucketCount: number;
  bucketSize: number;
  bucketStartIndex: number;
  firstIndices: Int32Array;
  lastIndices: Int32Array;
  maxIndices: Int32Array;
  minIndices: Int32Array;
}

interface SampleXTransform {
  maxX: number;
  xOffset: number;
  xScale: number;
}

interface RepresentativeDrawPointBuffer {
  count: number;
  sampleValues: Float32Array;
  xPositions: Float32Array;
}

export interface RepresentativeSampleCacheMeta {
  bucketCount: number;
  bucketEndIndex: number;
  bucketSize: number;
  bucketStartIndex: number;
}

export interface RawDisplayCacheMeta {
  bucketCount: number;
  bucketEndIndex: number;
  bucketSize: number;
  bucketStartIndex: number;
}

interface WaveformSamplePlotRenderOptions {
  alpha?: number;
  preserveExistingSurface?: boolean;
  rawDisplayCache?: RawDisplayCache | null;
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
  drawWaveformReferenceGuides(context, deviceWidth, midY, amplitudeHeight, chartTop, chartBottom, renderScale);
  context.fillStyle = color;

  const drawColumns = Math.min(columnCount, deviceWidth);
  for (let x = 0; x < drawColumns; x += 1) {
    const sourceIndex = x * 2;
    const minValue = clamp(peaks[sourceIndex] ?? 0, -1, 1);
    const maxValue = clamp(peaks[sourceIndex + 1] ?? 0, -1, 1);
    const top = clamp(Math.round(midY - maxValue * amplitudeHeight), chartTop, chartBottom);
    const bottom = clamp(Math.round(midY - minValue * amplitudeHeight), chartTop, chartBottom);
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

  const bucketCount = fillRepresentativeSampleBuckets(
    samples,
    meta.bucketStartIndex,
    meta.bucketEndIndex,
    meta.bucketSize,
    sampleIndices,
    sampleValues,
    0,
  );

  return {
    bucketCount,
    bucketSize: meta.bucketSize,
    bucketStartIndex: meta.bucketStartIndex,
    sampleIndices,
    sampleValues,
  };
}

export function fillRepresentativeSampleCacheWithReuse(
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
  sampleIndices: Int32Array,
  sampleValues: Float32Array,
  previousCache: RepresentativeSampleCache | null = null,
): RepresentativeSampleCache {
  const meta = getRepresentativeSampleCacheMeta(sampleStartFrame, visibleSampleCount, drawColumns);

  if (sampleIndices.length < meta.bucketCount || sampleValues.length < meta.bucketCount) {
    throw new Error('Representative sample cache capacity is insufficient.');
  }

  if (!previousCache || previousCache.bucketSize !== meta.bucketSize || previousCache.bucketCount <= 0) {
    return fillRepresentativeSampleCache(
      samples,
      sampleStartFrame,
      visibleSampleCount,
      drawColumns,
      sampleIndices,
      sampleValues,
    );
  }

  const previousEndIndex = previousCache.bucketStartIndex + previousCache.bucketCount;
  const overlapStartIndex = Math.max(meta.bucketStartIndex, previousCache.bucketStartIndex);
  const overlapEndIndex = Math.min(meta.bucketEndIndex, previousEndIndex);

  if (overlapEndIndex <= overlapStartIndex) {
    return fillRepresentativeSampleCache(
      samples,
      sampleStartFrame,
      visibleSampleCount,
      drawColumns,
      sampleIndices,
      sampleValues,
    );
  }

  const overlapCount = overlapEndIndex - overlapStartIndex;
  const sourceOffset = overlapStartIndex - previousCache.bucketStartIndex;
  const targetOffset = overlapStartIndex - meta.bucketStartIndex;
  copyRepresentativeCacheWindow(
    previousCache,
    sampleIndices,
    sampleValues,
    sourceOffset,
    targetOffset,
    overlapCount,
  );

  fillRepresentativeSampleBuckets(
    samples,
    meta.bucketStartIndex,
    overlapStartIndex,
    meta.bucketSize,
    sampleIndices,
    sampleValues,
    0,
  );
  fillRepresentativeSampleBuckets(
    samples,
    overlapEndIndex,
    meta.bucketEndIndex,
    meta.bucketSize,
    sampleIndices,
    sampleValues,
    targetOffset + overlapCount,
  );

  return {
    bucketCount: meta.bucketCount,
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
  options: WaveformSamplePlotRenderOptions = {},
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
  const alpha = clamp01(options.alpha ?? 1);

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (!options.preserveExistingSurface) {
    context.clearRect(0, 0, deviceWidth, deviceHeight);
    drawWaveformReferenceGuides(context, deviceWidth, midY, amplitudeHeight, chartTop, chartBottom, renderScale);
  }
  if (alpha <= 0) {
    return;
  }
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  const drawPoints = collectRepresentativeDrawPoints(
    resolvedRepresentativeCache,
    sampleXTransform,
    startValue,
    endValue,
  );
  context.beginPath();
  for (let pointIndex = 0; pointIndex < drawPoints.count; pointIndex += 1) {
    const x = drawPoints.xPositions[pointIndex] ?? 0;
    const sampleValue = drawPoints.sampleValues[pointIndex] ?? 0;
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    if (pointIndex === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    const pointSize = Math.max(1.5, renderScale * 1.1);
    context.beginPath();
    for (let pointIndex = 0; pointIndex < drawPoints.count; pointIndex += 1) {
      const x = drawPoints.xPositions[pointIndex] ?? 0;
      const sampleValue = drawPoints.sampleValues[pointIndex] ?? 0;
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
  context.restore();
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
  options: WaveformSamplePlotRenderOptions = {},
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
  const alpha = clamp01(options.alpha ?? 1);

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (!options.preserveExistingSurface) {
    context.clearRect(0, 0, deviceWidth, deviceHeight);
    drawWaveformReferenceGuides(context, deviceWidth, midY, amplitudeHeight, chartTop, chartBottom, renderScale);
  }
  if (alpha <= 0) {
    return;
  }
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  const startY = clamp(midY - getInterpolatedSample(samples, sampleStartFrame) * amplitudeHeight, chartTop, chartBottom);
  context.moveTo(0, startY);
  const samplesPerPixel = pixelsPerSample > 0 ? 1 / pixelsPerSample : Number.POSITIVE_INFINITY;
  if (samplesPerPixel >= RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL && options.rawDisplayCache) {
    appendCachedRawSamplePath(
      context,
      samples,
      options.rawDisplayCache,
      sampleXTransform,
      midY,
      amplitudeHeight,
      chartTop,
      chartBottom,
    );
  } else if (samplesPerPixel >= RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL) {
    appendSimplifiedRawSamplePath(
      context,
      samples,
      firstSampleIndex,
      lastSampleIndex,
      sampleXTransform,
      midY,
      amplitudeHeight,
      chartTop,
      chartBottom,
    );
  } else {
    for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
      const x = getSampleX(sampleIndex, sampleXTransform);
      const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
      const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
      context.lineTo(x, y);
    }
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
      context.restore();
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
  context.restore();
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
    return samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'raw' : 'envelope';
  }

  return samplesPerPixel <= WAVEFORM_RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL ? 'raw' : 'envelope';
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

function appendCachedRawSamplePath(
  context: OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  rawDisplayCache: RawDisplayCache,
  sampleXTransform: SampleXTransform,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
): void {
  for (let bucketOffset = 0; bucketOffset < rawDisplayCache.bucketCount; bucketOffset += 1) {
    appendOrderedRawSamplePathPoints(
      context,
      samples,
      rawDisplayCache.firstIndices[bucketOffset] ?? 0,
      rawDisplayCache.minIndices[bucketOffset] ?? 0,
      rawDisplayCache.maxIndices[bucketOffset] ?? 0,
      rawDisplayCache.lastIndices[bucketOffset] ?? 0,
      sampleXTransform,
      midY,
      amplitudeHeight,
      chartTop,
      chartBottom,
    );
  }
}

function appendSimplifiedRawSamplePath(
  context: OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  firstSampleIndex: number,
  lastSampleIndex: number,
  sampleXTransform: SampleXTransform,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
): void {
  if (lastSampleIndex < firstSampleIndex) {
    return;
  }

  let sampleIndex = firstSampleIndex;
  while (sampleIndex <= lastSampleIndex) {
    const bucketPixelX = Math.floor(getSampleX(sampleIndex, sampleXTransform));
    let bucketFirstIndex = sampleIndex;
    let bucketLastIndex = sampleIndex;
    let minIndex = sampleIndex;
    let maxIndex = sampleIndex;
    let minValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    let maxValue = minValue;

    sampleIndex += 1;

    while (sampleIndex <= lastSampleIndex) {
      const currentPixelX = Math.floor(getSampleX(sampleIndex, sampleXTransform));
      if (currentPixelX !== bucketPixelX) {
        break;
      }

      const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
      if (sampleValue < minValue) {
        minValue = sampleValue;
        minIndex = sampleIndex;
      }
      if (sampleValue > maxValue) {
        maxValue = sampleValue;
        maxIndex = sampleIndex;
      }
      bucketLastIndex = sampleIndex;
      sampleIndex += 1;
    }

    appendOrderedRawSamplePathPoints(
      context,
      samples,
      bucketFirstIndex,
      minIndex,
      maxIndex,
      bucketLastIndex,
      sampleXTransform,
      midY,
      amplitudeHeight,
      chartTop,
      chartBottom,
    );
  }
}

function appendOrderedRawSamplePathPoints(
  context: OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  firstIndex: number,
  minIndex: number,
  maxIndex: number,
  lastIndex: number,
  sampleXTransform: SampleXTransform,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
): void {
  let a = firstIndex;
  let b = minIndex;
  let c = maxIndex;
  let d = lastIndex;
  let swap = 0;

  if (a > b) {
    swap = a;
    a = b;
    b = swap;
  }
  if (c > d) {
    swap = c;
    c = d;
    d = swap;
  }
  if (a > c) {
    swap = a;
    a = c;
    c = swap;
  }
  if (b > d) {
    swap = b;
    b = d;
    d = swap;
  }
  if (b > c) {
    swap = b;
    b = c;
    c = swap;
  }

  let previousIndex = -1;
  previousIndex = appendRawSamplePathPoint(
    context,
    samples,
    a,
    previousIndex,
    sampleXTransform,
    midY,
    amplitudeHeight,
    chartTop,
    chartBottom,
  );
  previousIndex = appendRawSamplePathPoint(
    context,
    samples,
    b,
    previousIndex,
    sampleXTransform,
    midY,
    amplitudeHeight,
    chartTop,
    chartBottom,
  );
  previousIndex = appendRawSamplePathPoint(
    context,
    samples,
    c,
    previousIndex,
    sampleXTransform,
    midY,
    amplitudeHeight,
    chartTop,
    chartBottom,
  );
  appendRawSamplePathPoint(
    context,
    samples,
    d,
    previousIndex,
    sampleXTransform,
    midY,
    amplitudeHeight,
    chartTop,
    chartBottom,
  );
}

function appendRawSamplePathPoint(
  context: OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  sampleIndex: number,
  previousIndex: number,
  sampleXTransform: SampleXTransform,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
): number {
  if (sampleIndex === previousIndex) {
    return previousIndex;
  }

  const x = getSampleX(sampleIndex, sampleXTransform);
  const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
  const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
  context.lineTo(x, y);
  return sampleIndex;
}

function fillRawDisplayBuckets(
  samples: Float32Array,
  bucketStartIndex: number,
  bucketEndIndex: number,
  bucketSize: number,
  firstIndices: Int32Array,
  minIndices: Int32Array,
  maxIndices: Int32Array,
  lastIndices: Int32Array,
  writeOffset: number,
): number {
  let writeIndex = writeOffset;
  const maxSampleIndex = Math.max(0, samples.length - 1);

  for (let bucketIndex = bucketStartIndex; bucketIndex < bucketEndIndex; bucketIndex += 1) {
    const safeStart = clamp(bucketIndex * bucketSize, 0, maxSampleIndex);
    const safeEndExclusive = clamp(safeStart + bucketSize, safeStart + 1, samples.length);
    let minIndex = safeStart;
    let maxIndex = safeStart;
    let minValue = clamp(samples[safeStart] ?? 0, -1, 1);
    let maxValue = minValue;

    for (let sampleIndex = safeStart + 1; sampleIndex < safeEndExclusive; sampleIndex += 1) {
      const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
      if (sampleValue < minValue) {
        minValue = sampleValue;
        minIndex = sampleIndex;
      }
      if (sampleValue > maxValue) {
        maxValue = sampleValue;
        maxIndex = sampleIndex;
      }
    }

    firstIndices[writeIndex] = safeStart;
    minIndices[writeIndex] = minIndex;
    maxIndices[writeIndex] = maxIndex;
    lastIndices[writeIndex] = safeEndExclusive - 1;
    writeIndex += 1;
  }

  return writeIndex - writeOffset;
}

function copyRawDisplayCacheWindow(
  rawDisplayCache: RawDisplayCache,
  firstIndices: Int32Array,
  minIndices: Int32Array,
  maxIndices: Int32Array,
  lastIndices: Int32Array,
  sourceOffset: number,
  targetOffset: number,
  count: number,
): void {
  if (count <= 0) {
    return;
  }

  const sourceEnd = sourceOffset + count;
  copyRawDisplayIndexWindow(rawDisplayCache.firstIndices, firstIndices, sourceOffset, targetOffset, sourceEnd);
  copyRawDisplayIndexWindow(rawDisplayCache.minIndices, minIndices, sourceOffset, targetOffset, sourceEnd);
  copyRawDisplayIndexWindow(rawDisplayCache.maxIndices, maxIndices, sourceOffset, targetOffset, sourceEnd);
  copyRawDisplayIndexWindow(rawDisplayCache.lastIndices, lastIndices, sourceOffset, targetOffset, sourceEnd);
}

function copyRawDisplayIndexWindow(
  sourceIndices: Int32Array,
  targetIndices: Int32Array,
  sourceOffset: number,
  targetOffset: number,
  sourceEnd: number,
): void {
  if (sourceIndices === targetIndices) {
    targetIndices.copyWithin(targetOffset, sourceOffset, sourceEnd);
  } else {
    targetIndices.set(sourceIndices.subarray(sourceOffset, sourceEnd), targetOffset);
  }
}

function drawWaveformReferenceGuides(
  context: OffscreenCanvasRenderingContext2D,
  deviceWidth: number,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
  renderScale: number,
): void {
  const guideThickness = Math.max(1, renderScale);
  const clippingTop = clamp(Math.round(midY - amplitudeHeight), chartTop, chartBottom);
  const clippingBottom = clamp(Math.round(midY + amplitudeHeight), chartTop, chartBottom);

  context.fillStyle = `rgba(255, 255, 255, ${CLIPPING_GUIDE_ALPHA})`;
  context.fillRect(0, clippingTop, deviceWidth, guideThickness);
  context.fillRect(0, clippingBottom, deviceWidth, guideThickness);

  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, guideThickness);
}

export function getRepresentativeSampleCacheMeta(
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
): RepresentativeSampleCacheMeta {
  const bucketSize = quantizeRepresentativeBucketSize(visibleSampleCount, drawColumns);
  const bucketStartIndex = Math.floor(sampleStartFrame / bucketSize);
  const bucketEndIndex = Math.ceil((sampleStartFrame + visibleSampleCount) / bucketSize);

  return {
    bucketCount: Math.max(0, bucketEndIndex - bucketStartIndex),
    bucketEndIndex,
    bucketSize,
    bucketStartIndex,
  };
}

export function getRawDisplayCacheCapacity(
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
): number {
  const { bucketCount } = getRawDisplayCacheMeta(sampleStartFrame, visibleSampleCount, drawColumns);
  return Math.max(1, bucketCount);
}

export function getRawDisplayCacheMeta(
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
): RawDisplayCacheMeta {
  const bucketSize = Math.max(1, Math.ceil(visibleSampleCount / Math.max(1, drawColumns)));
  const bucketStartIndex = Math.floor(sampleStartFrame / bucketSize);
  const bucketEndIndex = Math.ceil((sampleStartFrame + visibleSampleCount) / bucketSize);

  return {
    bucketCount: Math.max(0, bucketEndIndex - bucketStartIndex),
    bucketEndIndex,
    bucketSize,
    bucketStartIndex,
  };
}

export function fillRawDisplayCache(
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
  firstIndices: Int32Array,
  minIndices: Int32Array,
  maxIndices: Int32Array,
  lastIndices: Int32Array,
): RawDisplayCache {
  const meta = getRawDisplayCacheMeta(sampleStartFrame, visibleSampleCount, drawColumns);

  if (
    firstIndices.length < meta.bucketCount
    || minIndices.length < meta.bucketCount
    || maxIndices.length < meta.bucketCount
    || lastIndices.length < meta.bucketCount
  ) {
    throw new Error('Raw display cache capacity is insufficient.');
  }

  const bucketCount = fillRawDisplayBuckets(
    samples,
    meta.bucketStartIndex,
    meta.bucketEndIndex,
    meta.bucketSize,
    firstIndices,
    minIndices,
    maxIndices,
    lastIndices,
    0,
  );

  return {
    bucketCount,
    bucketSize: meta.bucketSize,
    bucketStartIndex: meta.bucketStartIndex,
    firstIndices,
    lastIndices,
    maxIndices,
    minIndices,
  };
}

export function fillRawDisplayCacheWithReuse(
  samples: Float32Array,
  sampleStartFrame: number,
  visibleSampleCount: number,
  drawColumns: number,
  firstIndices: Int32Array,
  minIndices: Int32Array,
  maxIndices: Int32Array,
  lastIndices: Int32Array,
  previousCache: RawDisplayCache | null = null,
): RawDisplayCache {
  const meta = getRawDisplayCacheMeta(sampleStartFrame, visibleSampleCount, drawColumns);

  if (
    firstIndices.length < meta.bucketCount
    || minIndices.length < meta.bucketCount
    || maxIndices.length < meta.bucketCount
    || lastIndices.length < meta.bucketCount
  ) {
    throw new Error('Raw display cache capacity is insufficient.');
  }

  if (!previousCache || previousCache.bucketSize !== meta.bucketSize || previousCache.bucketCount <= 0) {
    return fillRawDisplayCache(
      samples,
      sampleStartFrame,
      visibleSampleCount,
      drawColumns,
      firstIndices,
      minIndices,
      maxIndices,
      lastIndices,
    );
  }

  const previousEndIndex = previousCache.bucketStartIndex + previousCache.bucketCount;
  const overlapStartIndex = Math.max(meta.bucketStartIndex, previousCache.bucketStartIndex);
  const overlapEndIndex = Math.min(meta.bucketEndIndex, previousEndIndex);

  if (overlapEndIndex <= overlapStartIndex) {
    return fillRawDisplayCache(
      samples,
      sampleStartFrame,
      visibleSampleCount,
      drawColumns,
      firstIndices,
      minIndices,
      maxIndices,
      lastIndices,
    );
  }

  const overlapCount = overlapEndIndex - overlapStartIndex;
  const sourceOffset = overlapStartIndex - previousCache.bucketStartIndex;
  const targetOffset = overlapStartIndex - meta.bucketStartIndex;
  copyRawDisplayCacheWindow(
    previousCache,
    firstIndices,
    minIndices,
    maxIndices,
    lastIndices,
    sourceOffset,
    targetOffset,
    overlapCount,
  );

  fillRawDisplayBuckets(
    samples,
    meta.bucketStartIndex,
    overlapStartIndex,
    meta.bucketSize,
    firstIndices,
    minIndices,
    maxIndices,
    lastIndices,
    0,
  );
  fillRawDisplayBuckets(
    samples,
    overlapEndIndex,
    meta.bucketEndIndex,
    meta.bucketSize,
    firstIndices,
    minIndices,
    maxIndices,
    lastIndices,
    targetOffset + overlapCount,
  );

  return {
    bucketCount: meta.bucketCount,
    bucketSize: meta.bucketSize,
    bucketStartIndex: meta.bucketStartIndex,
    firstIndices,
    lastIndices,
    maxIndices,
    minIndices,
  };
}

function quantizeRepresentativeBucketSize(visibleSampleCount: number, drawColumns: number): number {
  const idealBucketSize = Math.max(1, visibleSampleCount / Math.max(1, drawColumns));
  if (idealBucketSize <= 1) {
    return 1;
  }

  // Snap to stable bucket sizes so representative samples do not jump on every zoom delta.
  return Math.max(1, 2 ** Math.ceil(Math.log2(idealBucketSize)));
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

function fillRepresentativeSampleBuckets(
  samples: Float32Array,
  bucketStartIndex: number,
  bucketEndIndex: number,
  bucketSize: number,
  sampleIndices: Int32Array,
  sampleValues: Float32Array,
  writeOffset: number,
): number {
  let writeIndex = writeOffset;

  for (let bucketIndex = bucketStartIndex; bucketIndex < bucketEndIndex; bucketIndex += 1) {
    const samplePoint = pickRepresentativeSamplePoint(
      samples,
      bucketIndex * bucketSize,
      bucketIndex * bucketSize + bucketSize,
    );
    if (!samplePoint) {
      continue;
    }

    sampleIndices[writeIndex] = samplePoint.sampleIndex;
    sampleValues[writeIndex] = samplePoint.sampleValue;
    writeIndex += 1;
  }

  return writeIndex - writeOffset;
}

function copyRepresentativeCacheWindow(
  representativeCache: RepresentativeSampleCache,
  sampleIndices: Int32Array,
  sampleValues: Float32Array,
  sourceOffset: number,
  targetOffset: number,
  count: number,
): void {
  if (count <= 0) {
    return;
  }

  const sourceEnd = sourceOffset + count;
  if (representativeCache.sampleIndices === sampleIndices) {
    sampleIndices.copyWithin(targetOffset, sourceOffset, sourceEnd);
  } else {
    sampleIndices.set(representativeCache.sampleIndices.subarray(sourceOffset, sourceEnd), targetOffset);
  }

  if (representativeCache.sampleValues === sampleValues) {
    sampleValues.copyWithin(targetOffset, sourceOffset, sourceEnd);
  } else {
    sampleValues.set(representativeCache.sampleValues.subarray(sourceOffset, sourceEnd), targetOffset);
  }
}

function collectRepresentativeDrawPoints(
  representativeCache: RepresentativeSampleCache,
  sampleXTransform: SampleXTransform,
  startValue: number,
  endValue: number,
): RepresentativeDrawPointBuffer {
  const xPositions = new Float32Array(representativeCache.bucketCount + 2);
  const sampleValues = new Float32Array(representativeCache.bucketCount + 2);
  let hasPendingPoint = false;
  let pendingX = 0;
  let pendingValue = 0;
  let pointCount = 0;

  const flushPendingPoint = (): void => {
    if (!hasPendingPoint) {
      return;
    }

    xPositions[pointCount] = pendingX;
    sampleValues[pointCount] = pendingValue;
    pointCount += 1;
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

  return {
    count: pointCount,
    sampleValues,
    xPositions,
  };
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

function smoothStep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
