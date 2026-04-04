// Common WGSL shader sources shared by multiple analysis types.
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
