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
  melDbValues[(columnIndex * melBandCount) + rowIndex] = 10.0 * (log(melPower) * LOG10_E);
}
`;

export const WEBGPU_MFCC_RENDER_SHADER = /* wgsl */`
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

fn compressCoefficient(value: f32, distributionGamma: f32) -> f32 {
  let contrast = clamp(distributionGamma, 0.2, 2.5);
  let magnitude = abs(value);
  if (magnitude <= 1e-6) {
    return 0.0;
  }

  let compression = 28.0 / contrast;
  return clamp(value / (magnitude + compression), -1.0, 1.0);
}

fn mixChannel(startValue: f32, endValue: f32, t: f32) -> f32 {
  return startValue + ((endValue - startValue) * clamp(t, 0.0, 1.0));
}

fn writeGradient(startColor: vec3<f32>, endColor: vec3<f32>, t: f32) -> vec4<f32> {
  return vec4<f32>(
    mixChannel(startColor.x, endColor.x, t) / 255.0,
    mixChannel(startColor.y, endColor.y, t) / 255.0,
    mixChannel(startColor.z, endColor.z, t) / 255.0,
    1.0,
  );
}

fn mfccPalette(value: f32) -> vec4<f32> {
  let center = vec3<f32>(8.0, 10.0, 18.0);
  let negativeMid = vec3<f32>(33.0, 92.0, 180.0);
  let negativeBright = vec3<f32>(148.0, 225.0, 255.0);
  let positiveMid = vec3<f32>(190.0, 84.0, 54.0);
  let positiveBright = vec3<f32>(255.0, 226.0, 138.0);
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

@compute @workgroup_size(8, 8)
fn renderMfccTexture(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let columnIndex = globalId.x;
  let coefficientIndex = globalId.y;
  let columnCount = params.header0.y;
  let coefficientCount = params.header0.z;
  let melBandCount = params.header1.x;

  if (columnIndex >= columnCount || coefficientIndex >= coefficientCount) {
    return;
  }

  let melBaseIndex = columnIndex * melBandCount;
  let basisBaseIndex = coefficientIndex * melBandCount;
  var coefficient = 0.0;

  for (var bandIndex = 0u; bandIndex < melBandCount; bandIndex += 1u) {
    coefficient += melDbValues[melBaseIndex + bandIndex] * dctBasis[basisBaseIndex + bandIndex];
  }

  if (coefficientIndex == 0u) {
    coefficient *= 0.25;
  }

  let normalized = compressCoefficient(coefficient, params.padding.x);
  let targetRow = i32((coefficientCount - 1u) - coefficientIndex);
  textureStore(outputTexture, vec2<i32>(i32(columnIndex), targetRow), mfccPalette(normalized));
}
`;
