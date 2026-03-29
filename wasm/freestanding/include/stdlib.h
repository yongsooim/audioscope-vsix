#ifndef WAVE_PREVIEW_FREESTANDING_STDLIB_H
#define WAVE_PREVIEW_FREESTANDING_STDLIB_H

#include <stddef.h>

typedef int (*wave_preview_compare_fn)(const void *left, const void *right);

void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void free(void *ptr);

static inline void wave_preview_swap_bytes(unsigned char *left, unsigned char *right, size_t size) {
  for (size_t index = 0; index < size; index += 1) {
    unsigned char value = left[index];
    left[index] = right[index];
    right[index] = value;
  }
}

static inline void qsort(void *base, size_t count, size_t size, wave_preview_compare_fn compare) {
  if (!base || count < 2 || size == 0 || !compare) {
    return;
  }

  unsigned char *bytes = (unsigned char *) base;

  for (size_t gap = count / 2; gap > 0; gap /= 2) {
    for (size_t index = gap; index < count; index += 1) {
      size_t inner = index;

      while (inner >= gap) {
        unsigned char *left = bytes + ((inner - gap) * size);
        unsigned char *right = bytes + (inner * size);

        if (compare(left, right) <= 0) {
          break;
        }

        wave_preview_swap_bytes(left, right, size);
        inner -= gap;
      }
    }
  }
}

#endif
