#ifndef WAVE_PREVIEW_FREESTANDING_MATH_H
#define WAVE_PREVIEW_FREESTANDING_MATH_H

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#ifndef M_SQRT1_2
#define M_SQRT1_2 0.70710678118654752440
#endif

#ifndef M_SQRT2
#define M_SQRT2 1.41421356237309504880
#endif

static inline double cos(double value) {
  return __builtin_cos(value);
}

static inline double sin(double value) {
  return __builtin_sin(value);
}

static inline float cosf(float value) {
  return __builtin_cosf(value);
}

static inline float sinf(float value) {
  return __builtin_sinf(value);
}

#endif
