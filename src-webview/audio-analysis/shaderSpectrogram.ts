import { WEBGPU_PALETTE_SHADER_HELPERS } from './shaderCommon';

export const WEBGPU_SPECTROGRAM_INPUT_SHADER = /* wgsl */`
struct ComputeParams {
  header0: vec4<u32>,
  header1: vec4<u32>,
  timing: vec4<f32>,
  padding: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: ComputeParams;
@group(0) @binding(1) var<storage, read> pcmSamples: array<f32>;
@group(0) @binding(2) var<storage, read_write> outputSpectrum: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> windowCoefficients: array<f32>;

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

  let window = windowCoefficients[sampleOffset];
  outputSpectrum[(columnIndex * fftSize) + sampleOffset] = vec2<f32>(sample * window, 0.0);
}
`;

export const WEBGPU_SPECTROGRAM_FFT_SHADER = /* wgsl */`
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
@group(0) @binding(3) var<storage, read> twiddleFactors: array<vec2<f32>>;

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
  let halfFftSize = max(1u, fftSize / 2u);
  let columnBase = columnIndex * fftSize;
  let evenIndex = columnBase + ((2u * j * l) + k);
  let oddIndex = evenIndex + l;
  let outputEvenIndex = columnBase + ((j * l) + k);
  let outputOddIndex = columnBase + (((j + q) * l) + k);
  let baseTwiddle = twiddleFactors[(stageIndex * halfFftSize) + j];
  let twiddle = vec2<f32>(baseTwiddle.x, -baseTwiddle.y);
  let evenValue = sourceSpectrum[evenIndex];
  let oddValue = sourceSpectrum[oddIndex];
  let twiddledOdd = complexMul(oddValue, twiddle);

  targetSpectrum[outputEvenIndex] = evenValue + twiddledOdd;
  targetSpectrum[outputOddIndex] = evenValue - twiddledOdd;
}
`;

export const WEBGPU_SPECTROGRAM_RENDER_SHADER = /* wgsl */`
${WEBGPU_PALETTE_SHADER_HELPERS}

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
    paletteColor(normalizePowerForAnalysis(meanPower, params.header1.y, params.padding.x, params.padding.y, params.padding.z)),
  );
}
`;
