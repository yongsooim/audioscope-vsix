# FFmpeg Source Availability

`audioscope` ships embedded FFmpeg WebAssembly binaries for `ffmpeg`, `ffprobe`,
`ffloudness`, and `ffencode` (the export tool, which additionally links
libmp3lame — see the LAME section below).

Platform-specific builds also ship native `ffdecode`, `ffdecode-wav`, `ffprobe`,
`ffloudness`, and `ffencode` executables from the same FFmpeg source revision.
The native decoder shares `src-wasm/embedded/ffdecode_module.c` with the WASM
decoder, preserves the source sample rate and channels, and delivers PCM before
the retained-PCM loudness pass. Its temporary PCM file is removed after the task.

## Exact Upstream Revision

- Upstream repository: `https://github.com/FFmpeg/FFmpeg.git`
- Bundled revision for this release: `7d57621b832a68c7b150fb2aab1c02e14c82144d`
- Vendored source path in this repository: `src-wasm/third_party/ffmpeg`
- Local modifications inside the FFmpeg submodule for this release: none
- Included LGPL license texts in this distribution:
  - `src-wasm/third_party/ffmpeg/COPYING.LGPLv2.1`
  - `src-wasm/third_party/ffmpeg/COPYING.LGPLv3`

## Rebuilding The Bundled Media Tools

1. Install `bun`, `zig` `0.15+`, and an Emscripten toolchain.
2. Clone this repository.
3. Initialize submodules:

```bash
git submodule update --init --recursive
```

4. Build the embedded media tools:

```bash
bun run build:embedded-media-tools
```

The build script is `scripts/build-embedded-media-tools.mts`.

It writes the packaged artifacts and build manifest to:

- `dist/embedded-tools/`

The generated `dist/embedded-tools/manifest.json` currently records the build timestamp and bundled FFmpeg revision for the current build.

Build the native tools with a C compiler, `make`, `pkg-config`, and a POSIX shell:

```bash
bun run build:native-media-tools
```

The build script is `scripts/build-native-media-tools.mts`. It statically links
the audio-only FFmpeg libraries and LAME, leaving only system libraries as runtime
dependencies. Output persists in `.artifacts/native-tools/<platform>-<arch>/` and is copied to
`dist/native-tools/<platform>-<arch>/` for development; its manifest
records the exact source revision, target, compiler, and FFmpeg configure flags.
Native and WASM builds share the codec list in `scripts/audio-codec-config.mts`.
Build on the intended target OS/architecture (MSYS2/MinGW on Windows). The build
does not enable GPL or nonfree components. macOS uses a 12.0 deployment target.
The manifest includes CPU architecture, minimum runtime versions, binary SHA-256,
and source SHA-256. Packaging checks these against the current shared WASM build
and helper sources before creating a target-specific VSIX.

## LAME (libmp3lame)

The `ffencode` binary statically links libmp3lame for MP3 export.

- Upstream project: `https://sourceforge.net/projects/lame/`
- Bundled version: `3.100`
- Source tarball: `lame-3.100.tar.gz`, downloaded during the build and verified
  against SHA-256 `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`
- LAME is licensed under the GNU Lesser General Public License, version 2 or later.
- Included license texts: `licenses/LAME-COPYING` and `licenses/LAME-LICENSE`.

## Matching Source Checkout

To inspect the exact upstream FFmpeg source used by this release outside this repository:

```bash
git clone https://github.com/FFmpeg/FFmpeg.git
cd FFmpeg
git checkout 7d57621b832a68c7b150fb2aab1c02e14c82144d
```

For licensing context, see:

- `THIRD_PARTY_NOTICES.md`
- `src-wasm/third_party/ffmpeg/COPYING.LGPLv2.1`
- `src-wasm/third_party/ffmpeg/COPYING.LGPLv3`
