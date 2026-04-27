import {
  WEBGPU_MEL_ANALYSIS_FUNCTIONS,
  WEBGPU_MEL_ANALYSIS_SHADER_HELPERS,
} from './shaderMel';
import { WEBGPU_PALETTE_SHADER_HELPERS } from './shaderCommon';

export const WEBGPU_MFCC_MEL_VALUES_SHADER = /* wgsl */`
${WEBGPU_PALETTE_SHADER_HELPERS}

struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding: vec4<f32>,
};

${WEBGPU_MEL_ANALYSIS_SHADER_HELPERS}

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> baseSpectrum: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> melRows: array<MelRow>;
@group(0) @binding(3) var<storage, read> melBins: array<u32>;
@group(0) @binding(4) var<storage, read> melWeights: array<f32>;
@group(0) @binding(5) var<storage, read_write> melDbValues: array<f32>;

${WEBGPU_MEL_ANALYSIS_FUNCTIONS}

@compute @workgroup_size(8, 8)
fn computeMfccMelValues(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let columnIndex = globalId.x;
  let rowIndex = globalId.y;
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let melBandCount = params.header1.x;

  if (columnIndex >= columnCount || rowIndex >= melBandCount) {
    return;
  }

  let melPower = max(computeMelPower(columnIndex, rowIndex, fftSize), 1e-20);
  melDbValues[(columnIndex * melBandCount) + rowIndex] = log(melPower) * DB_LOG_SCALE;
}
`;

export const WEBGPU_MFCC_RENDER_SHADER = /* wgsl */`
const MFCC_COLUMN_TILE_SIZE: u32 = 4u;
const MFCC_COEFFICIENT_TILE_SIZE: u32 = 8u;
const MFCC_WORKGROUP_SIZE: u32 = MFCC_COLUMN_TILE_SIZE * MFCC_COEFFICIENT_TILE_SIZE;
const MFCC_MAX_MEL_BANDS: u32 = 512u;

struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> melDbValues: array<f32>;
@group(0) @binding(2) var<storage, read> dctBasis: array<f32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;

var<workgroup> cachedMelDbValues: array<f32, MFCC_COLUMN_TILE_SIZE * MFCC_MAX_MEL_BANDS>;

fn compressCoefficient(value: f32, distributionGamma: f32) -> f32 {
  let contrast = clamp(distributionGamma, 0.2, 2.5);
  let magnitude = abs(value);
  if (magnitude <= 1e-6) {
    return 0.0;
  }

  let compression = 28.0 / contrast;
  return clamp(value / (magnitude + compression), -1.0, 1.0);
}

fn writeGradient(startColor: vec3<f32>, endColor: vec3<f32>, t: f32) -> vec4<f32> {
  return vec4<f32>(startColor + ((endColor - startColor) * t), 1.0);
}

fn mfccPalette(value: f32) -> vec4<f32> {
  let center = vec3<f32>(8.0 / 255.0, 10.0 / 255.0, 18.0 / 255.0);
  let negativeMid = vec3<f32>(33.0 / 255.0, 92.0 / 255.0, 180.0 / 255.0);
  let negativeBright = vec3<f32>(148.0 / 255.0, 225.0 / 255.0, 255.0 / 255.0);
  let positiveMid = vec3<f32>(190.0 / 255.0, 84.0 / 255.0, 54.0 / 255.0);
  let positiveBright = vec3<f32>(255.0 / 255.0, 226.0 / 255.0, 138.0 / 255.0);
  let magnitude = sqrt(clamp(abs(value), 0.0, 1.0));

  if (value < 0.0) {
    if (magnitude < 0.55) {
      return writeGradient(center, negativeMid, magnitude / 0.55);
    }
    return writeGradient(negativeMid, negativeBright, (magnitude - 0.55) / 0.45);
  }

  if (magnitude < 0.55) {
    return writeGradient(center, positiveMid, magnitude / 0.55);
  }
  return writeGradient(positiveMid, positiveBright, (magnitude - 0.55) / 0.45);
}

@compute @workgroup_size(MFCC_COLUMN_TILE_SIZE, MFCC_COEFFICIENT_TILE_SIZE)
fn renderMfccTexture(
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
) {
  let columnCount = params.header0.y;
  let coefficientCount = params.header0.z;
  let melBandCount = params.header1.x;
  let columnIndex = (workgroupId.x * MFCC_COLUMN_TILE_SIZE) + localId.x;
  let coefficientIndex = (workgroupId.y * MFCC_COEFFICIENT_TILE_SIZE) + localId.y;
  let localLinearIndex = (localId.y * MFCC_COLUMN_TILE_SIZE) + localId.x;
  let cachedValueCount = MFCC_COLUMN_TILE_SIZE * melBandCount;

  var cachedValueIndex = localLinearIndex;
  loop {
    if (cachedValueIndex >= cachedValueCount) {
      break;
    }

    let columnOffset = cachedValueIndex / melBandCount;
    let bandIndex = cachedValueIndex % melBandCount;
    let cachedColumnIndex = (workgroupId.x * MFCC_COLUMN_TILE_SIZE) + columnOffset;
    if (cachedColumnIndex < columnCount) {
      cachedMelDbValues[cachedValueIndex] = melDbValues[(cachedColumnIndex * melBandCount) + bandIndex];
    } else {
      cachedMelDbValues[cachedValueIndex] = 0.0;
    }
    cachedValueIndex += MFCC_WORKGROUP_SIZE;
  }
  workgroupBarrier();

  if (columnIndex >= columnCount || coefficientIndex >= coefficientCount) {
    return;
  }

  let melBaseIndex = localId.x * melBandCount;
  let basisBaseIndex = coefficientIndex * melBandCount;
  var coefficient = 0.0;

  for (var bandIndex = 0u; bandIndex < melBandCount; bandIndex += 1u) {
    coefficient += cachedMelDbValues[melBaseIndex + bandIndex] * dctBasis[basisBaseIndex + bandIndex];
  }
  if (coefficientIndex == 0u) {
    coefficient *= 0.25;
  }

  let normalized = compressCoefficient(coefficient, params.padding.x);
  let targetRow = i32((coefficientCount - 1u) - coefficientIndex);
  textureStore(outputTexture, vec2<i32>(i32(columnIndex), targetRow), mfccPalette(normalized));
}
`;
