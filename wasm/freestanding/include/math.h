#ifndef WAVE_SCOPE_FREESTANDING_MATH_H
#define WAVE_SCOPE_FREESTANDING_MATH_H

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#ifndef M_SQRT1_2
#define M_SQRT1_2 0.70710678118654752440
#endif

#ifndef M_SQRT2
#define M_SQRT2 1.41421356237309504880
#endif

#ifndef HUGE_VAL
#define HUGE_VAL (__builtin_huge_val())
#endif

static inline double cos(double value) {
  return __builtin_cos(value);
}

static inline double sin(double value) {
  return __builtin_sin(value);
}

static inline double tan(double value) {
  return __builtin_tan(value);
}

static inline double log(double value) {
  return __builtin_log(value);
}

static inline double pow(double base, double exponent) {
  return __builtin_pow(base, exponent);
}

static inline double fabs(double value) {
  return __builtin_fabs(value);
}

static inline float cosf(float value) {
  return __builtin_cosf(value);
}

static inline float sinf(float value) {
  return __builtin_sinf(value);
}

static inline float tanf(float value) {
  return __builtin_tanf(value);
}

static inline float logf(float value) {
  return __builtin_logf(value);
}

static inline float powf(float base, float exponent) {
  return __builtin_powf(base, exponent);
}

static inline float fabsf(float value) {
  return __builtin_fabsf(value);
}

#endif
