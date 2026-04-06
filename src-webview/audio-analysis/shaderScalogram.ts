import { WEBGPU_PALETTE_SHADER_HELPERS } from './shaderCommon';

export const WEBGPU_SCALOGRAM_RENDER_SHADER = /* wgsl */`
${WEBGPU_PALETTE_SHADER_HELPERS}

const SCALOGRAM_TAP_REDUCTION_SIZE: u32 = 32u;

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

struct ScalogramTap {
  sampleOffset: i32,
  realWeight: f32,
  imagWeight: f32,
  normWeight: f32,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> pcmSamples: array<f32>;
@group(0) @binding(2) var<storage, read> rowMeta: array<ScalogramRow>;
@group(0) @binding(3) var<storage, read> taps: array<ScalogramTap>;
@group(0) @binding(4) var outputTexture: texture_storage_2d<rgba8unorm, write>;

var<workgroup> partialReal: array<f32, SCALOGRAM_TAP_REDUCTION_SIZE>;
var<workgroup> partialImaginary: array<f32, SCALOGRAM_TAP_REDUCTION_SIZE>;
var<workgroup> partialNorm: array<f32, SCALOGRAM_TAP_REDUCTION_SIZE>;

@compute @workgroup_size(32, 1, 1)
fn renderScalogramTexture(
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
) {
  let columnIndex = workgroupId.x;
  let rowIndex = workgroupId.y;
  let columnCount = params.header0.x;
  let rowCount = params.header0.y;
  let sampleCount = params.header0.z;
  let localIndex = localId.x;

  if (columnIndex >= columnCount || rowIndex >= rowCount) {
    return;
  }

  let columnStep = params.timing.y / f32(max(columnCount, 1u));
  let centerTime = params.timing.x + ((f32(columnIndex) + 0.5) * columnStep);
  let centerSample = i32(round(centerTime * params.timing.z));
  let row = rowMeta[rowIndex];
  let firstSample = centerSample + row.firstOffset;
  let lastSample = centerSample + row.lastOffset;
  let useFullNormalization = firstSample >= 0 && u32(lastSample) < sampleCount;
  var real = 0.0;
  var imaginary = 0.0;
  var norm = 0.0;
  if (useFullNormalization) {
    norm = row.normalization;
  }
  var tapIndex = localIndex;

  loop {
    if (tapIndex >= row.tapCount) {
      break;
    }

    let packedIndex = row.tapOffset + tapIndex;
    let tap = taps[packedIndex];
    let sampleIndex = centerSample + tap.sampleOffset;
    if (sampleIndex >= 0 && u32(sampleIndex) < sampleCount) {
      let sample = pcmSamples[u32(sampleIndex)];
      real += sample * tap.realWeight;
      imaginary += sample * tap.imagWeight;
      if (!useFullNormalization) {
        norm += tap.normWeight;
      }
    }
    tapIndex += SCALOGRAM_TAP_REDUCTION_SIZE;
  }

  partialReal[localIndex] = real;
  partialImaginary[localIndex] = imaginary;
  partialNorm[localIndex] = norm;
  workgroupBarrier();

  var reductionStride = SCALOGRAM_TAP_REDUCTION_SIZE / 2u;
  loop {
    if (reductionStride == 0u) {
      break;
    }

    if (localIndex < reductionStride) {
      partialReal[localIndex] += partialReal[localIndex + reductionStride];
      partialImaginary[localIndex] += partialImaginary[localIndex + reductionStride];
      partialNorm[localIndex] += partialNorm[localIndex + reductionStride];
    }

    workgroupBarrier();
    reductionStride = reductionStride / 2u;
  }

  if (localIndex != 0u) {
    return;
  }

  let finalReal = partialReal[0];
  let finalImaginary = partialImaginary[0];
  let finalNorm = partialNorm[0];
  var power = 0.0;
  if (finalNorm > 1e-8) {
    power = ((finalReal * finalReal) + (finalImaginary * finalImaginary)) / finalNorm;
  }
  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(
    outputTexture,
    vec2<i32>(i32(columnIndex), targetRow),
    paletteColor(normalizePowerForAnalysis(power, ANALYSIS_TYPE_SCALOGRAM, params.padding1.x, params.padding1.y, params.padding1.z)),
  );
}
`;

export const WEBGPU_SCALOGRAM_FFT_SHADER = /* wgsl */`
const TWO_PI: f32 = 6.283185307179586;

struct FftParams {
  header0: vec4<u32>,
};

@group(0) @binding(0) var<uniform> params: FftParams;
@group(0) @binding(1) var<storage, read> sourceSpectrum: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> targetSpectrum: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> twiddleFactors: array<vec2<f32>>;

fn complexMul(left: vec2<f32>, right: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    (left.x * right.x) - (left.y * right.y),
    (left.x * right.y) + (left.y * right.x),
  );
}

@compute @workgroup_size(64)
fn runScalogramFftStage(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  let fftSize = params.header0.x;
  let stageIndex = params.header0.y;
  let inverseFlag = params.header0.z;
  let sequenceCount = max(1u, params.header0.w);
  let q = 1u << stageIndex;
  let l = fftSize >> (stageIndex + 1u);
  let butterfliesPerSequence = fftSize / 2u;
  let globalIndex = globalId.x + (globalId.y * numWorkgroups.x * 64u);
  let totalButterflies = butterfliesPerSequence * sequenceCount;

  if (globalIndex >= totalButterflies || l == 0u || butterfliesPerSequence == 0u) {
    return;
  }

  let sequenceIndex = globalIndex / butterfliesPerSequence;
  let butterflyIndex = globalIndex % butterfliesPerSequence;
  let j = butterflyIndex / l;
  let k = butterflyIndex % l;
  let halfFftSize = max(1u, fftSize / 2u);
  let baseIndex = sequenceIndex * fftSize;
  let evenIndex = (2u * j * l) + k;
  let oddIndex = evenIndex + l;
  let outputEvenIndex = (j * l) + k;
  let outputOddIndex = ((j + q) * l) + k;
  let baseTwiddle = twiddleFactors[(stageIndex * halfFftSize) + j];
  let twiddle = select(
    vec2<f32>(baseTwiddle.x, -baseTwiddle.y),
    baseTwiddle,
    inverseFlag != 0u,
  );
  let evenValue = sourceSpectrum[baseIndex + evenIndex];
  let oddValue = sourceSpectrum[baseIndex + oddIndex];
  let twiddledOdd = complexMul(oddValue, twiddle);

  targetSpectrum[baseIndex + outputEvenIndex] = evenValue + twiddledOdd;
  targetSpectrum[baseIndex + outputOddIndex] = evenValue - twiddledOdd;
}
`;

export const WEBGPU_SCALOGRAM_FFT_MULTIPLY_SHADER = /* wgsl */`
struct ComputeParams {
  header0: vec4<u32>,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> sourceSpectrum: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> waveletSpectra: array<f32>;
@group(0) @binding(3) var<storage, read_write> targetSpectrum: array<vec2<f32>>;

@compute @workgroup_size(64)
fn multiplyScalogramWavelet(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  let fftSize = params.header0.x;
  let rowStart = params.header0.y;
  let batchCount = params.header0.z;
  let halfFftSize = max(1u, params.header0.w);
  let globalIndex = globalId.x + (globalId.y * numWorkgroups.x * 64u);
  let totalBins = fftSize * batchCount;

  if (globalIndex >= totalBins) {
    return;
  }

  let batchIndex = globalIndex / fftSize;
  let binIndex = globalIndex % fftSize;
  let rowIndex = rowStart + batchIndex;

  if (binIndex == 0u || binIndex >= halfFftSize) {
    targetSpectrum[globalIndex] = vec2<f32>(0.0, 0.0);
    return;
  }

  let responseIndex = (rowIndex * halfFftSize) + binIndex;
  let response = waveletSpectra[responseIndex];
  targetSpectrum[globalIndex] = sourceSpectrum[binIndex] * response;
}
`;

export const WEBGPU_SCALOGRAM_FFT_RENDER_SHADER = /* wgsl */`
${WEBGPU_PALETTE_SHADER_HELPERS}

struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding1: vec4<f32>,
};

struct ScalogramFftRow {
  scaleSeconds: f32,
  normalization: f32,
  frequency: f32,
  pad0: f32,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> timeDomain: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> rowParams: array<ScalogramFftRow>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(64)
fn renderScalogramFftRow(
  @builtin(global_invocation_id) globalId: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let rowCount = params.header0.z;
  let rowStart = params.header0.w;
  let rowBatchCount = params.header1.x;
  let inputSampleCount = params.header1.y;
  let inputStartSample = params.header1.z;
  let linearIndex = globalId.x + (globalId.y * numWorkgroups.x * 64u);
  let totalPixels = columnCount * rowBatchCount;

  if (linearIndex >= totalPixels) {
    return;
  }

  let batchIndex = linearIndex / columnCount;
  let columnIndex = linearIndex % columnCount;
  let rowIndex = rowStart + batchIndex;
  if (rowIndex >= rowCount) {
    return;
  }

  let columnStep = params.timing.y / f32(max(columnCount, 1u));
  let centerTime = params.timing.x + ((f32(columnIndex) + 0.5) * columnStep);
  let sampleIndex = i32(round(centerTime * params.timing.z)) - i32(inputStartSample);
  let row = rowParams[rowIndex];
  var power = 0.0;

  if (sampleIndex >= 0 && u32(sampleIndex) < inputSampleCount && u32(sampleIndex) < fftSize) {
    let coefficient = timeDomain[(batchIndex * fftSize) + u32(sampleIndex)] * params.timing.w;
    power = dot(coefficient, coefficient) / max(row.normalization, 1e-8);
  }

  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(
    outputTexture,
    vec2<i32>(i32(columnIndex), targetRow),
    paletteColor(normalizePowerForAnalysis(power, ANALYSIS_TYPE_SCALOGRAM, params.padding1.x, params.padding1.y, params.padding1.z)),
  );
}
`;
