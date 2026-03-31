#ifndef WAVE_SCOPE_FREESTANDING_STDIO_H
#define WAVE_SCOPE_FREESTANDING_STDIO_H

typedef struct audioscope_file FILE;

#define stderr ((FILE *) 0)
#define printf(...) 0

static inline int fprintf(FILE *stream, const char *format, ...) {
  (void) stream;
  (void) format;
  return 0;
}

#endif
