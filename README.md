# audioscope

<p align="center">
  <img src="./images/icon.png" width="128" alt="audioscope icon">
</p>

<p align="center">
  <strong>Inspect audio files in VS Code with synchronized waveform, spectrogram, playback, and loudness views.</strong>
</p>

<p align="center">
  <img src="./images/audioscope-full.png" alt="audioscope waveform and spectrogram screenshot">
</p>

## What it does

`audioscope` is a read-only custom editor for audio inspection inside VS Code.

- Open common audio formats in a dedicated editor
- Inspect waveform + spectrogram in a split view
- Seek, zoom, loop, follow playback, and control speed
- Review metadata and loudness summary (LUFS/LRA/Peak/True Peak)
- Use embedded FFmpeg WASM tools (no system ffmpeg required at runtime)

## Quick start

1. Install the extension.
2. Open a supported audio file.
3. If needed, run **`audioscope: Open Active Audio File in audioscope`**.

> [!NOTE]
> VS Code `Media Preview` can still take precedence for some extensions on first open (`.mp3`, `.wav`, `.ogg`, `.oga`).

## Supported formats

`.wav`, `.wave`, `.mp3`, `.ogg`, `.oga`, `.flac`, `.m4a`, `.aac`, `.opus`, `.aif`, `.aiff`

## Settings

- `audioscope.spectrogramQuality`: `balanced | high | max`
- `audioscope.spectrogramDefaults`: persisted defaults for analysis controls
- `audioscope.openSampleOnStartupInDevelopment`: open bundled sample on dev startup

## Project structure (feature-oriented)

```text
src/
  extension.ts                         # VS Code activation entry
  audioscopeEditor.ts                  # custom editor orchestration
  audioscope-editor/
    constants.ts                       # shared option/default constants
    document.ts                        # CustomDocument model
    editorTarget.ts                    # "can open?" and active resource resolution
    payloadClone.ts                    # safe ArrayBuffer cloning helpers
    spectrogramDefaults.ts             # config normalization/validation
    webviewHtml.ts                     # webview HTML template
  externalAudioTools.ts                # ffprobe/ffmpeg WASM host bridge
  mediaHostCache.ts                    # host-side caching layer

src-webview/
  audioscope/app.ts                    # webview bootstrap + state wiring
  audioscope/controllers/*             # feature controllers (transport/load/media/...)
  audioscope/math/*                    # analysis math helpers
```

## Runtime flow (code-path order)

1. `activate()` registers the custom editor provider (`extension.ts`).
2. `AudioscopeEditorProvider.resolveCustomEditor()` initializes webview, CSP, and handlers.
3. Webview sends `ready` → extension sends `loadAudio` payload.
4. Webview requests optional data (`requestMediaMetadata`, `requestDecodeFallback`, `requestLoudnessSummary`).
5. Extension resolves requests using cache + embedded media tools, then posts response messages.
6. User changes spectrogram defaults → extension validates and persists config.

## Development

```bash
bun install
git submodule update --init --recursive
bun run compile
```

Build output:

- `out/` extension host JavaScript
- `dist/webview/` webview bundles
- `dist/wasm/` analysis WASM binaries
- `dist/embedded-tools/` embedded ffmpeg/ffprobe/browser decode tools

## Deployment inspection report

A full packaging readiness review and risk checklist is documented in:

- [`docs/deployment-inspection.md`](./docs/deployment-inspection.md)

## License

MIT
