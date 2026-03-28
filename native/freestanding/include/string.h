#ifndef WAVE_PREVIEW_FREESTANDING_STRING_H
#define WAVE_PREVIEW_FREESTANDING_STRING_H

#include <stddef.h>

static inline void *memcpy(void *dest, const void *src, size_t count) {
  return __builtin_memcpy(dest, src, count);
}

static inline void *memmove(void *dest, const void *src, size_t count) {
  return __builtin_memmove(dest, src, count);
}

static inline void *memset(void *dest, int value, size_t count) {
  return __builtin_memset(dest, value, count);
}

#endif
