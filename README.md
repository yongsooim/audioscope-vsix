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

## License

MIT
