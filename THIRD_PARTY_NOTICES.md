# Third-Party Notices

audioscope distributes WebAssembly binaries that are built from the following
third-party components.

## FFmpeg

audioscope distributes embedded FFmpeg WebAssembly binaries built from FFmpeg.
The FFmpeg source is included as the `src-wasm/third_party/ffmpeg` submodule.
The exact bundled revision and rebuild notes for this release are documented in
`FFMPEG_SOURCE.md`.

Copyright (c) the FFmpeg developers

FFmpeg is licensed under the GNU Lesser General Public License, version 2.1
or later, for the configuration distributed by this project. The relevant
license text is available in the FFmpeg source tree under:

- `src-wasm/third_party/ffmpeg/COPYING.LGPLv2.1`
- `src-wasm/third_party/ffmpeg/COPYING.LGPLv3`

## Signalsmith Stretch Web

audioscope vendors `src-webview/vendor/SignalsmithStretch.mjs` from
`signalsmith-stretch` by Geraint Luff.

Copyright (c) Geraint Luff

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## PFFFT / FFTPACK

Files in `src-wasm/third_party/pffft` are based on PFFFT by Julien Pommier and
FFTPACK code from NCAR/UCAR.

Copyright (c) 2013 Julien Pommier

Copyright (c) 2004 the University Corporation for Atmospheric Research
("UCAR"). All rights reserved. Developed by NCAR's Computational and
Information Systems Laboratory, UCAR, www.cisl.ucar.edu.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

- Neither the names of NCAR's Computational and Information Systems
  Laboratory, the University Corporation for Atmospheric Research, nor the
  names of its sponsors or contributors may be used to endorse or promote
  products derived from this software without specific prior written
  permission.
- Redistributions of source code must retain the above copyright notices,
  this list of conditions, and the disclaimer below.
- Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions, and the disclaimer below in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING, BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
SOFTWARE.
