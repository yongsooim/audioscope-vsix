import {
  WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
  WAVEFORM_BOTTOM_PADDING_PX,
  WAVEFORM_TOP_PADDING_PX,
} from '../interactive-waveform/geometry';

const CENTER_LINE_ALPHA = 0.14;
const CLIPPING_GUIDE_ALPHA = 0.08;
const RAW_SAMPLE_MARKER_FADE_IN_END_CSS_PIXELS_PER_SAMPLE = 7.5;
const RAW_SAMPLE_MARKER_FADE_IN_START_CSS_PIXELS_PER_SAMPLE = 4.5;
const RAW_SAMPLE_MARKER_FILL = 'rgba(166, 217, 234, 0.94)';
const RAW_SAMPLE_MARKER_OUTLINE = 'rgba(20, 56, 86, 0.88)';
const RAW_SAMPLE_MARKER_OUTLINE_WIDTH_CSS_PX = 1;
const RAW_SAMPLE_MARKER_RADIUS_CSS_PX = 2.15;
const STABLE_WAVEFORM_PATH_MIN_LINE_WIDTH_SCALE = 0.82;
const SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;

export const RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL = 4;

interface SampleXTransform {
  maxX: number;
  xOffset: number;
  xScale: number;
}

interface WaveformPathPlotRenderOptions {
  alpha?: number;
  preserveExistingSurface?: boolean;
  sampleData?: Float32Array | null;
  stableColumnSlotBlend?: number;
}

export function drawWaveformPathPlot(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  pathPoints: Float32Array,
  color: string,
  pixelsPerSample: number,
  sampleStartFrame: number,
  visibleSampleSpan: number,
  heightCssPx: number,
  renderScale: number,
  options: WaveformPathPlotRenderOptions = {},
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
  const alpha = clamp01(options.alpha ?? 1);
  const stableColumnSlotBlend = clamp01(options.stableColumnSlotBlend ?? 0);

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
  context.lineWidth = Math.max(
    1,
    renderScale
      * SAMPLE_PLOT_LINE_WIDTH_SCALE
      * lerp(1, STABLE_WAVEFORM_PATH_MIN_LINE_WIDTH_SCALE, stableColumnSlotBlend),
  );
  context.lineJoin = 'round';
  context.lineCap = 'round';

  if (!traceWaveformPath(
    context,
    pathPoints,
    sampleStartFrame,
    sampleXTransform,
    midY,
    amplitudeHeight,
    chartTop,
    chartBottom,
    stableColumnSlotBlend,
  )) {
    context.restore();
    return;
  }

  context.stroke();

  const markerAlpha = getRawSampleMarkerAlpha(pixelsPerSample, renderScale);
  if (options.sampleData instanceof Float32Array && markerAlpha > 0) {
    drawRawSampleMarkers(
      context,
      options.sampleData,
      sampleStartFrame,
      visibleSampleSpan,
      sampleXTransform,
      midY,
      amplitudeHeight,
      chartTop,
      chartBottom,
      renderScale,
      markerAlpha,
    );
  }

  context.restore();
}

function traceWaveformPath(
  context: OffscreenCanvasRenderingContext2D,
  pathPoints: Float32Array,
  sampleStartFrame: number,
  sampleXTransform: SampleXTransform,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
  stableColumnSlotBlend = 0,
): boolean {
  let previousOffset = Number.NEGATIVE_INFINITY;
  let started = false;

  context.beginPath();
  for (let pointIndex = 0; pointIndex + 1 < pathPoints.length; pointIndex += 2) {
    const pointOrdinal = Math.floor(pointIndex / 2);
    const sampleOffset = Number(pathPoints[pointIndex]);
    if (!(sampleOffset >= 0) || sampleOffset === previousOffset) {
      continue;
    }

    const samplePosition = sampleStartFrame + sampleOffset;
    const sampleValue = clamp(pathPoints[pointIndex + 1] ?? 0, -1, 1);
    const sampleX = getSampleX(samplePosition, sampleXTransform);
    const stableX = getStableWaveformPathX(pointOrdinal, sampleXTransform.maxX);
    const x = lerp(sampleX, stableX, stableColumnSlotBlend);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);

    if (!started) {
      context.moveTo(x, y);
      started = true;
    } else {
      context.lineTo(x, y);
    }

    previousOffset = sampleOffset;
  }

  return started;
}

function getStableWaveformPathX(pointOrdinal: number, maxX: number): number {
  if (maxX <= 0) {
    return 0;
  }

  const columnIndex = Math.floor(pointOrdinal / 4);
  const pointSlot = pointOrdinal % 4;
  const slotOffset = pointSlot === 0
    ? 0
    : pointSlot === 1
      ? 1 / 3
      : pointSlot === 2
        ? 2 / 3
        : 1;
  return clamp(columnIndex + slotOffset, 0, maxX);
}

function lerp(start: number, end: number, amount: number): number {
  return start + ((end - start) * clamp01(amount));
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
  markerAlpha: number,
): void {
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartFrame));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartFrame + visibleSampleSpan));
  if (lastSampleIndex < firstSampleIndex) {
    return;
  }

  const radius = Math.max(1, RAW_SAMPLE_MARKER_RADIUS_CSS_PX * renderScale);
  context.save();
  context.globalAlpha *= markerAlpha;
  context.fillStyle = RAW_SAMPLE_MARKER_FILL;
  context.strokeStyle = RAW_SAMPLE_MARKER_OUTLINE;
  context.lineWidth = Math.max(1, RAW_SAMPLE_MARKER_OUTLINE_WIDTH_CSS_PX * renderScale);
  context.beginPath();
  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getSampleX(sampleIndex, sampleXTransform);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.moveTo(x + radius, y);
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
  context.fill();
  context.stroke();
  context.restore();
}

function getRawSampleMarkerAlpha(pixelsPerSample: number, renderScale: number): number {
  const cssPixelsPerSample = pixelsPerSample / Math.max(1, renderScale);
  const fadeRange = RAW_SAMPLE_MARKER_FADE_IN_END_CSS_PIXELS_PER_SAMPLE - RAW_SAMPLE_MARKER_FADE_IN_START_CSS_PIXELS_PER_SAMPLE;
  if (!(fadeRange > 0)) {
    return cssPixelsPerSample >= RAW_SAMPLE_MARKER_FADE_IN_END_CSS_PIXELS_PER_SAMPLE ? 1 : 0;
  }

  return clamp01((cssPixelsPerSample - RAW_SAMPLE_MARKER_FADE_IN_START_CSS_PIXELS_PER_SAMPLE) / fadeRange);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}
