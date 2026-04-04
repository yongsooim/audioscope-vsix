import { WEBGPU_PALETTE_SHADER_HELPERS } from './shaderCommon';

export const WEBGPU_MEL_ANALYSIS_SHADER_HELPERS = /* wgsl */`
struct MelRow {
  weightOffset: u32,
  weightCount: u32,
  pad0: u32,
  pad1: u32,
};
`;

export const WEBGPU_MEL_ANALYSIS_FUNCTIONS = /* wgsl */`
fn computeMelPower(columnIndex: u32, rowIndex: u32, fftSize: u32) -> f32 {
  let row = melRows[rowIndex];
  let spectrumBaseIndex = columnIndex * fftSize;
  var melPower = 0.0;
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
    melPower += power * weight;
    weightIndex += 1u;
  }

  return melPower;
}
`;

export const WEBGPU_MEL_RENDER_SHADER = /* wgsl */`
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
@group(0) @binding(5) var outputTexture: texture_storage_2d<rgba8unorm, write>;

${WEBGPU_MEL_ANALYSIS_FUNCTIONS}

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

  let melPower = computeMelPower(columnIndex, rowIndex, fftSize);
  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(
    outputTexture,
    vec2<i32>(i32(columnIndex), targetRow),
    paletteColor(normalizePowerForAnalysis(melPower, ANALYSIS_TYPE_MEL, params.padding.x, params.padding.y, params.padding.z)),
  );
}
`;
