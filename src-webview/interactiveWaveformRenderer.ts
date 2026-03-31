const MIN_LEVEL_BLOCK_SIZE = 16;
const LEVEL_SCALE_FACTOR = 4;
const MIN_LEVEL_BUCKETS = 512;
const TOP_PADDING = 10;
const BOTTOM_PADDING = 10;
const SYMMETRIC_ENVELOPE_GAIN = 0.76;
const CENTER_LINE_ALPHA = 0.14;
const LINE_BLEND_START_SAMPLES_PER_PIXEL = 6;
const LINE_BLEND_END_SAMPLES_PER_PIXEL = 1;
const SYMMETRIC_BLEND_START_SAMPLES_PER_PIXEL = 12;
const SYMMETRIC_BLEND_END_SAMPLES_PER_PIXEL = 2;

interface WaveformLevel {
  blockSize: number;
  maxPeaks: Float32Array;
  minPeaks: Float32Array;
}

export interface InteractiveWaveformData {
  levels: WaveformLevel[];
  sampleCount: number;
  samples: Float32Array | null;
}

interface InteractiveWaveformSampleOptions {
  copy?: boolean;
}

export function buildInteractiveWaveformData(
  channelData: ArrayLike<number>,
  options: InteractiveWaveformSampleOptions = {},
): InteractiveWaveformData {
  const samples = normalizeInteractiveWaveformSamples(channelData, options);
  const levels: WaveformLevel[] = [];
  let previousLevel: WaveformLevel | null = null;

  for (const blockSize of getInteractiveWaveformBlockSizes(samples.length)) {
    const level = previousLevel && blockSize === previousLevel.blockSize * LEVEL_SCALE_FACTOR
      ? buildPeakLevelFromPrevious(previousLevel)
      : buildInteractiveWaveformLevel(samples, blockSize);
    levels.push(level);
    previousLevel = level;
  }

  return { sampleCount: samples.length, samples, levels };
}

export function normalizeInteractiveWaveformSamples(
  channelData: ArrayLike<number>,
  options: InteractiveWaveformSampleOptions = {},
): Float32Array {
  const shouldCopy = options?.copy !== false || !(channelData instanceof Float32Array);

  if (!shouldCopy) {
    return channelData;
  }

  const sampleCount = channelData.length;
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = clamp(channelData[index] ?? 0, -1, 1);
  }

  return samples;
}

export function createInteractiveWaveformData(
  samples: Float32Array | null,
  levels: WaveformLevel[] = [],
): InteractiveWaveformData {
  return {
    sampleCount: samples instanceof Float32Array ? samples.length : 0,
    samples: samples instanceof Float32Array ? samples : null,
    levels: Array.isArray(levels) ? levels : [],
  };
}

export function getInteractiveWaveformBlockSizes(sampleCount: number): number[] {
  const blockSizes: number[] = [];
  let blockSize = MIN_LEVEL_BLOCK_SIZE;

  while (blockSize < sampleCount) {
    blockSizes.push(blockSize);

    const nextBlockSize = blockSize * LEVEL_SCALE_FACTOR;
    if (Math.ceil(sampleCount / blockSize) <= MIN_LEVEL_BUCKETS) {
      break;
    }

    blockSize = nextBlockSize;
  }

  return blockSizes;
}

export function buildInteractiveWaveformLevel(samples: Float32Array, blockSize: number): WaveformLevel {
  return buildPeakLevel(samples, blockSize);
}

export function extractInteractiveWaveformSlice(
  waveformData: InteractiveWaveformData | null,
  duration: number,
  viewStart: number,
  viewEnd: number,
  columnCount: number,
  output: Float32Array | null = null,
): Float32Array {
  const safeColumnCount = Math.max(1, Math.round(columnCount || 0));
  const target = output instanceof Float32Array && output.length >= safeColumnCount * 2
    ? output
    : new Float32Array(safeColumnCount * 2);

  if (!waveformData || duration <= 0 || viewEnd <= viewStart || safeColumnCount <= 0) {
    target.fill(0, 0, safeColumnCount * 2);
    return target;
  }

  const clampedStart = clamp(viewStart, 0, duration);
  const clampedEnd = clamp(viewEnd, clampedStart + 1e-4, duration);
  const sampleCount = getWaveformDataSampleCount(waveformData);
  const samples = getWaveformDataSamples(waveformData);
  const levels = Array.isArray(waveformData.levels) ? waveformData.levels : [];

  if (sampleCount <= 0) {
    target.fill(0, 0, safeColumnCount * 2);
    return target;
  }

  const startSample = Math.floor((clampedStart / duration) * sampleCount);
  const endSample = Math.ceil((clampedEnd / duration) * sampleCount);
  const visibleSamples = Math.max(1, endSample - startSample);
  const samplesPerColumn = Math.max(1, visibleSamples / safeColumnCount);
  const selectedLevel = pickLevel(levels, samplesPerColumn) ?? levels[0] ?? null;

  for (let columnIndex = 0; columnIndex < safeColumnCount; columnIndex += 1) {
    const columnStartSample = Math.floor(startSample + (columnIndex / safeColumnCount) * visibleSamples);
    const columnEndSample = Math.ceil(startSample + ((columnIndex + 1) / safeColumnCount) * visibleSamples);
    const range = selectedLevel
      ? getLevelRange(selectedLevel, columnStartSample, columnEndSample)
      : samples
        ? getSampleRange(samples, columnStartSample, columnEndSample)
        : { min: 0, max: 0 };
    const targetIndex = columnIndex * 2;
    target[targetIndex] = Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max
      ? range.min
      : 0;
    target[targetIndex + 1] = Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max
      ? range.max
      : 0;
  }

  return target;
}

export function resizeInteractiveWaveformSurface(
  surface: OffscreenCanvas,
  width: number,
  height: number,
  renderScale: number,
): boolean {
  const nextWidth = Math.max(1, Math.round(width * renderScale));
  const nextHeight = Math.max(1, Math.round(height * renderScale));
  const changed = surface.width !== nextWidth || surface.height !== nextHeight;

  if (!changed) {
    return false;
  }

  surface.width = nextWidth;
  surface.height = nextHeight;
  return true;
}

export function renderInteractiveWaveform(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  renderScale: number,
  duration: number,
  viewStart: number,
  viewEnd: number,
  color: string,
  waveformData: InteractiveWaveformData | null,
): void {
  const deviceWidth = Math.max(1, Math.round(width * renderScale));
  const deviceHeight = Math.max(1, Math.round(height * renderScale));

  ctx.imageSmoothingEnabled = true;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, deviceWidth, deviceHeight);

  if (!waveformData || duration <= 0 || viewEnd <= viewStart || width <= 0 || height <= 0) {
    return;
  }

  const clampedStart = clamp(viewStart, 0, duration);
  const clampedEnd = clamp(viewEnd, clampedStart + 1e-4, duration);
  const sampleCount = getWaveformDataSampleCount(waveformData);
  const samples = getWaveformDataSamples(waveformData);
  const levels = Array.isArray(waveformData.levels) ? waveformData.levels : [];

  if (sampleCount <= 0) {
    return;
  }

  const startSample = Math.floor((clampedStart / duration) * sampleCount);
  const endSample = Math.ceil((clampedEnd / duration) * sampleCount);
  const visibleSamples = Math.max(1, endSample - startSample);
  const columnCount = deviceWidth;
  const samplesPerColumn = Math.max(1, visibleSamples / columnCount);
  const selectedLevel = pickLevel(levels, samplesPerColumn) ?? levels[0] ?? null;
  const chartTop = Math.round(TOP_PADDING * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((height - BOTTOM_PADDING) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const lineBlend = 1 - smoothStep(
    LINE_BLEND_END_SAMPLES_PER_PIXEL,
    LINE_BLEND_START_SAMPLES_PER_PIXEL,
    samplesPerColumn,
  );
  const symmetricBlend = smoothStep(
    SYMMETRIC_BLEND_END_SAMPLES_PER_PIXEL,
    SYMMETRIC_BLEND_START_SAMPLES_PER_PIXEL,
    samplesPerColumn,
  );
  const amplitudeHeight = chartHeight * lerp(0.48, 0.38, symmetricBlend);

  ctx.fillStyle = color;
  ctx.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  ctx.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  ctx.fillStyle = color;
  ctx.globalAlpha = lerp(1, 0.42, lineBlend);

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const columnStartSample = Math.floor(startSample + (columnIndex / columnCount) * visibleSamples);
    const columnEndSample = Math.ceil(startSample + ((columnIndex + 1) / columnCount) * visibleSamples);
    const range = selectedLevel
      ? getLevelRange(selectedLevel, columnStartSample, columnEndSample)
      : samples
        ? getSampleRange(samples, columnStartSample, columnEndSample)
        : { min: 0, max: 0 };
    const symmetricPeak = Math.max(Math.abs(range.min), Math.abs(range.max)) * SYMMETRIC_ENVELOPE_GAIN;
    const signedTop = midY - range.max * amplitudeHeight;
    const signedBottom = midY - range.min * amplitudeHeight;
    const symmetricTop = midY - symmetricPeak * amplitudeHeight;
    const symmetricBottom = midY + symmetricPeak * amplitudeHeight;
    const top = clamp(
      Math.round(lerp(signedTop, symmetricTop, symmetricBlend)),
      chartTop,
      chartBottom,
    );
    const bottom = clamp(
      Math.round(lerp(signedBottom, symmetricBottom, symmetricBlend)),
      chartTop,
      chartBottom,
    );
    const y = Math.min(top, bottom);
    const barHeight = Math.max(1, Math.abs(bottom - top));
    ctx.fillRect(columnIndex, y, 1, barHeight);
  }

  if (lineBlend > 0.001 && samples instanceof Float32Array) {
    renderWaveformLine({
      ctx,
      width: columnCount,
      sampleCount,
      startSample,
      visibleSamples,
      midY,
      amplitudeHeight: chartHeight * 0.48,
      samples,
      color,
      alpha: lineBlend,
    });
  }

  ctx.globalAlpha = 1;
}

function buildPeakLevel(samples, blockSize) {
  const blockCount = Math.ceil(samples.length / blockSize);
  const minPeaks = new Float32Array(blockCount);
  const maxPeaks = new Float32Array(blockCount);

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const start = blockIndex * blockSize;
    const end = Math.min(samples.length, start + blockSize);
    let minPeak = 1;
    let maxPeak = -1;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const value = clamp(samples[sampleIndex] ?? 0, -1, 1);

      if (value < minPeak) {
        minPeak = value;
      }

      if (value > maxPeak) {
        maxPeak = value;
      }
    }

    minPeaks[blockIndex] = minPeak;
    maxPeaks[blockIndex] = maxPeak;
  }

  return { blockSize, minPeaks, maxPeaks };
}

function buildPeakLevelFromPrevious(previousLevel) {
  const blockCount = Math.ceil(previousLevel.maxPeaks.length / LEVEL_SCALE_FACTOR);
  const minPeaks = new Float32Array(blockCount);
  const maxPeaks = new Float32Array(blockCount);

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const start = blockIndex * LEVEL_SCALE_FACTOR;
    const end = Math.min(previousLevel.maxPeaks.length, start + LEVEL_SCALE_FACTOR);
    let minPeak = 1;
    let maxPeak = -1;

    for (let peakIndex = start; peakIndex < end; peakIndex += 1) {
      const blockMin = previousLevel.minPeaks[peakIndex] ?? 0;
      const blockMax = previousLevel.maxPeaks[peakIndex] ?? 0;

      if (blockMin < minPeak) {
        minPeak = blockMin;
      }

      if (blockMax > maxPeak) {
        maxPeak = blockMax;
      }
    }

    minPeaks[blockIndex] = minPeak;
    maxPeaks[blockIndex] = maxPeak;
  }

  return {
    blockSize: previousLevel.blockSize * LEVEL_SCALE_FACTOR,
    minPeaks,
    maxPeaks,
  };
}

function getLevelRange(level, startSample, endSample) {
  const startBlock = Math.max(0, Math.floor(startSample / level.blockSize));
  const endBlock = Math.min(level.maxPeaks.length, Math.ceil(endSample / level.blockSize));

  if (endBlock <= startBlock) {
    return { min: 0, max: 0 };
  }

  let min = 1;
  let max = -1;

  for (let blockIndex = startBlock; blockIndex < endBlock; blockIndex += 1) {
    const blockMin = level.minPeaks[blockIndex] ?? 0;
    const blockMax = level.maxPeaks[blockIndex] ?? 0;

    if (blockMin < min) {
      min = blockMin;
    }

    if (blockMax > max) {
      max = blockMax;
    }
  }

  return { min, max };
}

function getSampleRange(samples, startSample, endSample) {
  const safeStart = Math.max(0, startSample);
  const safeEnd = Math.min(samples.length, endSample);

  if (safeEnd <= safeStart) {
    return { min: 0, max: 0 };
  }

  let min = 1;
  let max = -1;

  for (let sampleIndex = safeStart; sampleIndex < safeEnd; sampleIndex += 1) {
    const value = clamp(samples[sampleIndex] ?? 0, -1, 1);

    if (value < min) {
      min = value;
    }

    if (value > max) {
      max = value;
    }
  }

  return { min, max };
}

function pickLevel(levels, samplesPerPixel) {
  let selected = null;

  for (const level of levels) {
    if (level.blockSize <= samplesPerPixel * 1.5) {
      selected = level;
      continue;
    }

    break;
  }

  return selected;
}

function renderWaveformLine({
  ctx,
  width,
  sampleCount,
  startSample,
  visibleSamples,
  midY,
  amplitudeHeight,
  samples,
  color,
  alpha,
}) {
  const maxSampleIndex = Math.max(0, sampleCount - 1);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();

  for (let x = 0; x < width; x += 1) {
    const ratio = width <= 1 ? 0 : x / (width - 1);
    const samplePosition = clamp(startSample + ratio * Math.max(0, visibleSamples - 1), 0, maxSampleIndex);
    const value = getInterpolatedSample(samples, samplePosition);
    const drawY = midY - value * amplitudeHeight;

    if (x === 0) {
      ctx.moveTo(x, drawY);
    } else {
      ctx.lineTo(x, drawY);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function getInterpolatedSample(samples, position) {
  const index = Math.floor(position);
  const nextIndex = Math.min(samples.length - 1, index + 1);
  const fraction = position - index;
  const a = clamp(samples[index] ?? 0, -1, 1);
  const b = clamp(samples[nextIndex] ?? 0, -1, 1);

  return a + (b - a) * fraction;
}

function getWaveformDataSampleCount(waveformData) {
  if (!waveformData || typeof waveformData !== 'object') {
    return 0;
  }

  const explicitSampleCount = Number(waveformData.sampleCount);

  if (Number.isFinite(explicitSampleCount) && explicitSampleCount > 0) {
    return explicitSampleCount;
  }

  return waveformData.samples instanceof Float32Array ? waveformData.samples.length : 0;
}

function getWaveformDataSamples(waveformData) {
  return waveformData?.samples instanceof Float32Array ? waveformData.samples : null;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function smoothStep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
