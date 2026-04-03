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
const ENABLE_EXPERIMENTAL_WEBGPU_SPECTROGRAM_COMPUTE = true;
const MAX_WEBGPU_COMPUTE_FFT_SIZE = 4096;
const WEBGPU_TILE_TEXTURE_FORMAT = 'rgba8unorm';
const LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY = 1200;
const MIXED_FREQUENCY_PIVOT_HZ = 1000;
const MIXED_FREQUENCY_PIVOT_RATIO = 0.5;
const MIN_DECIBELS = -80;
const MAX_DECIBELS = 0;
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

const WEBGPU_SPECTROGRAM_INPUT_SHADER = /* wgsl */`
const TWO_PI: f32 = 6.283185307179586;

struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> pcmSamples: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputSpectrum: array<vec2<f32>>;

fn bitReverse(value: u32, bitCount: u32) -> u32 {
  var input = value;
  var result = 0u;
  var bit = 0u;

  loop {
    if (bit >= bitCount) {
      break;
    }
    result = (result << 1u) | (input & 1u);
    input = input >> 1u;
    bit += 1u;
  }

  return result;
}

@compute @workgroup_size(64)
fn prepareSpectrogramInput(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let sampleCount = params.header0.w;
  let fftStages = params.header1.y;
  let decimationFactor = max(params.header1.z, 1u);
  let totalSamples = fftSize * columnCount;
  let linearIndex = globalId.x;

  if (linearIndex >= totalSamples) {
    return;
  }

  let columnIndex = linearIndex / fftSize;
  let sampleOffset = linearIndex % fftSize;
  var centerRatio = 0.5;
  if (columnCount > 1u) {
    centerRatio = (f32(columnIndex) + 0.5) / f32(columnCount);
  }

  let centerTime = params.timing.x + (centerRatio * params.timing.y);
  let centerSample = i32(round(centerTime * params.timing.z));
  let fftSizeI32 = i32(fftSize);
  let sampleOffsetI32 = i32(sampleOffset);
  let decimationFactorI32 = i32(decimationFactor);
  var sample = 0.0;

  if (decimationFactor == 1u) {
    let sourceIndex = centerSample - (fftSizeI32 / 2) + sampleOffsetI32;
    if (sourceIndex >= 0 && u32(sourceIndex) < sampleCount) {
      sample = pcmSamples[u32(sourceIndex)];
    }
  } else {
    let windowStart = centerSample - ((fftSizeI32 * decimationFactorI32) / 2);
    var sum = 0.0;
    var tap = 0i;

    loop {
      if (tap >= decimationFactorI32) {
        break;
      }

      let sourceIndex = windowStart + (sampleOffsetI32 * decimationFactorI32) + tap;
      if (sourceIndex >= 0 && u32(sourceIndex) < sampleCount) {
        sum += pcmSamples[u32(sourceIndex)];
      }
      tap += 1i;
    }

    sample = sum / f32(decimationFactor);
  }

  let denominator = max(f32(max(fftSize, 2u) - 1u), 1.0);
  let phase = TWO_PI * f32(sampleOffset) / denominator;
  let window = 0.54 - (0.46 * cos(phase));
  let reversedIndex = bitReverse(sampleOffset, fftStages);
  outputSpectrum[(columnIndex * fftSize) + reversedIndex] = vec2<f32>(sample * window, 0.0);
}
`;

const WEBGPU_SPECTROGRAM_FFT_SHADER = /* wgsl */`
const TWO_PI: f32 = 6.283185307179586;

struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> sourceSpectrum: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> targetSpectrum: array<vec2<f32>>;

fn complexMul(left: vec2<f32>, right: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    (left.x * right.x) - (left.y * right.y),
    (left.x * right.y) + (left.y * right.x),
  );
}

@compute @workgroup_size(64)
fn runSpectrogramFftStage(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let stageSize = max(params.header1.x, 2u);
  let halfSize = stageSize / 2u;
  let butterfliesPerColumn = fftSize / 2u;
  let totalButterflies = butterfliesPerColumn * columnCount;
  let butterflyIndex = globalId.x;

  if (butterflyIndex >= totalButterflies || halfSize == 0u) {
    return;
  }

  let columnIndex = butterflyIndex / butterfliesPerColumn;
  let localIndex = butterflyIndex % butterfliesPerColumn;
  let groupIndex = localIndex / halfSize;
  let pairOffset = localIndex % halfSize;
  let baseIndex = (columnIndex * fftSize) + (groupIndex * stageSize);
  let evenIndex = baseIndex + pairOffset;
  let oddIndex = evenIndex + halfSize;
  let angle = (-TWO_PI * f32(pairOffset)) / f32(stageSize);
  let twiddle = vec2<f32>(cos(angle), sin(angle));
  let evenValue = sourceSpectrum[evenIndex];
  let oddValue = sourceSpectrum[oddIndex];
  let twiddledOdd = complexMul(oddValue, twiddle);

  targetSpectrum[evenIndex] = evenValue + twiddledOdd;
  targetSpectrum[oddIndex] = evenValue - twiddledOdd;
}
`;

const WEBGPU_SPECTROGRAM_RENDER_SHADER = /* wgsl */`
const LOG10_E: f32 = 0.4342944819032518;
const MIN_DB: f32 = -80.0;
const MAX_DB: f32 = 0.0;

struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding: vec4<f32>,
};

struct RowBand {
  baseStartBin: u32,
  baseEndBin: u32,
  enhancedStartBin: u32,
  enhancedEndBin: u32,
  useEnhanced: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> baseSpectrum: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> enhancedSpectrum: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> rowBands: array<RowBand>;
@group(0) @binding(4) var outputTexture: texture_storage_2d<rgba8unorm, write>;

fn normalizePower(power: f32) -> f32 {
  let decibels = 10.0 * (log(max(power + 1e-14, 1e-20)) * LOG10_E);
  return clamp((decibels - MIN_DB) / (MAX_DB - MIN_DB), 0.0, 1.0);
}

fn paletteColor(normalized: f32) -> vec4<f32> {
  let t = clamp(normalized, 0.0, 1.0);
  var localT = 0.0;
  var startColor = vec3<f32>(0.0, 0.0, 0.0);
  var endColor = vec3<f32>(0.0, 0.0, 0.0);

  if (t < 0.14) {
    localT = t / 0.14;
    startColor = vec3<f32>(4.0, 4.0, 12.0);
    endColor = vec3<f32>(34.0, 17.0, 70.0);
  } else if (t < 0.34) {
    localT = (t - 0.14) / 0.2;
    startColor = vec3<f32>(34.0, 17.0, 70.0);
    endColor = vec3<f32>(91.0, 31.0, 126.0);
  } else if (t < 0.58) {
    localT = (t - 0.34) / 0.24;
    startColor = vec3<f32>(91.0, 31.0, 126.0);
    endColor = vec3<f32>(179.0, 68.0, 112.0);
  } else if (t < 0.82) {
    localT = (t - 0.58) / 0.24;
    startColor = vec3<f32>(179.0, 68.0, 112.0);
    endColor = vec3<f32>(248.0, 143.0, 84.0);
  } else {
    localT = (t - 0.82) / 0.18;
    startColor = vec3<f32>(248.0, 143.0, 84.0);
    endColor = vec3<f32>(252.0, 236.0, 176.0);
  }

  let rgb = (startColor + ((endColor - startColor) * localT)) / 255.0;
  return vec4<f32>(rgb, 1.0);
}

@compute @workgroup_size(8, 8)
fn renderSpectrogramTexture(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let columnIndex = globalId.x;
  let rowIndex = globalId.y;
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let rowCount = params.header0.z;
  let useLowFrequencyEnhancement = params.header1.w != 0u;

  if (columnIndex >= columnCount || rowIndex >= rowCount) {
    return;
  }

  let rowBand = rowBands[rowIndex];
  let useEnhancedBand = useLowFrequencyEnhancement && rowBand.useEnhanced != 0u;
  let startBin = select(rowBand.baseStartBin, rowBand.enhancedStartBin, useEnhancedBand);
  let endBin = select(rowBand.baseEndBin, rowBand.enhancedEndBin, useEnhancedBand);
  let spectrumBaseIndex = columnIndex * fftSize;
  let bandSize = max(1u, endBin - startBin);
  var weightedEnergy = 0.0;
  var totalWeight = 0.0;
  var bin = startBin;

  loop {
    if (bin >= endBin) {
      break;
    }

    var position = 0.5;
    if (bandSize > 1u) {
      position = (f32(bin - startBin) + 0.5) / f32(bandSize);
    }
    let taper = 1.0 - abs((position * 2.0) - 1.0);
    let weight = 0.7 + (taper * 0.3);
    let spectrum = select(
      baseSpectrum[spectrumBaseIndex + bin],
      enhancedSpectrum[spectrumBaseIndex + bin],
      useEnhancedBand,
    );
    let power = dot(spectrum, spectrum) * params.timing.w;
    weightedEnergy += power * weight;
    totalWeight += weight;
    bin += 1u;
  }

  let meanPower = weightedEnergy / max(totalWeight, 1e-8);
  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(
    outputTexture,
    vec2<i32>(i32(columnIndex), targetRow),
    paletteColor(normalizePower(meanPower)),
  );
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
  gpuTextureUsage: number;
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
  samples: Float32Array | null;
  spectrogramOutputCapacity: number;
  spectrogramOutputPointer: number;
  tileCache: Map<string, TileRecord>;
  tileCacheBytes: number;
  visible: LayerState;
}

interface SpectrogramBandLayoutResource {
  buffer: any;
  hasEnhancedRows: boolean;
  key: string;
}

interface WebGpuSpectrogramComputeState {
  bandLayoutResources: Map<string, SpectrogramBandLayoutResource>;
  fftBindGroupLayout: any;
  fftPipeline: any;
  inputBindGroupLayout: any;
  inputPipeline: any;
  pcmBuffer: any;
  pcmSampleCount: number;
  renderBindGroupLayout: any;
  renderPipeline: any;
}

interface WebGpuCompositorState {
  bindGroupLayout: any;
  canvasContext: any;
  canvasFormat: string;
  compositorCanvas: OffscreenCanvas;
  device: any;
  backgroundPipeline: any;
  sampler: any;
  spectrogramCompute: WebGpuSpectrogramComputeState | null;
  spectrogramComputeDisabled: boolean;
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
    samples: null,
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

function destroySpectrogramBandLayoutResources(computeState: WebGpuSpectrogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.bandLayoutResources.values()) {
    if (resource.buffer && typeof resource.buffer.destroy === 'function') {
      resource.buffer.destroy();
    }
  }

  computeState.bandLayoutResources.clear();
}

function destroyWebGpuSpectrogramComputeState(computeState: WebGpuSpectrogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  destroySpectrogramBandLayoutResources(computeState);
  if (computeState.pcmBuffer && typeof computeState.pcmBuffer.destroy === 'function') {
    computeState.pcmBuffer.destroy();
  }
  computeState.pcmBuffer = null;
  computeState.pcmSampleCount = 0;
}

function resetWebGpuComputeSessionResources(): void {
  const computeState = surfaceState.webGpu?.spectrogramCompute ?? null;

  if (!computeState) {
    return;
  }

  destroySpectrogramBandLayoutResources(computeState);
  if (computeState.pcmBuffer && typeof computeState.pcmBuffer.destroy === 'function') {
    computeState.pcmBuffer.destroy();
  }
  computeState.pcmBuffer = null;
  computeState.pcmSampleCount = 0;
}

function destroyTileGpuResources(tileRecord: TileRecord): void {
  if (tileRecord.gpuTexture && typeof tileRecord.gpuTexture.destroy === 'function') {
    tileRecord.gpuTexture.destroy();
  }
  if (tileRecord.gpuUniformBuffer && typeof tileRecord.gpuUniformBuffer.destroy === 'function') {
    tileRecord.gpuUniformBuffer.destroy();
  }

  tileRecord.gpuTexture = null;
  tileRecord.gpuTextureUsage = 0;
  tileRecord.gpuTextureView = null;
  tileRecord.gpuBindGroup = null;
  tileRecord.gpuUniformBuffer = null;
  tileRecord.gpuDirty = true;
}

function destroyWebGpuCompositor(): void {
  for (const tileRecord of analysisState.tileCache.values()) {
    destroyTileGpuResources(tileRecord);
  }

  destroyWebGpuSpectrogramComputeState(surfaceState.webGpu?.spectrogramCompute ?? null);
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
        spectrogramCompute: null,
        spectrogramComputeDisabled: false,
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

function alignTo(value: number, alignment: number): number {
  if (alignment <= 1) {
    return value;
  }

  return Math.ceil(value / alignment) * alignment;
}

function createGpuBufferWithData(device: any, usage: number, data: ArrayBufferView | ArrayBuffer): any {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const size = alignTo(bytes.byteLength, 4);
  const buffer = device.createBuffer({
    mappedAtCreation: true,
    size,
    usage,
  });
  new Uint8Array(buffer.getMappedRange()).set(bytes);
  buffer.unmap();
  return buffer;
}

function createSpectrogramComputeParamsBuffer(
  device: any,
  globals: NonNullable<ReturnType<typeof getWebGpuGlobals>>,
  {
    columnCount,
    decimationFactor,
    fftSize,
    fftStages,
    rowCount,
    sampleCount,
    sampleRate,
    stageSize,
    tileSpan,
    tileStart,
    useLowFrequencyEnhancement,
  }: {
    columnCount: number;
    decimationFactor: number;
    fftSize: number;
    fftStages: number;
    rowCount: number;
    sampleCount: number;
    sampleRate: number;
    stageSize: number;
    tileSpan: number;
    tileStart: number;
    useLowFrequencyEnhancement: boolean;
  },
): any {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  const halfFftSize = Math.max(1, fftSize / 2);
  const powerScale = 1 / (halfFftSize * halfFftSize);

  view.setUint32(0, fftSize, true);
  view.setUint32(4, columnCount, true);
  view.setUint32(8, rowCount, true);
  view.setUint32(12, sampleCount, true);
  view.setUint32(16, stageSize, true);
  view.setUint32(20, fftStages, true);
  view.setUint32(24, decimationFactor, true);
  view.setUint32(28, useLowFrequencyEnhancement ? 1 : 0, true);
  view.setFloat32(32, tileStart, true);
  view.setFloat32(36, tileSpan, true);
  view.setFloat32(40, sampleRate, true);
  view.setFloat32(44, powerScale, true);

  return createGpuBufferWithData(device, globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM, buffer);
}

function initializeWebGpuSpectrogramCompute(webGpu: WebGpuCompositorState): WebGpuSpectrogramComputeState | null {
  if (!ENABLE_EXPERIMENTAL_WEBGPU_SPECTROGRAM_COMPUTE || webGpu.spectrogramComputeDisabled) {
    return null;
  }

  if (webGpu.spectrogramCompute) {
    return webGpu.spectrogramCompute;
  }

  const globals = getWebGpuGlobals();
  if (!globals) {
    webGpu.spectrogramComputeDisabled = true;
    return null;
  }
  if (!Number.isFinite(globals.textureUsage.STORAGE_BINDING)) {
    webGpu.spectrogramComputeDisabled = true;
    return null;
  }

  try {
    const inputModule = webGpu.device.createShaderModule({ code: WEBGPU_SPECTROGRAM_INPUT_SHADER });
    const fftModule = webGpu.device.createShaderModule({ code: WEBGPU_SPECTROGRAM_FFT_SHADER });
    const renderModule = webGpu.device.createShaderModule({ code: WEBGPU_SPECTROGRAM_RENDER_SHADER });
    const inputBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { type: 'uniform' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 1,
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 2,
          buffer: { type: 'storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    const fftBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { type: 'uniform' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 1,
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 2,
          buffer: { type: 'storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    const renderBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { type: 'uniform' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 1,
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 2,
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 3,
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 4,
          storageTexture: {
            access: 'write-only',
            format: WEBGPU_TILE_TEXTURE_FORMAT as any,
            viewDimension: '2d',
          },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });

    webGpu.spectrogramCompute = {
      bandLayoutResources: new Map(),
      fftBindGroupLayout,
      fftPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'runSpectrogramFftStage',
          module: fftModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [fftBindGroupLayout],
        }),
      }),
      inputBindGroupLayout,
      inputPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'prepareSpectrogramInput',
          module: inputModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [inputBindGroupLayout],
        }),
      }),
      pcmBuffer: null,
      pcmSampleCount: 0,
      renderBindGroupLayout,
      renderPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'renderSpectrogramTexture',
          module: renderModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderBindGroupLayout],
        }),
      }),
    };
  } catch {
    webGpu.spectrogramComputeDisabled = true;
    webGpu.spectrogramCompute = null;
    return null;
  }

  return webGpu.spectrogramCompute;
}

function ensureWebGpuPcmBuffer(
  webGpu: WebGpuCompositorState,
  computeState: WebGpuSpectrogramComputeState,
): boolean {
  const globals = getWebGpuGlobals();
  const samples = analysisState.samples;

  if (!globals || !samples || samples.length <= 0) {
    return false;
  }

  if (computeState.pcmBuffer && computeState.pcmSampleCount === samples.length) {
    return true;
  }

  if (computeState.pcmBuffer && typeof computeState.pcmBuffer.destroy === 'function') {
    computeState.pcmBuffer.destroy();
  }

  computeState.pcmBuffer = createGpuBufferWithData(
    webGpu.device,
    globals.bufferUsage.COPY_DST | globals.bufferUsage.STORAGE,
    samples,
  );
  computeState.pcmSampleCount = samples.length;
  return true;
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
    resetWebGpuComputeSessionResources();

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
    analysisState.samples = pcmSource;
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
    gpuTextureUsage: 0,
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

  if (canUseWebGpuSpectrogramCompute(plan)) {
    if (surfaceState.webGpuInitPromise && !surfaceState.webGpu) {
      await surfaceState.webGpuInitPromise;
    }

    if (surfaceState.webGpu && await renderSpectrogramTileWithWebGpu(plan, tileRecord, tileStart, tileEnd)) {
      onChunkReady?.();
      return tileRecord;
    }
  }

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

function getFftStageCount(fftSize: number): number {
  return Math.max(1, Math.round(Math.log2(Math.max(2, fftSize))));
}

function getMixedFrequencyPivot(minFrequency: number, maxFrequency: number): number {
  return clamp(MIXED_FREQUENCY_PIVOT_HZ, minFrequency, maxFrequency);
}

function getBandStartFrequencyForRow(
  row: number,
  rows: number,
  minFrequency: number,
  maxFrequency: number,
  scale: FrequencyScale,
): number {
  const safeRows = Math.max(1, rows);
  const ratio = row / safeRows;

  if (scale === 'linear') {
    return minFrequency + ((maxFrequency - minFrequency) * ratio);
  }

  if (scale === 'log') {
    return minFrequency * Math.exp(Math.log(maxFrequency / minFrequency) * ratio);
  }

  const pivot = getMixedFrequencyPivot(minFrequency, maxFrequency);
  if (ratio <= MIXED_FREQUENCY_PIVOT_RATIO || pivot >= maxFrequency) {
    const lowerRatio = MIXED_FREQUENCY_PIVOT_RATIO <= 0
      ? 0
      : ratio / MIXED_FREQUENCY_PIVOT_RATIO;
    return minFrequency + ((pivot - minFrequency) * lowerRatio);
  }

  const upperRatio = (ratio - MIXED_FREQUENCY_PIVOT_RATIO) / (1 - MIXED_FREQUENCY_PIVOT_RATIO);
  return pivot * Math.exp(Math.log(maxFrequency / pivot) * upperRatio);
}

function getBandEndFrequencyForRow(
  row: number,
  rows: number,
  minFrequency: number,
  maxFrequency: number,
  scale: FrequencyScale,
): number {
  const safeRows = Math.max(1, rows);
  const ratio = (row + 1) / safeRows;

  if (scale === 'linear') {
    return minFrequency + ((maxFrequency - minFrequency) * ratio);
  }

  if (scale === 'log') {
    return minFrequency * Math.exp(Math.log(maxFrequency / minFrequency) * ratio);
  }

  const pivot = getMixedFrequencyPivot(minFrequency, maxFrequency);
  if (ratio <= MIXED_FREQUENCY_PIVOT_RATIO || pivot >= maxFrequency) {
    const lowerRatio = MIXED_FREQUENCY_PIVOT_RATIO <= 0
      ? 0
      : ratio / MIXED_FREQUENCY_PIVOT_RATIO;
    return minFrequency + ((pivot - minFrequency) * lowerRatio);
  }

  const upperRatio = (ratio - MIXED_FREQUENCY_PIVOT_RATIO) / (1 - MIXED_FREQUENCY_PIVOT_RATIO);
  return pivot * Math.exp(Math.log(maxFrequency / pivot) * upperRatio);
}

function createSpectrogramBandRanges({
  fftSize,
  frequencyScale,
  maxFrequency,
  minFrequency,
  rowCount,
  sampleRate,
}: {
  fftSize: number;
  frequencyScale: FrequencyScale;
  maxFrequency: number;
  minFrequency: number;
  rowCount: number;
  sampleRate: number;
}): Array<{ endBin: number; endFrequency: number; startBin: number; startFrequency: number }> {
  const rows = Math.max(1, rowCount);
  const nyquist = sampleRate / 2;
  const maximumBin = Math.max(2, Math.trunc(fftSize / 2));
  const safeMinFrequency = Math.max(1, minFrequency);
  const safeMaxFrequency = frequencyScale === 'log'
    ? Math.max(safeMinFrequency * 1.01, maxFrequency)
    : Math.max(safeMinFrequency + 1, maxFrequency);
  const ranges = new Array(rows);

  for (let row = 0; row < rows; row += 1) {
    const startFrequency = frequencyScale === 'log'
      ? safeMinFrequency * Math.exp(Math.log(safeMaxFrequency / safeMinFrequency) * (row / rows))
      : getBandStartFrequencyForRow(row, rows, safeMinFrequency, safeMaxFrequency, frequencyScale);
    const endFrequency = frequencyScale === 'log'
      ? safeMinFrequency * Math.exp(Math.log(safeMaxFrequency / safeMinFrequency) * ((row + 1) / rows))
      : getBandEndFrequencyForRow(row, rows, safeMinFrequency, safeMaxFrequency, frequencyScale);
    const startBin = clamp(
      Math.floor((startFrequency / nyquist) * maximumBin),
      1,
      maximumBin - 1,
    );
    const endBin = clamp(
      Math.ceil((endFrequency / nyquist) * maximumBin),
      startBin + 1,
      maximumBin,
    );

    ranges[row] = {
      endBin,
      endFrequency,
      startBin,
      startFrequency,
    };
  }

  return ranges;
}

function createBandRangesForSampleRate(
  templateRanges: Array<{ endBin: number; endFrequency: number; startBin: number; startFrequency: number }>,
  fftSize: number,
  sampleRate: number,
  minFrequency: number,
  maxFrequency: number,
): Array<{ endBin: number; endFrequency: number; startBin: number; startFrequency: number }> {
  const nyquist = sampleRate / 2;
  const maximumBin = Math.max(2, Math.trunc(fftSize / 2));

  return templateRanges.map((templateRange) => {
    const startFrequency = Math.min(Math.max(minFrequency, templateRange.startFrequency), maxFrequency * 0.999);
    const endFrequency = Math.min(maxFrequency, Math.max(startFrequency * 1.01, templateRange.endFrequency));
    const startBin = clamp(
      Math.floor((startFrequency / nyquist) * maximumBin),
      1,
      maximumBin - 1,
    );
    const endBin = clamp(
      Math.ceil((endFrequency / nyquist) * maximumBin),
      startBin + 1,
      maximumBin,
    );

    return {
      endBin,
      endFrequency,
      startBin,
      startFrequency,
    };
  });
}

function buildSpectrogramBandLayoutCacheKey(plan: RenderRequestPlan): string {
  return [
    `fft${plan.fftSize}`,
    `scale${plan.frequencyScale}`,
    `rows${plan.rowCount}`,
    `dec${plan.decimationFactor}`,
    `sr${analysisState.sampleRate}`,
    `min${analysisState.minFrequency}`,
    `max${analysisState.maxFrequency}`,
  ].join(':');
}

function getSpectrogramBandLayoutResource(
  plan: RenderRequestPlan,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuSpectrogramComputeState,
): SpectrogramBandLayoutResource | null {
  const globals = getWebGpuGlobals();

  if (!globals) {
    return null;
  }

  const cacheKey = buildSpectrogramBandLayoutCacheKey(plan);
  const cached = computeState.bandLayoutResources.get(cacheKey) ?? null;
  if (cached) {
    return cached;
  }

  const baseRanges = createSpectrogramBandRanges({
    fftSize: plan.fftSize,
    frequencyScale: plan.frequencyScale,
    maxFrequency: analysisState.maxFrequency,
    minFrequency: analysisState.minFrequency,
    rowCount: plan.rowCount,
    sampleRate: analysisState.sampleRate,
  });
  let enhancedRanges = baseRanges;
  let lowFrequencyMaximum = 0;

  if (plan.decimationFactor > 1) {
    const effectiveSampleRate = analysisState.sampleRate / plan.decimationFactor;
    lowFrequencyMaximum = Math.min(
      LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY,
      Math.min((effectiveSampleRate / 2) * 0.92, analysisState.maxFrequency),
    );

    if (lowFrequencyMaximum > analysisState.minFrequency * 1.25) {
      enhancedRanges = createBandRangesForSampleRate(
        baseRanges,
        plan.fftSize,
        effectiveSampleRate,
        analysisState.minFrequency,
        lowFrequencyMaximum,
      );
    }
  }

  const bandData = new Uint32Array(plan.rowCount * 8);
  let hasEnhancedRows = false;

  for (let row = 0; row < plan.rowCount; row += 1) {
    const baseRange = baseRanges[row];
    const enhancedRange = enhancedRanges[row] ?? baseRange;
    const useEnhancedRow = lowFrequencyMaximum > 0 && baseRange.endFrequency <= lowFrequencyMaximum;
    const offset = row * 8;

    bandData[offset] = baseRange.startBin;
    bandData[offset + 1] = baseRange.endBin;
    bandData[offset + 2] = enhancedRange.startBin;
    bandData[offset + 3] = enhancedRange.endBin;
    bandData[offset + 4] = useEnhancedRow ? 1 : 0;
    hasEnhancedRows ||= useEnhancedRow;
  }

  const resource = {
    buffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, bandData),
    hasEnhancedRows,
    key: cacheKey,
  };
  computeState.bandLayoutResources.set(cacheKey, resource);
  return resource;
}

function destroyGpuBuffers(buffers: any[]): void {
  for (const buffer of buffers) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }
}

function canUseWebGpuSpectrogramCompute(plan: RenderRequestPlan): boolean {
  return ENABLE_EXPERIMENTAL_WEBGPU_SPECTROGRAM_COMPUTE
    && plan.analysisType === 'spectrogram'
    && plan.fftSize > 0
    && plan.fftSize <= MAX_WEBGPU_COMPUTE_FFT_SIZE
    && analysisState.sampleRate > 0
    && analysisState.sampleCount > 0
    && analysisState.samples instanceof Float32Array
    && analysisState.samples.length >= analysisState.sampleCount;
}

async function renderSpectrogramTileWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
): Promise<boolean> {
  const webGpu = surfaceState.webGpu;
  const globals = getWebGpuGlobals();

  if (!webGpu || !globals) {
    return false;
  }

  const computeState = initializeWebGpuSpectrogramCompute(webGpu);
  if (!computeState || !ensureWebGpuPcmBuffer(webGpu, computeState)) {
    return false;
  }

  const bandLayoutResource = getSpectrogramBandLayoutResource(plan, webGpu, computeState);
  if (!bandLayoutResource) {
    return false;
  }

  if (!ensureTileGpuResources(tileRecord, webGpu, { requiresStorage: true, uploadIfDirty: false })) {
    return false;
  }

  const fftStages = getFftStageCount(plan.fftSize);
  const columnCount = tileRecord.columnCount;
  const sampleCount = analysisState.sampleCount;
  const tileSpan = Math.max((1 / analysisState.sampleRate), tileEnd - tileStart);
  const spectrumByteLength = columnCount * plan.fftSize * Float32Array.BYTES_PER_ELEMENT * 2;
  const temporaryBuffers: any[] = [];
  const parameterBuffers: any[] = [];

  try {
    const createSpectrumBuffer = () => {
      const buffer = webGpu.device.createBuffer({
        size: spectrumByteLength,
        usage: globals.bufferUsage.STORAGE,
      });
      temporaryBuffers.push(buffer);
      return buffer;
    };

    const baseBufferA = createSpectrumBuffer();
    const baseBufferB = createSpectrumBuffer();
    const useLowFrequencyEnhancement = bandLayoutResource.hasEnhancedRows && plan.decimationFactor > 1;
    const lowBufferA = useLowFrequencyEnhancement ? createSpectrumBuffer() : null;
    const lowBufferB = useLowFrequencyEnhancement ? createSpectrumBuffer() : null;
    const trackParameterBuffer = (buffer: any) => {
      parameterBuffers.push(buffer);
      return buffer;
    };
    const buildParameterBuffer = (stageSize: number, decimationFactor: number, useLowBands: boolean) => trackParameterBuffer(
      createSpectrogramComputeParamsBuffer(webGpu.device, globals, {
        columnCount,
        decimationFactor,
        fftSize: plan.fftSize,
        fftStages,
        rowCount: plan.rowCount,
        sampleCount,
        sampleRate: analysisState.sampleRate,
        stageSize,
        tileSpan,
        tileStart,
        useLowFrequencyEnhancement: useLowBands,
      }),
    );
    const prepareBaseParams = buildParameterBuffer(0, 1, useLowFrequencyEnhancement);
    const renderParams = buildParameterBuffer(0, 1, useLowFrequencyEnhancement);

    const commandEncoder = webGpu.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();

    computePass.setPipeline(computeState.inputPipeline);
    computePass.setBindGroup(0, webGpu.device.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: { buffer: prepareBaseParams },
        },
        {
          binding: 1,
          resource: { buffer: computeState.pcmBuffer },
        },
        {
          binding: 2,
          resource: { buffer: baseBufferA },
        },
      ],
      layout: computeState.inputBindGroupLayout,
    }));
    computePass.dispatchWorkgroups(Math.ceil((columnCount * plan.fftSize) / 64));

    if (useLowFrequencyEnhancement && lowBufferA) {
      const prepareLowParams = buildParameterBuffer(0, plan.decimationFactor, useLowFrequencyEnhancement);
      computePass.setBindGroup(0, webGpu.device.createBindGroup({
        entries: [
          {
            binding: 0,
            resource: { buffer: prepareLowParams },
          },
          {
            binding: 1,
            resource: { buffer: computeState.pcmBuffer },
          },
          {
            binding: 2,
            resource: { buffer: lowBufferA },
          },
        ],
        layout: computeState.inputBindGroupLayout,
      }));
      computePass.dispatchWorkgroups(Math.ceil((columnCount * plan.fftSize) / 64));
    }

    computePass.setPipeline(computeState.fftPipeline);
    let activeBaseSource = baseBufferA;
    let activeBaseTarget = baseBufferB;

    for (let stage = 0; stage < fftStages; stage += 1) {
      const stageParams = buildParameterBuffer(1 << (stage + 1), 1, useLowFrequencyEnhancement);
      computePass.setBindGroup(0, webGpu.device.createBindGroup({
        entries: [
          {
            binding: 0,
            resource: { buffer: stageParams },
          },
          {
            binding: 1,
            resource: { buffer: activeBaseSource },
          },
          {
            binding: 2,
            resource: { buffer: activeBaseTarget },
          },
        ],
        layout: computeState.fftBindGroupLayout,
      }));
      computePass.dispatchWorkgroups(Math.ceil((columnCount * (plan.fftSize / 2)) / 64));
      [activeBaseSource, activeBaseTarget] = [activeBaseTarget, activeBaseSource];
    }

    let activeLowSource = activeBaseSource;
    if (useLowFrequencyEnhancement && lowBufferA && lowBufferB) {
      activeLowSource = lowBufferA;
      let activeLowTarget = lowBufferB;

      for (let stage = 0; stage < fftStages; stage += 1) {
        const stageParams = buildParameterBuffer(1 << (stage + 1), plan.decimationFactor, useLowFrequencyEnhancement);
        computePass.setBindGroup(0, webGpu.device.createBindGroup({
          entries: [
            {
              binding: 0,
              resource: { buffer: stageParams },
            },
            {
              binding: 1,
              resource: { buffer: activeLowSource },
            },
            {
              binding: 2,
              resource: { buffer: activeLowTarget },
            },
          ],
          layout: computeState.fftBindGroupLayout,
        }));
        computePass.dispatchWorkgroups(Math.ceil((columnCount * (plan.fftSize / 2)) / 64));
        [activeLowSource, activeLowTarget] = [activeLowTarget, activeLowSource];
      }
    }

    computePass.setPipeline(computeState.renderPipeline);
    computePass.setBindGroup(0, webGpu.device.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: { buffer: renderParams },
        },
        {
          binding: 1,
          resource: { buffer: activeBaseSource },
        },
        {
          binding: 2,
          resource: { buffer: activeLowSource },
        },
        {
          binding: 3,
          resource: { buffer: bandLayoutResource.buffer },
        },
        {
          binding: 4,
          resource: tileRecord.gpuTextureView,
        },
      ],
      layout: computeState.renderBindGroupLayout,
    }));
    computePass.dispatchWorkgroups(
      Math.ceil(columnCount / 8),
      Math.ceil(plan.rowCount / 8),
    );
    computePass.end();

    webGpu.device.queue.submit([commandEncoder.finish()]);
    await webGpu.device.queue.onSubmittedWorkDone();
    tileRecord.gpuDirty = false;
    tileRecord.renderedColumns = tileRecord.columnCount;
    tileRecord.complete = true;
    return true;
  } catch {
    destroyTileGpuResources(tileRecord);
    return false;
  } finally {
    destroyGpuBuffers(parameterBuffers);
    destroyGpuBuffers(temporaryBuffers);
  }
}

function ensureTileGpuResources(
  tileRecord: TileRecord,
  webGpu: WebGpuCompositorState,
  options: {
    requiresStorage?: boolean;
    uploadIfDirty?: boolean;
  } = {},
): boolean {
  const globals = getWebGpuGlobals();

  if (!globals) {
    return false;
  }

  const width = Math.max(1, tileRecord.columnCount);
  const height = Math.max(1, tileRecord.rowCount);
  const requiresStorage = options.requiresStorage === true;
  const uploadIfDirty = options.uploadIfDirty !== false;
  const storageUsage = requiresStorage && Number.isFinite(globals.textureUsage.STORAGE_BINDING)
    ? globals.textureUsage.STORAGE_BINDING
    : 0;
  const requiredTextureUsage = globals.textureUsage.COPY_DST | globals.textureUsage.TEXTURE_BINDING | storageUsage;
  const hasRequiredTextureUsage = Boolean(
    tileRecord.gpuTexture
    && tileRecord.gpuTextureUsage
    && (tileRecord.gpuTextureUsage & requiredTextureUsage) === requiredTextureUsage,
  );

  if (!tileRecord.gpuUniformBuffer) {
    tileRecord.gpuUniformBuffer = webGpu.device.createBuffer({
      size: Float32Array.BYTES_PER_ELEMENT * 4,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM,
    });
  }

  if (!hasRequiredTextureUsage) {
    if (tileRecord.gpuTexture && typeof tileRecord.gpuTexture.destroy === 'function') {
      tileRecord.gpuTexture.destroy();
    }
    tileRecord.gpuTexture = null;
    tileRecord.gpuTextureView = null;
    tileRecord.gpuBindGroup = null;
    tileRecord.gpuTexture = webGpu.device.createTexture({
      format: WEBGPU_TILE_TEXTURE_FORMAT,
      size: { depthOrArrayLayers: 1, height, width },
      usage: requiredTextureUsage,
    });
    tileRecord.gpuTextureUsage = requiredTextureUsage;
    tileRecord.gpuTextureView = tileRecord.gpuTexture.createView();
    tileRecord.gpuDirty = true;
  }

  if (!tileRecord.gpuBindGroup || !tileRecord.gpuTextureView) {
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
  }

  if (uploadIfDirty && tileRecord.gpuDirty) {
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

  resetWebGpuComputeSessionResources();
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
