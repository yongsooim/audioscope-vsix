// WGSL shader sources used by audioAnalysisWorker.
export const WEBGPU_BACKGROUND_SHADER = /* wgsl */`
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

export const WEBGPU_TILE_SHADER = /* wgsl */`
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

export const WEBGPU_PALETTE_SHADER_HELPERS = /* wgsl */`
const LOG10_E: f32 = 0.4342944819032518;
const MAX_DB: f32 = 0.0;
const ANALYSIS_TYPE_SPECTROGRAM: u32 = 0u;
const ANALYSIS_TYPE_MEL: u32 = 1u;
const ANALYSIS_TYPE_SCALOGRAM: u32 = 2u;
const MEL_DISPLAY_MIN_DB: f32 = -92.0;
const MEL_DISPLAY_GAMMA: f32 = 0.92;
const SCALOGRAM_DISPLAY_MIN_DB: f32 = -72.0;
const SCALOGRAM_DISPLAY_GAMMA: f32 = 1.08;

fn displayMinDbForAnalysisType(analysisType: u32) -> f32 {
  if (analysisType == ANALYSIS_TYPE_MEL) {
    return MEL_DISPLAY_MIN_DB;
  }
  if (analysisType == ANALYSIS_TYPE_SCALOGRAM) {
    return SCALOGRAM_DISPLAY_MIN_DB;
  }
  return -80.0;
}

fn displayGammaForAnalysisType(analysisType: u32) -> f32 {
  if (analysisType == ANALYSIS_TYPE_MEL) {
    return MEL_DISPLAY_GAMMA;
  }
  if (analysisType == ANALYSIS_TYPE_SCALOGRAM) {
    return SCALOGRAM_DISPLAY_GAMMA;
  }
  return 1.0;
}

fn normalizePowerForAnalysis(
  power: f32,
  analysisType: u32,
  distributionGamma: f32,
  minDb: f32,
  maxDb: f32,
) -> f32 {
  let decibels = 10.0 * (log(max(power + 1e-14, 1e-20)) * LOG10_E);
  let clampedMaxDb = max(minDb + 1.0, maxDb);
  let normalized = clamp((decibels - minDb) / (clampedMaxDb - minDb), 0.0, 1.0);
  let gamma = max(0.2, displayGammaForAnalysisType(analysisType) * distributionGamma);
  return pow(normalized, gamma);
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

export const WEBGPU_SPECTROGRAM_INPUT_SHADER = /* wgsl */`
const TWO_PI: f32 = 6.283185307179586;
const WINDOW_HANN: u32 = 0u;
const WINDOW_HAMMING: u32 = 1u;
const WINDOW_BLACKMAN: u32 = 2u;
const WINDOW_RECTANGULAR: u32 = 3u;

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
  let windowFunction = params.header1.y;
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
  var window = 0.5 - (0.5 * cos(phase));
  if (windowFunction == WINDOW_HAMMING) {
    window = 0.54 - (0.46 * cos(phase));
  } else if (windowFunction == WINDOW_BLACKMAN) {
    window = 0.42 - (0.5 * cos(phase)) + (0.08 * cos(phase * 2.0));
  } else if (windowFunction == WINDOW_RECTANGULAR) {
    window = 1.0;
  }
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
  let power = select(
    0.0,
    ((finalReal * finalReal) + (finalImaginary * finalImaginary)) / max(finalNorm, 1e-8),
    finalNorm > 1e-8,
  );
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
  let baseIndex = sequenceIndex * fftSize;
  let evenIndex = (2u * j * l) + k;
  let oddIndex = evenIndex + l;
  let outputEvenIndex = (j * l) + k;
  let outputOddIndex = ((j + q) * l) + k;
  let direction = select(-1.0, 1.0, inverseFlag != 0u);
  let angle = (direction * TWO_PI * f32(j)) / f32(2u * q);
  let twiddle = vec2<f32>(cos(angle), sin(angle));
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

  var centerRatio = 0.5;
  if (columnCount > 1u) {
    centerRatio = (f32(columnIndex) + 0.5) / f32(columnCount);
  }

  let centerTime = params.timing.x + (centerRatio * params.timing.y);
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
