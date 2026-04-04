# audioscope

<p align="center">
  <img src="./images/icon.png" width="128" alt="audioscope icon">
</p>

<p align="center">
  <strong>VS Code audio inspector for waveform, spectrogram, playback, loop selection, loudness, and metadata review.</strong>
</p>

<p align="center">
  <img src="./images/audioscope-full.png" alt="audioscope waveform and spectrogram screenshot">
</p>

## Quick Start

1. Install the extension.
2. Open a supported audio file.
3. If needed, run **`audioscope: Open Active Audio File in audioscope`**.

## What it does

`audioscope` is a read-only custom editor for audio files inside VS Code.

- Open supported audio files in a dedicated audio editor
- Inspect synchronized waveform and spectrogram views
- Switch between spectrogram, mel-spectrogram, MFCC, scalogram, and chroma analysis
- Seek with the timeline or `-5s` / `+5s` buttons
- Control playback speed from `0.5x` to `2x`
- Zoom the waveform, follow playback, and set loop ranges by dragging
- Review metadata such as codec, container, duration, sample rate, bitrate, channels, tags, and chapters
- View loudness summary values including integrated LUFS, LRA, sample peak, and true peak
- Use bundled FFmpeg and ffprobe WASM tools, so no system ffmpeg install is required at runtime

> [!NOTE]
> VS Code `Media Preview` can still take precedence for some extensions on first open, especially `.mp3`, `.wav`, and `.ogg` files.

## Supported Formats

`.wav`, `.wave`, `.mp3`, `.ogg`, `.oga`, `.flac`, `.m4a`, `.aac`, `.opus`, `.aif`, `.aiff`

## Features

### Waveform and transport

- Synchronized waveform viewer
- Timeline scrubber and overview strip
- Play / pause controls
- Seek backward and forward by 5 seconds
- Playback speed control
- Follow playback mode
- Loop selection and loop handles
- Waveform zoom controls

### Spectrogram and analysis

- Spectrogram visualization
- Audio analysis uses WebGPU when available, with WASM fallback for unsupported environments
- Mel-spectrogram analysis
- MFCC analysis
- Scalogram analysis
- Chroma analysis
- FFT size controls
- Overlap ratio controls
- Window function selection
- Frequency scale controls
- Colormap distribution controls
- Decibel range controls
- Mel band count controls
- MFCC coefficient controls
- Scalogram frequency range controls
- Scalogram omega0 and row density controls

### Metadata and loudness

- Audio metadata summary
- Codec name and long name
- Container / format information
- Duration, size, bitrate, sample rate, and channel layout
- Tags and chapter data
- Loudness analysis with LUFS, LRA, Peak, and True Peak
- FFmpeg / ffprobe tool status and fallback guidance

## Settings

- `audioscope.spectrogramQuality`: `balanced | high | max`
- `audioscope.spectrogramDefaults`: persisted defaults for analysis controls
- `audioscope.openSampleOnStartupInDevelopment`: open the bundled sample on startup in development mode

## Keywords

audio inspector, waveform, spectrogram, mel, mfcc, scalogram, chroma, playback, loop, metadata, loudness, LUFS, integrated LUFS, EBU R 128, LRA, mp3, wav, flac, m4a, ogg, aac, opus, aiff, aif

## Development

## Third-Party And Vendor Code

This repository includes a small amount of vendored and third-party source used
to build the shipped extension and WASM tools.

- `src-wasm/third_party/ffmpeg`
  The FFmpeg source tree vendored as a submodule and used to build the
  embedded FFmpeg / ffprobe WebAssembly binaries.
  Upstream repository: <https://github.com/FFmpeg/FFmpeg>
- `src-wasm/third_party/pffft`
  PFFFT and FFTPACK-based FFT code used by the analysis WASM runtime.
  Original PFFFT repository: <https://bitbucket.org/jpommier/pffft/>
- `src-webview/vendor/SignalsmithStretch.mjs`
  Vendored Signalsmith Stretch Web module used for time-stretch playback in the
  webview transport path.
  Official upstream: <https://signalsmith-audio.co.uk/code/stretch.git>
  GitHub mirror: <https://github.com/Signalsmith-Audio/signalsmith-stretch>

Licensing and attribution details for bundled third-party code are documented
in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). FFmpeg rebuild notes and
revision details are documented in [FFMPEG_SOURCE.md](./FFMPEG_SOURCE.md).

Build prerequisites:

- `bun`
- `zig` `0.15+`
- Emscripten toolchain
- FFmpeg submodule checkout

Build from source:

```bash
bun install
git submodule update --init --recursive
bun run compile
```

The full build compiles:

- embedded FFmpeg / ffprobe WASM tools
- analysis WASM binaries
- webview bundles
- extension host output

## License

MIT
