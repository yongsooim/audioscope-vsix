# Wave Scope

<p align="center">
  <img src="./images/icon.png" width="128" alt="Wave Scope icon">
</p>

<p align="center">
  <strong>Inspect audio files in VS Code with synchronized waveform, spectrogram, playback, and loudness views.</strong>
</p>

<p align="center">
  Open a supported audio file and explore timing, frequency content, loop ranges, metadata, and loudness without leaving the editor.
</p>

<p align="center">
  <img src="./images/wave-scope-full.png" alt="Wave Scope waveform and spectrogram screenshot">
</p>

## Overview

Wave Scope is a custom read-only audio viewer for VS Code. It is built for quick inspection and analysis rather than editing, so you can stay inside your workspace while reviewing audio assets, recordings, stems, or exports.

| See | Control | Review |
| --- | --- | --- |
| Waveform and spectrogram side by side | Seek, zoom, pan, follow playback, and loop sections | Metadata, LUFS/LRA, sample peak, and true peak summary |

## Highlights

- Open common audio formats in a dedicated VS Code view
- View waveform and spectrogram together in a fullscreen-first, resizable layout
- Click to seek, drag to create loop ranges, and refine loop points with direct handles
- Use follow mode, overview scrolling, and zoom controls for long recordings
- Review codec, container, duration, bitrate, and channel metadata
- Inspect integrated loudness, loudness range, sample peak, and true peak at a glance
- Use optional `ffmpeg` and `ffprobe` integration for richer metadata and decode fallback on local files

## Quick Start

1. Install the extension.
2. Open a supported audio file in VS Code.
3. If VS Code selects `Wave Scope`, the file opens directly in the custom view.
4. If it opens somewhere else, use `Reopen Editor With...` or run `Wave Scope: Open Active Audio File in Wave Scope` from the Command Palette.

> [!NOTE]
> VS Code's built-in `Media Preview` currently takes precedence for `.mp3`, `.wav`, `.ogg`, and `.oga`, so those formats may not open in `Wave Scope` automatically on first install.

To make Wave Scope the default editor for those formats, use `Reopen Editor With...` and choose `Set as Default`, or add this to your VS Code settings:

```json
{
  "workbench.editorAssociations": {
    "*.mp3": "waveScope.editor",
    "*.wav": "waveScope.editor",
    "*.ogg": "waveScope.editor",
    "*.oga": "waveScope.editor"
  }
}
```

## Supported Formats

Wave Scope contributes a custom editor for:

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

## Controls

- `Space`: play or pause
- `Left Arrow` / `Right Arrow`: seek backward or forward by 5 seconds
- `-` / `=`: zoom out or zoom in
- Click on the waveform or spectrogram: seek to that point
- Drag on the waveform or spectrogram: create a loop range
- Drag loop handles: adjust loop boundaries
- Mouse wheel or trackpad: zoom or pan the visible range
- Drag the center splitter: resize waveform and spectrogram panels

## Embedded ffmpeg Tools

Wave Scope now bundles embedded FFmpeg WebAssembly tools for:

- richer metadata via embedded `ffprobe`
- decode fallback for files the runtime cannot open directly
- probing files even when the webview cannot decode them natively

If you prefer a system `ffmpeg` / `ffprobe` install instead, set:

- `waveScope.ffmpegPath`
- `waveScope.ffprobePath`

Quick install examples for external overrides:

```bash
# macOS (Homebrew)
brew install ffmpeg
```

```powershell
# Windows (winget)
winget install --id Gyan.FFmpeg --exact
```

Other platforms: [ffmpeg.org/download.html](https://ffmpeg.org/download.html)

## Requirements

- VS Code `1.100.0` or later
- Development builds of the embedded media tools require Emscripten (`emcc`, `emconfigure`, `emmake`)

## Settings

- `waveScope.spectrogramQuality`: choose `balanced`, `high`, or `max`
- `waveScope.ffmpegPath`: optional external `ffmpeg` executable path or command name
- `waveScope.ffprobePath`: optional external `ffprobe` executable path or command name
- `waveScope.openSampleOnStartupInDevelopment`: open the bundled sample file automatically in development mode

## Notes

- Very long, high-sample-rate, or multichannel files can use substantial memory while Wave Scope decodes audio and prepares waveform and spectrogram analysis.
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
