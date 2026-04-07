import { loadWaveCoreRuntime, type WaveCoreModule, type WaveCoreRuntime } from '../waveCoreRuntime';
import {
  drawRawSamplePlot as drawSharedRawSamplePlot,
  drawWaveformEnvelope as drawSharedWaveformEnvelope,
} from '../audio-engine-worker/waveformRender';
import { resizeInteractiveWaveformSurface } from './renderer';
import {
  WAVEFORM_AMPLITUDE_HEIGHT_RATIO,
  WAVEFORM_BOTTOM_PADDING_PX as BOTTOM_PADDING,
  WAVEFORM_TOP_PADDING_PX as TOP_PADDING,
} from './geometry';

type WaveformPlotMode = 'envelope' | 'raw';

interface CanvasInitOptions {
  color?: string;
  height?: number;
  offscreenCanvas?: OffscreenCanvas;
  renderScale?: number;
  width?: number;
}

interface AudioSessionOptions {
  duration?: number;
  sampleCount?: number;
  sampleRate?: number;
  samplesBuffer?: ArrayBuffer;
  sessionVersion?: number;
}

interface RenderWaveformRequest {
  color?: string;
  generation?: number;
  height?: number;
  renderScale?: number;
  viewEnd?: number;
  viewStart?: number;
  visibleSpan?: number;
  width?: number;
}

interface WaveformPresentedBody {
  columnCount: number;
  generation: number;
  height: number;
  rawSamplePlotMode: boolean;
  viewEnd: number;
  viewStart: number;
  visibleSpan: number;
  width: number;
}

interface RenderSurface {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
}


interface SurfaceState {
  canvas: OffscreenCanvas | null;
  color: string;
  context: OffscreenCanvasRenderingContext2D | null;
  height: number;
  renderScale: number;
  width: number;
}

interface AnalysisState {
  attachedSessionVersion: number;
  duration: number;
  initialized: boolean;
  plotMode: WaveformPlotMode;
  runtimeVariant: string;
  sampleCount: number;
  sampleRate: number;
  waveformBuilt: boolean;
  waveformData: unknown | null;
  waveformPcmPointer: number;
  waveformSlice: Float32Array | null;
  waveformSliceCapacity: number;
  waveformSliceMetaPointer: number;
  waveformSlicePointer: number;
}

type WorkerMessage =
  | { type: 'attachAudioSession'; body?: AudioSessionOptions }
  | { type: 'bootstrapRuntime' }
  | { type: 'buildWaveformPyramid' }
  | { type: 'dispose' }
  | { type: 'disposeSession' }
  | { type: 'initCanvas'; body?: CanvasInitOptions }
  | { type: 'renderWaveformView'; body?: RenderWaveformRequest }
  | { type: 'resizeCanvas'; body?: CanvasInitOptions };

const CENTER_LINE_ALPHA = 0.14;
const RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL = 64;
const RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL = 60;
const SAMPLE_PLOT_LINE_WIDTH_SCALE = 0.75;
const SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE = 1;
const RAW_SAMPLE_MARKER_MIN_CSS_PIXELS_PER_SAMPLE = 7.5;
const RAW_SAMPLE_MARKER_RADIUS_CSS_PX = 1.5;
const RAW_SAMPLE_MARKER_FILL = 'rgba(248, 250, 252, 0.94)';
const WAVEFORM_RUNTIME_VARIANT = 'waveform-worker-pending';
let requestQueue: Promise<void> = Promise.resolve();
let renderLoopActive = false;
let pendingRenderRequest: RenderWaveformRequest | null = null;
let latestRequestedGeneration = 0;
let runtimePromise: Promise<WaveCoreRuntime> | null = null;

const surfaceState: SurfaceState = {
  canvas: null,
  context: null,
  width: 0,
  height: 0,
  renderScale: 2,
  color: '#8ccadd',
};

let analysisState: AnalysisState = createEmptyAnalysisState();

self.onmessage = (event: MessageEvent<WorkerMessage | undefined>): void => {
  const message = event.data;

  if (!message) {
    return;
  }

  switch (message.type) {
    case 'bootstrapRuntime':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        self.postMessage({
          type: 'runtimeReady',
          body: {
            runtimeVariant: runtime.variant,
          },
        });
      });
      return;
    case 'initCanvas':
      initializeCanvas(message.body);
      void pumpRenderLoop();
      return;
    case 'resizeCanvas':
      resizeCanvas(message.body);
      void pumpRenderLoop();
      return;
    case 'attachAudioSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        attachAudioSession(runtime, message.body);
        void pumpRenderLoop();
      });
      return;
    case 'buildWaveformPyramid':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        buildWaveformPyramid(runtime);
        void pumpRenderLoop();
      });
      return;
    case 'renderWaveformView':
      pendingRenderRequest = message.body ?? null;
      latestRequestedGeneration = Number.isFinite(Number(message.body?.generation))
        ? Number(message.body?.generation)
        : latestRequestedGeneration;
      void pumpRenderLoop();
      return;
    case 'disposeSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        disposeSession(runtime);
        clearCanvas();
      });
      return;
    case 'dispose':
      pendingRenderRequest = null;
      latestRequestedGeneration = 0;
      surfaceState.context = null;
      surfaceState.canvas = null;
      analysisState = createEmptyAnalysisState();
      return;
    default:
      return;
  }
};

function createEmptyAnalysisState(): AnalysisState {
  return {
    initialized: false,
    waveformBuilt: false,
    attachedSessionVersion: -1,
    sampleRate: 0,
    sampleCount: 0,
    duration: 0,
    runtimeVariant: WAVEFORM_RUNTIME_VARIANT,
    plotMode: 'envelope',
    waveformData: null,
    waveformPcmPointer: 0,
    waveformSliceMetaPointer: 0,
    waveformSlice: null,
    waveformSlicePointer: 0,
    waveformSliceCapacity: 0,
  };
}

function enqueueRequest(task: () => void | Promise<void>): void {
  requestQueue = requestQueue
    .then(task)
    .catch((error) => {
      postError(error);
    });
}

function initializeCanvas(options: CanvasInitOptions | undefined): void {
  if (options?.offscreenCanvas) {
    surfaceState.canvas = options.offscreenCanvas;
  }

  surfaceState.width = Math.max(1, Math.round(Number(options?.width) || surfaceState.width || 1));
  surfaceState.height = Math.max(1, Math.round(Number(options?.height) || surfaceState.height || 1));
  surfaceState.renderScale = Math.max(1, Number(options?.renderScale) || surfaceState.renderScale || 1);
  surfaceState.color = typeof options?.color === 'string' && options.color
    ? options.color
    : surfaceState.color;

  if (surfaceState.canvas) {
    resizeDisplaySurface();
    surfaceState.context = surfaceState.canvas.getContext('2d');
  }
  clearCanvas();
}

function resizeCanvas(options: CanvasInitOptions | undefined): void {
  const resizeSnapshot = captureDisplayedSurfaceSnapshot();
  surfaceState.width = Math.max(1, Math.round(Number(options?.width) || surfaceState.width || 1));
  surfaceState.height = Math.max(1, Math.round(Number(options?.height) || surfaceState.height || 1));
  surfaceState.renderScale = Math.max(1, Number(options?.renderScale) || surfaceState.renderScale || 1);
  surfaceState.color = typeof options?.color === 'string' && options.color
    ? options.color
    : surfaceState.color;

  const resized = resizeDisplaySurface();

  if (resized && resizeSnapshot) {
    restoreDisplayedSurfaceSnapshot(resizeSnapshot);
  }
}

function resizeSurface(
  surface: OffscreenCanvas | null,
  width: number,
  height: number,
  renderScale: number,
): boolean {
  if (!surface) {
    return false;
  }

  return resizeInteractiveWaveformSurface(
    surface,
    width,
    height,
    renderScale,
  );
}

function resizeDisplaySurface(): boolean {
  if (!surfaceState.canvas) {
    return false;
  }

  return resizeSurface(
    surfaceState.canvas,
    surfaceState.width,
    surfaceState.height,
    surfaceState.renderScale,
  );
}

function captureDisplayedSurfaceSnapshot(): OffscreenCanvas | null {
  if (!surfaceState.canvas || typeof OffscreenCanvas !== 'function') {
    return null;
  }

  const width = Math.max(1, surfaceState.canvas.width);
  const height = Math.max(1, surfaceState.canvas.height);
  const snapshot = new OffscreenCanvas(width, height);
  const snapshotContext = snapshot.getContext('2d');

  if (!snapshotContext) {
    return null;
  }

  snapshotContext.drawImage(surfaceState.canvas, 0, 0);
  return snapshot;
}

function restoreDisplayedSurfaceSnapshot(snapshot: OffscreenCanvas | null): void {
  if (!snapshot) {
    return;
  }

  const surfaces: RenderSurface[] = surfaceState.canvas && surfaceState.context
    ? [{ canvas: surfaceState.canvas, context: surfaceState.context }]
    : [];

  for (const surface of surfaces) {
    surface.context.save();
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.globalCompositeOperation = 'copy';
    surface.context.drawImage(
      snapshot,
      0,
      0,
      snapshot.width,
      snapshot.height,
      0,
      0,
      surface.canvas.width,
      surface.canvas.height,
    );
    surface.context.restore();
  }
}

function clearCanvas(): void {
  const surfaces: RenderSurface[] = surfaceState.canvas && surfaceState.context
    ? [{ canvas: surfaceState.canvas, context: surfaceState.context }]
    : [];

  for (const surface of surfaces) {
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  }
}

function attachAudioSession(runtime: WaveCoreRuntime, options: AudioSessionOptions | undefined): void {
  const module = runtime.module;
  const sessionVersion = Number.isFinite(options?.sessionVersion) ? Number(options?.sessionVersion) : 0;
  const sampleRate = Number(options?.sampleRate);
  const duration = Number(options?.duration);
  const sampleCount = Number(options?.sampleCount);

  if (!options?.samplesBuffer) {
    throw new Error('Transferable PCM buffer is missing.');
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    throw new Error('Audio session metadata is invalid.');
  }

  const isNewAudioSession = sessionVersion !== analysisState.attachedSessionVersion;

  if (isNewAudioSession) {
    disposeWasmSession(module);
    const samples = new Float32Array(options.samplesBuffer);

    if (!module._wave_prepare_session(sampleCount, sampleRate, duration)) {
      throw new Error('Failed to allocate waveform session.');
    }

    const pcmPointer = module._wave_get_pcm_ptr();

    if (!pcmPointer) {
      throw new Error('Wasm PCM allocation failed.');
    }

    getHeapF32View(module, pcmPointer, sampleCount).set(samples);
    analysisState.waveformPcmPointer = pcmPointer;

    analysisState.waveformData = null;
    analysisState.waveformBuilt = false;
    analysisState.waveformSlice = null;
    analysisState.waveformSliceCapacity = 0;
  }

  analysisState.initialized = true;
  analysisState.attachedSessionVersion = sessionVersion;
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  analysisState.runtimeVariant = runtime.variant;

  self.postMessage({
    type: 'analysisInitialized',
    body: {
      duration,
      runtimeVariant: analysisState.runtimeVariant,
      sampleCount,
      sampleRate,
    },
  });
}

function buildWaveformPyramid(runtime: WaveCoreRuntime): void {
  assertInitialized();

  if (analysisState.waveformBuilt) {
    self.postMessage({
      type: 'waveformPyramidReady',
    });
    return;
  }

  runtime.module._wave_build_waveform_pyramid();
  analysisState.waveformBuilt = true;

  self.postMessage({
    type: 'waveformPyramidReady',
  });
}
async function pumpRenderLoop() {
  if (renderLoopActive) {
    return;
  }

  renderLoopActive = true;

  try {
    while (pendingRenderRequest) {
      if (pendingRenderRequest) {
        const request = pendingRenderRequest;
        pendingRenderRequest = null;

        await requestQueue;

        if (!request) {
          clearCanvas();
          continue;
        }

        if (!isRenderReady()) {
          pendingRenderRequest = request;
          break;
        }

        await renderWaveform(request);
      }
    }
  } catch (error) {
    postError(error);
  } finally {
    renderLoopActive = false;
  }
}

async function renderWaveform(request: RenderWaveformRequest): Promise<void> {
  const viewStart = clamp(Number(request?.viewStart) || 0, 0, analysisState.duration);
  const viewEnd = clamp(
    Number(request?.viewEnd) || analysisState.duration,
    viewStart + (1 / analysisState.sampleRate),
    analysisState.duration,
  );
  const width = Math.max(1, Math.round(Number(request?.width) || surfaceState.width || 1));
  const height = Math.max(1, Math.round(Number(request?.height) || surfaceState.height || 1));
  const renderScale = Math.max(1, Number(request?.renderScale) || surfaceState.renderScale || 1);
  const color = typeof request?.color === 'string' && request.color
    ? request.color
    : surfaceState.color;
  const visibleSpan = Number.isFinite(request?.visibleSpan) ? Number(request.visibleSpan) : Math.max(0, viewEnd - viewStart);
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const columnCount = Math.max(1, Math.round(width * renderScale));
  const renderSpan = Math.max(1 / analysisState.sampleRate, viewEnd - viewStart);
  const visibleSampleCount = Math.max(1, renderSpan * analysisState.sampleRate);
  const samplesPerPixel = visibleSampleCount / columnCount;
  const pixelsPerSample = columnCount / visibleSampleCount;
  const runtime = await getRuntime();
  const module = runtime.module;
  const sampleData = getWaveformSampleData(module);
  const plotMode = resolveWaveformPlotMode(samplesPerPixel, sampleData instanceof Float32Array);
  const rawSamplePlotMode = plotMode === 'raw';
  const sampleStartPosition = viewStart * analysisState.sampleRate;
  const visibleSampleSpan = Math.max(0, visibleSampleCount - 1);

  analysisState.plotMode = plotMode;

  surfaceState.width = width;
  surfaceState.height = height;
  surfaceState.renderScale = renderScale;
  surfaceState.color = color;
  resizeDisplaySurface();

  let peaks: Float32Array | null = null;
  if (!rawSamplePlotMode) {
    peaks = ensureWaveformSliceCapacity(module, columnCount * 2);

    if (!module._wave_extract_waveform_peaks(
      viewStart,
      viewEnd,
      columnCount,
      analysisState.waveformSlicePointer,
      0,
    )) {
      throw new Error('Waveform slice extraction failed.');
    }
  }

  if (generation !== latestRequestedGeneration) {
    return;
  }

  const renderSurface: RenderSurface | null = surfaceState.canvas && surfaceState.context
    ? {
      canvas: surfaceState.canvas,
      context: surfaceState.context,
    }
    : null;

  if (!renderSurface) {
    return;
  }

  if (!analysisState.waveformBuilt && !rawSamplePlotMode) {
    renderSurface.context.setTransform(1, 0, 0, 1, 0, 0);
    renderSurface.context.clearRect(0, 0, renderSurface.canvas.width, renderSurface.canvas.height);
    return;
  }

  if (rawSamplePlotMode && sampleData instanceof Float32Array) {
    drawSharedRawSamplePlot(
      renderSurface.context,
      renderSurface.canvas,
      sampleData,
      color,
      pixelsPerSample,
      sampleStartPosition,
      visibleSampleSpan,
      height,
      renderScale,
    );
    if (generation !== latestRequestedGeneration) {
      return;
    }
    postWaveformPresented({
      columnCount,
      generation,
      height,
      rawSamplePlotMode,
      viewEnd,
      viewStart,
      visibleSpan,
      width,
    });
    return;
  }

  if (peaks) {
    drawSharedWaveformEnvelope(
      renderSurface.context,
      renderSurface.canvas,
      peaks,
      columnCount,
      height,
      renderScale,
      color,
    );
  }
  if (generation !== latestRequestedGeneration) {
    return;
  }

  postWaveformPresented({
    columnCount,
    generation,
    height,
    rawSamplePlotMode,
    viewEnd,
    viewStart,
    visibleSpan,
    width,
  });
}

function postWaveformPresented(body: WaveformPresentedBody): void {
  self.postMessage({
    type: 'waveformPresented',
    body,
  });
}

function drawColumnsCount(renderSurface: RenderSurface | null, columnCount: number): number {
  const canvas = renderSurface?.canvas ?? surfaceState.canvas;
  const deviceWidth = canvas ? Math.max(1, canvas.width) : columnCount;
  return Math.min(columnCount, deviceWidth);
}

function resolveWaveformPlotMode(samplesPerPixel: number, hasSampleData: boolean): WaveformPlotMode {
  if (!hasSampleData) {
    return 'envelope';
  }

  if (analysisState.plotMode === 'raw') {
    return samplesPerPixel <= RAW_SAMPLE_PLOT_EXIT_SAMPLES_PER_PIXEL ? 'raw' : 'envelope';
  }

  return samplesPerPixel <= RAW_SAMPLE_PLOT_ENTER_SAMPLES_PER_PIXEL ? 'raw' : 'envelope';
}

function getRenderableSampleX(
  samplePosition: number,
  sampleStartPosition: number,
  visibleSampleSpan: number,
  drawColumns: number,
): number {
  const maxX = Math.max(0, drawColumns - 1);

  if (maxX <= 0 || visibleSampleSpan <= 0) {
    return 0;
  }

  return clamp(((samplePosition - sampleStartPosition) / visibleSampleSpan) * maxX, 0, maxX);
}

function drawRawSamplePlot(
  renderSurface: RenderSurface,
  samples: Float32Array,
  color: string,
  pixelsPerSample: number,
  sampleStartPosition: number,
  visibleSampleSpan: number,
): void {
  const context = renderSurface.context;
  const canvas = renderSurface.canvas;
  const drawColumns = drawColumnsCount(renderSurface, Math.max(1, canvas.width));

  if (drawColumns <= 0 || samples.length === 0) {
    return;
  }

  const deviceWidth = Math.max(1, canvas.width);
  const deviceHeight = Math.max(1, canvas.height);
  const chartTop = Math.round(TOP_PADDING * surfaceState.renderScale);
  const chartBottom = Math.max(chartTop + 1, Math.round((surfaceState.height - BOTTOM_PADDING) * surfaceState.renderScale));
  const chartHeight = Math.max(1, chartBottom - chartTop);
  const midY = chartTop + chartHeight * 0.5;
  const amplitudeHeight = chartHeight * WAVEFORM_AMPLITUDE_HEIGHT_RATIO;
  const maxSampleIndex = Math.max(0, samples.length - 1);

  context.imageSmoothingEnabled = true;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = `rgba(255, 255, 255, ${CENTER_LINE_ALPHA})`;
  context.fillRect(0, Math.round(midY), deviceWidth, Math.max(1, surfaceState.renderScale));
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = Math.max(1, surfaceState.renderScale * SAMPLE_PLOT_LINE_WIDTH_SCALE);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartPosition));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartPosition + visibleSampleSpan));
  const startY = clamp(midY - getInterpolatedSample(samples, sampleStartPosition) * amplitudeHeight, chartTop, chartBottom);
  context.moveTo(0, startY);

  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getRenderableSampleX(sampleIndex, sampleStartPosition, visibleSampleSpan, drawColumns);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.lineTo(x, y);
  }

  const endX = Math.max(0, drawColumns - 1);
  const endY = clamp(
    midY - getInterpolatedSample(samples, sampleStartPosition + visibleSampleSpan) * amplitudeHeight,
    chartTop,
    chartBottom,
  );
  context.lineTo(endX, endY);

  context.stroke();

  if (pixelsPerSample >= SAMPLE_PLOT_POINT_MIN_PIXELS_PER_SAMPLE) {
    if (shouldDrawRawSampleMarkers(pixelsPerSample)) {
      drawRawSampleMarkers(
        context,
        samples,
        sampleStartPosition,
        visibleSampleSpan,
        drawColumns,
        midY,
        amplitudeHeight,
        chartTop,
        chartBottom,
      );
      return;
    }

    const pointSize = Math.max(1.5, surfaceState.renderScale * 1.1);
    context.beginPath();

    for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
      const x = getRenderableSampleX(sampleIndex, sampleStartPosition, visibleSampleSpan, drawColumns);
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

function shouldDrawRawSampleMarkers(pixelsPerSample: number): boolean {
  return getCssPixelsPerSample(pixelsPerSample) >= RAW_SAMPLE_MARKER_MIN_CSS_PIXELS_PER_SAMPLE;
}

function getCssPixelsPerSample(pixelsPerSample: number): number {
  return pixelsPerSample / Math.max(1, surfaceState.renderScale);
}

function drawRawSampleMarkers(
  context: OffscreenCanvasRenderingContext2D,
  samples: Float32Array,
  sampleStartPosition: number,
  visibleSampleSpan: number,
  drawColumns: number,
  midY: number,
  amplitudeHeight: number,
  chartTop: number,
  chartBottom: number,
): void {
  const maxSampleIndex = Math.max(0, samples.length - 1);
  const firstSampleIndex = Math.max(0, Math.ceil(sampleStartPosition));
  const lastSampleIndex = Math.min(maxSampleIndex, Math.floor(sampleStartPosition + visibleSampleSpan));

  if (lastSampleIndex < firstSampleIndex) {
    return;
  }

  const radius = Math.max(1, RAW_SAMPLE_MARKER_RADIUS_CSS_PX * surfaceState.renderScale);
  context.save();
  context.fillStyle = RAW_SAMPLE_MARKER_FILL;
  context.beginPath();

  for (let sampleIndex = firstSampleIndex; sampleIndex <= lastSampleIndex; sampleIndex += 1) {
    const x = getRenderableSampleX(sampleIndex, sampleStartPosition, visibleSampleSpan, drawColumns);
    const sampleValue = clamp(samples[sampleIndex] ?? 0, -1, 1);
    const y = clamp(midY - sampleValue * amplitudeHeight, chartTop, chartBottom);
    context.moveTo(x + radius, y);
    context.arc(x, y, radius, 0, Math.PI * 2);
  }

  context.fill();
  context.restore();
}

function getInterpolatedSample(samples: Float32Array, position: number): number {
  const index = Math.floor(position);
  const nextIndex = Math.min(samples.length - 1, index + 1);
  const fraction = position - index;
  const a = clamp(samples[index] ?? 0, -1, 1);
  const b = clamp(samples[nextIndex] ?? 0, -1, 1);

  return a + (b - a) * fraction;
}

function ensureWaveformSliceCapacity(module: WaveCoreModule, floatCount: number): Float32Array {
  if (
    analysisState.waveformSliceCapacity >= floatCount
    && analysisState.waveformSlicePointer
  ) {
    const view = getHeapF32View(module, analysisState.waveformSlicePointer, floatCount);
    analysisState.waveformSlice = view;
    return view;
  }

  if (analysisState.waveformSlicePointer) {
    module._free(analysisState.waveformSlicePointer);
  }

  const pointer = module._malloc(floatCount * Float32Array.BYTES_PER_ELEMENT);

  if (!pointer) {
    throw new Error('Failed to allocate waveform slice buffer.');
  }

  analysisState.waveformSlicePointer = pointer;
  analysisState.waveformSliceCapacity = floatCount;
  analysisState.waveformSlice = getHeapF32View(module, pointer, floatCount);
  return analysisState.waveformSlice;
}

function hasRenderableWaveformData(_waveformData: unknown): boolean {
  return Boolean(analysisState.waveformPcmPointer && analysisState.sampleCount > 0);
}

function hasRenderableSurface(): boolean {
  return Boolean(surfaceState.canvas && surfaceState.context);
}

function isRenderReady(): boolean {
  return hasRenderableSurface()
    && analysisState.initialized
    && hasRenderableWaveformData(analysisState.waveformData);
}

function getWaveformSampleData(module: WaveCoreModule): Float32Array | null {
  if (!analysisState.waveformPcmPointer || analysisState.sampleCount <= 0) {
    return null;
  }

  return getHeapF32View(module, analysisState.waveformPcmPointer, analysisState.sampleCount);
}

function disposeWasmSession(module: WaveCoreModule) {
  if (analysisState.waveformSlicePointer) {
    module._free(analysisState.waveformSlicePointer);
  }

  if (analysisState.waveformSliceMetaPointer) {
    module._free(analysisState.waveformSliceMetaPointer);
  }

  module._wave_dispose_session();
  analysisState.waveformPcmPointer = 0;
  analysisState.waveformSliceMetaPointer = 0;
  analysisState.waveformSlicePointer = 0;
  analysisState.waveformSlice = null;
  analysisState.waveformSliceCapacity = 0;
}

function disposeSession(runtime: WaveCoreRuntime) {
  if (analysisState.initialized) {
    disposeWasmSession(runtime.module);
  }

  analysisState = createEmptyAnalysisState();
}

function getRuntime(): Promise<WaveCoreRuntime> {
  if (!runtimePromise) {
    runtimePromise = loadWaveCoreRuntime();
  }

  return runtimePromise;
}

function getHeapF32View(module: WaveCoreModule, pointer: number, length: number): Float32Array {
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}

function assertInitialized() {
  if (!analysisState.initialized) {
    throw new Error('Waveform analysis is not initialized.');
  }
}

function postError(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);

  self.postMessage({
    type: 'error',
    body: { message: text },
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
