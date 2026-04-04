import { WEBGPU_PALETTE_SHADER_HELPERS } from './shaderCommon';

export const WEBGPU_CQT_VALUES_SHADER = /* wgsl */`
const CQT_TAP_REDUCTION_SIZE: u32 = 32u;

struct ComputeParams {
  header0: vec4<u32>,
  timing: vec4<f32>,
  padding0: vec4<u32>,
  padding1: vec4<f32>,
};

struct CqtRow {
  tapOffset: u32,
  tapCount: u32,
  firstOffset: i32,
  lastOffset: i32,
  normalization: f32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

struct CqtTap {
  sampleOffset: i32,
  realWeight: f32,
  imagWeight: f32,
  normWeight: f32,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> pcmSamples: array<f32>;
@group(0) @binding(2) var<storage, read> rowMeta: array<CqtRow>;
@group(0) @binding(3) var<storage, read> taps: array<CqtTap>;
@group(0) @binding(4) var<storage, read_write> cqtValues: array<f32>;

var<workgroup> partialReal: array<f32, CQT_TAP_REDUCTION_SIZE>;
var<workgroup> partialImaginary: array<f32, CQT_TAP_REDUCTION_SIZE>;
var<workgroup> partialNorm: array<f32, CQT_TAP_REDUCTION_SIZE>;

@compute @workgroup_size(32, 1, 1)
fn computeCqtValues(
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
) {
  let columnIndex = workgroupId.x;
  let binIndex = workgroupId.y;
  let columnCount = params.header0.x;
  let binCount = params.header0.y;
  let sampleCount = params.header0.z;
  let localIndex = localId.x;

  if (columnIndex >= columnCount || binIndex >= binCount) {
    return;
  }

  var centerRatio = 0.5;
  if (columnCount > 1u) {
    centerRatio = (f32(columnIndex) + 0.5) / f32(columnCount);
  }

  let centerTime = params.timing.x + (centerRatio * params.timing.y);
  let centerSample = i32(round(centerTime * params.timing.z));
  let row = rowMeta[binIndex];
  let firstSample = centerSample + row.firstOffset;
  let lastSample = centerSample + row.lastOffset;
  let useFullNormalization = firstSample >= 0 && u32(lastSample) < sampleCount;
  var real = 0.0;
  var imaginary = 0.0;
  var norm = select(0.0, row.normalization, useFullNormalization);
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
    tapIndex += CQT_TAP_REDUCTION_SIZE;
  }

  partialReal[localIndex] = real;
  partialImaginary[localIndex] = imaginary;
  partialNorm[localIndex] = norm;
  workgroupBarrier();

  var reductionStride = CQT_TAP_REDUCTION_SIZE / 2u;
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

  let finalNorm = partialNorm[0];
  let power = select(
    0.0,
    ((partialReal[0] * partialReal[0]) + (partialImaginary[0] * partialImaginary[0])) / max(finalNorm, 1e-8),
    finalNorm > 1e-8,
  );
  cqtValues[(columnIndex * binCount) + binIndex] = power;
}
`;

export const WEBGPU_CQT_CHROMA_RENDER_SHADER = /* wgsl */`
${WEBGPU_PALETTE_SHADER_HELPERS}

struct ComputeParams {
  header0: vec4<u32>,
  timing: vec4<f32>,
  padding0: vec4<u32>,
  padding1: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> cqtValues: array<f32>;
@group(0) @binding(2) var<storage, read> chromaAssignments: array<u32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;

fn normalizeCqtChromaValue(value: f32, columnMax: f32, distributionGamma: f32) -> f32 {
  if (columnMax <= 1e-8) {
    return 0.0;
  }

  return pow(clamp(value / columnMax, 0.0, 1.0), clamp(distributionGamma, 0.2, 2.5));
}

@compute @workgroup_size(8, 8)
fn renderCqtChromaTexture(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let columnIndex = globalId.x;
  let rowIndex = globalId.y;
  let columnCount = params.header0.x;
  let rowCount = params.header0.y;
  let binCount = params.header0.z;

  if (columnIndex >= columnCount || rowIndex >= rowCount) {
    return;
  }

  let baseIndex = columnIndex * binCount;
  var chromaValues = array<f32, 12>(
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
  );

  for (var binIndex = 0u; binIndex < binCount; binIndex += 1u) {
    let chromaIndex = min(chromaAssignments[binIndex], rowCount - 1u);
    chromaValues[chromaIndex] += cqtValues[baseIndex + binIndex];
  }

  var columnMax = 0.0;
  for (var chromaIndex = 0u; chromaIndex < rowCount; chromaIndex += 1u) {
    columnMax = max(columnMax, chromaValues[chromaIndex]);
  }

  let normalized = normalizeCqtChromaValue(chromaValues[rowIndex], columnMax, params.padding1.x);
  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(outputTexture, vec2<i32>(i32(columnIndex), targetRow), paletteColor(normalized));
}
`;
