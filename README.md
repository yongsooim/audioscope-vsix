# Wave Scope

<p align="center">Inspect audio files in VS Code with synchronized waveform, spectrogram, playback, and loudness views.</p>

Wave Scope is a custom read-only audio viewer for VS Code. Open a supported audio file and inspect timing, frequency content, playback position, loop ranges, metadata, and loudness without leaving the editor.

 For metadata and decode fallback, install the `ffmpeg` CLI first.

 macOS
 ```bash
 brew install ffmpeg
 ```

 Windows
 ```powershell
 winget install --id Gyan.FFmpeg --exact
 ```

 Other platforms: [ffmpeg.org/download.html](https://ffmpeg.org/download.html)

| Inspect | Navigate | Analyze |
| --- | --- | --- |
| Waveform and spectrogram side by side | Seek, zoom, pan, follow playback, and loop sections | Metadata, LUFS/LRA, sample peak, and true peak summary |

## Highlights

- Open common audio formats directly in a dedicated VS Code view
- View waveform and spectrogram together in a fullscreen-first, resizable layout
- Click to seek, drag to create loop ranges, and refine loop points with direct handles
- Use follow mode, overview scrolling, and zoom controls for long recordings
- Review codec, container, duration, bitrate, and channel metadata
- Inspect integrated loudness, loudness range, sample peak, and true peak at a glance
- Use optional `ffmpeg` and `ffprobe` integration for richer metadata and decode fallback on local files

## Supported Formats

`Wave Scope` registers as the default editor for these file types (with ffmpeg decoder):

- `.wav`
- `.wave`
- `.mp3`
- `.ogg`
- `.oga`
- `.flac`
- `.m4a`
- `.aac`
- `.opus`
- `.aif`
- `.aiff`

## Requirements

- VS Code `1.100.0` or later
- Optional but recommended: `ffmpeg` CLI tools including `ffprobe` for richer metadata and decode fallback on local filesystem files

## Getting Started

1. Install the extension.
2. Open a supported audio file in VS Code.
3. The file opens in `Wave Scope` automatically.
4. To open manually, run `Wave Scope: Open Active Audio File in Wave Scope` from the Command Palette or use `Reopen Editor With...`.

## Interaction

- `Space`: play or pause
- `←` / `→`: seek backward or forward by 5 seconds
- `-` / `=`: zoom out or zoom in
- Click on the waveform or spectrogram: seek to that point
- Drag on the waveform or spectrogram: create a loop range
- Drag loop handles: adjust loop boundaries
- Mouse wheel or trackpad: zoom or pan the visible range
- Drag the center splitter: resize waveform and spectrogram panels

## Optional ffmpeg Integration

Wave Scope works out of the box for formats the runtime can decode natively. Installing `ffmpeg` and `ffprobe` improves the experience for local filesystem files by enabling:

- richer metadata via `ffprobe`
- decode fallback for files the runtime cannot open directly

Quick install examples:

- macOS (Homebrew): [`brew install ffmpeg`](https://formulae.brew.sh/formula/ffmpeg)
- Windows (winget): [`winget install --id Gyan.FFmpeg --exact`](https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Gyan/FFmpeg)
- Other platforms: use your package manager of choice from [ffmpeg.org/download.html](https://ffmpeg.org/download.html)

If the binaries are not on `PATH`, configure them with:

- `waveScope.ffmpegPath`
- `waveScope.ffprobePath`

## Settings

- `waveScope.spectrogramQuality`: choose `balanced`, `high`, or `max`
- `waveScope.ffmpegPath`: custom `ffmpeg` executable path or command name
- `waveScope.ffprobePath`: custom `ffprobe` executable path or command name
- `waveScope.openSampleOnStartupInDevelopment`: open the bundled sample file automatically in development mode

## Notes

- Wave Scope is currently read-only. It does not modify the source audio file.
- Loudness values currently use the same mono downmix used for waveform and spectrogram analysis. Multichannel audio renders correctly, but LUFS/LRA/peak numbers are downmix-based.

## Development

```bash
bun install
git submodule update --init --recursive
bun run compile
```

`bun run compile` requires `bun` and `zig` 0.15+ and produces:

- `dist/webview/` webview bundles
- `dist/wasm/wave_core_simd.wasm`
- `dist/wasm/wave_core_fallback.wasm`

Open this folder in VS Code and press `F5` to launch the Extension Development Host.

In development mode, `exampleFiles/sample-tone.wav` opens automatically in `Wave Scope`. To disable that behavior, set `waveScope.openSampleOnStartupInDevelopment` to `false`.

## Acknowledgements

- Scalogram optimization was informed by the public implementation and documentation of [`fCWT`](https://github.com/fastlib/fCWT), especially around precomputed scale-to-frequency mappings, wavelet kernel reuse, and vectorization-friendly computation structure.
- Wave Scope does not embed or depend on `fCWT` directly at runtime.
