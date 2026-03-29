#ifndef WAVE_PREVIEW_FREESTANDING_STDIO_H
#define WAVE_PREVIEW_FREESTANDING_STDIO_H

typedef struct wave_preview_file FILE;

#define stderr ((FILE *) 0)
#define printf(...) 0

static inline int fprintf(FILE *stream, const char *format, ...) {
  (void) stream;
  (void) format;
  return 0;
}

#endif
