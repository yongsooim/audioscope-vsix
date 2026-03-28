import {
  buildInteractiveWaveformLevel,
  createInteractiveWaveformData,
  getInteractiveWaveformBlockSizes,
  renderInteractiveWaveform,
  resizeInteractiveWaveformSurface,
} from './interactiveWaveformRenderer.js';

let canvas = null;
let context = null;
let waveformData = null;
let width = 0;
let height = 0;
let renderScale = 2;
let duration = 0;
let viewStart = 0;
let viewEnd = 0;
let color = '#3b82f6';
let renderQueued = false;
let waveformLoadGeneration = 0;

self.onmessage = (event) => {
  const { type, payload } = event.data ?? {};

  switch (type) {
    case 'init': {
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
        context = canvas.getContext('2d');
      }

      queueRender();
      break;
    }

    case 'setData': {
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

    case 'updateView': {
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

    case 'clear': {
      waveformLoadGeneration += 1;
      waveformData = null;
      queueRender();
      break;
    }

    case 'stop': {
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

  if (typeof self.requestAnimationFrame === 'function') {
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
    waveformData,
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
      type: 'waveformProgress',
      payload: {
        progress: (index + 1) / descendingBlockSizes.length,
      },
    });

    await yieldToWorker();
  }

  if (generation !== waveformLoadGeneration) {
    return;
  }

  self.postMessage({
    type: 'waveformReady',
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
