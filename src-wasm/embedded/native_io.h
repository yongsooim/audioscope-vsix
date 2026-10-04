#ifndef AUDIOSCOPE_NATIVE_IO_H
#define AUDIOSCOPE_NATIVE_IO_H

#include <stdio.h>
#include "libavutil/file_open.h"

// FFmpeg's file API accepts UTF-8 paths on Windows as well as POSIX systems.
#define fopen avpriv_fopen_utf8

#endif
