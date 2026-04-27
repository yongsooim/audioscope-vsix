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
@group(0) @binding(4) var<storage, read> centerSamples: array<i32>;

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
  let centerSample = centerSamples[columnIndex];
  let fftSizeI32 = i32(fftSize);
  let sampleOffsetI32 = i32(sampleOffset);
  let decimationFactorI32 = i32(decimationFactor);
  let decimationFactorF32 = f32(decimationFactor);
  var sample = 0.0;

  if (decimationFactor == 1u) {
    let sourceIndex = centerSample - (fftSizeI32 / 2) + sampleOffsetI32;
    if (sourceIndex >= 0 && u32(sourceIndex) < sampleCount) {
      sample = pcmSamples[u32(sourceIndex)];
    }
  } else {
    let windowStart = centerSample - ((fftSizeI32 * decimationFactorI32) / 2);
    var sourceIndex = windowStart + (sampleOffsetI32 * decimationFactorI32);
    var sum = 0.0;
    var tap = 0i;

    loop {
      if (tap >= decimationFactorI32) {
        break;
      }

      if (sourceIndex >= 0 && u32(sourceIndex) < sampleCount) {
        sum += pcmSamples[u32(sourceIndex)];
      }
      sourceIndex += 1i;
      tap += 1i;
    }

    sample = sum / decimationFactorF32;
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
) {
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let stageIndex = params.header1.x;
  let q = 1u << stageIndex;
  let l = fftSize >> (stageIndex + 1u);
  let butterfliesPerColumn = fftSize / 2u;
  let columnIndex = globalId.y;
  let butterflyIndex = globalId.x;

  if (columnIndex >= columnCount || butterflyIndex >= butterfliesPerColumn || l == 0u) {
    return;
  }

  let j = butterflyIndex / l;
  let k = butterflyIndex % l;
  let columnBase = columnIndex * fftSize;
  let evenIndex = columnBase + ((2u * j * l) + k);
  let oddIndex = evenIndex + l;
  let outputEvenIndex = columnBase + ((j * l) + k);
  let outputOddIndex = columnBase + (((j + q) * l) + k);
  let baseTwiddle = twiddleFactors[((1u << stageIndex) - 1u) + j];
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
const SPECTROGRAM_REDUCTION_SIZE: u32 = 32u;

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

var<workgroup> partialEnergy: array<f32, SPECTROGRAM_REDUCTION_SIZE>;
var<workgroup> partialWeight: array<f32, SPECTROGRAM_REDUCTION_SIZE>;

@compute @workgroup_size(32, 1, 1)
fn renderSpectrogramTexture(
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>,
) {
  let columnIndex = workgroupId.x;
  let rowIndex = workgroupId.y;
  let fftSize = params.header0.x;
  let columnCount = params.header0.y;
  let rowCount = params.header0.z;
  let useLowFrequencyEnhancement = params.header1.w != 0u;
  let localIndex = localId.x;

  if (columnIndex >= columnCount || rowIndex >= rowCount) {
    return;
  }

  let rowBand = rowBands[rowIndex];
  let useEnhancedBand = useLowFrequencyEnhancement && rowBand.useEnhanced != 0u;
  let spectrumBaseIndex = columnIndex * fftSize;
  let powerScale = params.timing.w;
  let startBin = select(rowBand.baseStartBin, rowBand.enhancedStartBin, useEnhancedBand);
  let endBin = select(rowBand.baseEndBin, rowBand.enhancedEndBin, useEnhancedBand);
  let bandSize = max(1u, endBin - startBin);
  let inverseBandSize = 1.0 / f32(bandSize);
  var centeredPositionTwice = (1.0 - f32(bandSize)) + (2.0 * f32(localIndex));
  var bin = startBin + localIndex;
  var weightedEnergy = 0.0;
  var totalWeight = 0.0;

  if (useEnhancedBand) {
    loop {
      if (bin >= endBin) {
        break;
      }

      let weight = 1.0 - (0.3 * abs(centeredPositionTwice * inverseBandSize));
      let spectrum = enhancedSpectrum[spectrumBaseIndex + bin];
      weightedEnergy += dot(spectrum, spectrum) * (weight * powerScale);
      totalWeight += weight;
      centeredPositionTwice += 2.0 * f32(SPECTROGRAM_REDUCTION_SIZE);
      bin += SPECTROGRAM_REDUCTION_SIZE;
    }
  } else {
    loop {
      if (bin >= endBin) {
        break;
      }

      let weight = 1.0 - (0.3 * abs(centeredPositionTwice * inverseBandSize));
      let spectrum = baseSpectrum[spectrumBaseIndex + bin];
      weightedEnergy += dot(spectrum, spectrum) * (weight * powerScale);
      totalWeight += weight;
      centeredPositionTwice += 2.0 * f32(SPECTROGRAM_REDUCTION_SIZE);
      bin += SPECTROGRAM_REDUCTION_SIZE;
    }
  }

  partialEnergy[localIndex] = weightedEnergy;
  partialWeight[localIndex] = totalWeight;
  workgroupBarrier();

  var reductionStride = SPECTROGRAM_REDUCTION_SIZE / 2u;
  loop {
    if (reductionStride == 0u) {
      break;
    }

    if (localIndex < reductionStride) {
      partialEnergy[localIndex] += partialEnergy[localIndex + reductionStride];
      partialWeight[localIndex] += partialWeight[localIndex + reductionStride];
    }

    workgroupBarrier();
    reductionStride = reductionStride / 2u;
  }

  if (localIndex != 0u) {
    return;
  }

  weightedEnergy = partialEnergy[0];
  totalWeight = partialWeight[0];
  let meanPower = weightedEnergy / max(totalWeight, 1e-8);
  let targetRow = i32((rowCount - 1u) - rowIndex);
  textureStore(
    outputTexture,
    vec2<i32>(i32(columnIndex), targetRow),
    paletteColor(normalizePowerForAnalysis(meanPower, params.padding.w, params.padding.y, params.padding.z)),
  );
}
`;
