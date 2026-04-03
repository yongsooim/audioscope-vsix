import { loadWaveCoreRuntime, type WaveCoreModule, type WaveCoreRuntime } from './waveCoreRuntime';
import {
  TILE_COLUMN_COUNT,
  quantizeCeil,
} from './sharedBuffers';

const MIN_FREQUENCY = 50;
const MAX_FREQUENCY = 20000;
const ROW_BUCKET_SIZE = 16;
const VISIBLE_ROW_OVERSAMPLE = 1.35;

const QUALITY_PRESETS = {
  balanced: {
    rowsMultiplier: 1.5,
    colsMultiplier: 2.5,
    lowFrequencyDecimationFactor: 2,
  },
  high: {
    rowsMultiplier: 2.5,
    colsMultiplier: 4,
    lowFrequencyDecimationFactor: 4,
  },
  max: {
    rowsMultiplier: 4,
    colsMultiplier: 6,
    lowFrequencyDecimationFactor: 4,
  },
};

const FFT_SIZE_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const OVERLAP_RATIO_OPTIONS = [0.5, 0.75, 0.875, 0.9375];
const SCALOGRAM_COLUMN_CHUNK_SIZE = 32;
const SCALOGRAM_ROW_BLOCK_SIZE = 32;
const MAX_TILE_CACHE_ENTRIES = 24;
const MAX_TILE_CACHE_BYTES = 96 * 1024 * 1024;
const ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR = true;
const WEBGPU_TILE_TEXTURE_FORMAT = 'rgba8unorm';
const ANALYSIS_TYPE_CODES = {
  spectrogram: 0,
  mel: 1,
  scalogram: 2,
};
const FREQUENCY_SCALE_CODES = {
  log: 0,
  linear: 1,
  mixed: 2,
};
const SCALOGRAM_HOP_SAMPLES_BY_QUALITY = {
  balanced: 2048,
  high: 1024,
  max: 512,
};

type QualityPreset = 'balanced' | 'high' | 'max';
type AnalysisType = 'mel' | 'scalogram' | 'spectrogram';
type FrequencyScale = 'linear' | 'log' | 'mixed';
type LayerKind = 'overview' | 'visible';
type SurfaceBackend = '2d' | 'initializing' | 'uninitialized' | 'webgpu';

const WEBGPU_BACKGROUND_SHADER = /* wgsl */`
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn backgroundVs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, -1.0),
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
  );

  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

fn mixColor(startColor: vec3<f32>, endColor: vec3<f32>, t: f32) -> vec3<f32> {
  return startColor + ((endColor - startColor) * t);
}

@fragment
fn backgroundFs(input: VertexOutput) -> @location(0) vec4<f32> {
  let topColor = vec3<f32>(23.0 / 255.0, 17.0 / 255.0, 39.0 / 255.0);
  let middleColor = vec3<f32>(13.0 / 255.0, 11.0 / 255.0, 25.0 / 255.0);
  let bottomColor = vec3<f32>(4.0 / 255.0, 5.0 / 255.0, 12.0 / 255.0);
  let y = clamp(input.uv.y, 0.0, 1.0);
  var color = bottomColor;
  if (y <= 0.46) {
    color = mixColor(topColor, middleColor, y / 0.46);
  } else {
    color = mixColor(middleColor, bottomColor, (y - 0.46) / 0.54);
  }

  return vec4<f32>(color, 1.0);
}
`;

const WEBGPU_TILE_SHADER = /* wgsl */`
struct TileUniforms {
  destLeft: f32,
  destRight: f32,
  uvStart: f32,
  uvEnd: f32,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var<uniform> tileUniforms: TileUniforms;
@group(0) @binding(1) var tileSampler: sampler;
@group(0) @binding(2) var tileTexture: texture_2d<f32>;

@vertex
fn tileVs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(tileUniforms.destLeft, 1.0),
    vec2<f32>(tileUniforms.destRight, 1.0),
    vec2<f32>(tileUniforms.destLeft, -1.0),
    vec2<f32>(tileUniforms.destLeft, -1.0),
    vec2<f32>(tileUniforms.destRight, 1.0),
    vec2<f32>(tileUniforms.destRight, -1.0),
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(tileUniforms.uvStart, 0.0),
    vec2<f32>(tileUniforms.uvEnd, 0.0),
    vec2<f32>(tileUniforms.uvStart, 1.0),
    vec2<f32>(tileUniforms.uvStart, 1.0),
    vec2<f32>(tileUniforms.uvEnd, 0.0),
    vec2<f32>(tileUniforms.uvEnd, 1.0),
  );

  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@fragment
fn tileFs(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(tileTexture, tileSampler, input.uv);
}
`;

interface CanvasInitOptions {
  offscreenCanvas?: OffscreenCanvas;
  pixelHeight?: number;
  pixelWidth?: number;
}

interface AudioSessionOptions {
  duration?: number;
  quality?: QualityPreset;
  sampleCount?: number;
  sampleRate?: number;
  samplesBuffer?: ArrayBuffer;
  sessionVersion?: number;
}

interface SpectrogramRequest {
  analysisType?: AnalysisType;
  configVersion?: number;
  displayEnd?: number;
  displayStart?: number;
  dpr?: number;
  fftSize?: number;
  frequencyScale?: FrequencyScale;
  generation?: number;
  overlapRatio?: number;
  pixelHeight?: number;
  pixelWidth?: number;
  requestEnd?: number;
  requestKind?: LayerKind;
  requestStart?: number;
  viewEnd?: number;
  viewStart?: number;
}

interface LayerState {
  generation: number;
  kind: LayerKind;
  plan: RenderRequestPlan | null;
  ready: boolean;
  requestPending: boolean;
}

interface TileRecord {
  byteLength: number;
  canvas: OffscreenCanvas;
  columnCount: number;
  complete: boolean;
  context: OffscreenCanvasRenderingContext2D | null;
  gpuBindGroup: any;
  gpuDirty: boolean;
  gpuTexture: any;
  gpuTextureView: any;
  gpuUniformBuffer: any;
  imageData: ImageData;
  renderedColumns: number;
  rowCount: number;
  tileEnd: number;
  tileIndex: number;
  tileKey: string;
  tileStart: number;
}

interface RenderRequestPlan {
  analysisType: AnalysisType;
  configKey: string;
  configVersion: number;
  decimationFactor: number;
  displayEnd: number;
  displayStart: number;
  dprBucket: number;
  endTileIndex: number;
  fftSize: number;
  frequencyScale: FrequencyScale;
  generation: number;
  hopSamples: number;
  hopSeconds: number;
  overlapRatio: number;
  pixelHeight: number;
  pixelWidth: number;
  requestKind: LayerKind;
  rowCount: number;
  startTileIndex: number;
  targetColumns: number;
  tileDuration: number;
  viewEnd: number;
  viewStart: number;
  windowSeconds: number;
}

interface EnsurePlanTilesOptions {
  onTileReady?: () => void;
  shouldAbort?: () => boolean;
}

interface RenderTileOptions {
  cacheKey?: string;
  existingTile?: TileRecord | null;
  onChunkReady?: () => void;
  shouldAbort?: () => boolean;
}

interface AnalysisWorkerState {
  activeConfigVersion: number;
  attachedSessionVersion: number;
  currentDisplayRange: {
    end: number;
    pixelHeight: number;
    pixelWidth: number;
    start: number;
  };
  duration: number;
  generationStatus: Map<number, { cancelled: boolean }>;
  initialized: boolean;
  maxFrequency: number;
  minFrequency: number;
  overview: LayerState;
  quality: QualityPreset;
  runtimeVariant: string | null;
  sampleCount: number;
  sampleRate: number;
  spectrogramOutputCapacity: number;
  spectrogramOutputPointer: number;
  tileCache: Map<string, TileRecord>;
  tileCacheBytes: number;
  visible: LayerState;
}

interface WebGpuCompositorState {
  bindGroupLayout: any;
  canvasContext: any;
  canvasFormat: string;
  compositorCanvas: OffscreenCanvas;
  device: any;
  backgroundPipeline: any;
  sampler: any;
  tilePipeline: any;
}

let runtimePromise: Promise<WaveCoreRuntime> | null = null;
let requestQueue = Promise.resolve();
let overviewRenderLoopActive = false;
let visibleRenderLoopActive = false;
let pendingOverviewRequest: SpectrogramRequest | null = null;
let pendingVisibleRequest: SpectrogramRequest | null = null;

const surfaceState = {
  backend: 'uninitialized' as SurfaceBackend,
  canvas: null as OffscreenCanvas | null,
  context: null as OffscreenCanvasRenderingContext2D | null,
  pixelWidth: 0,
  pixelHeight: 0,
  webGpu: null as WebGpuCompositorState | null,
  webGpuInitPromise: null as Promise<void> | null,
  webGpuPresentSerial: 0,
};

let analysisState: AnalysisWorkerState = createEmptyAnalysisState();

self.onmessage = (event) => {
  const message = event.data ?? {};

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
      return;
    case 'resizeCanvas':
      resizeCanvas(message.body);
      return;
    case 'attachAudioSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        attachAudioSession(runtime, message.body);
      });
      return;
    case 'renderOverview':
      registerActiveConfigVersion(message.body?.configVersion);
      pendingOverviewRequest = message.body ?? null;
      void pumpOverviewLoop();
      return;
    case 'renderVisibleRange':
      registerActiveConfigVersion(message.body?.configVersion);
      if (message.body) {
        updateCurrentDisplayRange(message.body);
      }
      pendingVisibleRequest = message.body ?? null;
      paintSpectrogramDisplay();
      void pumpVisibleLoop();
      return;
    case 'updateVisibleDisplayRange':
      if (message.body) {
        updateCurrentDisplayRange(message.body);
      }
      paintSpectrogramDisplay();
      return;
    case 'cancelGeneration':
      cancelGeneration(message.body?.generation);
      return;
    case 'disposeSession':
      enqueueRequest(async () => {
        const runtime = await getRuntime();
        disposeSession(runtime);
        paintSpectrogramDisplay();
      });
      return;
    case 'dispose':
      pendingOverviewRequest = null;
      pendingVisibleRequest = null;
      destroyWebGpuCompositor();
      surfaceState.canvas = null;
      surfaceState.context = null;
      surfaceState.backend = 'uninitialized';
      analysisState = createEmptyAnalysisState();
      return;
    default:
      return;
  }
};

function createEmptyLayerState(kind: LayerKind): LayerState {
  return {
    kind,
    generation: kind === 'overview' ? 0 : -1,
    ready: false,
    requestPending: false,
    plan: null,
  };
}

function createEmptyAnalysisState(): AnalysisWorkerState {
  return {
    initialized: false,
    attachedSessionVersion: -1,
    sampleRate: 0,
    sampleCount: 0,
    duration: 0,
    quality: 'high',
    minFrequency: MIN_FREQUENCY,
    maxFrequency: MAX_FREQUENCY,
    runtimeVariant: null,
    activeConfigVersion: 0,
    generationStatus: new Map(),
    tileCache: new Map(),
    tileCacheBytes: 0,
    overview: createEmptyLayerState('overview'),
    visible: createEmptyLayerState('visible'),
    currentDisplayRange: {
      start: 0,
      end: 0,
      pixelWidth: 0,
      pixelHeight: 0,
    },
    spectrogramOutputPointer: 0,
    spectrogramOutputCapacity: 0,
  };
}

function clearTileCache(): void {
  for (const tileRecord of analysisState.tileCache.values()) {
    destroyTileGpuResources(tileRecord);
  }

  analysisState.tileCache.clear();
  analysisState.tileCacheBytes = 0;
}

function getPinnedTileKeys(): Set<string> {
  const pinnedKeys = new Set<string>();

  for (const plan of [analysisState.overview.plan, analysisState.visible.plan]) {
    if (!plan) {
      continue;
    }

    for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
      pinnedKeys.add(buildTileCacheKey(plan, tileIndex));
    }
  }

  return pinnedKeys;
}

function touchTileRecord(cacheKey: string): TileRecord | null {
  const tileRecord = analysisState.tileCache.get(cacheKey) ?? null;

  if (!tileRecord) {
    return null;
  }

  analysisState.tileCache.delete(cacheKey);
  analysisState.tileCache.set(cacheKey, tileRecord);
  return tileRecord;
}

function pruneTileCache(): void {
  if (
    analysisState.tileCache.size <= MAX_TILE_CACHE_ENTRIES
    && analysisState.tileCacheBytes <= MAX_TILE_CACHE_BYTES
  ) {
    return;
  }

  const pinnedKeys = getPinnedTileKeys();

  for (const [cacheKey, tileRecord] of analysisState.tileCache) {
    if (
      analysisState.tileCache.size <= MAX_TILE_CACHE_ENTRIES
      && analysisState.tileCacheBytes <= MAX_TILE_CACHE_BYTES
    ) {
      break;
    }

    if (pinnedKeys.has(cacheKey)) {
      continue;
    }

    analysisState.tileCache.delete(cacheKey);
    analysisState.tileCacheBytes = Math.max(0, analysisState.tileCacheBytes - tileRecord.byteLength);
    destroyTileGpuResources(tileRecord);
  }
}

function setTileRecord(cacheKey: string, tileRecord: TileRecord): void {
  const previousRecord = analysisState.tileCache.get(cacheKey) ?? null;

  if (!previousRecord) {
    analysisState.tileCacheBytes += tileRecord.byteLength;
  } else if (previousRecord !== tileRecord) {
    analysisState.tileCacheBytes += tileRecord.byteLength - previousRecord.byteLength;
  } else {
    analysisState.tileCache.delete(cacheKey);
  }

  analysisState.tileCache.set(cacheKey, tileRecord);
  pruneTileCache();
}

function getTileRecord(cacheKey: string): TileRecord | null {
  return touchTileRecord(cacheKey);
}

function enqueueRequest(task: () => Promise<void>): void {
  requestQueue = requestQueue
    .then(task)
    .catch((error) => {
      postError(error);
    });
}

function getRuntime(): Promise<WaveCoreRuntime> {
  if (!runtimePromise) {
    runtimePromise = loadWaveCoreRuntime();
  }

  return runtimePromise;
}

function normalizeQualityPreset(value: unknown): QualityPreset {
  return value === 'balanced' || value === 'max' ? value : 'high';
}

function normalizeAnalysisType(value: unknown): AnalysisType {
  return value === 'mel' || value === 'scalogram' ? value : 'spectrogram';
}

function normalizeFrequencyScale(value: unknown): FrequencyScale {
  return value === 'linear' || value === 'mixed' ? value : 'log';
}

function getEffectiveFrequencyScale(analysisType: AnalysisType, value: unknown): FrequencyScale {
  return analysisType === 'spectrogram' ? normalizeFrequencyScale(value) : 'log';
}

function getScalogramHopSamples(quality: QualityPreset): number {
  return SCALOGRAM_HOP_SAMPLES_BY_QUALITY[quality] ?? SCALOGRAM_HOP_SAMPLES_BY_QUALITY.high;
}

function getWebGpuGlobals() {
  const webGpuScope = globalThis as typeof globalThis & {
    GPUBufferUsage?: Record<string, number>;
    GPUShaderStage?: Record<string, number>;
    GPUTextureUsage?: Record<string, number>;
    navigator?: Navigator & {
      gpu?: {
        getPreferredCanvasFormat?: () => string;
        requestAdapter?: (options?: { powerPreference?: 'high-performance' | 'low-power' }) => Promise<any>;
      };
    };
  };
  const gpu = webGpuScope.navigator?.gpu;
  const bufferUsage = webGpuScope.GPUBufferUsage;
  const shaderStage = webGpuScope.GPUShaderStage;
  const textureUsage = webGpuScope.GPUTextureUsage;

  if (!gpu || !bufferUsage || !shaderStage || !textureUsage) {
    return null;
  }

  return {
    bufferUsage,
    gpu,
    shaderStage,
    textureUsage,
  };
}

function destroyTileGpuResources(tileRecord: TileRecord): void {
  if (tileRecord.gpuTexture && typeof tileRecord.gpuTexture.destroy === 'function') {
    tileRecord.gpuTexture.destroy();
  }
  if (tileRecord.gpuUniformBuffer && typeof tileRecord.gpuUniformBuffer.destroy === 'function') {
    tileRecord.gpuUniformBuffer.destroy();
  }

  tileRecord.gpuTexture = null;
  tileRecord.gpuTextureView = null;
  tileRecord.gpuBindGroup = null;
  tileRecord.gpuUniformBuffer = null;
  tileRecord.gpuDirty = true;
}

function destroyWebGpuCompositor(): void {
  for (const tileRecord of analysisState.tileCache.values()) {
    destroyTileGpuResources(tileRecord);
  }

  surfaceState.webGpu = null;
  surfaceState.webGpuInitPromise = null;
  if (surfaceState.backend === 'webgpu' || surfaceState.backend === 'initializing') {
    surfaceState.backend = 'uninitialized';
  }
}

function initialize2dSurface(): void {
  if (!surfaceState.canvas) {
    surfaceState.context = null;
    surfaceState.backend = 'uninitialized';
    return;
  }

  surfaceState.canvas.width = Math.max(1, surfaceState.pixelWidth);
  surfaceState.canvas.height = Math.max(1, surfaceState.pixelHeight);
  surfaceState.context = surfaceState.canvas.getContext('2d', { alpha: false });
  if (surfaceState.backend !== 'webgpu') {
    surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
  }
}

async function validateWebGpuPresentation(device: any, canvasFormat: string): Promise<boolean> {
  const probeCanvas = new OffscreenCanvas(1, 1);
  const probeContext = probeCanvas.getContext('2d', { alpha: false });
  if (!probeContext) {
    return false;
  }

  const validationCanvas = new OffscreenCanvas(1, 1);
  const validationContext = (validationCanvas.getContext('webgpu') as any) ?? null;
  if (!validationContext) {
    return false;
  }

  validationContext.configure({
    alphaMode: 'opaque',
    device,
    format: canvasFormat,
  });

  const commandEncoder = device.createCommandEncoder();
  const renderPass = commandEncoder.beginRenderPass({
    colorAttachments: [
      {
        clearValue: { a: 1, b: 1, g: 0, r: 1 },
        loadOp: 'clear',
        storeOp: 'store',
        view: validationContext.getCurrentTexture().createView(),
      },
    ],
  });
  renderPass.end();
  device.queue.submit([commandEncoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  const imageSource = typeof createImageBitmap === 'function'
    ? await createImageBitmap(validationCanvas)
    : validationCanvas;
  try {
    probeContext.drawImage(imageSource, 0, 0, 1, 1);
  } finally {
    if (imageSource instanceof ImageBitmap) {
      imageSource.close();
    }
  }

  const pixel = probeContext.getImageData(0, 0, 1, 1).data;
  return pixel[0] >= 200 && pixel[1] <= 50 && pixel[2] >= 200;
}

async function initializeWebGpuCompositor(): Promise<void> {
  if (
    !ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR
    || surfaceState.webGpu
    || surfaceState.webGpuInitPromise
    || !surfaceState.canvas
  ) {
    return;
  }

  const globals = getWebGpuGlobals();
  if (!globals) {
    initialize2dSurface();
    return;
  }

  surfaceState.backend = 'initializing';
  surfaceState.webGpuInitPromise = (async () => {
    try {
      const adapter = await globals.gpu.requestAdapter?.({ powerPreference: 'high-performance' });
      if (!adapter) {
        surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
        return;
      }

      const device = await adapter.requestDevice();
      const canvasFormat = globals.gpu.getPreferredCanvasFormat?.() || 'bgra8unorm';
      if (!(await validateWebGpuPresentation(device, canvasFormat))) {
        surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
        return;
      }

      const backgroundModule = device.createShaderModule({ code: WEBGPU_BACKGROUND_SHADER });
      const tileModule = device.createShaderModule({ code: WEBGPU_TILE_SHADER });
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            buffer: { type: 'uniform' },
            visibility: globals.shaderStage.VERTEX,
          },
          {
            binding: 1,
            sampler: { type: 'filtering' },
            visibility: globals.shaderStage.FRAGMENT,
          },
          {
            binding: 2,
            texture: { sampleType: 'float' },
            visibility: globals.shaderStage.FRAGMENT,
          },
        ],
      });
      const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
      });
      const backgroundPipeline = device.createRenderPipeline({
        fragment: {
          entryPoint: 'backgroundFs',
          module: backgroundModule,
          targets: [{ format: canvasFormat }],
        },
        layout: 'auto',
        primitive: { topology: 'triangle-list' },
        vertex: {
          entryPoint: 'backgroundVs',
          module: backgroundModule,
        },
      });
      const tilePipeline = device.createRenderPipeline({
        fragment: {
          entryPoint: 'tileFs',
          module: tileModule,
          targets: [{ format: canvasFormat }],
        },
        layout: device.createPipelineLayout({
          bindGroupLayouts: [bindGroupLayout],
        }),
        primitive: { topology: 'triangle-list' },
        vertex: {
          entryPoint: 'tileVs',
          module: tileModule,
        },
      });

      const compositorCanvas = new OffscreenCanvas(
        Math.max(1, surfaceState.pixelWidth),
        Math.max(1, surfaceState.pixelHeight),
      );
      const canvasContext = (compositorCanvas.getContext('webgpu') as any) ?? null;
      if (!canvasContext) {
        surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
        return;
      }

      canvasContext.configure({
        alphaMode: 'opaque',
        device,
        format: canvasFormat,
      });

      surfaceState.webGpu = {
        backgroundPipeline,
        bindGroupLayout,
        canvasContext,
        canvasFormat,
        compositorCanvas,
        device,
        sampler,
        tilePipeline,
      };
      surfaceState.backend = 'webgpu';
      void device.lost.then(() => {
        if (surfaceState.webGpu?.device !== device) {
          return;
        }

        destroyWebGpuCompositor();
        surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
        paintSpectrogramDisplay();
      });
      paintSpectrogramDisplay();
    } catch {
      destroyWebGpuCompositor();
      surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
      paintSpectrogramDisplay();
    } finally {
      surfaceState.webGpuInitPromise = null;
    }
  })();

  await surfaceState.webGpuInitPromise;
}

function resizeWebGpuSurface(): void {
  if (!surfaceState.webGpu) {
    return;
  }

  surfaceState.webGpu.compositorCanvas.width = Math.max(1, surfaceState.pixelWidth);
  surfaceState.webGpu.compositorCanvas.height = Math.max(1, surfaceState.pixelHeight);
  surfaceState.webGpu.canvasContext.configure({
    alphaMode: 'opaque',
    device: surfaceState.webGpu.device,
    format: surfaceState.webGpu.canvasFormat,
  });
}

function initializeCanvas(options: CanvasInitOptions | undefined): void {
  if (options?.offscreenCanvas) {
    surfaceState.canvas = options.offscreenCanvas;
  }

  surfaceState.pixelWidth = Math.max(1, Math.round(Number(options?.pixelWidth) || surfaceState.pixelWidth || 1));
  surfaceState.pixelHeight = Math.max(1, Math.round(Number(options?.pixelHeight) || surfaceState.pixelHeight || 1));

  if (!surfaceState.canvas) {
    return;
  }

  initialize2dSurface();

  if (ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR) {
    void initializeWebGpuCompositor();
  }

  paintSpectrogramDisplay();
}

function resizeCanvas(options: CanvasInitOptions | undefined): void {
  surfaceState.pixelWidth = Math.max(1, Math.round(Number(options?.pixelWidth) || surfaceState.pixelWidth || 1));
  surfaceState.pixelHeight = Math.max(1, Math.round(Number(options?.pixelHeight) || surfaceState.pixelHeight || 1));

  if (!surfaceState.canvas) {
    return;
  }

  surfaceState.canvas.width = surfaceState.pixelWidth;
  surfaceState.canvas.height = surfaceState.pixelHeight;
  analysisState.currentDisplayRange.pixelWidth = surfaceState.pixelWidth;
  analysisState.currentDisplayRange.pixelHeight = surfaceState.pixelHeight;
  if (surfaceState.backend === 'webgpu') {
    resizeWebGpuSurface();
  }

  initialize2dSurface();

  if (surfaceState.backend === 'uninitialized' && ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR) {
    void initializeWebGpuCompositor();
  } else if (surfaceState.backend === 'uninitialized') {
    initialize2dSurface();
  }

  paintSpectrogramDisplay();
}

function attachAudioSession(runtime: WaveCoreRuntime, options: AudioSessionOptions | undefined): void {
  const module = runtime.module;
  const sessionVersion = Number.isFinite(options?.sessionVersion) ? Number(options.sessionVersion) : 0;
  const sampleRate = Number(options?.sampleRate);
  const duration = Number(options?.duration);
  const sampleCount = Number(options?.sampleCount);
  const quality = normalizeQualityPreset(options?.quality);

  if (!options?.samplesBuffer) {
    throw new Error('Transferable PCM buffer is missing.');
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    throw new Error('Audio session metadata is invalid.');
  }

  const isNewAudioSession = sessionVersion !== analysisState.attachedSessionVersion;

  if (isNewAudioSession) {
    disposeWasmSession(module);

    if (!module._wave_prepare_session(sampleCount, sampleRate, duration)) {
      throw new Error('Failed to allocate spectrogram session.');
    }

    const pcmPointer = module._wave_get_pcm_ptr();

    if (!pcmPointer) {
      throw new Error('Wasm PCM allocation failed.');
    }

    const pcmSource = new Float32Array(options.samplesBuffer);
    const pcmTarget = getHeapF32View(module, pcmPointer, sampleCount);
    pcmTarget.set(pcmSource);
  }

  analysisState.initialized = true;
  analysisState.attachedSessionVersion = sessionVersion;
  analysisState.sampleRate = sampleRate;
  analysisState.sampleCount = sampleCount;
  analysisState.duration = duration;
  analysisState.quality = quality;
  analysisState.minFrequency = MIN_FREQUENCY;
  analysisState.maxFrequency = Math.min(MAX_FREQUENCY, sampleRate / 2);
  analysisState.runtimeVariant = runtime.variant;

  if (isNewAudioSession) {
    clearTileCache();
    analysisState.generationStatus.clear();
    analysisState.overview = createEmptyLayerState('overview');
    analysisState.visible = createEmptyLayerState('visible');
  }

  self.postMessage({
    type: 'analysisInitialized',
    body: {
      duration,
      maxFrequency: analysisState.maxFrequency,
      minFrequency: analysisState.minFrequency,
      quality,
      runtimeVariant: runtime.variant,
      sampleCount,
      sampleRate,
    },
  });

}

function updateCurrentDisplayRange(request: SpectrogramRequest | null): void {
  const start = clamp(Number(request?.displayStart) || 0, 0, analysisState.duration);
  const end = clamp(
    Number(request?.displayEnd) || analysisState.duration,
    start + (analysisState.sampleRate > 0 ? (1 / analysisState.sampleRate) : 1e-6),
    analysisState.duration || start + 1e-6,
  );

  analysisState.currentDisplayRange = {
    start,
    end,
    pixelWidth: Math.max(1, Math.round(Number(request?.pixelWidth) || surfaceState.pixelWidth || 1)),
    pixelHeight: Math.max(1, Math.round(Number(request?.pixelHeight) || surfaceState.pixelHeight || 1)),
  };
}

function cancelGeneration(generation: unknown): void {
  if (!Number.isFinite(generation)) {
    return;
  }

  analysisState.generationStatus.set(Number(generation), { cancelled: true });
}

function isGenerationCancelled(generation: number): boolean {
  return analysisState.generationStatus.get(generation)?.cancelled === true;
}

function normalizeConfigVersion(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

function getRequestConfigVersion(request: SpectrogramRequest | null): number {
  return normalizeConfigVersion(request?.configVersion);
}

function registerActiveConfigVersion(value: unknown): void {
  const nextConfigVersion = normalizeConfigVersion(value);

  if (nextConfigVersion === analysisState.activeConfigVersion) {
    return;
  }

  analysisState.activeConfigVersion = nextConfigVersion;
  analysisState.generationStatus.clear();
  clearTileCache();
  analysisState.overview = createEmptyLayerState('overview');
  analysisState.visible = createEmptyLayerState('visible');
  pendingOverviewRequest = null;
  pendingVisibleRequest = null;
  paintSpectrogramDisplay();
}

async function pumpOverviewLoop() {
  if (overviewRenderLoopActive) {
    return;
  }

  overviewRenderLoopActive = true;

  try {
    while (pendingOverviewRequest) {
      const request = pendingOverviewRequest;
      pendingOverviewRequest = null;

      await requestQueue;

      if (!request || !analysisState.initialized) {
        continue;
      }

      const runtime = await getRuntime();
      const plan = createRequestPlan({
        ...request,
        generation: 0,
        requestKind: 'overview',
        viewEnd: analysisState.duration,
        viewStart: 0,
      });

      analysisState.overview = {
        generation: 0,
        kind: 'overview',
        plan,
        ready: false,
        requestPending: true,
      };

      const completed = await ensurePlanTiles(runtime, plan, {
        shouldAbort: () => shouldAbortOverviewPlan(plan),
      });

      if (!completed || shouldAbortOverviewPlan(plan)) {
        continue;
      }

      analysisState.overview = {
        generation: 0,
        kind: 'overview',
        plan,
        ready: true,
        requestPending: false,
      };

      paintSpectrogramDisplay();

      self.postMessage({
        type: 'overviewReady',
        body: createLayerReadyBody(plan),
      });
    }
  } catch (error) {
    postError(error);
  } finally {
    overviewRenderLoopActive = false;
  }
}

async function pumpVisibleLoop() {
  if (visibleRenderLoopActive) {
    return;
  }

  visibleRenderLoopActive = true;

  try {
    while (pendingVisibleRequest) {
      const request = pendingVisibleRequest;
      pendingVisibleRequest = null;

      await requestQueue;

      if (!request || !analysisState.initialized) {
        continue;
      }

      updateCurrentDisplayRange(request);
      const plan = createRequestPlan({
        ...request,
        requestKind: 'visible',
        viewEnd: request.requestEnd,
        viewStart: request.requestStart,
      });

      if (isEquivalentPlan(plan, analysisState.visible.plan) && analysisState.visible.ready) {
        analysisState.visible.generation = plan.generation;
        paintSpectrogramDisplay();
        continue;
      }

      analysisState.generationStatus.set(plan.generation, { cancelled: false });
      analysisState.visible = {
        generation: plan.generation,
        kind: 'visible',
        plan,
        ready: false,
        requestPending: true,
      };

      // Repaint immediately against the new viewport instead of stretching the previous raster.
      paintSpectrogramDisplay();

      const completed = await ensurePlanTiles(runtimePromise ? await runtimePromise : await getRuntime(), plan, {
        onTileReady: () => {
          if (analysisState.visible.generation === plan.generation) {
            paintSpectrogramDisplay();
          }
        },
        shouldAbort: () => shouldAbortVisiblePlan(plan),
      });

      if (!completed || shouldAbortVisiblePlan(plan)) {
        continue;
      }

      analysisState.visible = {
        generation: plan.generation,
        kind: 'visible',
        plan,
        ready: true,
        requestPending: false,
      };

      paintSpectrogramDisplay();

      self.postMessage({
        type: 'visibleReady',
        body: createLayerReadyBody(plan),
      });
    }
  } catch (error) {
    postError(error);
  } finally {
    visibleRenderLoopActive = false;
  }
}

function shouldAbortVisiblePlan(plan: RenderRequestPlan): boolean {
  if (plan.configVersion !== analysisState.activeConfigVersion) {
    return true;
  }

  if (isGenerationCancelled(plan.generation)) {
    return true;
  }

  return Boolean(
    pendingVisibleRequest
    && (
      getRequestConfigVersion(pendingVisibleRequest) !== plan.configVersion
      || (
        Number.isFinite(pendingVisibleRequest.generation)
        && Number(pendingVisibleRequest.generation) !== plan.generation
      )
    )
  );
}

function shouldAbortOverviewPlan(plan: RenderRequestPlan): boolean {
  if (plan.configVersion !== analysisState.activeConfigVersion) {
    return true;
  }

  return Boolean(
    pendingOverviewRequest
    && getRequestConfigVersion(pendingOverviewRequest) !== plan.configVersion
  );
}

async function ensurePlanTiles(
  runtime: WaveCoreRuntime,
  plan: RenderRequestPlan,
  options: EnsurePlanTilesOptions = {},
): Promise<boolean> {
  const onTileReady = typeof options.onTileReady === 'function' ? options.onTileReady : null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;

  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    if (shouldAbort?.()) {
      return false;
    }

    const cacheKey = buildTileCacheKey(plan, tileIndex);
    const tileStart = tileIndex * plan.tileDuration;
    const tileEnd = Math.min(analysisState.duration, tileStart + plan.tileDuration);
    const existingTile = getTileRecord(cacheKey);

    if (!existingTile || existingTile.complete !== true) {
      const tileRecord = await renderTile(runtime, plan, tileIndex, tileStart, tileEnd, {
        cacheKey,
        existingTile,
        onChunkReady: onTileReady,
        shouldAbort,
      });

      if (!tileRecord) {
        return false;
      }
    }

    onTileReady?.();
    await yieldToEventLoop();
  }

  return true;
}

function createTileRecord({
  cacheKey,
  rowCount,
  tileEnd,
  tileIndex,
  tileStart,
}: {
  cacheKey: string;
  rowCount: number;
  tileEnd: number;
  tileIndex: number;
  tileStart: number;
}): TileRecord {
  const canvas = new OffscreenCanvas(TILE_COLUMN_COUNT, rowCount);
  const context = canvas.getContext('2d', { alpha: false });

  if (!context) {
    throw new Error('OffscreenCanvas 2D context is unavailable.');
  }

  const imageData = context.createImageData(TILE_COLUMN_COUNT, rowCount);

  return {
    byteLength: TILE_COLUMN_COUNT * rowCount * 4,
    canvas,
    columnCount: TILE_COLUMN_COUNT,
    complete: false,
    context,
    gpuBindGroup: null,
    gpuDirty: true,
    gpuTexture: null,
    gpuTextureView: null,
    gpuUniformBuffer: null,
    imageData,
    renderedColumns: 0,
    rowCount,
    tileEnd,
    tileIndex,
    tileKey: cacheKey,
    tileStart,
  };
}

function drawTileChunk(
  tileRecord: TileRecord,
  rgba: Uint8Array,
  columnOffset: number,
  columnCount: number,
  rowCount: number,
): void {
  const destination = tileRecord.imageData.data;

  if (columnOffset === 0 && columnCount === tileRecord.columnCount) {
    destination.set(rgba);
  } else {
    const sourceRowLength = columnCount * 4;
    const destinationRowLength = tileRecord.columnCount * 4;
    const destinationOffset = columnOffset * 4;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const sourceStart = rowIndex * sourceRowLength;
      const sourceEnd = sourceStart + sourceRowLength;
      const destinationStart = rowIndex * destinationRowLength + destinationOffset;
      destination.set(rgba.subarray(sourceStart, sourceEnd), destinationStart);
    }
  }

  tileRecord.gpuDirty = true;
  tileRecord.context.putImageData(tileRecord.imageData, 0, 0, columnOffset, 0, columnCount, rowCount);
}

function renderTileChunk(
  runtime: WaveCoreRuntime,
  plan: RenderRequestPlan,
  tileIndex: number,
  tileStart: number,
  tileEnd: number,
  tileRecord: TileRecord,
  startColumn: number,
  columnCount: number,
): void {
  const tileSpan = tileEnd - tileStart;
  const chunkStart = tileStart + ((startColumn / TILE_COLUMN_COUNT) * tileSpan);
  const chunkEnd = tileStart + (((startColumn + columnCount) / TILE_COLUMN_COUNT) * tileSpan);
  const byteLength = columnCount * plan.rowCount * 4;

  ensureSpectrogramOutputCapacity(runtime.module, byteLength);

  const ok = runtime.module._wave_render_spectrogram_tile_rgba(
    chunkStart,
    chunkEnd,
    columnCount,
    plan.rowCount,
    plan.fftSize,
    plan.decimationFactor,
    analysisState.minFrequency,
    analysisState.maxFrequency,
    ANALYSIS_TYPE_CODES[plan.analysisType] ?? ANALYSIS_TYPE_CODES.spectrogram,
    FREQUENCY_SCALE_CODES[plan.frequencyScale] ?? FREQUENCY_SCALE_CODES.log,
    analysisState.spectrogramOutputPointer,
  );

  if (!ok) {
    throw new Error(`Spectrogram tile render failed for tile ${tileIndex} chunk ${startColumn}.`);
  }

  const rgba = getHeapU8View(runtime.module, analysisState.spectrogramOutputPointer, byteLength);
  drawTileChunk(tileRecord, rgba, startColumn, columnCount, plan.rowCount);
}

async function renderTile(
  runtime: WaveCoreRuntime,
  plan: RenderRequestPlan,
  tileIndex: number,
  tileStart: number,
  tileEnd: number,
  options: RenderTileOptions = {},
): Promise<TileRecord | null> {
  const cacheKey = typeof options.cacheKey === 'string' ? options.cacheKey : buildTileCacheKey(plan, tileIndex);
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const onChunkReady = typeof options.onChunkReady === 'function' ? options.onChunkReady : null;
  const chunkColumnCount = plan.analysisType === 'scalogram' ? SCALOGRAM_COLUMN_CHUNK_SIZE : TILE_COLUMN_COUNT;
  const existingTile = options.existingTile;
  const tileRecord = existingTile ?? createTileRecord({
    cacheKey,
    rowCount: plan.rowCount,
    tileEnd,
    tileIndex,
    tileStart,
  });

  if (!tileRecord.context) {
    tileRecord.context = tileRecord.canvas.getContext('2d', { alpha: false });
    if (!tileRecord.context) {
      throw new Error('OffscreenCanvas 2D context is unavailable.');
    }
    tileRecord.imageData = tileRecord.context.createImageData(tileRecord.columnCount, tileRecord.rowCount);
  }

  setTileRecord(cacheKey, tileRecord);

  while (tileRecord.renderedColumns < TILE_COLUMN_COUNT) {
    if (shouldAbort?.()) {
      return null;
    }

    const startColumn = tileRecord.renderedColumns;
    const columnCount = Math.min(chunkColumnCount, TILE_COLUMN_COUNT - startColumn);
    renderTileChunk(runtime, plan, tileIndex, tileStart, tileEnd, tileRecord, startColumn, columnCount);
    tileRecord.renderedColumns += columnCount;
    tileRecord.complete = tileRecord.renderedColumns >= TILE_COLUMN_COUNT;
    onChunkReady?.();

    if (chunkColumnCount < TILE_COLUMN_COUNT) {
      await yieldToEventLoop();
    }
  }

  return tileRecord;
}

function paintSpectrogramDisplay(): void {
  const displayRange = analysisState.currentDisplayRange;
  const context = surfaceState.context;

  if (context && surfaceState.webGpu && paintSpectrogramDisplayWithWebGpu(displayRange, context)) {
    return;
  }

  if (!context) {
    return;
  }

  drawBackground(context, surfaceState.pixelWidth, surfaceState.pixelHeight);

  if (!(displayRange.end > displayRange.start)) {
    return;
  }

  if (analysisState.overview.plan) {
    paintLayer(context, analysisState.overview.plan, displayRange, {
      smoothing: true,
      smoothingQuality: 'high',
    });
  }

  if (analysisState.visible.plan) {
    paintLayer(context, analysisState.visible.plan, displayRange, {
      smoothing: true,
      smoothingQuality: 'medium',
    });
  }
}

function paintSpectrogramDisplayWithWebGpu(
  displayRange: AnalysisWorkerState['currentDisplayRange'],
  context: OffscreenCanvasRenderingContext2D,
): boolean {
  const webGpu = surfaceState.webGpu;

  if (!webGpu) {
    return false;
  }

  try {
    const currentTexture = webGpu.canvasContext.getCurrentTexture();
    const commandEncoder = webGpu.device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          clearValue: { a: 1, b: 0, g: 0, r: 0 },
          loadOp: 'clear',
          storeOp: 'store',
          view: currentTexture.createView(),
        },
      ],
    });

    renderPass.setPipeline(webGpu.backgroundPipeline);
    renderPass.draw(6);

    if (displayRange.end > displayRange.start) {
      if (analysisState.overview.plan) {
        paintLayerWithWebGpu(renderPass, webGpu, analysisState.overview.plan, displayRange);
      }

      if (analysisState.visible.plan) {
        paintLayerWithWebGpu(renderPass, webGpu, analysisState.visible.plan, displayRange);
      }
    }

    renderPass.end();
    webGpu.device.queue.submit([commandEncoder.finish()]);
    const presentSerial = surfaceState.webGpuPresentSerial + 1;
    surfaceState.webGpuPresentSerial = presentSerial;
    const width = Math.max(1, surfaceState.pixelWidth);
    const height = Math.max(1, surfaceState.pixelHeight);
    void webGpu.device.queue.onSubmittedWorkDone()
      .then(async () => {
        if (
          surfaceState.webGpu !== webGpu
          || surfaceState.webGpuPresentSerial !== presentSerial
        ) {
          return;
        }

        const imageSource = typeof createImageBitmap === 'function'
          ? await createImageBitmap(webGpu.compositorCanvas)
          : webGpu.compositorCanvas;
        try {
          if (
            surfaceState.webGpu !== webGpu
            || surfaceState.webGpuPresentSerial !== presentSerial
          ) {
            return;
          }

          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, width, height);
          context.drawImage(imageSource, 0, 0, width, height);
        } finally {
          if (imageSource instanceof ImageBitmap) {
            imageSource.close();
          }
        }
      })
      .catch(() => {
        if (surfaceState.webGpu !== webGpu) {
          return;
        }

        destroyWebGpuCompositor();
        surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
        paintSpectrogramDisplay();
      });
    return true;
  } catch {
    destroyWebGpuCompositor();
    surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
    return false;
  }
}

function drawBackground(context: OffscreenCanvasRenderingContext2D, width: number, height: number): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, '#171127');
  background.addColorStop(0.46, '#0d0b19');
  background.addColorStop(1, '#04050c');

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
}

function ensureTileGpuResources(tileRecord: TileRecord, webGpu: WebGpuCompositorState): boolean {
  const globals = getWebGpuGlobals();

  if (!globals) {
    return false;
  }

  const width = Math.max(1, tileRecord.columnCount);
  const height = Math.max(1, tileRecord.rowCount);
  if (!tileRecord.gpuTexture || !tileRecord.gpuUniformBuffer || !tileRecord.gpuBindGroup) {
    destroyTileGpuResources(tileRecord);
    tileRecord.gpuUniformBuffer = webGpu.device.createBuffer({
      size: Float32Array.BYTES_PER_ELEMENT * 4,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM,
    });
    tileRecord.gpuTexture = webGpu.device.createTexture({
      format: WEBGPU_TILE_TEXTURE_FORMAT,
      size: { depthOrArrayLayers: 1, height, width },
      usage: globals.textureUsage.COPY_DST | globals.textureUsage.TEXTURE_BINDING,
    });
    tileRecord.gpuTextureView = tileRecord.gpuTexture.createView();
    tileRecord.gpuBindGroup = webGpu.device.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: { buffer: tileRecord.gpuUniformBuffer },
        },
        {
          binding: 1,
          resource: webGpu.sampler,
        },
        {
          binding: 2,
          resource: tileRecord.gpuTextureView,
        },
      ],
      layout: webGpu.bindGroupLayout,
    });
    tileRecord.gpuDirty = true;
  }

  if (tileRecord.gpuDirty) {
    webGpu.device.queue.writeTexture(
      { texture: tileRecord.gpuTexture },
      tileRecord.imageData.data,
      {
        bytesPerRow: width * 4,
        rowsPerImage: height,
      },
      {
        depthOrArrayLayers: 1,
        height,
        width,
      },
    );
    tileRecord.gpuDirty = false;
  }

  return true;
}

function paintLayerWithWebGpu(
  renderPass: any,
  webGpu: WebGpuCompositorState,
  plan: RenderRequestPlan | null,
  displayRange: AnalysisWorkerState['currentDisplayRange'],
): void {
  if (!plan) {
    return;
  }

  const span = Math.max(1e-6, displayRange.end - displayRange.start);
  const destinationWidth = Math.max(1, surfaceState.pixelWidth);

  renderPass.setPipeline(webGpu.tilePipeline);

  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    const cacheKey = buildTileCacheKey(plan, tileIndex);
    const tile = getTileRecord(cacheKey);

    if (!tile || !ensureTileGpuResources(tile, webGpu) || !tile.gpuBindGroup || !tile.gpuUniformBuffer) {
      continue;
    }

    const tileSpan = Math.max(1e-6, tile.tileEnd - tile.tileStart);
    const overlapStart = Math.max(displayRange.start, tile.tileStart);
    const availableColumns = tile.complete ? tile.columnCount : Math.max(0, tile.renderedColumns ?? 0);
    if (availableColumns <= 0) {
      continue;
    }
    const availableTileEnd = tile.tileStart + ((availableColumns / tile.columnCount) * tileSpan);
    const overlapEnd = Math.min(displayRange.end, availableTileEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const sourceStartRatio = (overlapStart - tile.tileStart) / tileSpan;
    const sourceEndRatio = (overlapEnd - tile.tileStart) / tileSpan;
    const destinationStartRatio = (overlapStart - displayRange.start) / span;
    const destinationEndRatio = (overlapEnd - displayRange.start) / span;
    const sourceX = clamp(Math.floor(sourceStartRatio * tile.columnCount), 0, Math.max(0, tile.columnCount - 1));
    if (sourceX >= availableColumns) {
      continue;
    }
    const sourceWidth = Math.max(
      1,
      Math.min(
        availableColumns - sourceX,
        Math.ceil((sourceEndRatio - sourceStartRatio) * tile.columnCount),
      ),
    );
    const destinationX = Math.floor(destinationStartRatio * destinationWidth);
    const destinationWidthPx = Math.max(
      1,
      Math.ceil((destinationEndRatio - destinationStartRatio) * destinationWidth),
    );
    const uniforms = new Float32Array([
      ((destinationX / destinationWidth) * 2) - 1,
      (((destinationX + destinationWidthPx) / destinationWidth) * 2) - 1,
      sourceX / tile.columnCount,
      (sourceX + sourceWidth) / tile.columnCount,
    ]);

    webGpu.device.queue.writeBuffer(tile.gpuUniformBuffer, 0, uniforms);
    renderPass.setBindGroup(0, tile.gpuBindGroup);
    renderPass.draw(6);
  }
}

function paintLayer(
  context: OffscreenCanvasRenderingContext2D,
  plan: RenderRequestPlan | null,
  displayRange: AnalysisWorkerState['currentDisplayRange'],
  { smoothing, smoothingQuality }: { smoothing: boolean; smoothingQuality: ImageSmoothingQuality },
): void {
  if (!plan) {
    return;
  }

  const span = Math.max(1e-6, displayRange.end - displayRange.start);
  const destinationWidth = Math.max(1, surfaceState.pixelWidth);
  const destinationHeight = Math.max(1, surfaceState.pixelHeight);

  context.imageSmoothingEnabled = smoothing;
  context.imageSmoothingQuality = smoothingQuality;

  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    const cacheKey = buildTileCacheKey(plan, tileIndex);
      const tile = getTileRecord(cacheKey);

    if (!tile) {
      continue;
    }

    const tileSpan = Math.max(1e-6, tile.tileEnd - tile.tileStart);
    const overlapStart = Math.max(displayRange.start, tile.tileStart);
    const availableColumns = tile.complete ? tile.columnCount : Math.max(0, tile.renderedColumns ?? 0);
    if (availableColumns <= 0) {
      continue;
    }
    const availableTileEnd = tile.tileStart + ((availableColumns / tile.columnCount) * tileSpan);
    const overlapEnd = Math.min(displayRange.end, availableTileEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const sourceStartRatio = (overlapStart - tile.tileStart) / tileSpan;
    const sourceEndRatio = (overlapEnd - tile.tileStart) / tileSpan;
    const destinationStartRatio = (overlapStart - displayRange.start) / span;
    const destinationEndRatio = (overlapEnd - displayRange.start) / span;
    const sourceX = clamp(Math.floor(sourceStartRatio * tile.columnCount), 0, Math.max(0, tile.columnCount - 1));
    if (sourceX >= availableColumns) {
      continue;
    }
    const sourceWidth = Math.max(
      1,
      Math.min(
        availableColumns - sourceX,
        Math.ceil((sourceEndRatio - sourceStartRatio) * tile.columnCount),
      ),
    );
    const destinationX = Math.floor(destinationStartRatio * destinationWidth);
    const destinationWidthPx = Math.max(
      1,
      Math.ceil((destinationEndRatio - destinationStartRatio) * destinationWidth),
    );

    context.drawImage(
      tile.canvas,
      sourceX,
      0,
      sourceWidth,
      tile.rowCount,
      destinationX,
      0,
      destinationWidthPx,
      destinationHeight,
    );
  }
}

function createRequestPlan(request: SpectrogramRequest | null): RenderRequestPlan {
  const preset = QUALITY_PRESETS[analysisState.quality];
  const requestKind = request?.requestKind === 'overview' ? 'overview' : 'visible';
  const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
  const configVersion = getRequestConfigVersion(request);
  const requestedStart = Number.isFinite(request?.viewStart) ? Number(request.viewStart) : 0;
  const requestedEnd = Number.isFinite(request?.viewEnd) ? Number(request.viewEnd) : analysisState.duration;
  const viewStart = clamp(requestedStart, 0, analysisState.duration);
  const viewEnd = clamp(
    Math.max(viewStart + (1 / analysisState.sampleRate), requestedEnd),
    viewStart + (1 / analysisState.sampleRate),
    analysisState.duration,
  );
  const requestedDisplayStart = Number.isFinite(request?.displayStart) ? Number(request.displayStart) : viewStart;
  const displayStart = clamp(requestedDisplayStart, 0, analysisState.duration);
  const requestedDisplayEnd = Number.isFinite(request?.displayEnd) ? Number(request.displayEnd) : viewEnd;
  const displayEnd = clamp(
    Math.max(displayStart + (1 / analysisState.sampleRate), requestedDisplayEnd),
    displayStart + (1 / analysisState.sampleRate),
    analysisState.duration,
  );
  const pixelWidth = Math.max(1, Math.round(Number(request?.pixelWidth) || surfaceState.pixelWidth || 1));
  const pixelHeight = Math.max(1, Math.round(Number(request?.pixelHeight) || surfaceState.pixelHeight || 1));
  const dprBucket = Math.max(2, Math.round(Number(request?.dpr) || 2));
  const analysisType = normalizeAnalysisType(request?.analysisType);
  const frequencyScale = getEffectiveFrequencyScale(analysisType, request?.frequencyScale);
  const fftSize = analysisType === 'scalogram' ? 0 : normalizeFftSize(request?.fftSize);
  const overlapRatio = analysisType === 'scalogram' ? 0 : normalizeOverlapRatio(request?.overlapRatio);
  const rowBucketSize = analysisType === 'scalogram' ? SCALOGRAM_ROW_BLOCK_SIZE : ROW_BUCKET_SIZE;
  const rowOversample = requestKind === 'visible' && analysisType !== 'scalogram'
    ? VISIBLE_ROW_OVERSAMPLE
    : 1;
  const rowCount = quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier * rowOversample), rowBucketSize);
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2),
  );
  const hopSamples = analysisType === 'scalogram'
    ? getScalogramHopSamples(analysisState.quality)
    : Math.max(1, Math.round(fftSize * (1 - overlapRatio)));
  const secondsPerColumn = hopSamples / analysisState.sampleRate;
  const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / analysisState.sampleRate);
  const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
  const endTileIndex = Math.max(
    startTileIndex,
    Math.floor(Math.max(viewStart, viewEnd - (secondsPerColumn * 0.5)) / tileDuration),
  );
  const windowSeconds = analysisType === 'scalogram' ? 0 : fftSize / analysisState.sampleRate;
  const decimationFactor = analysisType === 'spectrogram'
    ? Math.max(1, preset.lowFrequencyDecimationFactor || 1)
    : 1;
  const configKey = [
    `type${analysisType}`,
    `scale${frequencyScale}`,
    `fft${fftSize}`,
    `ov${Math.round(overlapRatio * 1000)}`,
    `hop${hopSamples}`,
    `rows${rowCount}`,
  ].join('-');

  return {
    analysisType,
    decimationFactor,
    configKey,
    configVersion,
    displayEnd,
    displayStart,
    dprBucket,
    endTileIndex,
    fftSize,
    frequencyScale,
    generation,
    hopSamples,
    hopSeconds: secondsPerColumn,
    overlapRatio,
    pixelHeight,
    pixelWidth,
    requestKind,
    rowCount,
    startTileIndex,
    targetColumns,
    tileDuration,
    viewEnd,
    viewStart,
    windowSeconds,
  };
}

function buildTileCacheKey(plan: RenderRequestPlan, tileIndex: number): string {
  return [
    analysisState.quality,
    plan.configKey,
    `tile${tileIndex}`,
    `dpr${plan.dprBucket}`,
  ].join(':');
}

function createLayerReadyBody(plan: RenderRequestPlan) {
  return {
    analysisType: plan.analysisType,
    configVersion: plan.configVersion,
    decimationFactor: plan.decimationFactor,
    displayEnd: plan.displayEnd,
    displayStart: plan.displayStart,
    fftSize: plan.fftSize,
    frequencyScale: plan.frequencyScale,
    generation: plan.generation,
    hopSamples: plan.hopSamples,
    hopSeconds: plan.hopSeconds,
    overlapRatio: plan.overlapRatio,
    pixelHeight: plan.pixelHeight,
    pixelWidth: plan.pixelWidth,
    requestKind: plan.requestKind,
    runtimeVariant: analysisState.runtimeVariant,
    targetColumns: plan.targetColumns,
    targetRows: plan.rowCount,
    viewEnd: plan.viewEnd,
    viewStart: plan.viewStart,
    windowSeconds: plan.windowSeconds,
  };
}

function isEquivalentPlan(left: RenderRequestPlan | null, right: RenderRequestPlan | null): boolean {
  if (!left || !right) {
    return false;
  }

  return left.requestKind === right.requestKind
    && left.configVersion === right.configVersion
    && left.analysisType === right.analysisType
    && left.dprBucket === right.dprBucket
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && left.rowCount === right.rowCount
    && left.targetColumns === right.targetColumns
    && left.fftSize === right.fftSize
    && left.frequencyScale === right.frequencyScale
    && Math.abs(left.overlapRatio - right.overlapRatio) <= 1e-6
    && Math.abs(left.viewStart - right.viewStart) <= 1e-6
    && Math.abs(left.viewEnd - right.viewEnd) <= 1e-6;
}

function normalizeFftSize(value: unknown): number {
  const numericValue = Number(value);
  return FFT_SIZE_OPTIONS.includes(numericValue) ? numericValue : 4096;
}

function normalizeOverlapRatio(value: unknown): number {
  const numericValue = Number(value);
  return OVERLAP_RATIO_OPTIONS.includes(numericValue) ? numericValue : 0.75;
}

function ensureSpectrogramOutputCapacity(module: WaveCoreModule, byteLength: number): void {
  if (analysisState.spectrogramOutputCapacity >= byteLength && analysisState.spectrogramOutputPointer) {
    return;
  }

  if (analysisState.spectrogramOutputPointer) {
    module._free(analysisState.spectrogramOutputPointer);
  }

  analysisState.spectrogramOutputPointer = module._malloc(byteLength);
  analysisState.spectrogramOutputCapacity = byteLength;
}

function getHeapF32View(module: WaveCoreModule, pointer: number, length: number): Float32Array {
  return new Float32Array(module.HEAPF32.buffer, pointer, length);
}

function getHeapU8View(module: WaveCoreModule, pointer: number, length: number): Uint8Array {
  return new Uint8Array(module.HEAPU8.buffer, pointer, length);
}

function disposeWasmSession(module: WaveCoreModule): void {
  if (analysisState.spectrogramOutputPointer) {
    module._free(analysisState.spectrogramOutputPointer);
  }

  module._wave_dispose_session();
  analysisState.spectrogramOutputPointer = 0;
  analysisState.spectrogramOutputCapacity = 0;
}

function disposeSession(runtime: WaveCoreRuntime): void {
  if (analysisState.initialized) {
    disposeWasmSession(runtime.module);
  }

  clearTileCache();
  analysisState = createEmptyAnalysisState();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function postError(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);

  self.postMessage({
    type: 'error',
    body: { message: text },
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
