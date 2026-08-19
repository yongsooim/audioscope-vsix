import { loadWaveCoreRuntime, type WaveCoreModule, type WaveCoreRuntime, type WaveCoreWasmBytes } from '../waveCoreRuntime';
import {
  RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL,
  drawWaveformPathPlot,
} from '../audio-engine-worker/waveformRender';
import { alignSampleToColumnGrid } from '../audioscope/core/waveformColumnGrid';
import { resizeInteractiveWaveformSurface } from './renderer';

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
  amplitudeMax?: number;
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
  peak: number;
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
  | { type: 'bootstrapRuntime'; body?: { wasmBytes?: { fallback?: ArrayBuffer | null; simd?: ArrayBuffer | null } } }
  | { type: 'buildWaveformPyramid' }
  | { type: 'dispose' }
  | { type: 'disposeSession' }
  | { type: 'initCanvas'; body?: CanvasInitOptions }
  | { type: 'renderWaveformView'; body?: RenderWaveformRequest }
  | { type: 'resizeCanvas'; body?: CanvasInitOptions };

const WAVEFORM_PATH_VALUES_PER_COLUMN = 8;
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
      if (message.body?.wasmBytes) {
        pendingWasmBytes = {
          fallback: message.body.wasmBytes.fallback ?? null,
          simd: message.body.wasmBytes.simd ?? null,
        };
      }
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
      // Kick off the build behind the request queue (so the session is attached),
      // but run it as a detached background loop so it doesn't block rendering.
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        void buildWaveformPyramidProgressive(runtime);
      });
      void pumpRenderLoop();
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

// Re-snap the render origin onto the column grid the engine already aligned the
// presented range to. Idempotent on the normal path (same formula, same inputs);
// it only bites for callers that render a range of their own choosing.
//
// Only a left clamp. The span passed here includes the off-screen slack, so a right
// clamp against `sampleCount - span` sits a slack-width short of the real limit and
// would drag the origin backwards for every view near the end of the file. The engine
// owns range clamping; this owns grid alignment.
function quantizeWaveformPathStartFrame(
  sampleStartFrame: number,
  columnCount: number,
  spanSamples: number,
): number {
  if (!(columnCount > 0) || !(spanSamples > 0)) {
    return Math.max(0, sampleStartFrame);
  }

  return Math.max(0, alignSampleToColumnGrid(sampleStartFrame, {
    columnCount,
    spanSamples: Math.max(1, Math.round(spanSamples)),
  }));
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
      sessionVersion: analysisState.attachedSessionVersion,
    },
  });
}

// How many pyramid blocks to build per step before yielding. Small enough to
// keep the worker responsive (so renders interleave), large enough to finish
// quickly. Coarser levels finish last, refining repeated renders/zoom.
const WAVEFORM_PYRAMID_STEP_BLOCKS = 8192;
let waveformPyramidBuildActive = false;
let waveformPyramidRequestedSessionVersion = -1;

function postWaveformPyramidReady(): void {
  self.postMessage({
    type: 'waveformPyramidReady',
    body: { sessionVersion: analysisState.attachedSessionVersion },
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    self.setTimeout(resolve, 0);
  });
}

async function buildWaveformPyramidProgressive(runtime: WaveCoreRuntime): Promise<void> {
  if (!analysisState.initialized) {
    return;
  }
  waveformPyramidRequestedSessionVersion = analysisState.attachedSessionVersion;
  if (analysisState.waveformBuilt) {
    postWaveformPyramidReady();
    return;
  }
  if (waveformPyramidBuildActive) {
    return;
  }

  waveformPyramidBuildActive = true;
  const buildToken = analysisState.attachedSessionVersion;
  try {
    const levelCount = runtime.module._wave_begin_waveform_pyramid_build();
    if (levelCount <= 0) {
      analysisState.waveformBuilt = true;
      postWaveformPyramidReady();
      return;
    }

    while (true) {
      // Abort if the session was replaced while building.
      if (buildToken !== analysisState.attachedSessionVersion) {
        return;
      }
      const done = runtime.module._wave_build_waveform_pyramid_step(WAVEFORM_PYRAMID_STEP_BLOCKS) === 1;
      if (done) {
        break;
      }
      await yieldToEventLoop();
    }

    analysisState.waveformBuilt = true;
    // One final render now that the full pyramid is available (fast path).
    postWaveformPyramidReady();
  } catch (error) {
    postError(error);
  } finally {
    waveformPyramidBuildActive = false;
    if (
      analysisState.initialized
      && !analysisState.waveformBuilt
      && buildToken !== waveformPyramidRequestedSessionVersion
      && waveformPyramidRequestedSessionVersion === analysisState.attachedSessionVersion
    ) {
      void buildWaveformPyramidProgressive(runtime);
    }
  }
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
  // No duration ceiling. The request is the viewport plus a fixed strip of off-screen
  // slack columns, so near the end of the file the window legitimately runs past the
  // last sample. Clipping it here would shrink samples-per-column against a column
  // count that does not shrink with it, and the visible half of the canvas would stop
  // being 1:1 with the viewport (at full zoom-out that reads as the whole waveform
  // stretched ~8% and its tail pushed off screen). The extractor clamps its per-column
  // sample lookups instead, so columns past the last sample just go flat.
  const viewEnd = Math.max(
    viewStart + (1 / analysisState.sampleRate),
    Number(request?.viewEnd) || analysisState.duration,
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
  // Columns that land inside the viewport; the rest is the off-screen slack strip
  // the compositor slides in while a re-render is still in flight.
  const visibleColumnCount = visibleSpan > 0
    ? clamp(Math.round((columnCount * visibleSpan) / renderSpan), 1, columnCount)
    : columnCount;
  // Samples under the FULL render window (viewport + slack), not just the on-screen
  // part — every column ratio below is taken against this span. Naming it "visible"
  // is what once made a right-edge clamp look correct here.
  const renderSampleCount = Math.max(1, renderSpan * analysisState.sampleRate);
  const samplesPerPixel = renderSampleCount / columnCount;
  const pixelsPerSample = columnCount / renderSampleCount;
  const runtime = await getRuntime();
  const module = runtime.module;
  const sampleData = getWaveformSampleData(module);
  const rawSamplePlotMode = samplesPerPixel < RAW_SAMPLE_SIMPLIFY_MIN_SAMPLES_PER_PIXEL;
  const sampleStartPosition = viewStart * analysisState.sampleRate;
  // Envelope mode is column-locked, with no fade between the two geometries: a
  // partial blend leaves the origin on neither the sample grid nor the column grid,
  // so the buckets re-partition on every frame — the worst case, right in the middle
  // of the zoom range where one column covers about one pyramid block.
  const stableColumnSlots = !rawSamplePlotMode;
  const renderSampleStartPosition = stableColumnSlots
    ? quantizeWaveformPathStartFrame(sampleStartPosition, columnCount, renderSampleCount)
    : sampleStartPosition;
  const renderViewStart = renderSampleStartPosition / analysisState.sampleRate;
  // Same span as requested, never clipped at EOF — see viewEnd above. Holding the span
  // fixed is what keeps samples-per-column constant while the view scrolls.
  const renderViewEnd = renderViewStart + renderSpan;

  analysisState.plotMode = rawSamplePlotMode ? 'raw' : 'envelope';

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

  // The pyramid builds incrementally in the background; until it's ready the
  // WASM path extractor falls back to already-built levels / raw samples, so the
  // waveform can render immediately instead of waiting for the full build.
  const pathPoints = ensureWaveformSliceCapacity(module, columnCount * WAVEFORM_PATH_VALUES_PER_COLUMN);
  if (!module._wave_extract_waveform_path_points(
    renderViewStart,
    renderViewEnd,
    columnCount,
    analysisState.waveformSlicePointer,
    0,
  )) {
    throw new Error('Waveform path extraction failed.');
  }

  if (generation !== latestRequestedGeneration) {
    return;
  }

  // Resize last: writing canvas.width wipes the surface, so doing it up front means
  // any bail between there and the draw leaves a blank canvas on screen for a frame.
  // Nothing above this point reads the surface size.
  surfaceState.width = width;
  surfaceState.height = height;
  surfaceState.renderScale = renderScale;
  surfaceState.color = color;
  resizeDisplaySurface();

  drawWaveformPathPlot(
    renderSurface.context,
    renderSurface.canvas,
    pathPoints,
    color,
    pixelsPerSample,
    renderSampleStartPosition,
    // Span convention (matches ruler / playhead / spectrogram): sample p maps to
    // x = p / span * width, so the window's right edge is the sample-span boundary.
    // Previously this used span-1, which pinned the last sample to the right edge
    // and drifted up to ~1 sample from the ruler at per-sample zoom.
    renderSampleCount,
    height,
    renderScale,
    {
      amplitudeMax: Number(request?.amplitudeMax) || 1,
      sampleData,
      stableColumnSlots,
    },
  );

  if (generation !== latestRequestedGeneration) {
    return;
  }

  postWaveformPresented({
    columnCount,
    generation,
    height,
    peak: getPathPointsPeak(pathPoints, visibleColumnCount),
    viewEnd,
    viewStart,
    visibleSpan,
    width,
  });
}

// Loudest |sample| in the points just drawn — feeds the toolbar's amplitude Fit.
// Points are (sampleOffset, value) pairs; a negative offset means "unused slot".
// Scoped to the on-screen columns: the render window also carries off-screen slack,
// and Fit should scale to what the user can actually see.
function getPathPointsPeak(pathPoints: Float32Array, visibleColumnCount: number): number {
  const visibleValueCount = Math.min(
    pathPoints.length,
    Math.max(1, visibleColumnCount) * WAVEFORM_PATH_VALUES_PER_COLUMN,
  );
  let peak = 0;
  for (let index = 0; index + 1 < visibleValueCount; index += 2) {
    if (!(pathPoints[index] >= 0)) {
      continue;
    }
    const magnitude = Math.abs(pathPoints[index + 1]);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }
  return peak;
}

function postWaveformPresented(body: WaveformPresentedBody): void {
  self.postMessage({
    type: 'waveformPresented',
    body: {
      ...body,
      sessionVersion: analysisState.attachedSessionVersion,
    },
  });
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

function hasRenderableWaveformData(): boolean {
  return Boolean(analysisState.waveformPcmPointer && analysisState.sampleCount > 0);
}

function hasRenderableSurface(): boolean {
  return Boolean(surfaceState.canvas && surfaceState.context);
}

function isRenderReady(): boolean {
  return hasRenderableSurface()
    && analysisState.initialized
    && hasRenderableWaveformData();
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
  waveformPyramidRequestedSessionVersion = -1;
}

let pendingWasmBytes: WaveCoreWasmBytes | null = null;

function getRuntime(): Promise<WaveCoreRuntime> {
  if (!runtimePromise) {
    runtimePromise = loadWaveCoreRuntime(pendingWasmBytes);
  }

  return runtimePromise;
}

function getHeapF32View(module: WaveCoreModule, pointer: number, length: number): Float32Array {
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}

function postError(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);

  self.postMessage({
    type: 'error',
    body: {
      message: text,
      sessionVersion: analysisState.attachedSessionVersion,
    },
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
