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
@group(0) @binding(4) var<storage, read> centerSamples: array<i32>;
@group(0) @binding(5) var<storage, read_write> cqtValues: array<f32>;

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

  let centerSample = centerSamples[columnIndex];
  let row = rowMeta[binIndex];
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
  var power = 0.0;
  if (finalNorm > 1e-8) {
    power = ((partialReal[0] * partialReal[0]) + (partialImaginary[0] * partialImaginary[0])) / finalNorm;
  }
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

struct ChromaRow {
  binOffset: u32,
  binCount: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> cqtValues: array<f32>;
@group(0) @binding(2) var<storage, read> chromaRows: array<ChromaRow>;
@group(0) @binding(3) var<storage, read> chromaBins: array<u32>;
@group(0) @binding(4) var outputTexture: texture_storage_2d<rgba8unorm, write>;
var<workgroup> partialMax: array<f32, 12>;

fn normalizeCqtChromaValue(value: f32, columnMax: f32, distributionGamma: f32) -> f32 {
  if (columnMax <= 1e-8) {
    return 0.0;
  }

  return pow(clamp(value / columnMax, 0.0, 1.0), clamp(distributionGamma, 0.2, 2.5));
}

@compute @workgroup_size(12, 1, 1)
fn renderCqtChromaTexture(
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
) {
  let columnIndex = workgroupId.x;
  let rowIndex = localId.x;
  let columnCount = params.header0.x;
  let rowCount = params.header0.y;
  let binCount = params.header0.z;

  if (columnIndex >= columnCount) {
    return;
  }

  var chromaValue = 0.0;
  if (rowIndex < rowCount) {
    let row = chromaRows[rowIndex];
    let baseIndex = columnIndex * binCount;
    var packedIndex = row.binOffset;
    let packedEnd = row.binOffset + row.binCount;

    loop {
      if (packedIndex >= packedEnd) {
        break;
      }

      chromaValue += cqtValues[baseIndex + chromaBins[packedIndex]];
      packedIndex += 1u;
    }
    partialMax[rowIndex] = chromaValue;
  }
  workgroupBarrier();

  if (rowIndex < 6u && (rowIndex + 6u) < rowCount) {
    partialMax[rowIndex] = max(partialMax[rowIndex], partialMax[rowIndex + 6u]);
  }
  workgroupBarrier();

  if (rowIndex < 3u && (rowIndex + 3u) < rowCount) {
    partialMax[rowIndex] = max(partialMax[rowIndex], partialMax[rowIndex + 3u]);
  }
  workgroupBarrier();

  if (rowIndex == 0u) {
    var columnMax = partialMax[0];
    if (rowCount > 1u) {
      columnMax = max(columnMax, partialMax[1]);
    }
    if (rowCount > 2u) {
      columnMax = max(columnMax, partialMax[2]);
    }
    partialMax[0] = columnMax;
  }

  workgroupBarrier();

  if (rowIndex >= rowCount) {
    return;
  }

  let normalized = normalizeCqtChromaValue(chromaValue, partialMax[0], params.padding1.x);
  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(outputTexture, vec2<i32>(i32(columnIndex), targetRow), paletteColor(normalized));
}
`;
