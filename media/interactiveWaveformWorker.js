// src-webview/sharedBuffers.js
var CONTROL_INDEX = {
  sessionVersion: 0,
  attached: 1,
  waveformSlotBase: 16,
  spectrogramSlotBase: 48
};
function readWaveformSlotSequence(controlView2, slotId) {
  return Atomics.load(controlView2, CONTROL_INDEX.waveformSlotBase + slotId);
}

// src-webview/interactiveWaveformWorker.js
var TOP_PADDING = 10;
var BOTTOM_PADDING = 10;
var CENTER_LINE_ALPHA = 0.14;
var SYMMETRIC_ENVELOPE_GAIN = 0.76;
var canvas = null;
var context = null;
var waveformSab = null;
var controlView = null;
var waveformMaxColumns = 0;
var width = 0;
var height = 0;
var renderScale = 2;
var color = "#7dd3fc";
var latestSlice = null;
self.onmessage = (event) => {
  const { type, payload } = event.data ?? {};
  switch (type) {
    case "initCanvas":
      canvas = payload?.offscreenCanvas ?? null;
      width = payload?.width ?? width;
      height = payload?.height ?? height;
      renderScale = payload?.renderScale ?? renderScale;
      color = payload?.color ?? color;
      if (canvas) {
        resizeSurface(canvas, width, height, renderScale);
        context = canvas.getContext("2d");
      }
      return;
    case "attachSharedBuffers":
      waveformSab = payload?.waveformSab ?? waveformSab;
      controlView = payload?.controlSab ? new Int32Array(payload.controlSab) : controlView;
      waveformMaxColumns = payload?.waveformMaxColumns ?? waveformMaxColumns;
      return;
    case "renderWaveformSlice":
      width = payload?.width ?? width;
      height = payload?.height ?? height;
      renderScale = payload?.renderScale ?? renderScale;
      color = payload?.color ?? color;
      latestSlice = payload;
      if (canvas) {
        resizeSurface(canvas, width, height, renderScale);
      }
      drawFrame();
      return;
    case "clear":
      latestSlice = null;
      clearCanvas();
      return;
    case "dispose":
      latestSlice = null;
      waveformSab = null;
      controlView = null;
      waveformMaxColumns = 0;
      context = null;
      canvas = null;
      return;
    default:
      return;
  }
};
function resizeSurface(surface, nextWidth, nextHeight, nextRenderScale) {
  surface.width = Math.max(1, Math.round(nextWidth * nextRenderScale));
  surface.height = Math.max(1, Math.round(nextHeight * nextRenderScale));
}
function clearCanvas() {
  if (!context || !canvas) {
    return;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
}
function drawFrame() {
  if (!context || !canvas || !latestSlice) {
    clearCanvas();
    return;
  }
  const { columnCount } = latestSlice;
  let slice = null;
  if (latestSlice.sliceBuffer) {
    slice = new Float32Array(latestSlice.sliceBuffer);
  } else {
    if (!waveformSab || !controlView || waveformMaxColumns <= 0) {
      clearCanvas();
      return;
    }
    const { slotId, sequence } = latestSlice;
    if (readWaveformSlotSequence(controlView, slotId) !== sequence) {
      return;
    }
    const slotByteOffset = Float32Array.BYTES_PER_ELEMENT * waveformMaxColumns * 2 * slotId;
    slice = new Float32Array(waveformSab, slotByteOffset, waveformMaxColumns * 2);
  }
  const deviceWidth = Math.max(1, Math.round(width * renderScale));
  const deviceHeight = Math.max(1, Math.round(height * renderScale));
  const chartTop = Math.round(TOP_PADDING * renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((height - BOTTOM_PADDING) * renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * 0.38;
  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, renderScale));
  context.fillStyle = color;
  const drawColumns = Math.min(columnCount, deviceWidth);
  for (let x = 0; x < drawColumns; x += 1) {
    const sourceIndex = x * 2;
    const minValue = slice[sourceIndex] ?? 0;
    const maxValue = slice[sourceIndex + 1] ?? 0;
    const symmetricPeak = Math.max(Math.abs(minValue), Math.abs(maxValue)) * SYMMETRIC_ENVELOPE_GAIN;
    const top = clamp(Math.round(midY - symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    const bottom = clamp(Math.round(midY + symmetricPeak * amplitudeHeight), chartTop, chartBottom);
    context.fillRect(x, Math.min(top, bottom), 1, Math.max(1, Math.abs(bottom - top)));
  }
  self.postMessage({
    type: "waveformRendered",
    payload: {
      generation: latestSlice.generation,
      slotId: latestSlice.slotId ?? -1
    }
  });
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
