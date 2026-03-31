#ifndef WAVE_SCOPE_FREESTANDING_ARM_NEON_H
#define WAVE_SCOPE_FREESTANDING_ARM_NEON_H

#if !defined(__wasm_simd128__)
#error "This compatibility header only supports wasm simd128 builds."
#endif

typedef float float32x4_t __attribute__((vector_size(16), aligned(16)));
typedef float float32x2_t __attribute__((vector_size(8), aligned(8)));

typedef struct float32x4x2_t {
  float32x4_t val[2];
} float32x4x2_t;

static inline float32x4_t vdupq_n_f32(float value) {
  return (float32x4_t){ value, value, value, value };
}

static inline float32x4_t vmulq_f32(float32x4_t left, float32x4_t right) {
  return left * right;
}

static inline float32x4_t vaddq_f32(float32x4_t left, float32x4_t right) {
  return left + right;
}

static inline float32x4_t vmlaq_f32(float32x4_t acc, float32x4_t left, float32x4_t right) {
  return acc + (left * right);
}

static inline float32x4_t vsubq_f32(float32x4_t left, float32x4_t right) {
  return left - right;
}

static inline float32x4_t vld1q_dup_f32(const float *value) {
  return vdupq_n_f32(*value);
}

static inline float32x4x2_t vzipq_f32(float32x4_t left, float32x4_t right) {
  float32x4x2_t result;
  result.val[0] = __builtin_shufflevector(left, right, 0, 4, 1, 5);
  result.val[1] = __builtin_shufflevector(left, right, 2, 6, 3, 7);
  return result;
}

static inline float32x4x2_t vuzpq_f32(float32x4_t left, float32x4_t right) {
  float32x4x2_t result;
  result.val[0] = __builtin_shufflevector(left, right, 0, 2, 4, 6);
  result.val[1] = __builtin_shufflevector(left, right, 1, 3, 5, 7);
  return result;
}

static inline float32x2_t vget_low_f32(float32x4_t value) {
  return __builtin_shufflevector(value, value, 0, 1);
}

static inline float32x2_t vget_high_f32(float32x4_t value) {
  return __builtin_shufflevector(value, value, 2, 3);
}

static inline float32x4_t vcombine_f32(float32x2_t low, float32x2_t high) {
  return __builtin_shufflevector(low, high, 0, 1, 2, 3);
}

#endif
