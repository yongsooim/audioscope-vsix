import { loadWaveCoreRuntime, type WaveCoreModule, type WaveCoreRuntime } from './waveCoreRuntime';
import {
  TILE_COLUMN_COUNT,
  quantizeCeil,
} from './sharedBuffers';
import {
  buildConstantQFrequencies,
  buildCqtChromaAssignments,
  CHROMA_BIN_COUNT,
  CQT_DEFAULT_BINS_PER_OCTAVE,
  CQT_DEFAULT_FMIN,
} from './chromaShared';
import {
  getWindowValue,
  normalizeSpectrogramWindowFunction,
  type SpectrogramWindowFunction,
  WINDOW_FUNCTION_CODES,
} from './windowShared';
import {
  ANALYSIS_TYPE_CODES,
  COLORMAP_DISTRIBUTION_GAMMAS,
  DEFAULT_MFCC_COEFFICIENT_COUNT,
  DEFAULT_MFCC_MEL_BAND_COUNT,
  DEFAULT_SCALOGRAM_HOP_SAMPLES,
  DEFAULT_SCALOGRAM_OMEGA0,
  DEFAULT_SCALOGRAM_ROW_DENSITY,
  ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR,
  ENABLE_EXPERIMENTAL_WEBGPU_SCALOGRAM_FFT,
  ENABLE_EXPERIMENTAL_WEBGPU_SPECTROGRAM_COMPUTE,
  FFT_SIZE_OPTIONS,
  FREQUENCY_SCALE_CODES,
  LIBROSA_DEFAULT_MEL_BAND_COUNT,
  LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY,
  MAX_DECIBELS,
  MAX_FREQUENCY,
  MAX_SCALOGRAM_FFT_WINDOW_CACHE_ENTRIES,
  MAX_TILE_CACHE_BYTES,
  MAX_TILE_CACHE_ENTRIES,
  MEL_BAND_COUNT_OPTIONS,
  MFCC_COEFFICIENT_OPTIONS,
  MIN_DECIBELS,
  MIN_FREQUENCY,
  MIXED_FREQUENCY_PIVOT_HZ,
  MIXED_FREQUENCY_PIVOT_RATIO,
  OVERLAP_RATIO_OPTIONS,
  QUALITY_PRESETS,
  ROW_BUCKET_SIZE,
  SLANEY_MEL_FREQUENCY_MIN,
  SLANEY_MEL_FREQUENCY_STEP,
  SLANEY_MEL_LOG_REGION_START_HZ,
  SLANEY_MEL_LOG_REGION_START_MEL,
  SLANEY_MEL_LOG_STEP,
  SCALOGRAM_COLUMN_CHUNK_SIZE,
  SCALOGRAM_FFT_MAX_INPUT_SAMPLES,
  SCALOGRAM_FFT_ROW_BATCH_SIZE,
  SCALOGRAM_HOP_SAMPLES_OPTIONS,
  SCALOGRAM_ROW_BLOCK_SIZE,
  SCALOGRAM_ROW_DENSITY_OPTIONS,
  SCALOGRAM_OMEGA_OPTIONS,
  SPECTROGRAM_COLUMN_CHUNK_SIZE,
  SPECTROGRAM_DB_WINDOW_LIMITS,
  VISIBLE_ROW_OVERSAMPLE,
  WEBGPU_LINEAR_WORKGROUP_SIZE,
  WEBGPU_OVERVIEW_TILE_SUBMIT_BATCH_SIZE,
  WEBGPU_SCALOGRAM_FFT_PARAM_ENTRY_COUNT,
  WEBGPU_STFT_PARAM_ENTRIES_PER_SLOT,
  WEBGPU_STFT_SCRATCH_SLOT_COUNT,
  WEBGPU_TILE_TEXTURE_FORMAT,
  WEBGPU_VISIBLE_TILE_SUBMIT_BATCH_SIZE,
} from './audio-analysis/constants';
import {
  WEBGPU_BACKGROUND_SHADER,
  WEBGPU_CQT_CHROMA_RENDER_SHADER,
  WEBGPU_CQT_VALUES_SHADER,
  WEBGPU_MEL_ANALYSIS_FUNCTIONS,
  WEBGPU_MEL_ANALYSIS_SHADER_HELPERS,
  WEBGPU_MEL_RENDER_SHADER,
  WEBGPU_MFCC_MEL_VALUES_SHADER,
  WEBGPU_MFCC_RENDER_SHADER,
  WEBGPU_PALETTE_SHADER_HELPERS,
  WEBGPU_SCALOGRAM_FFT_MULTIPLY_SHADER,
  WEBGPU_SCALOGRAM_FFT_RENDER_SHADER,
  WEBGPU_SCALOGRAM_FFT_SHADER,
  WEBGPU_SCALOGRAM_RENDER_SHADER,
  WEBGPU_SPECTROGRAM_FFT_SHADER,
  WEBGPU_SPECTROGRAM_INPUT_SHADER,
  WEBGPU_SPECTROGRAM_RENDER_SHADER,
  WEBGPU_TILE_SHADER,
} from './audio-analysis/shaders';

type QualityPreset = 'balanced' | 'high' | 'max';
type AnalysisType = 'chroma' | 'mel' | 'mfcc' | 'scalogram' | 'spectrogram';
type ColormapDistribution = keyof typeof COLORMAP_DISTRIBUTION_GAMMAS;
type FrequencyScale = 'linear' | 'log' | 'mixed';
type WindowFunction = SpectrogramWindowFunction;
type LayerKind = 'overview' | 'visible';
type SurfaceBackend = '2d' | 'initializing' | 'uninitialized' | 'webgpu';
type AnalysisRenderBackend = '2d-wasm' | 'webgpu-native';
type SurfaceResetReason = 'device-lost' | 'surface-invalid';

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
  colormapDistribution?: ColormapDistribution;
  configVersion?: number;
  displayEnd?: number;
  displayStart?: number;
  dpr?: number;
  fftSize?: number;
  frequencyScale?: FrequencyScale;
  generation?: number;
  maxDecibels?: number;
  melBandCount?: number;
  mfccCoefficientCount?: number;
  mfccMelBandCount?: number;
  minDecibels?: number;
  overlapRatio?: number;
  windowFunction?: WindowFunction;
  scalogramHopSamples?: number;
  scalogramMaxFrequency?: number;
  scalogramMinFrequency?: number;
  scalogramOmega0?: number;
  scalogramRowDensity?: number;
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
  retainedPlan: RenderRequestPlan | null;
  requestPending: boolean;
}

interface TileRecord {
  byteLength: number;
  canvas: OffscreenCanvas | null;
  columnCount: number;
  complete: boolean;
  context: OffscreenCanvasRenderingContext2D | null;
  gpuBindGroup: any;
  gpuDirty: boolean;
  gpuTexture: any;
  gpuTextureUsage: number;
  gpuTextureView: any;
  imageData: ImageData | null;
  renderedColumns: number;
  rowCount: number;
  tileEnd: number;
  tileIndex: number;
  tileKey: string;
  tileStart: number;
}

interface RenderRequestPlan {
  analysisType: AnalysisType;
  colormapDistribution: ColormapDistribution;
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
  maxDecibels: number;
  maxFrequency: number;
  melBandCount: number;
  mfccCoefficientCount: number;
  minDecibels: number;
  minFrequency: number;
  overlapRatio: number;
  pixelHeight: number;
  pixelWidth: number;
  requestKind: LayerKind;
  rowCount: number;
  scalogramOmega0: number;
  scalogramRowDensity: number;
  startTileIndex: number;
  targetColumns: number;
  tileDuration: number;
  viewEnd: number;
  viewStart: number;
  windowFunction: WindowFunction;
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
  deferWebGpuReady?: boolean;
  webGpuSlotIndex?: number;
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

interface WeightedBandLayoutResource {
  bandCount: number;
  binBuffer: any;
  key: string;
  rowBuffer: any;
  weightBuffer: any;
}

type WebGpuStftLayoutResource = SpectrogramBandLayoutResource | WeightedBandLayoutResource;

interface MfccDctBasisResource {
  bandCount: number;
  buffer: any;
  coefficientCount: number;
  key: string;
}

interface ScalogramKernelResource {
  key: string;
  rowBuffer: any;
  tapBuffer: any;
}

interface WebGpuCqtKernelResource {
  binCount: number;
  chromaAssignmentBuffer: any;
  key: string;
  rowBuffer: any;
  tapBuffer: any;
}

interface ScalogramFftResource {
  halfFftSize: number;
  key: string;
  maxSupportSamples: number;
  rowBuffer: any;
  spectrumBuffer: any;
}

interface ScalogramFftWindowResource {
  fftSize: number;
  inputSampleCount: number;
  key: string;
  lastUsedSerial: number;
  planKey: string;
  spectrumBuffer: any;
  windowStartSample: number;
}

interface WebGpuStftScratchSlot {
  baseInputBindGroup: any;
  basePingBuffer: any;
  basePongBuffer: any;
  fftBindGroupForward: any;
  fftBindGroupReverse: any;
  mfccMelBuffer: any;
  mfccMelBufferCapacity: number;
  lowInputBindGroup: any;
  lowPingBuffer: any;
  lowPongBuffer: any;
  lowStageBindGroupForward: any;
  lowStageBindGroupReverse: any;
}

interface WebGpuStftComputeState {
  bandLayoutResources: Map<string, WebGpuStftLayoutResource>;
  fftBindGroupLayout: any;
  fftPipeline: any;
  inputBindGroupLayout: any;
  inputPipeline: any;
  mfccBasisResources: Map<string, MfccDctBasisResource>;
  paramBuffer: any;
  paramSetStride: number;
  paramStride: number;
  pcmBuffer: any;
  pcmSampleCount: number;
  renderMfccBindGroupLayout: any;
  renderMfccPipeline: any;
  renderMelEnergyBindGroupLayout: any;
  renderMelEnergyPipeline: any;
  renderMelBindGroupLayout: any;
  renderMelPipeline: any;
  renderSpectrogramBindGroupLayout: any;
  renderSpectrogramPipeline: any;
  scratchFftSize: number;
  scratchSlots: WebGpuStftScratchSlot[];
}

interface WebGpuScalogramComputeState {
  fftBindGroupLayout: any;
  fftMultiplyBindGroupLayout: any;
  fftMultiplyPipeline: any;
  fftBatchPingBuffer: any;
  fftBatchPongBuffer: any;
  fftBatchSourceBuffer: any;
  fftFailureCount: number;
  fftFastPathDisabled: boolean;
  fftParamBuffer: any;
  fftParamStride: number;
  fftPipeline: any;
  fftRenderBindGroupLayout: any;
  fftRenderPipeline: any;
  fftResources: Map<string, ScalogramFftResource>;
  fftScratchFftSize: number;
  fftWindowCache: Map<string, ScalogramFftWindowResource>;
  fftWindowUseSerial: number;
  fftSourceBuffer: any;
  fftScratchPingBuffer: any;
  fftScratchPongBuffer: any;
  kernelResources: Map<string, ScalogramKernelResource>;
  paramBuffer: any;
  paramStride: number;
  pcmBuffer: any;
  pcmSampleCount: number;
  renderBindGroupLayout: any;
  renderPipeline: any;
}

interface WebGpuCqtComputeState {
  cqtValueBuffer: any;
  cqtValueBufferCapacity: number;
  kernelResources: Map<string, WebGpuCqtKernelResource>;
  paramBuffer: any;
  pcmBuffer: any;
  pcmSampleCount: number;
  renderChromaBindGroupLayout: any;
  renderChromaPipeline: any;
  renderValuesBindGroupLayout: any;
  renderValuesPipeline: any;
}

interface WebGpuCompositorState {
  analysisFallbackReasons: Partial<Record<AnalysisType, string>>;
  bindGroupLayout: any;
  canvasContext: any;
  canvasFormat: string;
  compositorCanvas: OffscreenCanvas | null;
  device: any;
  backgroundPipeline: any;
  presentInstanceBuffer: any;
  presentInstanceCapacity: number;
  sampler: any;
  cqtCompute: WebGpuCqtComputeState | null;
  scalogramCompute: WebGpuScalogramComputeState | null;
  stftCompute: WebGpuStftComputeState | null;
  surfaceResetPending: boolean;
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
  fallbackReason: null as string | null,
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
      surfaceState.fallbackReason = null;
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
    retainedPlan: null,
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

  for (const plan of [
    analysisState.overview.retainedPlan,
    analysisState.overview.plan,
    analysisState.visible.retainedPlan,
    analysisState.visible.plan,
  ]) {
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
  return value === 'chroma'
    || value === 'chroma_cqt'
    || value === 'mel'
    || value === 'mfcc'
    || value === 'scalogram'
    ? (value === 'chroma_cqt' ? 'chroma' : value)
    : 'spectrogram';
}

function normalizeColormapDistribution(value: unknown): ColormapDistribution {
  return value === 'contrast' || value === 'soft' ? value : 'balanced';
}

function getDefaultDbWindowForAnalysisType(analysisType: AnalysisType): {
  maxDecibels: number;
  minDecibels: number;
} {
  if (analysisType === 'mel') {
    return { minDecibels: -92, maxDecibels: 0 };
  }
  if (analysisType === 'mfcc') {
    return { minDecibels: -80, maxDecibels: 0 };
  }
  if (analysisType === 'scalogram') {
    return { minDecibels: -72, maxDecibels: 0 };
  }
  return { minDecibels: MIN_DECIBELS, maxDecibels: MAX_DECIBELS };
}

function normalizeDbWindow(
  minValue: unknown,
  maxValue: unknown,
  analysisType: AnalysisType,
): {
  maxDecibels: number;
  minDecibels: number;
} {
  const defaults = getDefaultDbWindowForAnalysisType(analysisType);
  let minDecibels = Number.isFinite(Number(minValue)) ? Math.round(Number(minValue)) : defaults.minDecibels;
  let maxDecibels = Number.isFinite(Number(maxValue)) ? Math.round(Number(maxValue)) : defaults.maxDecibels;

  minDecibels = clamp(
    minDecibels,
    SPECTROGRAM_DB_WINDOW_LIMITS.min,
    SPECTROGRAM_DB_WINDOW_LIMITS.max - SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
  );
  maxDecibels = clamp(
    maxDecibels,
    SPECTROGRAM_DB_WINDOW_LIMITS.min + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    SPECTROGRAM_DB_WINDOW_LIMITS.max,
  );

  if (maxDecibels < minDecibels + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan) {
    maxDecibels = Math.min(
      SPECTROGRAM_DB_WINDOW_LIMITS.max,
      minDecibels + SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    );
    minDecibels = Math.min(
      minDecibels,
      maxDecibels - SPECTROGRAM_DB_WINDOW_LIMITS.minimumSpan,
    );
  }

  return { minDecibels, maxDecibels };
}

function normalizeFrequencyScale(value: unknown): FrequencyScale {
  return value === 'linear' || value === 'mixed' ? value : 'log';
}

function getEffectiveFrequencyScale(analysisType: AnalysisType, value: unknown): FrequencyScale {
  return analysisType === 'spectrogram' ? normalizeFrequencyScale(value) : 'log';
}

function isChromaAnalysisType(analysisType: AnalysisType): boolean {
  return analysisType === 'chroma';
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

function destroySpectrogramBandLayoutResources(computeState: WebGpuStftComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.bandLayoutResources.values()) {
    if ('buffer' in resource && resource.buffer && typeof resource.buffer.destroy === 'function') {
      resource.buffer.destroy();
    }
    if ('rowBuffer' in resource && resource.rowBuffer && typeof resource.rowBuffer.destroy === 'function') {
      resource.rowBuffer.destroy();
    }
    if ('binBuffer' in resource && resource.binBuffer && typeof resource.binBuffer.destroy === 'function') {
      resource.binBuffer.destroy();
    }
    if ('weightBuffer' in resource && resource.weightBuffer && typeof resource.weightBuffer.destroy === 'function') {
      resource.weightBuffer.destroy();
    }
  }

  computeState.bandLayoutResources.clear();
}

function destroyMfccBasisResources(computeState: WebGpuStftComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.mfccBasisResources.values()) {
    if (resource.buffer && typeof resource.buffer.destroy === 'function') {
      resource.buffer.destroy();
    }
  }

  computeState.mfccBasisResources.clear();
}

function destroyScalogramKernelResources(computeState: WebGpuScalogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.kernelResources.values()) {
    if (resource.rowBuffer && typeof resource.rowBuffer.destroy === 'function') {
      resource.rowBuffer.destroy();
    }
    if (resource.tapBuffer && typeof resource.tapBuffer.destroy === 'function') {
      resource.tapBuffer.destroy();
    }
  }

  computeState.kernelResources.clear();
}

function destroyCqtKernelResources(computeState: WebGpuCqtComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.kernelResources.values()) {
    if (resource.rowBuffer && typeof resource.rowBuffer.destroy === 'function') {
      resource.rowBuffer.destroy();
    }
    if (resource.tapBuffer && typeof resource.tapBuffer.destroy === 'function') {
      resource.tapBuffer.destroy();
    }
    if (resource.chromaAssignmentBuffer && typeof resource.chromaAssignmentBuffer.destroy === 'function') {
      resource.chromaAssignmentBuffer.destroy();
    }
  }

  computeState.kernelResources.clear();
}

function destroyScalogramFftResources(computeState: WebGpuScalogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.fftResources.values()) {
    if (resource.rowBuffer && typeof resource.rowBuffer.destroy === 'function') {
      resource.rowBuffer.destroy();
    }
    if (resource.spectrumBuffer && typeof resource.spectrumBuffer.destroy === 'function') {
      resource.spectrumBuffer.destroy();
    }
  }

  computeState.fftResources.clear();
}

function destroyScalogramFftWindowResources(computeState: WebGpuScalogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.fftWindowCache.values()) {
    if (resource.spectrumBuffer && typeof resource.spectrumBuffer.destroy === 'function') {
      resource.spectrumBuffer.destroy();
    }
  }

  computeState.fftWindowCache.clear();
  computeState.fftWindowUseSerial = 0;
}

function destroyScalogramFftScratchBuffers(computeState: WebGpuScalogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const buffer of [
    computeState.fftBatchPingBuffer,
    computeState.fftBatchPongBuffer,
    computeState.fftBatchSourceBuffer,
    computeState.fftSourceBuffer,
    computeState.fftScratchPingBuffer,
    computeState.fftScratchPongBuffer,
  ]) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }

  computeState.fftBatchPingBuffer = null;
  computeState.fftBatchPongBuffer = null;
  computeState.fftBatchSourceBuffer = null;
  computeState.fftSourceBuffer = null;
  computeState.fftScratchPingBuffer = null;
  computeState.fftScratchPongBuffer = null;
  computeState.fftScratchFftSize = 0;
}

function destroyWebGpuStftScratchSlots(computeState: WebGpuStftComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const slot of computeState.scratchSlots) {
    for (const buffer of [
      slot.basePingBuffer,
      slot.basePongBuffer,
      slot.mfccMelBuffer,
      slot.lowPingBuffer,
      slot.lowPongBuffer,
    ]) {
      if (buffer && typeof buffer.destroy === 'function') {
        buffer.destroy();
      }
    }
  }

  computeState.scratchSlots = [];
  computeState.scratchFftSize = 0;
}

function destroyWebGpuStftComputeState(computeState: WebGpuStftComputeState | null): void {
  if (!computeState) {
    return;
  }

  destroySpectrogramBandLayoutResources(computeState);
  destroyMfccBasisResources(computeState);

  destroyWebGpuStftScratchSlots(computeState);

  for (const buffer of [
    computeState.paramBuffer,
    computeState.pcmBuffer,
  ]) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }

  computeState.paramBuffer = null;
  computeState.pcmBuffer = null;
  computeState.pcmSampleCount = 0;
  computeState.paramSetStride = 0;
}

function destroyWebGpuScalogramComputeState(computeState: WebGpuScalogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  destroyScalogramKernelResources(computeState);
  destroyScalogramFftResources(computeState);
  destroyScalogramFftWindowResources(computeState);
  destroyScalogramFftScratchBuffers(computeState);
  for (const buffer of [computeState.paramBuffer, computeState.pcmBuffer, computeState.fftParamBuffer]) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }
  computeState.paramBuffer = null;
  computeState.pcmBuffer = null;
  computeState.pcmSampleCount = 0;
  computeState.fftParamBuffer = null;
}

function destroyWebGpuCqtComputeState(computeState: WebGpuCqtComputeState | null): void {
  if (!computeState) {
    return;
  }

  destroyCqtKernelResources(computeState);
  for (const buffer of [computeState.cqtValueBuffer, computeState.paramBuffer, computeState.pcmBuffer]) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }
  computeState.cqtValueBuffer = null;
  computeState.cqtValueBufferCapacity = 0;
  computeState.paramBuffer = null;
  computeState.pcmBuffer = null;
  computeState.pcmSampleCount = 0;
}

function resetWebGpuComputeSessionResources(): void {
  const webGpu = surfaceState.webGpu;

  if (!webGpu) {
    return;
  }

  destroySpectrogramBandLayoutResources(webGpu.stftCompute);
  destroyWebGpuStftScratchSlots(webGpu.stftCompute);
  if (webGpu.stftCompute?.pcmBuffer && typeof webGpu.stftCompute.pcmBuffer.destroy === 'function') {
    webGpu.stftCompute.pcmBuffer.destroy();
    webGpu.stftCompute.pcmBuffer = null;
    webGpu.stftCompute.pcmSampleCount = 0;
  }

  destroyCqtKernelResources(webGpu.cqtCompute);
  if (webGpu.cqtCompute?.cqtValueBuffer && typeof webGpu.cqtCompute.cqtValueBuffer.destroy === 'function') {
    webGpu.cqtCompute.cqtValueBuffer.destroy();
    webGpu.cqtCompute.cqtValueBuffer = null;
    webGpu.cqtCompute.cqtValueBufferCapacity = 0;
  }
  if (webGpu.cqtCompute?.pcmBuffer && typeof webGpu.cqtCompute.pcmBuffer.destroy === 'function') {
    webGpu.cqtCompute.pcmBuffer.destroy();
    webGpu.cqtCompute.pcmBuffer = null;
    webGpu.cqtCompute.pcmSampleCount = 0;
  }

  destroyScalogramKernelResources(webGpu.scalogramCompute);
  destroyScalogramFftResources(webGpu.scalogramCompute);
  destroyScalogramFftWindowResources(webGpu.scalogramCompute);
  destroyScalogramFftScratchBuffers(webGpu.scalogramCompute);
  if (webGpu.scalogramCompute?.pcmBuffer && typeof webGpu.scalogramCompute.pcmBuffer.destroy === 'function') {
    webGpu.scalogramCompute.pcmBuffer.destroy();
    webGpu.scalogramCompute.pcmBuffer = null;
    webGpu.scalogramCompute.pcmSampleCount = 0;
  }
  if (webGpu.scalogramCompute) {
    webGpu.scalogramCompute.fftFailureCount = 0;
    webGpu.scalogramCompute.fftFastPathDisabled = false;
  }

  webGpu.analysisFallbackReasons = {};
}

function destroyTileGpuResources(tileRecord: TileRecord): void {
  if (tileRecord.gpuTexture && typeof tileRecord.gpuTexture.destroy === 'function') {
    tileRecord.gpuTexture.destroy();
  }

  tileRecord.gpuTexture = null;
  tileRecord.gpuTextureUsage = 0;
  tileRecord.gpuTextureView = null;
  tileRecord.gpuBindGroup = null;
  tileRecord.gpuDirty = true;
}

function getCurrentRenderBackend(): AnalysisRenderBackend {
  return surfaceState.backend === 'webgpu' ? 'webgpu-native' : '2d-wasm';
}

function postAnalysisInitialized(): void {
  if (!analysisState.initialized) {
    return;
  }

  self.postMessage({
    type: 'analysisInitialized',
    body: {
      duration: analysisState.duration,
      fallbackReason: surfaceState.fallbackReason,
      maxFrequency: analysisState.maxFrequency,
      minFrequency: analysisState.minFrequency,
      quality: analysisState.quality,
      renderBackend: getCurrentRenderBackend(),
      runtimeVariant: analysisState.runtimeVariant,
      sampleCount: analysisState.sampleCount,
      sampleRate: analysisState.sampleRate,
    },
  });
}

function requestAnalysisSurfaceReset(reason: SurfaceResetReason): void {
  const webGpu = surfaceState.webGpu;
  if (webGpu?.surfaceResetPending) {
    return;
  }

  if (webGpu) {
    webGpu.surfaceResetPending = true;
  }

  clearTileCache();
  destroyWebGpuCompositor();
  surfaceState.canvas = null;
  surfaceState.context = null;
  surfaceState.backend = 'uninitialized';
  surfaceState.fallbackReason = reason === 'device-lost'
    ? 'WebGPU device lost.'
    : 'WebGPU surface became invalid.';

  self.postMessage({
    type: 'analysisSurfaceResetRequested',
    body: { reason },
  });
}

function destroyWebGpuCompositor(): void {
  for (const tileRecord of analysisState.tileCache.values()) {
    destroyTileGpuResources(tileRecord);
  }

  destroyWebGpuStftComputeState(surfaceState.webGpu?.stftCompute ?? null);
  destroyWebGpuCqtComputeState(surfaceState.webGpu?.cqtCompute ?? null);
  destroyWebGpuScalogramComputeState(surfaceState.webGpu?.scalogramCompute ?? null);
  if (surfaceState.webGpu?.presentInstanceBuffer && typeof surfaceState.webGpu.presentInstanceBuffer.destroy === 'function') {
    surfaceState.webGpu.presentInstanceBuffer.destroy();
  }
  surfaceState.webGpu = null;
  surfaceState.webGpuInitPromise = null;
  if (surfaceState.backend === 'webgpu' || surfaceState.backend === 'initializing') {
    surfaceState.backend = 'uninitialized';
  }
}

function initialize2dSurface(fallbackReason: string | null = null): void {
  if (!surfaceState.canvas) {
    surfaceState.context = null;
    surfaceState.backend = 'uninitialized';
    return;
  }

  surfaceState.canvas.width = Math.max(1, surfaceState.pixelWidth);
  surfaceState.canvas.height = Math.max(1, surfaceState.pixelHeight);
  surfaceState.context = surfaceState.canvas.getContext('2d', { alpha: false });
  surfaceState.backend = surfaceState.context ? '2d' : 'uninitialized';
  surfaceState.fallbackReason = surfaceState.context ? fallbackReason : '2D surface unavailable.';
  if (analysisState.initialized) {
    postAnalysisInitialized();
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
    initialize2dSurface('WebGPU globals unavailable.');
    return;
  }

  surfaceState.backend = 'initializing';
  surfaceState.webGpuInitPromise = (async () => {
    let acquiredSurfaceContext = false;
    try {
      const adapter = await globals.gpu.requestAdapter?.({ powerPreference: 'high-performance' });
      if (!adapter) {
        initialize2dSurface('WebGPU adapter unavailable.');
        return;
      }

      const device = await adapter.requestDevice();
      const canvasFormat = globals.gpu.getPreferredCanvasFormat?.() || 'bgra8unorm';
      if (!(await validateWebGpuPresentation(device, canvasFormat))) {
        initialize2dSurface('Direct WebGPU presentation validation failed.');
        return;
      }

      const backgroundModule = device.createShaderModule({ code: WEBGPU_BACKGROUND_SHADER });
      const tileModule = device.createShaderModule({ code: WEBGPU_TILE_SHADER });
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            sampler: { type: 'filtering' },
            visibility: globals.shaderStage.FRAGMENT,
          },
          {
            binding: 1,
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
          buffers: [
            {
              arrayStride: Float32Array.BYTES_PER_ELEMENT * 4,
              attributes: [
                {
                  format: 'float32x2',
                  offset: 0,
                  shaderLocation: 0,
                },
                {
                  format: 'float32x2',
                  offset: Float32Array.BYTES_PER_ELEMENT * 2,
                  shaderLocation: 1,
                },
              ],
              stepMode: 'instance',
            },
          ],
          entryPoint: 'tileVs',
          module: tileModule,
        },
      });

      const canvasContext = (surfaceState.canvas.getContext('webgpu') as any) ?? null;
      if (!canvasContext) {
        initialize2dSurface('Spectrogram surface rejected WebGPU context initialization.');
        return;
      }
      acquiredSurfaceContext = true;

      surfaceState.canvas.width = Math.max(1, surfaceState.pixelWidth);
      surfaceState.canvas.height = Math.max(1, surfaceState.pixelHeight);
      canvasContext.configure({
        alphaMode: 'opaque',
        device,
        format: canvasFormat,
      });

      surfaceState.webGpu = {
        analysisFallbackReasons: {},
        backgroundPipeline,
        bindGroupLayout,
        canvasContext,
        canvasFormat,
        compositorCanvas: null,
        device,
        presentInstanceBuffer: null,
        presentInstanceCapacity: 0,
        sampler,
        cqtCompute: null,
        scalogramCompute: null,
        stftCompute: null,
        surfaceResetPending: false,
        tilePipeline,
      };
      surfaceState.backend = 'webgpu';
      surfaceState.context = null;
      surfaceState.fallbackReason = null;
      void device.lost.then(() => {
        if (surfaceState.webGpu?.device !== device) {
          return;
        }

        requestAnalysisSurfaceReset('device-lost');
      });
      if (analysisState.initialized) {
        postAnalysisInitialized();
      }
      paintSpectrogramDisplay();
    } catch (error) {
      destroyWebGpuCompositor();
      if (acquiredSurfaceContext) {
        requestAnalysisSurfaceReset('surface-invalid');
      } else {
        initialize2dSurface(error instanceof Error ? error.message : 'WebGPU initialization failed.');
        paintSpectrogramDisplay();
      }
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

function getMaxComputeWorkgroupsPerDimension(device: any): number {
  const limit = Number(device?.limits?.maxComputeWorkgroupsPerDimension);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 65535;
}

function getLinearComputeDispatchSize(
  totalInvocations: number,
  device: any,
  workgroupSize: number = WEBGPU_LINEAR_WORKGROUP_SIZE,
): [number, number] {
  const safeWorkgroupSize = Math.max(1, Math.floor(workgroupSize));
  const totalGroups = Math.max(1, Math.ceil(Math.max(0, totalInvocations) / safeWorkgroupSize));
  const maxGroupsPerDimension = getMaxComputeWorkgroupsPerDimension(device);
  const xGroups = Math.max(1, Math.min(totalGroups, maxGroupsPerDimension));
  const yGroups = Math.max(1, Math.ceil(totalGroups / xGroups));

  if (yGroups > maxGroupsPerDimension) {
    throw new Error(`WebGPU dispatch exceeds device limits (${totalGroups} groups required).`);
  }

  return [xGroups, yGroups];
}

function resizeWebGpuSurface(): void {
  if (!surfaceState.webGpu || !surfaceState.canvas) {
    return;
  }

  surfaceState.canvas.width = Math.max(1, surfaceState.pixelWidth);
  surfaceState.canvas.height = Math.max(1, surfaceState.pixelHeight);
  surfaceState.webGpu.canvasContext.configure({
    alphaMode: 'opaque',
    device: surfaceState.webGpu.device,
    format: surfaceState.webGpu.canvasFormat,
  });
}

function initializeCanvas(options: CanvasInitOptions | undefined): void {
  if (options?.offscreenCanvas && options.offscreenCanvas !== surfaceState.canvas) {
    destroyWebGpuCompositor();
    surfaceState.context = null;
    surfaceState.canvas = options.offscreenCanvas;
    surfaceState.backend = 'uninitialized';
  }

  surfaceState.pixelWidth = Math.max(1, Math.round(Number(options?.pixelWidth) || surfaceState.pixelWidth || 1));
  surfaceState.pixelHeight = Math.max(1, Math.round(Number(options?.pixelHeight) || surfaceState.pixelHeight || 1));

  if (!surfaceState.canvas) {
    return;
  }

  if (ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR) {
    void initializeWebGpuCompositor();
  } else {
    initialize2dSurface(null);
  }

  if (surfaceState.backend !== 'initializing') {
    paintSpectrogramDisplay();
  }
}

function resizeCanvas(options: CanvasInitOptions | undefined): void {
  surfaceState.pixelWidth = Math.max(1, Math.round(Number(options?.pixelWidth) || surfaceState.pixelWidth || 1));
  surfaceState.pixelHeight = Math.max(1, Math.round(Number(options?.pixelHeight) || surfaceState.pixelHeight || 1));

  if (!surfaceState.canvas) {
    return;
  }

  analysisState.currentDisplayRange.pixelWidth = surfaceState.pixelWidth;
  analysisState.currentDisplayRange.pixelHeight = surfaceState.pixelHeight;

  if (surfaceState.backend === 'webgpu') {
    resizeWebGpuSurface();
  } else if (surfaceState.backend === '2d') {
    initialize2dSurface(surfaceState.fallbackReason);
  } else if (ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR) {
    void initializeWebGpuCompositor();
  } else {
    initialize2dSurface(surfaceState.fallbackReason);
  }

  if (surfaceState.backend !== 'initializing') {
    paintSpectrogramDisplay();
  }
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

  postAnalysisInitialized();
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
        retainedPlan: null,
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
        retainedPlan: null,
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

      const retainedPlan = analysisState.visible.ready
        ? analysisState.visible.plan
        : analysisState.visible.retainedPlan;

      analysisState.generationStatus.set(plan.generation, { cancelled: false });
      analysisState.visible = {
        generation: plan.generation,
        kind: 'visible',
        plan,
        ready: false,
        retainedPlan,
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
        retainedPlan: null,
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

function getPlanTileRenderOrder(plan: RenderRequestPlan): number[] {
  const tileIndices: number[] = [];
  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    tileIndices.push(tileIndex);
  }

  if (plan.requestKind !== 'visible' || tileIndices.length <= 2) {
    return tileIndices;
  }

  const centerTime = (plan.displayStart + plan.displayEnd) * 0.5;
  const centerTileIndex = clamp(
    Math.floor(centerTime / Math.max(plan.tileDuration, 1e-6)),
    plan.startTileIndex,
    plan.endTileIndex,
  );
  const ordered: number[] = [];
  const seen = new Set<number>();

  for (let offset = 0; ordered.length < tileIndices.length; offset += 1) {
    const left = centerTileIndex - offset;
    const right = centerTileIndex + offset;

    if (left >= plan.startTileIndex && left <= plan.endTileIndex && !seen.has(left)) {
      seen.add(left);
      ordered.push(left);
    }
    if (right >= plan.startTileIndex && right <= plan.endTileIndex && !seen.has(right)) {
      seen.add(right);
      ordered.push(right);
    }
  }

  return ordered;
}

function getWebGpuTileSubmitBatchSize(plan: RenderRequestPlan): number {
  if (
    !surfaceState.webGpu
    || !canUseWebGpuNativeCompute(plan)
    || plan.analysisType === 'scalogram'
    || plan.analysisType === 'chroma'
  ) {
    return 1;
  }

  return plan.requestKind === 'visible'
    ? WEBGPU_VISIBLE_TILE_SUBMIT_BATCH_SIZE
    : WEBGPU_OVERVIEW_TILE_SUBMIT_BATCH_SIZE;
}

async function ensurePlanTiles(
  runtime: WaveCoreRuntime,
  plan: RenderRequestPlan,
  options: EnsurePlanTilesOptions = {},
): Promise<boolean> {
  const onTileReady = typeof options.onTileReady === 'function' ? options.onTileReady : null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const tileIndices = getPlanTileRenderOrder(plan);
  const submitBatchSize = getWebGpuTileSubmitBatchSize(plan);

  for (let batchStart = 0; batchStart < tileIndices.length; batchStart += submitBatchSize) {
    let batchRendered = false;
    const batchEnd = Math.min(tileIndices.length, batchStart + submitBatchSize);

    for (let batchIndex = batchStart; batchIndex < batchEnd; batchIndex += 1) {
      const tileIndex = tileIndices[batchIndex];
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
          deferWebGpuReady: submitBatchSize > 1,
          existingTile,
          onChunkReady: submitBatchSize > 1 ? undefined : onTileReady,
          shouldAbort,
          webGpuSlotIndex: batchIndex - batchStart,
        });

        if (!tileRecord) {
          return false;
        }

        batchRendered = true;
      } else if (submitBatchSize === 1) {
        onTileReady?.();
      }
    }

    if (submitBatchSize > 1 && batchRendered) {
      onTileReady?.();
    }

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
  return {
    byteLength: TILE_COLUMN_COUNT * rowCount * 4,
    canvas: null,
    columnCount: TILE_COLUMN_COUNT,
    complete: false,
    context: null,
    gpuBindGroup: null,
    gpuDirty: true,
    gpuTexture: null,
    gpuTextureUsage: 0,
    gpuTextureView: null,
    imageData: null,
    renderedColumns: 0,
    rowCount,
    tileEnd,
    tileIndex,
    tileKey: cacheKey,
    tileStart,
  };
}

function ensureCpuTileSurface(tileRecord: TileRecord): void {
  if (tileRecord.context && tileRecord.imageData && tileRecord.canvas) {
    return;
  }

  tileRecord.canvas = new OffscreenCanvas(tileRecord.columnCount, tileRecord.rowCount);
  tileRecord.context = tileRecord.canvas.getContext('2d', { alpha: false });
  if (!tileRecord.context) {
    throw new Error('OffscreenCanvas 2D context is unavailable.');
  }
  tileRecord.imageData = tileRecord.context.createImageData(tileRecord.columnCount, tileRecord.rowCount);
  tileRecord.gpuDirty = true;
}

function drawTileChunk(
  tileRecord: TileRecord,
  rgba: Uint8Array,
  columnOffset: number,
  columnCount: number,
  rowCount: number,
): void {
  ensureCpuTileSurface(tileRecord);
  if (!tileRecord.imageData || !tileRecord.context) {
    throw new Error('Tile CPU surface is unavailable.');
  }

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
    plan.melBandCount,
    plan.fftSize,
    plan.decimationFactor,
    plan.minFrequency,
    plan.maxFrequency,
    ANALYSIS_TYPE_CODES[plan.analysisType] ?? ANALYSIS_TYPE_CODES.spectrogram,
    FREQUENCY_SCALE_CODES[plan.frequencyScale] ?? FREQUENCY_SCALE_CODES.log,
    COLORMAP_DISTRIBUTION_GAMMAS[plan.colormapDistribution],
    plan.minDecibels,
    plan.maxDecibels,
    plan.scalogramOmega0,
    WINDOW_FUNCTION_CODES[plan.windowFunction] ?? 0,
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
  const deferWebGpuReady = options.deferWebGpuReady === true;
  const webGpuSlotIndex = Number.isFinite(options.webGpuSlotIndex)
    ? Math.max(0, Math.min(WEBGPU_STFT_SCRATCH_SLOT_COUNT - 1, Math.trunc(options.webGpuSlotIndex as number)))
    : 0;
  const chunkColumnCount = plan.analysisType === 'scalogram'
    ? SCALOGRAM_COLUMN_CHUNK_SIZE
    : SPECTROGRAM_COLUMN_CHUNK_SIZE;
  const existingTile = options.existingTile;
  const tileRecord = existingTile ?? createTileRecord({
    cacheKey,
    rowCount: plan.rowCount,
    tileEnd,
    tileIndex,
    tileStart,
  });

  setTileRecord(cacheKey, tileRecord);

  if (canUseWebGpuNativeCompute(plan)) {
    if (surfaceState.webGpuInitPromise && !surfaceState.webGpu) {
      await surfaceState.webGpuInitPromise;
    }

    if (surfaceState.webGpu && await renderTileWithWebGpu(plan, tileRecord, tileStart, tileEnd, webGpuSlotIndex)) {
      if (!deferWebGpuReady) {
        onChunkReady?.();
      }
      return tileRecord;
    }
  }

  ensureCpuTileSurface(tileRecord);
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

  if (surfaceState.webGpu && paintSpectrogramDisplayWithWebGpu(displayRange)) {
    return;
  }

  if (!context) {
    return;
  }

  drawBackground(context, surfaceState.pixelWidth, surfaceState.pixelHeight);

  if (!(displayRange.end > displayRange.start)) {
    return;
  }

  if (analysisState.overview.retainedPlan) {
    paintLayer(context, analysisState.overview.retainedPlan, displayRange, {
      smoothing: true,
      smoothingQuality: 'high',
    });
  }

  if (analysisState.overview.plan) {
    paintLayer(context, analysisState.overview.plan, displayRange, {
      smoothing: true,
      smoothingQuality: 'high',
    });
  }

  if (analysisState.visible.retainedPlan) {
    paintLayer(context, analysisState.visible.retainedPlan, displayRange, {
      smoothing: true,
      smoothingQuality: 'medium',
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
      if (analysisState.overview.retainedPlan) {
        paintLayerWithWebGpu(renderPass, webGpu, analysisState.overview.retainedPlan, displayRange);
      }
      if (analysisState.overview.plan) {
        paintLayerWithWebGpu(renderPass, webGpu, analysisState.overview.plan, displayRange);
      }

      if (analysisState.visible.retainedPlan) {
        paintLayerWithWebGpu(renderPass, webGpu, analysisState.visible.retainedPlan, displayRange);
      }
      if (analysisState.visible.plan) {
        paintLayerWithWebGpu(renderPass, webGpu, analysisState.visible.plan, displayRange);
      }
    }

    renderPass.end();
    webGpu.device.queue.submit([commandEncoder.finish()]);
    return true;
  } catch {
    requestAnalysisSurfaceReset('surface-invalid');
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

function hzToMel(frequency: number): number {
  const safeFrequency = Math.max(0, frequency);

  if (safeFrequency < SLANEY_MEL_LOG_REGION_START_HZ) {
    return (safeFrequency - SLANEY_MEL_FREQUENCY_MIN) / SLANEY_MEL_FREQUENCY_STEP;
  }

  return SLANEY_MEL_LOG_REGION_START_MEL
    + (Math.log(safeFrequency / SLANEY_MEL_LOG_REGION_START_HZ) / SLANEY_MEL_LOG_STEP);
}

function melToHz(melValue: number): number {
  if (melValue < SLANEY_MEL_LOG_REGION_START_MEL) {
    return SLANEY_MEL_FREQUENCY_MIN + (SLANEY_MEL_FREQUENCY_STEP * melValue);
  }

  return SLANEY_MEL_LOG_REGION_START_HZ
    * Math.exp(SLANEY_MEL_LOG_STEP * (melValue - SLANEY_MEL_LOG_REGION_START_MEL));
}

function getScalogramFrequencyForRow(row: number, rows: number, minFrequency: number, maxFrequency: number): number {
  if (rows <= 1) {
    return minFrequency;
  }

  const ratio = row / (rows - 1);
  return minFrequency * Math.exp(Math.log(maxFrequency / minFrequency) * ratio);
}

function buildStftLayoutCacheKey(plan: RenderRequestPlan): string {
  const bandCount = plan.analysisType === 'mfcc' ? plan.melBandCount : plan.rowCount;
  return [
    `type${plan.analysisType}`,
    `fft${plan.fftSize}`,
    `scale${plan.frequencyScale}`,
    `rows${plan.rowCount}`,
    `bands${bandCount}`,
    `dec${plan.decimationFactor}`,
    `sr${analysisState.sampleRate}`,
    `min${plan.minFrequency}`,
    `max${plan.maxFrequency}`,
  ].join(':');
}

function createMfccDctBasisData(coefficientCount: number, bandCount: number): Float32Array {
  const safeCoefficientCount = Math.max(1, Math.floor(coefficientCount));
  const safeBandCount = Math.max(1, Math.floor(bandCount));
  const data = new Float32Array(safeCoefficientCount * safeBandCount);
  const bandCountFloat = safeBandCount;

  for (let coefficientIndex = 0; coefficientIndex < safeCoefficientCount; coefficientIndex += 1) {
    const normalization = coefficientIndex === 0
      ? Math.sqrt(1 / bandCountFloat)
      : Math.sqrt(2 / bandCountFloat);
    const rowOffset = coefficientIndex * safeBandCount;

    for (let bandIndex = 0; bandIndex < safeBandCount; bandIndex += 1) {
      const bandPosition = bandIndex + 0.5;
      data[rowOffset + bandIndex] = Math.cos((Math.PI / bandCountFloat) * bandPosition * coefficientIndex) * normalization;
    }
  }

  return data;
}

function buildMfccBasisCacheKey(plan: RenderRequestPlan): string {
  return [
    `coeff${plan.rowCount}`,
    `bands${plan.melBandCount}`,
  ].join(':');
}

function getMfccBasisResource(
  plan: RenderRequestPlan,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuStftComputeState,
): MfccDctBasisResource | null {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return null;
  }

  const cacheKey = buildMfccBasisCacheKey(plan);
  const cached = computeState.mfccBasisResources.get(cacheKey) ?? null;
  if (cached) {
    return cached;
  }

  try {
    const resource: MfccDctBasisResource = {
      bandCount: plan.melBandCount,
      buffer: createGpuBufferWithData(
        webGpu.device,
        globals.bufferUsage.STORAGE,
        createMfccDctBasisData(plan.rowCount, plan.melBandCount),
      ),
      coefficientCount: plan.rowCount,
      key: cacheKey,
    };
    computeState.mfccBasisResources.set(cacheKey, resource);
    return resource;
  } catch {
    return null;
  }
}

function getStftLayoutResource(
  plan: RenderRequestPlan,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuStftComputeState,
): WebGpuStftLayoutResource | null {
  const globals = getWebGpuGlobals();

  if (!globals) {
    return null;
  }

  const cacheKey = buildStftLayoutCacheKey(plan);
  const cached = computeState.bandLayoutResources.get(cacheKey) ?? null;
  if (cached) {
    return cached;
  }

  if (plan.analysisType === 'mel' || plan.analysisType === 'mfcc') {
    const rows = Math.max(1, plan.melBandCount);
    const nyquist = analysisState.sampleRate / 2;
    const maximumBin = Math.max(2, Math.trunc(plan.fftSize / 2));
    const safeMinFrequency = Math.max(0, plan.minFrequency);
    const safeMaxFrequency = Math.max(safeMinFrequency + 1, plan.maxFrequency);
    const melMin = hzToMel(safeMinFrequency);
    const melMax = hzToMel(safeMaxFrequency);
    const melStep = (melMax - melMin) / (rows + 1);
    const rowData = new Uint32Array(rows * 4);
    const bins: number[] = [];
    const weights: number[] = [];

    for (let row = 0; row < rows; row += 1) {
      const leftFrequency = melToHz(melMin + (melStep * row));
      const centerFrequency = melToHz(melMin + (melStep * (row + 1)));
      const rightFrequency = melToHz(melMin + (melStep * (row + 2)));
      const areaNormalization = 2 / Math.max(1e-6, rightFrequency - leftFrequency);
      const startBin = clamp(
        Math.floor((leftFrequency / nyquist) * maximumBin),
        0,
        maximumBin - 1,
      );
      const peakBin = clamp(
        Math.round((centerFrequency / nyquist) * maximumBin),
        startBin + 1,
        maximumBin - 1,
      );
      const endBin = clamp(
        Math.ceil((rightFrequency / nyquist) * maximumBin),
        peakBin + 1,
        maximumBin,
      );
      const rowOffset = bins.length;

      for (let bin = startBin; bin < endBin; bin += 1) {
        const frequency = (bin / maximumBin) * nyquist;
        let weight = 0;

        if (frequency <= centerFrequency) {
          const denominator = Math.max(1e-6, centerFrequency - leftFrequency);
          weight = (frequency - leftFrequency) / denominator;
        } else {
          const denominator = Math.max(1e-6, rightFrequency - centerFrequency);
          weight = (rightFrequency - frequency) / denominator;
        }

        weight = clamp(weight, 0, 1);
        if (weight <= 0) {
          continue;
        }

        weight *= areaNormalization;

        bins.push(bin);
        weights.push(weight);
      }

      const offset = row * 4;
      rowData[offset] = rowOffset;
      rowData[offset + 1] = bins.length - rowOffset;
    }

    const resource: WeightedBandLayoutResource = {
      bandCount: rows,
      binBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, new Uint32Array(bins)),
      key: cacheKey,
      rowBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, rowData),
      weightBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, new Float32Array(weights)),
    };
    computeState.bandLayoutResources.set(cacheKey, resource);
    return resource;
  }

  const baseRanges = createSpectrogramBandRanges({
    fftSize: plan.fftSize,
    frequencyScale: plan.frequencyScale,
    maxFrequency: plan.maxFrequency,
    minFrequency: plan.minFrequency,
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
        plan.minFrequency,
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
  } satisfies SpectrogramBandLayoutResource;
  computeState.bandLayoutResources.set(cacheKey, resource);
  return resource;
}

function buildScalogramKernelCacheKey(plan: RenderRequestPlan): string {
  return [
    `rows${plan.rowCount}`,
    `sr${analysisState.sampleRate}`,
    `min${plan.minFrequency}`,
    `max${plan.maxFrequency}`,
    `omega${plan.scalogramOmega0}`,
  ].join(':');
}

function getScalogramKernelResource(
  plan: RenderRequestPlan,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuScalogramComputeState,
): ScalogramKernelResource | null {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return null;
  }

  const cacheKey = buildScalogramKernelCacheKey(plan);
  const cached = computeState.kernelResources.get(cacheKey) ?? null;
  if (cached) {
    return cached;
  }

  const rowCount = Math.max(1, plan.rowCount);
  const sampleRate = analysisState.sampleRate;
  const minFrequency = Math.max(1, plan.minFrequency);
  const maxFrequency = Math.max(minFrequency * 1.01, plan.maxFrequency);
  const omega0 = Math.max(1, plan.scalogramOmega0);
  const rowBufferData = new ArrayBuffer(rowCount * 32);
  const rowView = new DataView(rowBufferData);
  const taps: Array<{ imagWeight: number; normWeight: number; realWeight: number; sampleOffset: number }> = [];
  const twoPi = Math.PI * 2;

  for (let row = 0; row < rowCount; row += 1) {
    const frequency = getScalogramFrequencyForRow(row, rowCount, minFrequency, maxFrequency);
    const safeFrequency = Math.max(1, frequency);
    const scaleSeconds = omega0 / (twoPi * safeFrequency);
    const supportSamples = Math.min(
      4096,
      Math.max(24, Math.ceil(scaleSeconds * 3 * sampleRate)),
    );
    const stride = Math.max(1, Math.trunc(supportSamples / 96));
    const tapCount = Math.floor((supportSamples * 2) / stride) + 1;
    const phaseStep = (twoPi * frequency * stride) / sampleRate;
    const stepCos = Math.cos(phaseStep);
    const stepSin = Math.sin(phaseStep);
    const initialPhase = (twoPi * frequency * -supportSamples) / sampleRate;
    let phaseCos = Math.cos(initialPhase);
    let phaseSin = Math.sin(initialPhase);
    let normalization = 0;
    let offsetValue = -supportSamples;
    const tapOffset = taps.length;

    for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
      const time = offsetValue / sampleRate;
      const normalizedTime = time / scaleSeconds;
      const gaussian = Math.exp(-0.5 * normalizedTime * normalizedTime);
      const normWeight = gaussian * gaussian;

      taps.push({
        imagWeight: -gaussian * phaseSin,
        normWeight,
        realWeight: gaussian * phaseCos,
        sampleOffset: offsetValue,
      });
      normalization += normWeight;

      const nextPhaseCos = (phaseCos * stepCos) - (phaseSin * stepSin);
      phaseSin = (phaseSin * stepCos) + (phaseCos * stepSin);
      phaseCos = nextPhaseCos;
      offsetValue += stride;
    }

    const rowOffset = row * 32;
    rowView.setUint32(rowOffset, tapOffset, true);
    rowView.setUint32(rowOffset + 4, tapCount, true);
    rowView.setInt32(rowOffset + 8, taps[tapOffset]?.sampleOffset ?? 0, true);
    rowView.setInt32(rowOffset + 12, taps[tapOffset + tapCount - 1]?.sampleOffset ?? 0, true);
    rowView.setFloat32(rowOffset + 16, normalization, true);
  }

  const tapBufferData = new ArrayBuffer(taps.length * 16);
  const tapView = new DataView(tapBufferData);
  for (let tapIndex = 0; tapIndex < taps.length; tapIndex += 1) {
    const tap = taps[tapIndex]!;
    const byteOffset = tapIndex * 16;
    tapView.setInt32(byteOffset, tap.sampleOffset, true);
    tapView.setFloat32(byteOffset + 4, tap.realWeight, true);
    tapView.setFloat32(byteOffset + 8, tap.imagWeight, true);
    tapView.setFloat32(byteOffset + 12, tap.normWeight, true);
  }

  const resource: ScalogramKernelResource = {
    key: cacheKey,
    rowBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, rowBufferData),
    tapBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, tapBufferData),
  };
  computeState.kernelResources.set(cacheKey, resource);
  return resource;
}

function buildCqtKernelCacheKey(plan: RenderRequestPlan): string {
  return [
    `sr${analysisState.sampleRate}`,
    `max${plan.maxFrequency}`,
    `bpo${CQT_DEFAULT_BINS_PER_OCTAVE}`,
    `win${plan.windowFunction}`,
  ].join(':');
}

function getCqtKernelResource(
  plan: RenderRequestPlan,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuCqtComputeState,
): WebGpuCqtKernelResource | null {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return null;
  }

  const cacheKey = buildCqtKernelCacheKey(plan);
  const cached = computeState.kernelResources.get(cacheKey) ?? null;
  if (cached) {
    return cached;
  }

  const frequencies = buildConstantQFrequencies(plan.maxFrequency, {
    binsPerOctave: CQT_DEFAULT_BINS_PER_OCTAVE,
    fmin: CQT_DEFAULT_FMIN,
  });
  const assignments = buildCqtChromaAssignments(frequencies.length, {
    binsPerOctave: CQT_DEFAULT_BINS_PER_OCTAVE,
    chromaBinCount: CHROMA_BIN_COUNT,
  });
  const rowBufferData = new ArrayBuffer(frequencies.length * 32);
  const rowView = new DataView(rowBufferData);
  const taps: Array<{ imagWeight: number; normWeight: number; realWeight: number; sampleOffset: number }> = [];
  const twoPi = Math.PI * 2;

  for (let binIndex = 0; binIndex < frequencies.length; binIndex += 1) {
    const frequency = Math.max(1, frequencies[binIndex] ?? 0);
    const scaleSeconds = DEFAULT_SCALOGRAM_OMEGA0 / (twoPi * frequency);
    const supportSamples = Math.min(
      4096,
      Math.max(24, Math.ceil(scaleSeconds * 3 * analysisState.sampleRate)),
    );
    const stride = Math.max(1, Math.trunc(supportSamples / 96));
    const tapCount = Math.floor((supportSamples * 2) / stride) + 1;
    const phaseStep = (twoPi * frequency * stride) / analysisState.sampleRate;
    const stepCos = Math.cos(phaseStep);
    const stepSin = Math.sin(phaseStep);
    const initialPhase = (twoPi * frequency * -supportSamples) / analysisState.sampleRate;
    let phaseCos = Math.cos(initialPhase);
    let phaseSin = Math.sin(initialPhase);
    let normalization = 0;
    let offsetValue = -supportSamples;
    const tapOffset = taps.length;

    for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
      const windowValue = getWindowValue(plan.windowFunction, tapIndex, tapCount);
      const normWeight = windowValue * windowValue;

      taps.push({
        imagWeight: -windowValue * phaseSin,
        normWeight,
        realWeight: windowValue * phaseCos,
        sampleOffset: offsetValue,
      });
      normalization += normWeight;

      const nextPhaseCos = (phaseCos * stepCos) - (phaseSin * stepSin);
      phaseSin = (phaseSin * stepCos) + (phaseCos * stepSin);
      phaseCos = nextPhaseCos;
      offsetValue += stride;
    }

    const rowOffset = binIndex * 32;
    rowView.setUint32(rowOffset, tapOffset, true);
    rowView.setUint32(rowOffset + 4, tapCount, true);
    rowView.setInt32(rowOffset + 8, taps[tapOffset]?.sampleOffset ?? 0, true);
    rowView.setInt32(rowOffset + 12, taps[tapOffset + tapCount - 1]?.sampleOffset ?? 0, true);
    rowView.setFloat32(rowOffset + 16, normalization, true);
  }

  const tapBufferData = new ArrayBuffer(taps.length * 16);
  const tapView = new DataView(tapBufferData);
  for (let tapIndex = 0; tapIndex < taps.length; tapIndex += 1) {
    const tap = taps[tapIndex]!;
    const byteOffset = tapIndex * 16;
    tapView.setInt32(byteOffset, tap.sampleOffset, true);
    tapView.setFloat32(byteOffset + 4, tap.realWeight, true);
    tapView.setFloat32(byteOffset + 8, tap.imagWeight, true);
    tapView.setFloat32(byteOffset + 12, tap.normWeight, true);
  }

  try {
    const resource: WebGpuCqtKernelResource = {
      binCount: frequencies.length,
      chromaAssignmentBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, assignments),
      key: cacheKey,
      rowBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, rowBufferData),
      tapBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, tapBufferData),
    };
    computeState.kernelResources.set(cacheKey, resource);
    return resource;
  } catch {
    return null;
  }
}

function buildScalogramFftPlanKey(plan: RenderRequestPlan): string {
  return [
    plan.requestKind,
    `cfg${plan.configVersion}`,
    plan.configKey,
    `gen${plan.generation}`,
  ].join(':');
}

function buildScalogramFftCacheKey(plan: RenderRequestPlan, fftSize: number): string {
  return [
    `fft${fftSize}`,
    `rows${plan.rowCount}`,
    `sr${analysisState.sampleRate}`,
    `min${plan.minFrequency}`,
    `max${plan.maxFrequency}`,
    `omega${plan.scalogramOmega0}`,
  ].join(':');
}

function getScalogramFftResource(
  plan: RenderRequestPlan,
  fftSize: number,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuScalogramComputeState,
): ScalogramFftResource | null {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return null;
  }

  const cacheKey = buildScalogramFftCacheKey(plan, fftSize);
  const cached = computeState.fftResources.get(cacheKey) ?? null;
  if (cached) {
    return cached;
  }

  const rowCount = Math.max(1, plan.rowCount);
  const halfFftSize = Math.max(1, Math.trunc(fftSize / 2));
  const sampleRate = analysisState.sampleRate;
  const minFrequency = Math.max(1, plan.minFrequency);
  const maxFrequency = Math.max(minFrequency * 1.01, plan.maxFrequency);
  const omega0 = Math.max(1, plan.scalogramOmega0);
  const rowData = new Float32Array(rowCount * 4);
  const waveletSpectrumData = new Float32Array(rowCount * halfFftSize);
  const twoPi = Math.PI * 2;
  let maxSupportSamples = 0;

  for (let row = 0; row < rowCount; row += 1) {
    const frequency = getScalogramFrequencyForRow(row, rowCount, minFrequency, maxFrequency);
    const safeFrequency = Math.max(1, frequency);
    const scaleSeconds = omega0 / (twoPi * safeFrequency);
    const supportSamples = Math.min(
      4096,
      Math.max(24, Math.ceil(scaleSeconds * 3 * sampleRate)),
    );
    const stride = Math.max(1, Math.trunc(supportSamples / 96));
    const tapCount = Math.floor((supportSamples * 2) / stride) + 1;
    const phaseStep = (twoPi * frequency * stride) / sampleRate;
    const stepCos = Math.cos(phaseStep);
    const stepSin = Math.sin(phaseStep);
    const initialPhase = (twoPi * frequency * -supportSamples) / sampleRate;
    let phaseCos = Math.cos(initialPhase);
    let phaseSin = Math.sin(initialPhase);
    let normalization = 0;
    let offsetValue = -supportSamples;

    for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
      const time = offsetValue / sampleRate;
      const normalizedTime = time / scaleSeconds;
      const gaussian = Math.exp(-0.5 * normalizedTime * normalizedTime);
      const normWeight = gaussian * gaussian;

      normalization += normWeight;

      const nextPhaseCos = (phaseCos * stepCos) - (phaseSin * stepSin);
      phaseSin = (phaseSin * stepCos) + (phaseCos * stepSin);
      phaseCos = nextPhaseCos;
      offsetValue += stride;
    }

    maxSupportSamples = Math.max(maxSupportSamples, supportSamples);
    const offset = row * 4;
    rowData[offset] = scaleSeconds;
    rowData[offset + 1] = normalization;
    rowData[offset + 2] = frequency;
    rowData[offset + 3] = supportSamples;

    const waveletOffset = row * halfFftSize;
    waveletSpectrumData[waveletOffset] = 0;
    for (let bin = 1; bin < halfFftSize; bin += 1) {
      const frequencyHz = (bin * sampleRate) / fftSize;
      waveletSpectrumData[waveletOffset + bin] = Math.exp(
        -0.5 * (((scaleSeconds * twoPi * frequencyHz) - omega0) ** 2),
      );
    }
  }

  try {
    const resource: ScalogramFftResource = {
      halfFftSize,
      key: cacheKey,
      maxSupportSamples,
      rowBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, rowData),
      spectrumBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, waveletSpectrumData),
    };
    computeState.fftResources.set(cacheKey, resource);
    return resource;
  } catch {
    return null;
  }
}

function nextPowerOfTwo(value: number): number {
  const safeValue = Math.max(1, Math.ceil(value));
  return 2 ** Math.ceil(Math.log2(safeValue));
}

function getActiveScalogramFftPlanKeys(): Set<string> {
  const planKeys = new Set<string>();

  for (const plan of [analysisState.overview.plan, analysisState.visible.plan]) {
    if (plan?.analysisType === 'scalogram') {
      planKeys.add(buildScalogramFftPlanKey(plan));
    }
  }

  return planKeys;
}

function pruneScalogramFftWindowCache(computeState: WebGpuScalogramComputeState): void {
  const activePlanKeys = getActiveScalogramFftPlanKeys();

  for (const [cacheKey, resource] of computeState.fftWindowCache) {
    if (activePlanKeys.has(resource.planKey)) {
      continue;
    }

    if (resource.spectrumBuffer && typeof resource.spectrumBuffer.destroy === 'function') {
      resource.spectrumBuffer.destroy();
    }
    computeState.fftWindowCache.delete(cacheKey);
  }

  if (computeState.fftWindowCache.size <= MAX_SCALOGRAM_FFT_WINDOW_CACHE_ENTRIES) {
    return;
  }

  const removable = [...computeState.fftWindowCache.values()]
    .sort((left, right) => left.lastUsedSerial - right.lastUsedSerial);
  const removeCount = computeState.fftWindowCache.size - MAX_SCALOGRAM_FFT_WINDOW_CACHE_ENTRIES;

  for (let index = 0; index < removeCount; index += 1) {
    const resource = removable[index];
    if (!resource) {
      break;
    }
    if (resource.spectrumBuffer && typeof resource.spectrumBuffer.destroy === 'function') {
      resource.spectrumBuffer.destroy();
    }
    computeState.fftWindowCache.delete(resource.key);
  }
}

function buildScalogramFftWindowCacheKey(
  plan: RenderRequestPlan,
  fftSize: number,
  windowStartSample: number,
): string {
  return [
    buildScalogramFftPlanKey(plan),
    `fft${fftSize}`,
    `start${windowStartSample}`,
  ].join(':');
}

function recordScalogramFftPathFailure(computeState: WebGpuScalogramComputeState): void {
  computeState.fftFailureCount += 1;
  if (computeState.fftFailureCount >= 3) {
    computeState.fftFastPathDisabled = true;
  }
}

function canUseWebGpuNativeCompute(plan: RenderRequestPlan): boolean {
  return ENABLE_EXPERIMENTAL_WEBGPU_SPECTROGRAM_COMPUTE
    && surfaceState.backend === 'webgpu'
    && !surfaceState.webGpu?.analysisFallbackReasons[plan.analysisType]
    && analysisState.sampleRate > 0
    && analysisState.sampleCount > 0
    && analysisState.samples instanceof Float32Array
    && analysisState.samples.length >= analysisState.sampleCount;
}

function markAnalysisTypeWebGpuFallback(plan: RenderRequestPlan, reason: string): void {
  if (surfaceState.webGpu) {
    surfaceState.webGpu.analysisFallbackReasons[plan.analysisType] = reason;
  }
}

function writeBufferAtOffset(target: any, offset: number, data: ArrayBuffer): void {
  const webGpu = surfaceState.webGpu;
  if (!webGpu) {
    return;
  }

  webGpu.device.queue.writeBuffer(target, offset, data);
}

function createStftComputeParamsData(
  plan: RenderRequestPlan,
  {
    columnCount,
    decimationFactor,
    sampleCount,
    sampleRate,
    slotStageIndex,
    tileSpan,
    tileStart,
    useLowFrequencyEnhancement,
  }: {
    columnCount: number;
    decimationFactor: number;
    sampleCount: number;
    sampleRate: number;
    slotStageIndex: number;
    tileSpan: number;
    tileStart: number;
    useLowFrequencyEnhancement: boolean;
  },
): ArrayBuffer {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  const halfFftSize = Math.max(1, plan.fftSize / 2);
  const powerScale = 1 / (halfFftSize * halfFftSize);

  view.setUint32(0, plan.fftSize, true);
  view.setUint32(4, columnCount, true);
  view.setUint32(8, plan.rowCount, true);
  view.setUint32(12, sampleCount, true);
  view.setUint32(16, slotStageIndex, true);
  view.setUint32(20, WINDOW_FUNCTION_CODES[plan.windowFunction] ?? 0, true);
  view.setUint32(24, decimationFactor, true);
  view.setUint32(28, useLowFrequencyEnhancement ? 1 : 0, true);
  view.setFloat32(32, tileStart, true);
  view.setFloat32(36, tileSpan, true);
  view.setFloat32(40, sampleRate, true);
  view.setFloat32(44, powerScale, true);
  view.setFloat32(48, COLORMAP_DISTRIBUTION_GAMMAS[plan.colormapDistribution], true);
  view.setFloat32(52, plan.minDecibels, true);
  view.setFloat32(56, plan.maxDecibels, true);
  return buffer;
}

function createStftRenderParamsData(
  plan: RenderRequestPlan,
  {
    columnCount,
    sampleCount,
    sampleRate,
    tileSpan,
    tileStart,
    useLowFrequencyEnhancement,
  }: {
    columnCount: number;
    sampleCount: number;
    sampleRate: number;
    tileSpan: number;
    tileStart: number;
    useLowFrequencyEnhancement: boolean;
  },
): ArrayBuffer {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  const halfFftSize = Math.max(1, plan.fftSize / 2);
  const powerScale = 1 / (halfFftSize * halfFftSize);

  view.setUint32(0, plan.fftSize, true);
  view.setUint32(4, columnCount, true);
  view.setUint32(8, plan.rowCount, true);
  view.setUint32(12, sampleCount, true);
  view.setUint32(16, plan.melBandCount, true);
  view.setUint32(20, ANALYSIS_TYPE_CODES[plan.analysisType] ?? 0, true);
  view.setUint32(24, plan.decimationFactor, true);
  view.setUint32(28, useLowFrequencyEnhancement ? 1 : 0, true);
  view.setFloat32(32, tileStart, true);
  view.setFloat32(36, tileSpan, true);
  view.setFloat32(40, sampleRate, true);
  view.setFloat32(44, powerScale, true);
  view.setFloat32(48, COLORMAP_DISTRIBUTION_GAMMAS[plan.colormapDistribution], true);
  view.setFloat32(52, plan.minDecibels, true);
  view.setFloat32(56, plan.maxDecibels, true);
  return buffer;
}

function createScalogramComputeParamsData(
  plan: RenderRequestPlan,
  {
    columnCount,
    sampleCount,
    sampleRate,
    tileSpan,
    tileStart,
  }: {
    columnCount: number;
    sampleCount: number;
    sampleRate: number;
    tileSpan: number;
    tileStart: number;
  },
): ArrayBuffer {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  view.setUint32(0, columnCount, true);
  view.setUint32(4, plan.rowCount, true);
  view.setUint32(8, sampleCount, true);
  view.setFloat32(16, tileStart, true);
  view.setFloat32(20, tileSpan, true);
  view.setFloat32(24, sampleRate, true);
  view.setFloat32(48, COLORMAP_DISTRIBUTION_GAMMAS[plan.colormapDistribution], true);
  view.setFloat32(52, plan.minDecibels, true);
  view.setFloat32(56, plan.maxDecibels, true);
  return buffer;
}

function createCqtComputeParamsData(
  columnCount: number,
  binCount: number,
  sampleCount: number,
  sampleRate: number,
  tileStart: number,
  tileSpan: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  view.setUint32(0, columnCount, true);
  view.setUint32(4, binCount, true);
  view.setUint32(8, sampleCount, true);
  view.setFloat32(16, tileStart, true);
  view.setFloat32(20, tileSpan, true);
  view.setFloat32(24, sampleRate, true);
  return buffer;
}

function createCqtRenderParamsData(
  plan: RenderRequestPlan,
  columnCount: number,
  binCount: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  view.setUint32(0, columnCount, true);
  view.setUint32(4, plan.rowCount, true);
  view.setUint32(8, binCount, true);
  view.setFloat32(48, COLORMAP_DISTRIBUTION_GAMMAS[plan.colormapDistribution], true);
  return buffer;
}

function createScalogramFftStageParamsData(
  fftSize: number,
  stageIndex: number,
  inverse: boolean,
  sequenceCount: number = 1,
): ArrayBuffer {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  view.setUint32(0, fftSize, true);
  view.setUint32(4, stageIndex, true);
  view.setUint32(8, inverse ? 1 : 0, true);
  view.setUint32(12, Math.max(1, sequenceCount), true);
  return buffer;
}

function createScalogramFftMultiplyParamsData(
  fftSize: number,
  batchCount: number,
  halfFftSize: number,
  rowStart: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  view.setUint32(0, fftSize, true);
  view.setUint32(4, rowStart, true);
  view.setUint32(8, batchCount, true);
  view.setUint32(12, halfFftSize, true);
  return buffer;
}

function createScalogramFftRenderParamsData(
  plan: RenderRequestPlan,
  {
    batchCount,
    columnCount,
    fftSize,
    inputSampleCount,
    inputStartSample,
    rowStart,
    tileSpan,
    tileStart,
  }: {
    batchCount: number;
    columnCount: number;
    fftSize: number;
    inputSampleCount: number;
    inputStartSample: number;
    rowStart: number;
    tileSpan: number;
    tileStart: number;
  },
): ArrayBuffer {
  const buffer = new ArrayBuffer(64);
  const view = new DataView(buffer);
  view.setUint32(0, fftSize, true);
  view.setUint32(4, columnCount, true);
  view.setUint32(8, plan.rowCount, true);
  view.setUint32(12, rowStart, true);
  view.setUint32(16, batchCount, true);
  view.setUint32(20, inputSampleCount, true);
  view.setUint32(24, Math.max(0, inputStartSample), true);
  view.setFloat32(32, tileStart, true);
  view.setFloat32(36, tileSpan, true);
  view.setFloat32(40, analysisState.sampleRate, true);
  view.setFloat32(44, 1 / Math.max(1, fftSize), true);
  view.setFloat32(48, COLORMAP_DISTRIBUTION_GAMMAS[plan.colormapDistribution], true);
  view.setFloat32(52, plan.minDecibels, true);
  view.setFloat32(56, plan.maxDecibels, true);
  return buffer;
}

function ensureWebGpuScalogramFftScratchBuffers(
  fftSize: number,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuScalogramComputeState,
): boolean {
  if (computeState.fftScratchFftSize === fftSize
    && computeState.fftBatchSourceBuffer
    && computeState.fftBatchPingBuffer
    && computeState.fftBatchPongBuffer
    && computeState.fftSourceBuffer
    && computeState.fftScratchPingBuffer
    && computeState.fftScratchPongBuffer) {
    return true;
  }

  destroyScalogramFftScratchBuffers(computeState);

  try {
    const globals = getWebGpuGlobals();
    if (!globals) {
      return false;
    }

    const byteLength = fftSize * Float32Array.BYTES_PER_ELEMENT * 2;
    const batchByteLength = byteLength * SCALOGRAM_FFT_ROW_BATCH_SIZE;
    computeState.fftSourceBuffer = webGpu.device.createBuffer({
      size: byteLength,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.STORAGE,
    });
    computeState.fftScratchPingBuffer = webGpu.device.createBuffer({
      size: byteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.fftScratchPongBuffer = webGpu.device.createBuffer({
      size: byteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.fftBatchSourceBuffer = webGpu.device.createBuffer({
      size: batchByteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.fftBatchPingBuffer = webGpu.device.createBuffer({
      size: batchByteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.fftBatchPongBuffer = webGpu.device.createBuffer({
      size: batchByteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.fftScratchFftSize = fftSize;
    return true;
  } catch {
    destroyScalogramFftScratchBuffers(computeState);
    return false;
  }
}

function createScalogramFftInputData(
  fftSize: number,
  inputEndSample: number,
  inputStartSample: number,
): Float32Array {
  const data = new Float32Array(fftSize * 2);
  const samples = analysisState.samples;
  if (!samples) {
    return data;
  }

  const clampedStart = clamp(inputStartSample, 0, analysisState.sampleCount);
  const clampedEnd = clamp(inputEndSample, clampedStart, analysisState.sampleCount);
  let sourceIndex = clampedStart;
  let targetIndex = 0;

  while (sourceIndex < clampedEnd && targetIndex < fftSize) {
    data[targetIndex * 2] = samples[sourceIndex] ?? 0;
    sourceIndex += 1;
    targetIndex += 1;
  }

  return data;
}

function getScalogramMaxSupportSamples(plan: RenderRequestPlan): number {
  const safeFrequency = Math.max(1, plan.minFrequency);
  const scaleSeconds = Math.max(1, plan.scalogramOmega0) / ((Math.PI * 2) * safeFrequency);
  return Math.min(
    4096,
    Math.max(24, Math.ceil(scaleSeconds * 3 * analysisState.sampleRate)),
  );
}

function getScalogramFftReuseWindow(
  tileStart: number,
  tileEnd: number,
  maxSupportSamples: number,
): {
  fftSize: number;
  inputEndSample: number;
  inputSampleCount: number;
  inputStartSample: number;
  reuseWindowStride: number;
} | null {
  if (!ENABLE_EXPERIMENTAL_WEBGPU_SCALOGRAM_FFT || analysisState.sampleRate <= 0) {
    return null;
  }

  const tileSampleSpan = Math.max(1, Math.ceil(Math.max(0, tileEnd - tileStart) * analysisState.sampleRate));
  const reuseWindowSampleCount = nextPowerOfTwo(clamp(
    (tileSampleSpan * 4) + (maxSupportSamples * 2),
    8192,
    SCALOGRAM_FFT_MAX_INPUT_SAMPLES,
  ));
  const reuseWindowStride = Math.max(1, Math.trunc(reuseWindowSampleCount / 2));
  const tileCenterSample = Math.round(((tileStart + tileEnd) * 0.5) * analysisState.sampleRate);
  const snappedCenterSample = Math.floor(tileCenterSample / reuseWindowStride) * reuseWindowStride;
  const inputStartSample = clamp(
    snappedCenterSample - Math.trunc(reuseWindowSampleCount / 2),
    0,
    Math.max(0, analysisState.sampleCount - reuseWindowSampleCount),
  );
  const inputEndSample = Math.min(analysisState.sampleCount, inputStartSample + reuseWindowSampleCount);
  const expandedStartSample = Math.floor(tileStart * analysisState.sampleRate) - maxSupportSamples;
  const expandedEndSample = Math.ceil(tileEnd * analysisState.sampleRate) + maxSupportSamples + 1;
  const paddedWindowEnd = inputStartSample + reuseWindowSampleCount;
  const canCoverLeft = inputStartSample === 0 || expandedStartSample >= inputStartSample;
  const canCoverRight = paddedWindowEnd >= analysisState.sampleCount || expandedEndSample <= paddedWindowEnd;

  if (!canCoverLeft || !canCoverRight || reuseWindowSampleCount > SCALOGRAM_FFT_MAX_INPUT_SAMPLES) {
    return null;
  }

  return {
    fftSize: reuseWindowSampleCount,
    inputEndSample,
    inputSampleCount: Math.max(1, inputEndSample - inputStartSample),
    inputStartSample,
    reuseWindowStride,
  };
}

function getScalogramFftWindowResource(
  plan: RenderRequestPlan,
  fftWindow: {
    fftSize: number;
    inputEndSample: number;
    inputSampleCount: number;
    inputStartSample: number;
  },
  webGpu: WebGpuCompositorState,
  computeState: WebGpuScalogramComputeState,
): ScalogramFftWindowResource | null {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return null;
  }

  pruneScalogramFftWindowCache(computeState);
  const cacheKey = buildScalogramFftWindowCacheKey(plan, fftWindow.fftSize, fftWindow.inputStartSample);
  const cached = computeState.fftWindowCache.get(cacheKey) ?? null;
  if (cached) {
    cached.lastUsedSerial = ++computeState.fftWindowUseSerial;
    return cached;
  }

  if (!ensureWebGpuScalogramFftScratchBuffers(fftWindow.fftSize, webGpu, computeState)) {
    return null;
  }

  try {
    const inputData = createScalogramFftInputData(
      fftWindow.fftSize,
      fftWindow.inputEndSample,
      fftWindow.inputStartSample,
    );
    webGpu.device.queue.writeBuffer(
      computeState.fftSourceBuffer,
      0,
      inputData.buffer,
      inputData.byteOffset,
      inputData.byteLength,
    );

    const stageCount = getFftStageCount(fftWindow.fftSize);
    const [fftDispatchX, fftDispatchY] = getLinearComputeDispatchSize(
      fftWindow.fftSize / 2,
      webGpu.device,
    );
    const commandEncoder = webGpu.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(computeState.fftPipeline);
    let forwardSourceBuffer = computeState.fftSourceBuffer;
    let forwardTargetBuffer = computeState.fftScratchPingBuffer;

    for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
      const paramOffset = computeState.fftParamStride * stageIndex;
      writeBufferAtOffset(
        computeState.fftParamBuffer,
        paramOffset,
        createScalogramFftStageParamsData(fftWindow.fftSize, stageIndex, false),
      );
      const bindGroup = webGpu.device.createBindGroup({
        layout: computeState.fftBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeState.fftParamBuffer, size: 16 } },
          { binding: 1, resource: { buffer: forwardSourceBuffer } },
          { binding: 2, resource: { buffer: forwardTargetBuffer } },
        ],
      });
      computePass.setBindGroup(0, bindGroup, [paramOffset]);
      computePass.dispatchWorkgroups(fftDispatchX, fftDispatchY);

      const nextSourceBuffer = forwardTargetBuffer;
      forwardTargetBuffer = nextSourceBuffer === computeState.fftScratchPingBuffer
        ? computeState.fftScratchPongBuffer
        : computeState.fftScratchPingBuffer;
      forwardSourceBuffer = nextSourceBuffer;
    }

    computePass.end();

    const byteLength = fftWindow.fftSize * Float32Array.BYTES_PER_ELEMENT * 2;
    const spectrumBuffer = webGpu.device.createBuffer({
      size: byteLength,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.COPY_SRC | globals.bufferUsage.STORAGE,
    });
    commandEncoder.copyBufferToBuffer(forwardSourceBuffer, 0, spectrumBuffer, 0, byteLength);
    webGpu.device.queue.submit([commandEncoder.finish()]);

    const resource: ScalogramFftWindowResource = {
      fftSize: fftWindow.fftSize,
      inputSampleCount: fftWindow.inputSampleCount,
      key: cacheKey,
      lastUsedSerial: ++computeState.fftWindowUseSerial,
      planKey: buildScalogramFftPlanKey(plan),
      spectrumBuffer,
      windowStartSample: fftWindow.inputStartSample,
    };
    computeState.fftWindowCache.set(cacheKey, resource);
    pruneScalogramFftWindowCache(computeState);
    return resource;
  } catch {
    return null;
  }
}

function initializeWebGpuStftCompute(webGpu: WebGpuCompositorState): WebGpuStftComputeState | null {
  if (webGpu.stftCompute) {
    return webGpu.stftCompute;
  }

  const globals = getWebGpuGlobals();
  if (!globals || !Number.isFinite(globals.textureUsage.STORAGE_BINDING)) {
    return null;
  }

  try {
    const inputModule = webGpu.device.createShaderModule({ code: WEBGPU_SPECTROGRAM_INPUT_SHADER });
    const fftModule = webGpu.device.createShaderModule({ code: WEBGPU_SPECTROGRAM_FFT_SHADER });
    const spectrogramRenderModule = webGpu.device.createShaderModule({ code: WEBGPU_SPECTROGRAM_RENDER_SHADER });
    const melRenderModule = webGpu.device.createShaderModule({ code: WEBGPU_MEL_RENDER_SHADER });
    const mfccMelValuesModule = webGpu.device.createShaderModule({ code: WEBGPU_MFCC_MEL_VALUES_SHADER });
    const mfccRenderModule = webGpu.device.createShaderModule({ code: WEBGPU_MFCC_RENDER_SHADER });
    const paramStride = 256;
    const paramSetStride = paramStride * WEBGPU_STFT_PARAM_ENTRIES_PER_SLOT;
    const paramBuffer = webGpu.device.createBuffer({
      size: paramSetStride * WEBGPU_STFT_SCRATCH_SLOT_COUNT,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM,
    });
    const inputBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
    const renderSpectrogramBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
    const renderMelBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 5,
          storageTexture: {
            access: 'write-only',
            format: WEBGPU_TILE_TEXTURE_FORMAT as any,
            viewDimension: '2d',
          },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    const renderMelEnergyBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 5,
          buffer: { type: 'storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    const renderMfccBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
          storageTexture: {
            access: 'write-only',
            format: WEBGPU_TILE_TEXTURE_FORMAT as any,
            viewDimension: '2d',
          },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    webGpu.stftCompute = {
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
      mfccBasisResources: new Map(),
      paramBuffer,
      paramSetStride,
      paramStride,
      pcmBuffer: null,
      pcmSampleCount: 0,
      renderMfccBindGroupLayout,
      renderMfccPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'renderMfccTexture',
          module: mfccRenderModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderMfccBindGroupLayout],
        }),
      }),
      renderMelEnergyBindGroupLayout,
      renderMelEnergyPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'computeMfccMelValues',
          module: mfccMelValuesModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderMelEnergyBindGroupLayout],
        }),
      }),
      renderMelBindGroupLayout,
      renderMelPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'renderMelTexture',
          module: melRenderModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderMelBindGroupLayout],
        }),
      }),
      renderSpectrogramBindGroupLayout,
      renderSpectrogramPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'renderSpectrogramTexture',
          module: spectrogramRenderModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderSpectrogramBindGroupLayout],
        }),
      }),
      scratchFftSize: 0,
      scratchSlots: [],
    };
  } catch {
    return null;
  }

  return webGpu.stftCompute;
}

function initializeWebGpuCqtCompute(webGpu: WebGpuCompositorState): WebGpuCqtComputeState | null {
  if (webGpu.cqtCompute) {
    return webGpu.cqtCompute;
  }

  const globals = getWebGpuGlobals();
  if (!globals || !Number.isFinite(globals.textureUsage.STORAGE_BINDING)) {
    return null;
  }

  try {
    const valuesModule = webGpu.device.createShaderModule({ code: WEBGPU_CQT_VALUES_SHADER });
    const renderModule = webGpu.device.createShaderModule({ code: WEBGPU_CQT_CHROMA_RENDER_SHADER });
    const paramBuffer = webGpu.device.createBuffer({
      size: 512,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM,
    });
    const renderValuesBindGroupLayout = webGpu.device.createBindGroupLayout({
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
          buffer: { type: 'storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    const renderChromaBindGroupLayout = webGpu.device.createBindGroupLayout({
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
          storageTexture: {
            access: 'write-only',
            format: WEBGPU_TILE_TEXTURE_FORMAT as any,
            viewDimension: '2d',
          },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });

    webGpu.cqtCompute = {
      cqtValueBuffer: null,
      cqtValueBufferCapacity: 0,
      kernelResources: new Map(),
      paramBuffer,
      pcmBuffer: null,
      pcmSampleCount: 0,
      renderChromaBindGroupLayout,
      renderChromaPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'renderCqtChromaTexture',
          module: renderModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderChromaBindGroupLayout],
        }),
      }),
      renderValuesBindGroupLayout,
      renderValuesPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'computeCqtValues',
          module: valuesModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderValuesBindGroupLayout],
        }),
      }),
    };
  } catch {
    return null;
  }

  return webGpu.cqtCompute;
}

function initializeWebGpuScalogramCompute(webGpu: WebGpuCompositorState): WebGpuScalogramComputeState | null {
  if (webGpu.scalogramCompute) {
    return webGpu.scalogramCompute;
  }

  const globals = getWebGpuGlobals();
  if (!globals || !Number.isFinite(globals.textureUsage.STORAGE_BINDING)) {
    return null;
  }

  try {
    const fftModule = webGpu.device.createShaderModule({ code: WEBGPU_SCALOGRAM_FFT_SHADER });
    const multiplyModule = webGpu.device.createShaderModule({ code: WEBGPU_SCALOGRAM_FFT_MULTIPLY_SHADER });
    const fftRenderModule = webGpu.device.createShaderModule({ code: WEBGPU_SCALOGRAM_FFT_RENDER_SHADER });
    const renderModule = webGpu.device.createShaderModule({ code: WEBGPU_SCALOGRAM_RENDER_SHADER });
    const paramStride = 256;
    const paramBuffer = webGpu.device.createBuffer({
      size: paramStride,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM,
    });
    const fftParamStride = 256;
    const fftParamBuffer = webGpu.device.createBuffer({
      size: fftParamStride * WEBGPU_SCALOGRAM_FFT_PARAM_ENTRY_COUNT,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM,
    });
    const fftBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
    const fftMultiplyBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
          buffer: { type: 'storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    const fftRenderBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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
          storageTexture: {
            access: 'write-only',
            format: WEBGPU_TILE_TEXTURE_FORMAT as any,
            viewDimension: '2d',
          },
          visibility: globals.shaderStage.COMPUTE,
        },
      ],
    });
    const renderBindGroupLayout = webGpu.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          buffer: { hasDynamicOffset: true, type: 'uniform' },
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

    webGpu.scalogramCompute = {
      fftBindGroupLayout,
      fftMultiplyBindGroupLayout,
      fftMultiplyPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'multiplyScalogramWavelet',
          module: multiplyModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [fftMultiplyBindGroupLayout],
        }),
      }),
      fftParamBuffer,
      fftParamStride,
      fftPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'runScalogramFftStage',
          module: fftModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [fftBindGroupLayout],
        }),
      }),
      fftRenderBindGroupLayout,
      fftRenderPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'renderScalogramFftRow',
          module: fftRenderModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [fftRenderBindGroupLayout],
        }),
      }),
      fftBatchPingBuffer: null,
      fftBatchPongBuffer: null,
      fftBatchSourceBuffer: null,
      fftFailureCount: 0,
      fftFastPathDisabled: false,
      fftResources: new Map(),
      fftScratchFftSize: 0,
      fftWindowCache: new Map(),
      fftWindowUseSerial: 0,
      fftSourceBuffer: null,
      fftScratchPingBuffer: null,
      fftScratchPongBuffer: null,
      kernelResources: new Map(),
      paramBuffer,
      paramStride,
      pcmBuffer: null,
      pcmSampleCount: 0,
      renderBindGroupLayout,
      renderPipeline: webGpu.device.createComputePipeline({
        compute: {
          entryPoint: 'renderScalogramTexture',
          module: renderModule,
        },
        layout: webGpu.device.createPipelineLayout({
          bindGroupLayouts: [renderBindGroupLayout],
        }),
      }),
    };
  } catch {
    return null;
  }

  return webGpu.scalogramCompute;
}

function ensureWebGpuPcmBuffer(
  webGpu: WebGpuCompositorState,
  computeState: { pcmBuffer: any; pcmSampleCount: number },
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
  if ('scratchSlots' in computeState) {
    destroyWebGpuStftScratchSlots(computeState as WebGpuStftComputeState);
  }
  return true;
}

function ensureWebGpuStftScratchBuffers(
  plan: RenderRequestPlan,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuStftComputeState,
): boolean {
  const globals = getWebGpuGlobals();
  if (!globals || !computeState.pcmBuffer) {
    return false;
  }

  const spectrumByteLength = TILE_COLUMN_COUNT * plan.fftSize * Float32Array.BYTES_PER_ELEMENT * 2;
  const needsScratchRebuild =
    computeState.scratchFftSize !== plan.fftSize
    || computeState.scratchSlots.length !== WEBGPU_STFT_SCRATCH_SLOT_COUNT;

  if (needsScratchRebuild) {
    destroyWebGpuStftScratchSlots(computeState);

    for (let slotIndex = 0; slotIndex < WEBGPU_STFT_SCRATCH_SLOT_COUNT; slotIndex += 1) {
      const basePingBuffer = webGpu.device.createBuffer({
        size: spectrumByteLength,
        usage: globals.bufferUsage.STORAGE,
      });
      const basePongBuffer = webGpu.device.createBuffer({
        size: spectrumByteLength,
        usage: globals.bufferUsage.STORAGE,
      });
      const lowPingBuffer = webGpu.device.createBuffer({
        size: spectrumByteLength,
        usage: globals.bufferUsage.STORAGE,
      });
      const lowPongBuffer = webGpu.device.createBuffer({
        size: spectrumByteLength,
        usage: globals.bufferUsage.STORAGE,
      });

      computeState.scratchSlots.push({
        baseInputBindGroup: webGpu.device.createBindGroup({
          layout: computeState.inputBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
            { binding: 1, resource: { buffer: computeState.pcmBuffer } },
            { binding: 2, resource: { buffer: basePingBuffer } },
          ],
        }),
        basePingBuffer,
        basePongBuffer,
        fftBindGroupForward: webGpu.device.createBindGroup({
          layout: computeState.fftBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
            { binding: 1, resource: { buffer: basePingBuffer } },
            { binding: 2, resource: { buffer: basePongBuffer } },
          ],
        }),
        fftBindGroupReverse: webGpu.device.createBindGroup({
          layout: computeState.fftBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
            { binding: 1, resource: { buffer: basePongBuffer } },
            { binding: 2, resource: { buffer: basePingBuffer } },
          ],
        }),
        mfccMelBuffer: null,
        mfccMelBufferCapacity: 0,
        lowInputBindGroup: webGpu.device.createBindGroup({
          layout: computeState.inputBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
            { binding: 1, resource: { buffer: computeState.pcmBuffer } },
            { binding: 2, resource: { buffer: lowPingBuffer } },
          ],
        }),
        lowPingBuffer,
        lowPongBuffer,
        lowStageBindGroupForward: webGpu.device.createBindGroup({
          layout: computeState.fftBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
            { binding: 1, resource: { buffer: lowPingBuffer } },
            { binding: 2, resource: { buffer: lowPongBuffer } },
          ],
        }),
        lowStageBindGroupReverse: webGpu.device.createBindGroup({
          layout: computeState.fftBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
            { binding: 1, resource: { buffer: lowPongBuffer } },
            { binding: 2, resource: { buffer: lowPingBuffer } },
          ],
        }),
      });
    }

    computeState.scratchFftSize = plan.fftSize;
  }

  return true;
}

function ensureWebGpuMfccScratchBuffer(
  slot: WebGpuStftScratchSlot,
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  webGpu: WebGpuCompositorState,
): boolean {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return false;
  }

  const requiredValueCount = Math.max(1, tileRecord.columnCount * plan.melBandCount);
  if (slot.mfccMelBuffer && slot.mfccMelBufferCapacity >= requiredValueCount) {
    return true;
  }

  if (slot.mfccMelBuffer && typeof slot.mfccMelBuffer.destroy === 'function') {
    slot.mfccMelBuffer.destroy();
  }

  try {
    slot.mfccMelBuffer = webGpu.device.createBuffer({
      size: alignTo(requiredValueCount * Float32Array.BYTES_PER_ELEMENT, 4),
      usage: globals.bufferUsage.STORAGE,
    });
    slot.mfccMelBufferCapacity = requiredValueCount;
    return true;
  } catch {
    slot.mfccMelBuffer = null;
    slot.mfccMelBufferCapacity = 0;
    return false;
  }
}

function ensureWebGpuCqtValueBuffer(
  computeState: WebGpuCqtComputeState,
  tileRecord: TileRecord,
  binCount: number,
  webGpu: WebGpuCompositorState,
): boolean {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return false;
  }

  const requiredValueCount = Math.max(1, tileRecord.columnCount * Math.max(1, binCount));
  if (computeState.cqtValueBuffer && computeState.cqtValueBufferCapacity >= requiredValueCount) {
    return true;
  }

  if (computeState.cqtValueBuffer && typeof computeState.cqtValueBuffer.destroy === 'function') {
    computeState.cqtValueBuffer.destroy();
  }

  try {
    computeState.cqtValueBuffer = webGpu.device.createBuffer({
      size: alignTo(requiredValueCount * Float32Array.BYTES_PER_ELEMENT, 4),
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.cqtValueBufferCapacity = requiredValueCount;
    return true;
  } catch {
    computeState.cqtValueBuffer = null;
    computeState.cqtValueBufferCapacity = 0;
    return false;
  }
}

async function renderStftTileWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
  scratchSlotIndex: number,
): Promise<boolean> {
  const webGpu = surfaceState.webGpu;
  if (!webGpu) {
    return false;
  }

  const computeState = initializeWebGpuStftCompute(webGpu);
  if (!computeState) {
    markAnalysisTypeWebGpuFallback(plan, 'STFT WebGPU compute initialization failed.');
    return false;
  }
  if (!ensureWebGpuPcmBuffer(webGpu, computeState) || !ensureWebGpuStftScratchBuffers(plan, webGpu, computeState)) {
    markAnalysisTypeWebGpuFallback(plan, 'STFT WebGPU buffers are unavailable.');
    return false;
  }

  const layoutResource = getStftLayoutResource(plan, webGpu, computeState);
  if (!layoutResource) {
    return false;
  }
  const mfccBasisResource = plan.analysisType === 'mfcc'
    ? getMfccBasisResource(plan, webGpu, computeState)
    : null;
  if (plan.analysisType === 'mfcc' && !mfccBasisResource) {
    return false;
  }

  if (!ensureTileGpuResources(tileRecord, webGpu, { requiresStorage: true, uploadIfDirty: false })) {
    return false;
  }

  const stageCount = getFftStageCount(plan.fftSize);
  const columnCount = tileRecord.columnCount;
  const sampleCount = analysisState.sampleCount;
  const tileSpan = Math.max((1 / analysisState.sampleRate), tileEnd - tileStart);
  const useLowFrequencyEnhancement = plan.analysisType === 'spectrogram'
    && 'hasEnhancedRows' in layoutResource
    && layoutResource.hasEnhancedRows
    && plan.decimationFactor > 1;
  const [inputDispatchX, inputDispatchY] = getLinearComputeDispatchSize(
    columnCount * plan.fftSize,
    webGpu.device,
  );
  const [fftDispatchX, fftDispatchY] = getLinearComputeDispatchSize(
    columnCount * (plan.fftSize / 2),
    webGpu.device,
  );
  const slotIndex = Math.max(0, Math.min(computeState.scratchSlots.length - 1, scratchSlotIndex));
  const scratchSlot = computeState.scratchSlots[slotIndex] ?? null;
  if (!scratchSlot) {
    return false;
  }
  if (plan.analysisType === 'mfcc' && !ensureWebGpuMfccScratchBuffer(scratchSlot, plan, tileRecord, webGpu)) {
    return false;
  }
  const slotParamOffsetBase = computeState.paramSetStride * slotIndex;

  try {
    writeBufferAtOffset(computeState.paramBuffer, slotParamOffsetBase, createStftComputeParamsData(plan, {
      columnCount,
      decimationFactor: 1,
      sampleCount,
      sampleRate: analysisState.sampleRate,
      slotStageIndex: 0,
      tileSpan,
      tileStart,
      useLowFrequencyEnhancement,
    }));

    if (useLowFrequencyEnhancement) {
      writeBufferAtOffset(computeState.paramBuffer, slotParamOffsetBase + computeState.paramStride, createStftComputeParamsData(plan, {
        columnCount,
        decimationFactor: plan.decimationFactor,
        sampleCount,
        sampleRate: analysisState.sampleRate,
        slotStageIndex: 0,
        tileSpan,
        tileStart,
        useLowFrequencyEnhancement,
      }));
    }

    for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
      writeBufferAtOffset(
        computeState.paramBuffer,
        slotParamOffsetBase + (computeState.paramStride * (2 + stageIndex)),
        createStftComputeParamsData(plan, {
          columnCount,
          decimationFactor: 1,
          sampleCount,
          sampleRate: analysisState.sampleRate,
          slotStageIndex: stageIndex,
          tileSpan,
          tileStart,
          useLowFrequencyEnhancement,
        }),
      );
    }

    const renderParamOffset = slotParamOffsetBase + (computeState.paramStride * (2 + stageCount));
    writeBufferAtOffset(computeState.paramBuffer, renderParamOffset, createStftRenderParamsData(plan, {
      columnCount,
      sampleCount,
      sampleRate: analysisState.sampleRate,
      tileSpan,
      tileStart,
      useLowFrequencyEnhancement,
    }));

    const commandEncoder = webGpu.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();

    computePass.setPipeline(computeState.inputPipeline);
    computePass.setBindGroup(0, scratchSlot.baseInputBindGroup, [slotParamOffsetBase]);
    computePass.dispatchWorkgroups(inputDispatchX, inputDispatchY);

    if (useLowFrequencyEnhancement && scratchSlot.lowInputBindGroup) {
      computePass.setBindGroup(0, scratchSlot.lowInputBindGroup, [slotParamOffsetBase + computeState.paramStride]);
      computePass.dispatchWorkgroups(inputDispatchX, inputDispatchY);
    }

    computePass.setPipeline(computeState.fftPipeline);
    for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
      const paramOffset = slotParamOffsetBase + (computeState.paramStride * (2 + stageIndex));
      computePass.setBindGroup(
        0,
        stageIndex % 2 === 0 ? scratchSlot.fftBindGroupForward : scratchSlot.fftBindGroupReverse,
        [paramOffset],
      );
      computePass.dispatchWorkgroups(fftDispatchX, fftDispatchY);
    }

    if (useLowFrequencyEnhancement) {
      for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
        const paramOffset = slotParamOffsetBase + (computeState.paramStride * (2 + stageIndex));
        computePass.setBindGroup(
          0,
          stageIndex % 2 === 0 ? scratchSlot.lowStageBindGroupForward : scratchSlot.lowStageBindGroupReverse,
          [paramOffset],
        );
        computePass.dispatchWorkgroups(fftDispatchX, fftDispatchY);
      }
    }

    const finalBaseBuffer = stageCount % 2 === 0 ? scratchSlot.basePingBuffer : scratchSlot.basePongBuffer;
    const finalLowBuffer = useLowFrequencyEnhancement
      ? (stageCount % 2 === 0 ? scratchSlot.lowPingBuffer : scratchSlot.lowPongBuffer)
      : finalBaseBuffer;

    if (plan.analysisType === 'mel') {
      const melResource = layoutResource as WeightedBandLayoutResource;
      const bindGroup = webGpu.device.createBindGroup({
        layout: computeState.renderMelBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
          { binding: 1, resource: { buffer: finalBaseBuffer } },
          { binding: 2, resource: { buffer: melResource.rowBuffer } },
          { binding: 3, resource: { buffer: melResource.binBuffer } },
          { binding: 4, resource: { buffer: melResource.weightBuffer } },
          { binding: 5, resource: tileRecord.gpuTextureView },
        ],
      });
      computePass.setPipeline(computeState.renderMelPipeline);
      computePass.setBindGroup(0, bindGroup, [renderParamOffset]);
    } else if (plan.analysisType === 'mfcc') {
      const melResource = layoutResource as WeightedBandLayoutResource;
      const melEnergyBindGroup = webGpu.device.createBindGroup({
        layout: computeState.renderMelEnergyBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
          { binding: 1, resource: { buffer: finalBaseBuffer } },
          { binding: 2, resource: { buffer: melResource.rowBuffer } },
          { binding: 3, resource: { buffer: melResource.binBuffer } },
          { binding: 4, resource: { buffer: melResource.weightBuffer } },
          { binding: 5, resource: { buffer: scratchSlot.mfccMelBuffer } },
        ],
      });
      computePass.setPipeline(computeState.renderMelEnergyPipeline);
      computePass.setBindGroup(0, melEnergyBindGroup, [renderParamOffset]);
      computePass.dispatchWorkgroups(
        Math.ceil(columnCount / 8),
        Math.ceil(plan.melBandCount / 8),
      );

      const mfccBindGroup = webGpu.device.createBindGroup({
        layout: computeState.renderMfccBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
          { binding: 1, resource: { buffer: scratchSlot.mfccMelBuffer } },
          { binding: 2, resource: { buffer: mfccBasisResource!.buffer } },
          { binding: 3, resource: tileRecord.gpuTextureView },
        ],
      });
      computePass.setPipeline(computeState.renderMfccPipeline);
      computePass.setBindGroup(0, mfccBindGroup, [renderParamOffset]);
    } else {
      const spectrogramResource = layoutResource as SpectrogramBandLayoutResource;
      const bindGroup = webGpu.device.createBindGroup({
        layout: computeState.renderSpectrogramBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
          { binding: 1, resource: { buffer: finalBaseBuffer } },
          { binding: 2, resource: { buffer: finalLowBuffer } },
          { binding: 3, resource: { buffer: spectrogramResource.buffer } },
          { binding: 4, resource: tileRecord.gpuTextureView },
        ],
      });
      computePass.setPipeline(computeState.renderSpectrogramPipeline);
      computePass.setBindGroup(0, bindGroup, [renderParamOffset]);
    }

    computePass.dispatchWorkgroups(
      Math.ceil(columnCount / 8),
      Math.ceil(plan.rowCount / 8),
    );
    computePass.end();

    webGpu.device.queue.submit([commandEncoder.finish()]);
    tileRecord.gpuDirty = false;
    tileRecord.renderedColumns = tileRecord.columnCount;
    tileRecord.complete = true;
    return true;
  } catch (error) {
    destroyTileGpuResources(tileRecord);
    markAnalysisTypeWebGpuFallback(plan, error instanceof Error ? error.message : 'STFT GPU compute failed.');
    return false;
  }
}

function shouldUseFftBasedScalogramTile(
  tileStart: number,
  tileEnd: number,
  maxSupportSamples: number,
): {
  fftSize: number;
  inputEndSample: number;
  inputSampleCount: number;
  inputStartSample: number;
} | null {
  return getScalogramFftReuseWindow(tileStart, tileEnd, maxSupportSamples);
}

async function renderScalogramTileDirectWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuScalogramComputeState,
): Promise<boolean> {
  const kernelResource = getScalogramKernelResource(plan, webGpu, computeState);
  if (!kernelResource) {
    return false;
  }

  if (!ensureTileGpuResources(tileRecord, webGpu, { requiresStorage: true, uploadIfDirty: false })) {
    return false;
  }

  try {
    writeBufferAtOffset(computeState.paramBuffer, 0, createScalogramComputeParamsData(plan, {
      columnCount: tileRecord.columnCount,
      sampleCount: analysisState.sampleCount,
      sampleRate: analysisState.sampleRate,
      tileSpan: Math.max((1 / analysisState.sampleRate), tileEnd - tileStart),
      tileStart,
    }));

    const bindGroup = webGpu.device.createBindGroup({
      layout: computeState.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
        { binding: 1, resource: { buffer: computeState.pcmBuffer } },
        { binding: 2, resource: { buffer: kernelResource.rowBuffer } },
        { binding: 3, resource: { buffer: kernelResource.tapBuffer } },
        { binding: 4, resource: tileRecord.gpuTextureView },
      ],
    });
    const commandEncoder = webGpu.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(computeState.renderPipeline);
    computePass.setBindGroup(0, bindGroup, [0]);
    computePass.dispatchWorkgroups(
      tileRecord.columnCount,
      plan.rowCount,
    );
    computePass.end();
    webGpu.device.queue.submit([commandEncoder.finish()]);
    tileRecord.gpuDirty = false;
    tileRecord.renderedColumns = tileRecord.columnCount;
    tileRecord.complete = true;
    return true;
  } catch (error) {
    destroyTileGpuResources(tileRecord);
    markAnalysisTypeWebGpuFallback(plan, error instanceof Error ? error.message : 'Scalogram GPU compute failed.');
    return false;
  }
}

async function renderScalogramTileWithFftWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
  webGpu: WebGpuCompositorState,
  computeState: WebGpuScalogramComputeState,
): Promise<boolean> {
  if (computeState.fftFastPathDisabled) {
    return false;
  }

  const fftWindow = shouldUseFftBasedScalogramTile(tileStart, tileEnd, getScalogramMaxSupportSamples(plan));
  if (!fftWindow) {
    return false;
  }

  if (!ensureTileGpuResources(tileRecord, webGpu, { requiresStorage: true, uploadIfDirty: false })) {
    return false;
  }

  const fftWindowResource = getScalogramFftWindowResource(plan, fftWindow, webGpu, computeState);
  if (!fftWindowResource || !ensureWebGpuScalogramFftScratchBuffers(fftWindow.fftSize, webGpu, computeState)) {
    recordScalogramFftPathFailure(computeState);
    return false;
  }

  const fftResource = getScalogramFftResource(plan, fftWindow.fftSize, webGpu, computeState);
  if (!fftResource) {
    recordScalogramFftPathFailure(computeState);
    return false;
  }

  try {
    const stageCount = getFftStageCount(fftWindow.fftSize);
    const tileSpan = Math.max((1 / analysisState.sampleRate), tileEnd - tileStart);

    for (let rowStart = 0; rowStart < plan.rowCount; rowStart += SCALOGRAM_FFT_ROW_BATCH_SIZE) {
      const batchCount = Math.min(SCALOGRAM_FFT_ROW_BATCH_SIZE, plan.rowCount - rowStart);
      const [multiplyDispatchX, multiplyDispatchY] = getLinearComputeDispatchSize(
        fftWindow.fftSize * batchCount,
        webGpu.device,
      );
      const [inverseDispatchX, inverseDispatchY] = getLinearComputeDispatchSize(
        (fftWindow.fftSize / 2) * batchCount,
        webGpu.device,
      );
      const [renderDispatchX, renderDispatchY] = getLinearComputeDispatchSize(
        tileRecord.columnCount * batchCount,
        webGpu.device,
      );
      const multiplyParamOffset = 0;
      writeBufferAtOffset(
        computeState.fftParamBuffer,
        multiplyParamOffset,
        createScalogramFftMultiplyParamsData(
          fftWindow.fftSize,
          batchCount,
          fftResource.halfFftSize,
          rowStart,
        ),
      );

      for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
        const paramOffset = computeState.fftParamStride * (1 + stageIndex);
        writeBufferAtOffset(
          computeState.fftParamBuffer,
          paramOffset,
          createScalogramFftStageParamsData(fftWindow.fftSize, stageIndex, true, batchCount),
        );
      }

      const renderParamOffset = computeState.fftParamStride * (1 + stageCount);
      writeBufferAtOffset(
        computeState.fftParamBuffer,
        renderParamOffset,
        createScalogramFftRenderParamsData(plan, {
          batchCount,
          columnCount: tileRecord.columnCount,
          fftSize: fftWindow.fftSize,
          inputSampleCount: fftWindowResource.inputSampleCount,
          inputStartSample: fftWindowResource.windowStartSample,
          rowStart,
          tileSpan,
          tileStart,
        }),
      );

      const batchEncoder = webGpu.device.createCommandEncoder();
      const batchPass = batchEncoder.beginComputePass();

      const multiplyBindGroup = webGpu.device.createBindGroup({
        layout: computeState.fftMultiplyBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeState.fftParamBuffer, size: 16 } },
          { binding: 1, resource: { buffer: fftWindowResource.spectrumBuffer } },
          { binding: 2, resource: { buffer: fftResource.spectrumBuffer } },
          { binding: 3, resource: { buffer: computeState.fftBatchSourceBuffer } },
        ],
      });
      batchPass.setPipeline(computeState.fftMultiplyPipeline);
      batchPass.setBindGroup(0, multiplyBindGroup, [multiplyParamOffset]);
      batchPass.dispatchWorkgroups(multiplyDispatchX, multiplyDispatchY);

      batchPass.setPipeline(computeState.fftPipeline);
      let inverseSourceBuffer = computeState.fftBatchSourceBuffer;
      let inverseTargetBuffer = computeState.fftBatchPingBuffer;

      for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
        const paramOffset = computeState.fftParamStride * (1 + stageIndex);
        const bindGroup = webGpu.device.createBindGroup({
          layout: computeState.fftBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: computeState.fftParamBuffer, size: 16 } },
            { binding: 1, resource: { buffer: inverseSourceBuffer } },
            { binding: 2, resource: { buffer: inverseTargetBuffer } },
          ],
        });
        batchPass.setBindGroup(0, bindGroup, [paramOffset]);
        batchPass.dispatchWorkgroups(inverseDispatchX, inverseDispatchY);

        const nextSourceBuffer = inverseTargetBuffer;
        if (nextSourceBuffer === computeState.fftBatchPingBuffer) {
          inverseTargetBuffer = computeState.fftBatchPongBuffer;
        } else if (nextSourceBuffer === computeState.fftBatchPongBuffer) {
          inverseTargetBuffer = computeState.fftBatchSourceBuffer;
        } else {
          inverseTargetBuffer = computeState.fftBatchPingBuffer;
        }
        inverseSourceBuffer = nextSourceBuffer;
      }

      const renderBindGroup = webGpu.device.createBindGroup({
        layout: computeState.fftRenderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: computeState.fftParamBuffer, size: 64 } },
          { binding: 1, resource: { buffer: inverseSourceBuffer } },
          { binding: 2, resource: { buffer: fftResource.rowBuffer } },
          { binding: 3, resource: tileRecord.gpuTextureView },
        ],
      });
      batchPass.setPipeline(computeState.fftRenderPipeline);
      batchPass.setBindGroup(0, renderBindGroup, [renderParamOffset]);
      batchPass.dispatchWorkgroups(renderDispatchX, renderDispatchY);
      batchPass.end();
      webGpu.device.queue.submit([batchEncoder.finish()]);
    }

    tileRecord.gpuDirty = false;
    tileRecord.renderedColumns = tileRecord.columnCount;
    tileRecord.complete = true;
    computeState.fftFailureCount = 0;
    return true;
  } catch {
    recordScalogramFftPathFailure(computeState);
    return false;
  }
}

async function renderScalogramTileWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
): Promise<boolean> {
  const webGpu = surfaceState.webGpu;
  if (!webGpu) {
    return false;
  }

  const computeState = initializeWebGpuScalogramCompute(webGpu);
  if (!computeState) {
    markAnalysisTypeWebGpuFallback(plan, 'Scalogram WebGPU compute initialization failed.');
    return false;
  }
  if (!ensureWebGpuPcmBuffer(webGpu, computeState)) {
    markAnalysisTypeWebGpuFallback(plan, 'Scalogram WebGPU buffers are unavailable.');
    return false;
  }

  const fftRendered = await renderScalogramTileWithFftWebGpu(
    plan,
    tileRecord,
    tileStart,
    tileEnd,
    webGpu,
    computeState,
  );
  if (fftRendered) {
    return true;
  }

  return renderScalogramTileDirectWithWebGpu(
    plan,
    tileRecord,
    tileStart,
    tileEnd,
    webGpu,
    computeState,
  );
}

async function renderCqtChromaTileWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
): Promise<boolean> {
  const webGpu = surfaceState.webGpu;
  if (!webGpu) {
    return false;
  }

  const computeState = initializeWebGpuCqtCompute(webGpu);
  if (!computeState) {
    markAnalysisTypeWebGpuFallback(plan, 'CQT WebGPU compute initialization failed.');
    return false;
  }
  if (!ensureWebGpuPcmBuffer(webGpu, computeState)) {
    markAnalysisTypeWebGpuFallback(plan, 'CQT WebGPU buffers are unavailable.');
    return false;
  }

  const kernelResource = getCqtKernelResource(plan, webGpu, computeState);
  if (!kernelResource) {
    markAnalysisTypeWebGpuFallback(plan, 'CQT kernel resources are unavailable.');
    return false;
  }
  if (!ensureTileGpuResources(tileRecord, webGpu, { requiresStorage: true, uploadIfDirty: false })) {
    return false;
  }
  if (!ensureWebGpuCqtValueBuffer(computeState, tileRecord, kernelResource.binCount, webGpu)) {
    return false;
  }

  try {
    const tileSpan = Math.max((1 / analysisState.sampleRate), tileEnd - tileStart);
    writeBufferAtOffset(
      computeState.paramBuffer,
      0,
      createCqtComputeParamsData(
        tileRecord.columnCount,
        kernelResource.binCount,
        analysisState.sampleCount,
        analysisState.sampleRate,
        tileStart,
        tileSpan,
      ),
    );
    writeBufferAtOffset(
      computeState.paramBuffer,
      256,
      createCqtRenderParamsData(plan, tileRecord.columnCount, kernelResource.binCount),
    );

    const computeBindGroup = webGpu.device.createBindGroup({
      layout: computeState.renderValuesBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: computeState.paramBuffer, offset: 0, size: 64 } },
        { binding: 1, resource: { buffer: computeState.pcmBuffer } },
        { binding: 2, resource: { buffer: kernelResource.rowBuffer } },
        { binding: 3, resource: { buffer: kernelResource.tapBuffer } },
        { binding: 4, resource: { buffer: computeState.cqtValueBuffer } },
      ],
    });
    const renderBindGroup = webGpu.device.createBindGroup({
      layout: computeState.renderChromaBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: computeState.paramBuffer, offset: 256, size: 64 } },
        { binding: 1, resource: { buffer: computeState.cqtValueBuffer } },
        { binding: 2, resource: { buffer: kernelResource.chromaAssignmentBuffer } },
        { binding: 3, resource: tileRecord.gpuTextureView },
      ],
    });

    const commandEncoder = webGpu.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(computeState.renderValuesPipeline);
    computePass.setBindGroup(0, computeBindGroup);
    computePass.dispatchWorkgroups(tileRecord.columnCount, kernelResource.binCount);

    computePass.setPipeline(computeState.renderChromaPipeline);
    computePass.setBindGroup(0, renderBindGroup);
    computePass.dispatchWorkgroups(
      Math.ceil(tileRecord.columnCount / 8),
      Math.ceil(plan.rowCount / 8),
    );
    computePass.end();

    webGpu.device.queue.submit([commandEncoder.finish()]);
    tileRecord.gpuDirty = false;
    tileRecord.renderedColumns = tileRecord.columnCount;
    tileRecord.complete = true;
    return true;
  } catch (error) {
    destroyTileGpuResources(tileRecord);
    markAnalysisTypeWebGpuFallback(plan, error instanceof Error ? error.message : 'CQT GPU compute failed.');
    return false;
  }
}

async function renderTileWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
  webGpuSlotIndex: number,
): Promise<boolean> {
  return plan.analysisType === 'chroma'
    ? renderCqtChromaTileWithWebGpu(plan, tileRecord, tileStart, tileEnd)
    : plan.analysisType === 'scalogram'
    ? renderScalogramTileWithWebGpu(plan, tileRecord, tileStart, tileEnd)
    : renderStftTileWithWebGpu(plan, tileRecord, tileStart, tileEnd, webGpuSlotIndex);
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
          resource: webGpu.sampler,
        },
        {
          binding: 1,
          resource: tileRecord.gpuTextureView,
        },
      ],
      layout: webGpu.bindGroupLayout,
    });
  }

  if (uploadIfDirty && tileRecord.gpuDirty) {
    if (!tileRecord.imageData) {
      return false;
    }

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

function ensurePresentInstanceBuffer(webGpu: WebGpuCompositorState, requiredInstances: number): void {
  const globals = getWebGpuGlobals();
  if (!globals) {
    return;
  }

  const instanceCount = Math.max(1, requiredInstances);
  if (webGpu.presentInstanceBuffer && webGpu.presentInstanceCapacity >= instanceCount) {
    return;
  }

  if (webGpu.presentInstanceBuffer && typeof webGpu.presentInstanceBuffer.destroy === 'function') {
    webGpu.presentInstanceBuffer.destroy();
  }

  webGpu.presentInstanceCapacity = instanceCount;
  webGpu.presentInstanceBuffer = webGpu.device.createBuffer({
    size: instanceCount * Float32Array.BYTES_PER_ELEMENT * 4,
    usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.VERTEX,
  });
}

function collectLayerWebGpuInstances(
  webGpu: WebGpuCompositorState,
  plan: RenderRequestPlan | null,
  displayRange: AnalysisWorkerState['currentDisplayRange'],
): Array<{ bindGroup: any; destLeft: number; destRight: number; uvStart: number; uvEnd: number }> {
  if (!plan) {
    return [];
  }

  const span = Math.max(1e-6, displayRange.end - displayRange.start);
  const destinationWidth = Math.max(1, surfaceState.pixelWidth);
  const instances: Array<{ bindGroup: any; destLeft: number; destRight: number; uvStart: number; uvEnd: number }> = [];

  for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
    const cacheKey = buildTileCacheKey(plan, tileIndex);
    const tile = getTileRecord(cacheKey);

    if (!tile || !ensureTileGpuResources(tile, webGpu) || !tile.gpuBindGroup) {
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
    instances.push({
      bindGroup: tile.gpuBindGroup,
      destLeft: ((destinationX / destinationWidth) * 2) - 1,
      destRight: (((destinationX + destinationWidthPx) / destinationWidth) * 2) - 1,
      uvEnd: (sourceX + sourceWidth) / tile.columnCount,
      uvStart: sourceX / tile.columnCount,
    });
  }

  return instances;
}

function paintLayerWithWebGpu(
  renderPass: any,
  webGpu: WebGpuCompositorState,
  plan: RenderRequestPlan | null,
  displayRange: AnalysisWorkerState['currentDisplayRange'],
): void {
  const instances = collectLayerWebGpuInstances(webGpu, plan, displayRange);
  if (instances.length === 0) {
    return;
  }

  ensurePresentInstanceBuffer(webGpu, instances.length);
  const instanceData = new Float32Array(instances.length * 4);

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];
    const offset = index * 4;
    instanceData[offset] = instance.destLeft;
    instanceData[offset + 1] = instance.destRight;
    instanceData[offset + 2] = instance.uvStart;
    instanceData[offset + 3] = instance.uvEnd;
  }

  webGpu.device.queue.writeBuffer(webGpu.presentInstanceBuffer, 0, instanceData);
  renderPass.setPipeline(webGpu.tilePipeline);
  renderPass.setVertexBuffer(0, webGpu.presentInstanceBuffer);

  for (let index = 0; index < instances.length; index += 1) {
    renderPass.setBindGroup(0, instances[index].bindGroup);
    renderPass.draw(6, 1, 0, index);
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

    if (!tile || !tile.canvas) {
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
  const isChroma = isChromaAnalysisType(analysisType);
  const colormapDistribution = normalizeColormapDistribution(request?.colormapDistribution);
  const dbWindow = normalizeDbWindow(request?.minDecibels, request?.maxDecibels, analysisType);
  const frequencyScale = getEffectiveFrequencyScale(analysisType, request?.frequencyScale);
  const windowFunction = normalizeSpectrogramWindowFunction(request?.windowFunction);
  const fftSize = analysisType === 'scalogram' || analysisType === 'chroma' ? 0 : normalizeFftSize(request?.fftSize);
  const overlapRatio = analysisType === 'scalogram' || analysisType === 'chroma' ? 0 : normalizeOverlapRatio(request?.overlapRatio);
  const mfccCoefficientCount = normalizeMfccCoefficientCount(request?.mfccCoefficientCount);
  const scalogramOmega0 = normalizeScalogramOmega0(request?.scalogramOmega0);
  const scalogramRowDensity = normalizeScalogramRowDensity(request?.scalogramRowDensity);
  const scalogramFrequencyRange = normalizeScalogramFrequencyRange(
    request?.scalogramMinFrequency,
    request?.scalogramMaxFrequency,
  );
  const melBandCount = analysisType === 'mfcc'
    ? normalizeMfccMelBandCount(request?.mfccMelBandCount ?? request?.melBandCount)
    : normalizeMelBandCount(request?.melBandCount);
  const rowBucketSize = analysisType === 'scalogram' ? SCALOGRAM_ROW_BLOCK_SIZE : ROW_BUCKET_SIZE;
  const rowOversample = requestKind === 'visible' && analysisType !== 'scalogram'
    ? VISIBLE_ROW_OVERSAMPLE
    : analysisType === 'scalogram'
      ? scalogramRowDensity
      : 1;
  const rowCount = isChroma
    ? CHROMA_BIN_COUNT
    : analysisType === 'mel'
    ? melBandCount
    : analysisType === 'mfcc'
      ? mfccCoefficientCount
    : quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier * rowOversample), rowBucketSize);
  const targetColumns = Math.max(
    TILE_COLUMN_COUNT,
    quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2),
  );
  const hopSamples = analysisType === 'scalogram' || analysisType === 'chroma'
    ? normalizeScalogramHopSamples(request?.scalogramHopSamples)
    : Math.max(1, Math.round(fftSize * (1 - overlapRatio)));
  const secondsPerColumn = hopSamples / analysisState.sampleRate;
  const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / analysisState.sampleRate);
  const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
  const endTileIndex = Math.max(
    startTileIndex,
    Math.floor(Math.max(viewStart, viewEnd - (secondsPerColumn * 0.5)) / tileDuration),
  );
  const windowSeconds = analysisType === 'scalogram' || analysisType === 'chroma' ? 0 : fftSize / analysisState.sampleRate;
  const decimationFactor = analysisType === 'spectrogram'
    ? Math.max(1, preset.lowFrequencyDecimationFactor || 1)
    : 1;
  const configKey = [
    `type${analysisType}`,
    `dist${colormapDistribution}`,
    `db${dbWindow.minDecibels}:${dbWindow.maxDecibels}`,
    `scale${frequencyScale}`,
    `win${windowFunction}`,
    `fft${fftSize}`,
    `bands${analysisType === 'mel' || analysisType === 'mfcc' ? melBandCount : 0}`,
    `coeff${analysisType === 'mfcc' ? mfccCoefficientCount : 0}`,
    `min${analysisType === 'scalogram'
      ? scalogramFrequencyRange.minFrequency
      : isChroma
        ? CQT_DEFAULT_FMIN
        : analysisState.minFrequency}`,
    `max${analysisType === 'scalogram' ? scalogramFrequencyRange.maxFrequency : analysisState.maxFrequency}`,
    `omega${analysisType === 'scalogram' ? scalogramOmega0 : 0}`,
    `density${analysisType === 'scalogram' ? scalogramRowDensity : 0}`,
    `ov${Math.round(overlapRatio * 1000)}`,
    `hop${hopSamples}`,
    `rows${rowCount}`,
  ].join('-');

  return {
    analysisType,
    colormapDistribution,
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
    maxDecibels: dbWindow.maxDecibels,
    maxFrequency: analysisType === 'scalogram' ? scalogramFrequencyRange.maxFrequency : analysisState.maxFrequency,
    melBandCount,
    mfccCoefficientCount,
    minDecibels: dbWindow.minDecibels,
    minFrequency: analysisType === 'scalogram'
      ? scalogramFrequencyRange.minFrequency
      : isChroma
        ? CQT_DEFAULT_FMIN
        : analysisState.minFrequency,
    overlapRatio,
    pixelHeight,
    pixelWidth,
    requestKind,
    rowCount,
    windowFunction,
    scalogramOmega0,
    scalogramRowDensity,
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
    colormapDistribution: plan.colormapDistribution,
    configVersion: plan.configVersion,
    decimationFactor: plan.decimationFactor,
    displayEnd: plan.displayEnd,
    displayStart: plan.displayStart,
    fftSize: plan.fftSize,
    frequencyScale: plan.frequencyScale,
    generation: plan.generation,
    hopSamples: plan.hopSamples,
    hopSeconds: plan.hopSeconds,
    maxDecibels: plan.maxDecibels,
    maxFrequency: plan.maxFrequency,
    melBandCount: plan.melBandCount,
    mfccCoefficientCount: plan.mfccCoefficientCount,
    minDecibels: plan.minDecibels,
    minFrequency: plan.minFrequency,
    overlapRatio: plan.overlapRatio,
    pixelHeight: plan.pixelHeight,
    pixelWidth: plan.pixelWidth,
    requestKind: plan.requestKind,
    scalogramHopSamples: plan.hopSamples,
    scalogramOmega0: plan.scalogramOmega0,
    scalogramRowDensity: plan.scalogramRowDensity,
    runtimeVariant: analysisState.runtimeVariant,
    targetColumns: plan.targetColumns,
    targetRows: plan.rowCount,
    viewEnd: plan.viewEnd,
    viewStart: plan.viewStart,
    windowFunction: plan.windowFunction,
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
    && left.colormapDistribution === right.colormapDistribution
    && left.dprBucket === right.dprBucket
    && left.pixelWidth === right.pixelWidth
    && left.pixelHeight === right.pixelHeight
    && left.rowCount === right.rowCount
    && left.targetColumns === right.targetColumns
    && left.fftSize === right.fftSize
    && left.frequencyScale === right.frequencyScale
    && left.minDecibels === right.minDecibels
    && left.maxDecibels === right.maxDecibels
    && left.melBandCount === right.melBandCount
    && left.mfccCoefficientCount === right.mfccCoefficientCount
    && left.minFrequency === right.minFrequency
    && left.maxFrequency === right.maxFrequency
    && Math.abs(left.scalogramOmega0 - right.scalogramOmega0) <= 1e-6
    && Math.abs(left.scalogramRowDensity - right.scalogramRowDensity) <= 1e-6
    && left.hopSamples === right.hopSamples
    && left.windowFunction === right.windowFunction
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

function normalizeMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return MEL_BAND_COUNT_OPTIONS.includes(numericValue)
    ? numericValue
    : LIBROSA_DEFAULT_MEL_BAND_COUNT;
}

function normalizeScalogramOmega0(value: unknown): number {
  const numericValue = Number(value);
  return SCALOGRAM_OMEGA_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_OMEGA0;
}

function normalizeScalogramRowDensity(value: unknown): number {
  const numericValue = Number(value);
  return SCALOGRAM_ROW_DENSITY_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_ROW_DENSITY;
}

function normalizeScalogramHopSamples(value: unknown): number {
  const numericValue = Number(value);
  return SCALOGRAM_HOP_SAMPLES_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_SCALOGRAM_HOP_SAMPLES;
}

function normalizeScalogramFrequencyRange(minValue: unknown, maxValue: unknown): {
  maxFrequency: number;
  minFrequency: number;
} {
  const ceiling = Math.max(
    MIN_FREQUENCY + 1,
    Math.min(MAX_FREQUENCY, Math.round(analysisState.maxFrequency || MAX_FREQUENCY)),
  );
  let minFrequency = Number.isFinite(Number(minValue))
    ? Math.round(Number(minValue))
    : MIN_FREQUENCY;
  let maxFrequency = Number.isFinite(Number(maxValue))
    ? Math.round(Number(maxValue))
    : ceiling;

  minFrequency = clamp(
    minFrequency,
    MIN_FREQUENCY,
    Math.max(MIN_FREQUENCY, ceiling - 1),
  );
  maxFrequency = clamp(
    maxFrequency,
    Math.min(ceiling, minFrequency + 1),
    ceiling,
  );

  if (maxFrequency <= minFrequency) {
    maxFrequency = Math.min(ceiling, minFrequency + 1);
    minFrequency = Math.min(minFrequency, maxFrequency - 1);
  }

  return { minFrequency, maxFrequency };
}

function normalizeMfccCoefficientCount(value: unknown): number {
  const numericValue = Number(value);
  return MFCC_COEFFICIENT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_MFCC_COEFFICIENT_COUNT;
}

function normalizeMfccMelBandCount(value: unknown): number {
  const numericValue = Number(value);
  return MEL_BAND_COUNT_OPTIONS.includes(numericValue)
    ? numericValue
    : DEFAULT_MFCC_MEL_BAND_COUNT;
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
