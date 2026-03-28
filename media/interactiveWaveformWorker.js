"use strict";
(() => {
  // src-webview/interactiveWaveformRenderer.js
  var MIN_LEVEL_BLOCK_SIZE = 16;
  var LEVEL_SCALE_FACTOR = 4;
  var MIN_LEVEL_BUCKETS = 512;
  var TOP_PADDING = 10;
  var BOTTOM_PADDING = 10;
  var SYMMETRIC_ENVELOPE_GAIN = 0.76;
  var CENTER_LINE_ALPHA = 0.14;
  var LINE_BLEND_START_SAMPLES_PER_PIXEL = 6;
  var LINE_BLEND_END_SAMPLES_PER_PIXEL = 1;
  var SYMMETRIC_BLEND_START_SAMPLES_PER_PIXEL = 12;
  var SYMMETRIC_BLEND_END_SAMPLES_PER_PIXEL = 2;
  function createInteractiveWaveformData(samples, levels = []) {
    return { samples, levels };
  }
  function getInteractiveWaveformBlockSizes(sampleCount) {
    const blockSizes = [];
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
  function buildInteractiveWaveformLevel(samples, blockSize) {
    return buildPeakLevel(samples, blockSize);
  }
  function resizeInteractiveWaveformSurface(surface, width2, height2, renderScale2) {
    surface.width = Math.max(1, Math.round(width2 * renderScale2));
    surface.height = Math.max(1, Math.round(height2 * renderScale2));
  }
  function renderInteractiveWaveform(ctx, width2, height2, renderScale2, duration2, viewStart2, viewEnd2, color2, waveformData2) {
    const deviceWidth = Math.max(1, Math.round(width2 * renderScale2));
    const deviceHeight = Math.max(1, Math.round(height2 * renderScale2));
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, deviceWidth, deviceHeight);
    if (!waveformData2 || duration2 <= 0 || viewEnd2 <= viewStart2 || width2 <= 0 || height2 <= 0) {
      return;
    }
    const clampedStart = clamp(viewStart2, 0, duration2);
    const clampedEnd = clamp(viewEnd2, clampedStart + 1e-4, duration2);
    const sampleCount = waveformData2.samples.length;
    if (sampleCount <= 0) {
      return;
    }
    const startSample = Math.floor(clampedStart / duration2 * sampleCount);
    const endSample = Math.ceil(clampedEnd / duration2 * sampleCount);
    const visibleSamples = Math.max(1, endSample - startSample);
    const columnCount = deviceWidth;
    const samplesPerColumn = Math.max(1, visibleSamples / columnCount);
    const selectedLevel = pickLevel(waveformData2.levels, samplesPerColumn);
    const chartTop = Math.round(TOP_PADDING * renderScale2);
    const chartBottom = Math.max(chartTop + 1, Math.round((height2 - BOTTOM_PADDING) * renderScale2));
    const chartHeight = Math.max(1, chartBottom - chartTop);
    const midY = chartTop + chartHeight * 0.5;
    const lineBlend = 1 - smoothStep(
      LINE_BLEND_END_SAMPLES_PER_PIXEL,
      LINE_BLEND_START_SAMPLES_PER_PIXEL,
      samplesPerColumn
    );
    const symmetricBlend = smoothStep(
      SYMMETRIC_BLEND_END_SAMPLES_PER_PIXEL,
      SYMMETRIC_BLEND_START_SAMPLES_PER_PIXEL,
      samplesPerColumn
    );
    const amplitudeHeight = chartHeight * lerp(0.48, 0.38, symmetricBlend);
    ctx.fillStyle = color2;
    ctx.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
    ctx.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale2));
    ctx.fillStyle = color2;
    ctx.globalAlpha = lerp(1, 0.42, lineBlend);
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const columnStartSample = Math.floor(startSample + columnIndex / columnCount * visibleSamples);
      const columnEndSample = Math.ceil(startSample + (columnIndex + 1) / columnCount * visibleSamples);
      const range = selectedLevel ? getLevelRange(selectedLevel, columnStartSample, columnEndSample) : getSampleRange(waveformData2.samples, columnStartSample, columnEndSample);
      const symmetricPeak = Math.max(Math.abs(range.min), Math.abs(range.max)) * SYMMETRIC_ENVELOPE_GAIN;
      const signedTop = midY - range.max * amplitudeHeight;
      const signedBottom = midY - range.min * amplitudeHeight;
      const symmetricTop = midY - symmetricPeak * amplitudeHeight;
      const symmetricBottom = midY + symmetricPeak * amplitudeHeight;
      const top = clamp(
        Math.round(lerp(signedTop, symmetricTop, symmetricBlend)),
        chartTop,
        chartBottom
      );
      const bottom = clamp(
        Math.round(lerp(signedBottom, symmetricBottom, symmetricBlend)),
        chartTop,
        chartBottom
      );
      const y = Math.min(top, bottom);
      const barHeight = Math.max(1, Math.abs(bottom - top));
      ctx.fillRect(columnIndex, y, 1, barHeight);
    }
    if (lineBlend > 1e-3) {
      renderWaveformLine({
        ctx,
        width: columnCount,
        sampleCount,
        startSample,
        visibleSamples,
        midY,
        amplitudeHeight: chartHeight * 0.48,
        samples: waveformData2.samples,
        color: color2,
        alpha: lineBlend
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
        const value = samples[sampleIndex] ?? 0;
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
  function getLevelRange(level, startSample, endSample) {
    const startBlock = Math.max(0, Math.floor(startSample / level.blockSize));
    const endBlock = Math.min(level.maxPeaks.length, Math.ceil(endSample / level.blockSize));
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
    let min = 1;
    let max = -1;
    for (let sampleIndex = Math.max(0, startSample); sampleIndex < Math.min(samples.length, endSample); sampleIndex += 1) {
      const value = samples[sampleIndex] ?? 0;
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
    width: width2,
    sampleCount,
    startSample,
    visibleSamples,
    midY,
    amplitudeHeight,
    samples,
    color: color2,
    alpha
  }) {
    const maxSampleIndex = Math.max(0, sampleCount - 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color2;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let x = 0; x < width2; x += 1) {
      const ratio = width2 <= 1 ? 0 : x / (width2 - 1);
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
    const a = samples[index] ?? 0;
    const b = samples[nextIndex] ?? 0;
    return a + (b - a) * fraction;
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

  // src-webview/interactiveWaveformWorker.js
  var canvas = null;
  var context = null;
  var waveformData = null;
  var width = 0;
  var height = 0;
  var renderScale = 2;
  var duration = 0;
  var viewStart = 0;
  var viewEnd = 0;
  var color = "#3b82f6";
  var renderQueued = false;
  var waveformLoadGeneration = 0;
  self.onmessage = (event) => {
    const { type, payload } = event.data ?? {};
    switch (type) {
      case "init": {
        canvas = payload?.offscreenCanvas ?? null;
        width = payload?.width ?? width;
        height = payload?.height ?? height;
        renderScale = payload?.renderScale ?? renderScale;
        duration = payload?.duration ?? duration;
        viewStart = payload?.viewStart ?? viewStart;
        viewEnd = payload?.viewEnd ?? viewEnd;
        color = payload?.color ?? color;
        if (canvas) {
          resizeInteractiveWaveformSurface(canvas, width, height, renderScale);
          context = canvas.getContext("2d");
        }
        queueRender();
        break;
      }
      case "setData": {
        const samplesBuffer = payload?.samplesBuffer;
        waveformLoadGeneration += 1;
        const currentGeneration = waveformLoadGeneration;
        duration = payload?.duration ?? duration;
        if (!samplesBuffer) {
          waveformData = null;
          queueRender();
          break;
        }
        const samples = new Float32Array(samplesBuffer);
        waveformData = createInteractiveWaveformData(samples, []);
        queueRender();
        void buildLevelsProgressively(currentGeneration, samples);
        break;
      }
      case "updateView": {
        width = payload?.width ?? width;
        height = payload?.height ?? height;
        renderScale = payload?.renderScale ?? renderScale;
        duration = payload?.duration ?? duration;
        viewStart = payload?.viewStart ?? viewStart;
        viewEnd = payload?.viewEnd ?? viewEnd;
        color = payload?.color ?? color;
        if (canvas) {
          resizeInteractiveWaveformSurface(canvas, width, height, renderScale);
        }
        queueRender();
        break;
      }
      case "clear": {
        waveformLoadGeneration += 1;
        waveformData = null;
        queueRender();
        break;
      }
      case "stop": {
        waveformLoadGeneration += 1;
        renderQueued = false;
        waveformData = null;
        context = null;
        canvas = null;
        break;
      }
    }
  };
  function queueRender() {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    if (typeof self.requestAnimationFrame === "function") {
      self.requestAnimationFrame(drawFrame);
      return;
    }
    setTimeout(drawFrame, 16);
  }
  function drawFrame() {
    renderQueued = false;
    if (!context) {
      return;
    }
    renderInteractiveWaveform(
      context,
      width,
      height,
      renderScale,
      duration,
      viewStart,
      viewEnd,
      color,
      waveformData
    );
  }
  async function buildLevelsProgressively(generation, samples) {
    const blockSizes = getInteractiveWaveformBlockSizes(samples.length);
    if (!waveformData || generation !== waveformLoadGeneration) {
      return;
    }
    const descendingBlockSizes = blockSizes.slice().reverse();
    for (let index = 0; index < descendingBlockSizes.length; index += 1) {
      if (generation !== waveformLoadGeneration || !waveformData) {
        return;
      }
      const blockSize = descendingBlockSizes[index];
      const level = buildInteractiveWaveformLevel(samples, blockSize);
      insertLevelSorted(waveformData.levels, level);
      queueRender();
      self.postMessage({
        type: "waveformProgress",
        payload: {
          progress: (index + 1) / descendingBlockSizes.length
        }
      });
      await yieldToWorker();
    }
    if (generation !== waveformLoadGeneration) {
      return;
    }
    self.postMessage({
      type: "waveformReady"
    });
  }
  function insertLevelSorted(levels, level) {
    const existingIndex = levels.findIndex((entry) => entry.blockSize === level.blockSize);
    if (existingIndex >= 0) {
      levels[existingIndex] = level;
    } else {
      levels.push(level);
      levels.sort((left, right) => left.blockSize - right.blockSize);
    }
  }
  function yieldToWorker() {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
})();
