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
const SPECTROGRAM_COLUMN_CHUNK_SIZE = 32;
const SCALOGRAM_COLUMN_CHUNK_SIZE = 32;
const SCALOGRAM_ROW_BLOCK_SIZE = 32;
const WEBGPU_LINEAR_WORKGROUP_SIZE = 64;
const MAX_TILE_CACHE_ENTRIES = 24;
const MAX_TILE_CACHE_BYTES = 96 * 1024 * 1024;
const ENABLE_EXPERIMENTAL_WEBGPU_COMPOSITOR = true;
const ENABLE_EXPERIMENTAL_WEBGPU_SPECTROGRAM_COMPUTE = true;
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
type AnalysisRenderBackend = '2d-wasm' | 'webgpu-native';
type SurfaceResetReason = 'device-lost' | 'surface-invalid';

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
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var tileSampler: sampler;
@group(0) @binding(1) var tileTexture: texture_2d<f32>;

@vertex
fn tileVs(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) destBounds: vec2<f32>,
  @location(1) uvBounds: vec2<f32>,
) -> VertexOutput {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(destBounds.x, 1.0),
    vec2<f32>(destBounds.y, 1.0),
    vec2<f32>(destBounds.x, -1.0),
    vec2<f32>(destBounds.x, -1.0),
    vec2<f32>(destBounds.y, 1.0),
    vec2<f32>(destBounds.y, -1.0),
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(uvBounds.x, 0.0),
    vec2<f32>(uvBounds.y, 0.0),
    vec2<f32>(uvBounds.x, 1.0),
    vec2<f32>(uvBounds.x, 1.0),
    vec2<f32>(uvBounds.y, 0.0),
    vec2<f32>(uvBounds.y, 1.0),
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

const WEBGPU_PALETTE_SHADER_HELPERS = /* wgsl */`
const LOG10_E: f32 = 0.4342944819032518;
const MIN_DB: f32 = -80.0;
const MAX_DB: f32 = 0.0;

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

@compute @workgroup_size(64)
fn prepareSpectrogramInput(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let sampleCount = params.header0.w;
  let decimationFactor = max(params.header1.z, 1u);
  let totalSamples = fftSize * columnCount;
  let linearIndex = globalId.x + (globalId.y * numWorkgroups.x * 64u);

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
  outputSpectrum[(columnIndex * fftSize) + sampleOffset] = vec2<f32>(sample * window, 0.0);
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
fn runSpectrogramFftStage(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let stageIndex = params.header1.x;
  let q = 1u << stageIndex;
  let l = fftSize >> (stageIndex + 1u);
  let butterfliesPerColumn = fftSize / 2u;
  let totalButterflies = butterfliesPerColumn * columnCount;
  let butterflyIndex = globalId.x + (globalId.y * numWorkgroups.x * 64u);

  if (butterflyIndex >= totalButterflies || l == 0u) {
    return;
  }

  let columnIndex = butterflyIndex / butterfliesPerColumn;
  let localIndex = butterflyIndex % butterfliesPerColumn;
  let j = localIndex / l;
  let k = localIndex % l;
  let columnBase = columnIndex * fftSize;
  let evenIndex = columnBase + ((2u * j * l) + k);
  let oddIndex = evenIndex + l;
  let outputEvenIndex = columnBase + ((j * l) + k);
  let outputOddIndex = columnBase + (((j + q) * l) + k);
  let angle = (-TWO_PI * f32(j)) / f32(2u * q);
  let twiddle = vec2<f32>(cos(angle), sin(angle));
  let evenValue = sourceSpectrum[evenIndex];
  let oddValue = sourceSpectrum[oddIndex];
  let twiddledOdd = complexMul(oddValue, twiddle);

  targetSpectrum[outputEvenIndex] = evenValue + twiddledOdd;
  targetSpectrum[outputOddIndex] = evenValue - twiddledOdd;
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

const WEBGPU_MEL_RENDER_SHADER = /* wgsl */`
${WEBGPU_PALETTE_SHADER_HELPERS}

struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding: vec4<f32>,
};

struct MelRow {
  weightOffset: u32,
  weightCount: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> baseSpectrum: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> melRows: array<MelRow>;
@group(0) @binding(3) var<storage, read> melBins: array<u32>;
@group(0) @binding(4) var<storage, read> melWeights: array<f32>;
@group(0) @binding(5) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn renderMelTexture(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let columnIndex = globalId.x;
  let rowIndex = globalId.y;
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let rowCount = params.header0.z;

  if (columnIndex >= columnCount || rowIndex >= rowCount) {
    return;
  }

  let row = melRows[rowIndex];
  let spectrumBaseIndex = columnIndex * fftSize;
  var weightedEnergy = 0.0;
  var totalWeight = 0.0;
  var weightIndex = row.weightOffset;
  let weightEnd = row.weightOffset + row.weightCount;

  loop {
    if (weightIndex >= weightEnd) {
      break;
    }

    let binIndex = melBins[weightIndex];
    let weight = melWeights[weightIndex];
    let spectrum = baseSpectrum[spectrumBaseIndex + binIndex];
    let power = dot(spectrum, spectrum) * params.timing.w;
    weightedEnergy += power * weight;
    totalWeight += weight;
    weightIndex += 1u;
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

const WEBGPU_SCALOGRAM_RENDER_SHADER = /* wgsl */`
${WEBGPU_PALETTE_SHADER_HELPERS}

struct ComputeParams {
  header0: vec4<u32>,
  timing: vec4<f32>,
  padding0: vec4<u32>,
  padding1: vec4<f32>,
};

struct ScalogramRow {
  tapOffset: u32,
  tapCount: u32,
  firstOffset: i32,
  lastOffset: i32,
  normalization: f32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> pcmSamples: array<f32>;
@group(0) @binding(2) var<storage, read> rowMeta: array<ScalogramRow>;
@group(0) @binding(3) var<storage, read> tapOffsets: array<i32>;
@group(0) @binding(4) var<storage, read> realWeights: array<f32>;
@group(0) @binding(5) var<storage, read> imagWeights: array<f32>;
@group(0) @binding(6) var<storage, read> normWeights: array<f32>;
@group(0) @binding(7) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn renderScalogramTexture(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let columnIndex = globalId.x;
  let rowIndex = globalId.y;
  let columnCount = params.header0.x;
  let rowCount = params.header0.y;
  let sampleCount = params.header0.z;

  if (columnIndex >= columnCount || rowIndex >= rowCount) {
    return;
  }

  var centerRatio = 0.5;
  if (columnCount > 1u) {
    centerRatio = (f32(columnIndex) + 0.5) / f32(columnCount);
  }

  let centerTime = params.timing.x + (centerRatio * params.timing.y);
  let centerSample = i32(round(centerTime * params.timing.z));
  let row = rowMeta[rowIndex];
  let firstSample = centerSample + row.firstOffset;
  let lastSample = centerSample + row.lastOffset;
  let useFullNormalization = firstSample >= 0 && u32(lastSample) < sampleCount;
  var real = 0.0;
  var imaginary = 0.0;
  var norm = select(0.0, row.normalization, useFullNormalization);
  var tapIndex = 0u;

  loop {
    if (tapIndex >= row.tapCount) {
      break;
    }

    let packedIndex = row.tapOffset + tapIndex;
    let sampleIndex = centerSample + tapOffsets[packedIndex];
    if (sampleIndex >= 0 && u32(sampleIndex) < sampleCount) {
      let sample = pcmSamples[u32(sampleIndex)];
      real += sample * realWeights[packedIndex];
      imaginary += sample * imagWeights[packedIndex];
      if (!useFullNormalization) {
        norm += normWeights[packedIndex];
      }
    }
    tapIndex += 1u;
  }

  let power = select(0.0, ((real * real) + (imaginary * imaginary)) / max(norm, 1e-8), norm > 1e-8);
  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(
    outputTexture,
    vec2<i32>(i32(columnIndex), targetRow),
    paletteColor(normalizePower(power)),
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

interface MelBandLayoutResource {
  binBuffer: any;
  key: string;
  rowBuffer: any;
  weightBuffer: any;
}

type WebGpuStftLayoutResource = MelBandLayoutResource | SpectrogramBandLayoutResource;

interface ScalogramKernelResource {
  imagWeightBuffer: any;
  key: string;
  normWeightBuffer: any;
  offsetBuffer: any;
  realWeightBuffer: any;
  rowBuffer: any;
}

interface WebGpuStftComputeState {
  bandLayoutResources: Map<string, WebGpuStftLayoutResource>;
  baseInputBindGroup: any;
  basePingBuffer: any;
  basePongBuffer: any;
  fftBindGroupForward: any;
  fftBindGroupReverse: any;
  fftBindGroupLayout: any;
  fftPipeline: any;
  inputBindGroupLayout: any;
  inputPipeline: any;
  lowInputBindGroup: any;
  lowPingBuffer: any;
  lowPongBuffer: any;
  lowStageBindGroupForward: any;
  lowStageBindGroupReverse: any;
  paramBuffer: any;
  paramStride: number;
  pcmBuffer: any;
  pcmSampleCount: number;
  renderMelBindGroupLayout: any;
  renderMelPipeline: any;
  renderSpectrogramBindGroupLayout: any;
  renderSpectrogramPipeline: any;
  scratchFftSize: number;
}

interface WebGpuScalogramComputeState {
  kernelResources: Map<string, ScalogramKernelResource>;
  paramBuffer: any;
  paramStride: number;
  pcmBuffer: any;
  pcmSampleCount: number;
  renderBindGroupLayout: any;
  renderPipeline: any;
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

function destroyScalogramKernelResources(computeState: WebGpuScalogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  for (const resource of computeState.kernelResources.values()) {
    if (resource.rowBuffer && typeof resource.rowBuffer.destroy === 'function') {
      resource.rowBuffer.destroy();
    }
    if (resource.offsetBuffer && typeof resource.offsetBuffer.destroy === 'function') {
      resource.offsetBuffer.destroy();
    }
    if (resource.realWeightBuffer && typeof resource.realWeightBuffer.destroy === 'function') {
      resource.realWeightBuffer.destroy();
    }
    if (resource.imagWeightBuffer && typeof resource.imagWeightBuffer.destroy === 'function') {
      resource.imagWeightBuffer.destroy();
    }
    if (resource.normWeightBuffer && typeof resource.normWeightBuffer.destroy === 'function') {
      resource.normWeightBuffer.destroy();
    }
  }

  computeState.kernelResources.clear();
}

function destroyWebGpuStftComputeState(computeState: WebGpuStftComputeState | null): void {
  if (!computeState) {
    return;
  }

  destroySpectrogramBandLayoutResources(computeState);

  for (const buffer of [
    computeState.basePingBuffer,
    computeState.basePongBuffer,
    computeState.lowPingBuffer,
    computeState.lowPongBuffer,
    computeState.paramBuffer,
    computeState.pcmBuffer,
  ]) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }

  computeState.basePingBuffer = null;
  computeState.basePongBuffer = null;
  computeState.lowPingBuffer = null;
  computeState.lowPongBuffer = null;
  computeState.paramBuffer = null;
  computeState.pcmBuffer = null;
  computeState.pcmSampleCount = 0;
  computeState.scratchFftSize = 0;
}

function destroyWebGpuScalogramComputeState(computeState: WebGpuScalogramComputeState | null): void {
  if (!computeState) {
    return;
  }

  destroyScalogramKernelResources(computeState);
  for (const buffer of [computeState.paramBuffer, computeState.pcmBuffer]) {
    if (buffer && typeof buffer.destroy === 'function') {
      buffer.destroy();
    }
  }
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
  if (webGpu.stftCompute?.pcmBuffer && typeof webGpu.stftCompute.pcmBuffer.destroy === 'function') {
    webGpu.stftCompute.pcmBuffer.destroy();
    webGpu.stftCompute.pcmBuffer = null;
    webGpu.stftCompute.pcmSampleCount = 0;
  }

  destroyScalogramKernelResources(webGpu.scalogramCompute);
  if (webGpu.scalogramCompute?.pcmBuffer && typeof webGpu.scalogramCompute.pcmBuffer.destroy === 'function') {
    webGpu.scalogramCompute.pcmBuffer.destroy();
    webGpu.scalogramCompute.pcmBuffer = null;
    webGpu.scalogramCompute.pcmSampleCount = 0;
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

async function ensurePlanTiles(
  runtime: WaveCoreRuntime,
  plan: RenderRequestPlan,
  options: EnsurePlanTilesOptions = {},
): Promise<boolean> {
  const onTileReady = typeof options.onTileReady === 'function' ? options.onTileReady : null;
  const shouldAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
  const tileIndices = getPlanTileRenderOrder(plan);

  for (const tileIndex of tileIndices) {
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

    if (surfaceState.webGpu && await renderTileWithWebGpu(plan, tileRecord, tileStart, tileEnd)) {
      onChunkReady?.();
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
  return 1127 * Math.log(1 + (frequency / 700));
}

function melToHz(melValue: number): number {
  return 700 * (Math.exp(melValue / 1127) - 1);
}

function getScalogramFrequencyForRow(row: number, rows: number, minFrequency: number, maxFrequency: number): number {
  if (rows <= 1) {
    return minFrequency;
  }

  const ratio = row / (rows - 1);
  return minFrequency * Math.exp(Math.log(maxFrequency / minFrequency) * ratio);
}

function buildStftLayoutCacheKey(plan: RenderRequestPlan): string {
  return [
    `type${plan.analysisType}`,
    `fft${plan.fftSize}`,
    `scale${plan.frequencyScale}`,
    `rows${plan.rowCount}`,
    `dec${plan.decimationFactor}`,
    `sr${analysisState.sampleRate}`,
    `min${analysisState.minFrequency}`,
    `max${analysisState.maxFrequency}`,
  ].join(':');
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

  if (plan.analysisType === 'mel') {
    const rows = Math.max(1, plan.rowCount);
    const nyquist = analysisState.sampleRate / 2;
    const maximumBin = Math.max(2, Math.trunc(plan.fftSize / 2));
    const safeMinFrequency = Math.max(1, analysisState.minFrequency);
    const safeMaxFrequency = Math.max(safeMinFrequency * 1.01, analysisState.maxFrequency);
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
      const startBin = clamp(
        Math.floor((leftFrequency / nyquist) * maximumBin),
        1,
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

        bins.push(bin);
        weights.push(weight);
      }

      const offset = row * 4;
      rowData[offset] = rowOffset;
      rowData[offset + 1] = bins.length - rowOffset;
    }

    const resource: MelBandLayoutResource = {
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
  } satisfies SpectrogramBandLayoutResource;
  computeState.bandLayoutResources.set(cacheKey, resource);
  return resource;
}

function buildScalogramKernelCacheKey(plan: RenderRequestPlan): string {
  return [
    `rows${plan.rowCount}`,
    `sr${analysisState.sampleRate}`,
    `min${analysisState.minFrequency}`,
    `max${analysisState.maxFrequency}`,
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
  const minFrequency = Math.max(1, analysisState.minFrequency);
  const maxFrequency = Math.max(minFrequency * 1.01, analysisState.maxFrequency);
  const rowBufferData = new ArrayBuffer(rowCount * 32);
  const rowView = new DataView(rowBufferData);
  const offsets: number[] = [];
  const realWeights: number[] = [];
  const imagWeights: number[] = [];
  const normWeights: number[] = [];
  const twoPi = Math.PI * 2;

  for (let row = 0; row < rowCount; row += 1) {
    const frequency = getScalogramFrequencyForRow(row, rowCount, minFrequency, maxFrequency);
    const safeFrequency = Math.max(1, frequency);
    const scaleSeconds = 6 / (twoPi * safeFrequency);
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
    const tapOffset = offsets.length;

    for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
      const time = offsetValue / sampleRate;
      const normalizedTime = time / scaleSeconds;
      const gaussian = Math.exp(-0.5 * normalizedTime * normalizedTime);
      const normWeight = gaussian * gaussian;

      offsets.push(offsetValue);
      realWeights.push(gaussian * phaseCos);
      imagWeights.push(-gaussian * phaseSin);
      normWeights.push(normWeight);
      normalization += normWeight;

      const nextPhaseCos = (phaseCos * stepCos) - (phaseSin * stepSin);
      phaseSin = (phaseSin * stepCos) + (phaseCos * stepSin);
      phaseCos = nextPhaseCos;
      offsetValue += stride;
    }

    const rowOffset = row * 32;
    rowView.setUint32(rowOffset, tapOffset, true);
    rowView.setUint32(rowOffset + 4, tapCount, true);
    rowView.setInt32(rowOffset + 8, offsets[tapOffset], true);
    rowView.setInt32(rowOffset + 12, offsets[tapOffset + tapCount - 1], true);
    rowView.setFloat32(rowOffset + 16, normalization, true);
  }

  const resource: ScalogramKernelResource = {
    imagWeightBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, new Float32Array(imagWeights)),
    key: cacheKey,
    normWeightBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, new Float32Array(normWeights)),
    offsetBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, new Int32Array(offsets)),
    realWeightBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, new Float32Array(realWeights)),
    rowBuffer: createGpuBufferWithData(webGpu.device, globals.bufferUsage.STORAGE, rowBufferData),
  };
  computeState.kernelResources.set(cacheKey, resource);
  return resource;
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
  view.setUint32(20, ANALYSIS_TYPE_CODES[plan.analysisType] ?? 0, true);
  view.setUint32(24, decimationFactor, true);
  view.setUint32(28, useLowFrequencyEnhancement ? 1 : 0, true);
  view.setFloat32(32, tileStart, true);
  view.setFloat32(36, tileSpan, true);
  view.setFloat32(40, sampleRate, true);
  view.setFloat32(44, powerScale, true);
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
  return buffer;
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
    const paramStride = 256;
    const paramBuffer = webGpu.device.createBuffer({
      size: paramStride * 32,
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

    webGpu.stftCompute = {
      bandLayoutResources: new Map(),
      baseInputBindGroup: null,
      basePingBuffer: null,
      basePongBuffer: null,
      fftBindGroupForward: null,
      fftBindGroupLayout,
      fftBindGroupReverse: null,
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
      lowInputBindGroup: null,
      lowPingBuffer: null,
      lowPongBuffer: null,
      lowStageBindGroupForward: null,
      lowStageBindGroupReverse: null,
      paramBuffer,
      paramStride,
      pcmBuffer: null,
      pcmSampleCount: 0,
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
    };
  } catch {
    return null;
  }

  return webGpu.stftCompute;
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
    const renderModule = webGpu.device.createShaderModule({ code: WEBGPU_SCALOGRAM_RENDER_SHADER });
    const paramStride = 256;
    const paramBuffer = webGpu.device.createBuffer({
      size: paramStride,
      usage: globals.bufferUsage.COPY_DST | globals.bufferUsage.UNIFORM,
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
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 5,
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 6,
          buffer: { type: 'read-only-storage' },
          visibility: globals.shaderStage.COMPUTE,
        },
        {
          binding: 7,
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
  if (computeState.scratchFftSize !== plan.fftSize || !computeState.basePingBuffer || !computeState.basePongBuffer) {
    for (const buffer of [
      computeState.basePingBuffer,
      computeState.basePongBuffer,
      computeState.lowPingBuffer,
      computeState.lowPongBuffer,
    ]) {
      if (buffer && typeof buffer.destroy === 'function') {
        buffer.destroy();
      }
    }

    computeState.basePingBuffer = webGpu.device.createBuffer({
      size: spectrumByteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.basePongBuffer = webGpu.device.createBuffer({
      size: spectrumByteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.lowPingBuffer = webGpu.device.createBuffer({
      size: spectrumByteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.lowPongBuffer = webGpu.device.createBuffer({
      size: spectrumByteLength,
      usage: globals.bufferUsage.STORAGE,
    });
    computeState.scratchFftSize = plan.fftSize;
  }

  computeState.baseInputBindGroup = webGpu.device.createBindGroup({
    layout: computeState.inputBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
      { binding: 1, resource: { buffer: computeState.pcmBuffer } },
      { binding: 2, resource: { buffer: computeState.basePingBuffer } },
    ],
  });
  computeState.lowInputBindGroup = webGpu.device.createBindGroup({
    layout: computeState.inputBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
      { binding: 1, resource: { buffer: computeState.pcmBuffer } },
      { binding: 2, resource: { buffer: computeState.lowPingBuffer } },
    ],
  });
  computeState.fftBindGroupForward = webGpu.device.createBindGroup({
    layout: computeState.fftBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
      { binding: 1, resource: { buffer: computeState.basePingBuffer } },
      { binding: 2, resource: { buffer: computeState.basePongBuffer } },
    ],
  });
  computeState.fftBindGroupReverse = webGpu.device.createBindGroup({
    layout: computeState.fftBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
      { binding: 1, resource: { buffer: computeState.basePongBuffer } },
      { binding: 2, resource: { buffer: computeState.basePingBuffer } },
    ],
  });
  computeState.lowStageBindGroupForward = webGpu.device.createBindGroup({
    layout: computeState.fftBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
      { binding: 1, resource: { buffer: computeState.lowPingBuffer } },
      { binding: 2, resource: { buffer: computeState.lowPongBuffer } },
    ],
  });
  computeState.lowStageBindGroupReverse = webGpu.device.createBindGroup({
    layout: computeState.fftBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: computeState.paramBuffer, size: 64 } },
      { binding: 1, resource: { buffer: computeState.lowPongBuffer } },
      { binding: 2, resource: { buffer: computeState.lowPingBuffer } },
    ],
  });
  return true;
}

async function renderStftTileWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
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

  try {
    writeBufferAtOffset(computeState.paramBuffer, 0, createStftComputeParamsData(plan, {
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
      writeBufferAtOffset(computeState.paramBuffer, computeState.paramStride, createStftComputeParamsData(plan, {
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
        computeState.paramStride * (2 + stageIndex),
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

    const renderParamOffset = computeState.paramStride * (2 + stageCount);
    writeBufferAtOffset(computeState.paramBuffer, renderParamOffset, createStftComputeParamsData(plan, {
      columnCount,
      decimationFactor: 1,
      sampleCount,
      sampleRate: analysisState.sampleRate,
      slotStageIndex: 0,
      tileSpan,
      tileStart,
      useLowFrequencyEnhancement,
    }));

    const commandEncoder = webGpu.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();

    computePass.setPipeline(computeState.inputPipeline);
    computePass.setBindGroup(0, computeState.baseInputBindGroup, [0]);
    computePass.dispatchWorkgroups(inputDispatchX, inputDispatchY);

    if (useLowFrequencyEnhancement && computeState.lowInputBindGroup) {
      computePass.setBindGroup(0, computeState.lowInputBindGroup, [computeState.paramStride]);
      computePass.dispatchWorkgroups(inputDispatchX, inputDispatchY);
    }

    computePass.setPipeline(computeState.fftPipeline);
    for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
      const paramOffset = computeState.paramStride * (2 + stageIndex);
      computePass.setBindGroup(
        0,
        stageIndex % 2 === 0 ? computeState.fftBindGroupForward : computeState.fftBindGroupReverse,
        [paramOffset],
      );
      computePass.dispatchWorkgroups(fftDispatchX, fftDispatchY);
    }

    if (useLowFrequencyEnhancement) {
      for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
        const paramOffset = computeState.paramStride * (2 + stageIndex);
        computePass.setBindGroup(
          0,
          stageIndex % 2 === 0 ? computeState.lowStageBindGroupForward : computeState.lowStageBindGroupReverse,
          [paramOffset],
        );
        computePass.dispatchWorkgroups(fftDispatchX, fftDispatchY);
      }
    }

    const finalBaseBuffer = stageCount % 2 === 0 ? computeState.basePingBuffer : computeState.basePongBuffer;
    const finalLowBuffer = useLowFrequencyEnhancement
      ? (stageCount % 2 === 0 ? computeState.lowPingBuffer : computeState.lowPongBuffer)
      : finalBaseBuffer;

    if (plan.analysisType === 'mel') {
      const melResource = layoutResource as MelBandLayoutResource;
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
        { binding: 3, resource: { buffer: kernelResource.offsetBuffer } },
        { binding: 4, resource: { buffer: kernelResource.realWeightBuffer } },
        { binding: 5, resource: { buffer: kernelResource.imagWeightBuffer } },
        { binding: 6, resource: { buffer: kernelResource.normWeightBuffer } },
        { binding: 7, resource: tileRecord.gpuTextureView },
      ],
    });
    const commandEncoder = webGpu.device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(computeState.renderPipeline);
    computePass.setBindGroup(0, bindGroup, [0]);
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
    markAnalysisTypeWebGpuFallback(plan, error instanceof Error ? error.message : 'Scalogram GPU compute failed.');
    return false;
  }
}

async function renderTileWithWebGpu(
  plan: RenderRequestPlan,
  tileRecord: TileRecord,
  tileStart: number,
  tileEnd: number,
): Promise<boolean> {
  return plan.analysisType === 'scalogram'
    ? renderScalogramTileWithWebGpu(plan, tileRecord, tileStart, tileEnd)
    : renderStftTileWithWebGpu(plan, tileRecord, tileStart, tileEnd);
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
