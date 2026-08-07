# FFmpeg Source Availability

`audioscope` ships embedded FFmpeg WebAssembly binaries for `ffmpeg`, `ffprobe`,
`ffloudness`, and `ffencode` (the export tool, which additionally links
libmp3lame — see the LAME section below).

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

## LAME (libmp3lame)

The `ffencode` binary statically links libmp3lame for MP3 export.

- Upstream project: `https://sourceforge.net/projects/lame/`
- Bundled version: `3.100`
- Source tarball: `lame-3.100.tar.gz`, downloaded during the build and verified
  against SHA-256 `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`
- LAME is licensed under the GNU Lesser General Public License, version 2 or later.

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
