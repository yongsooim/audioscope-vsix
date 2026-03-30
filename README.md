# Wave Scope

An audio-focused custom editor scaffold for VS Code, based on the structure of the `custom-editor-sample`.

The current setup includes:

- An audio custom editor built on `CustomReadonlyEditorProvider`
- A unified spectrogram/loudness compute pipeline powered by freestanding Zig `wave_core`
- `SharedArrayBuffer`-based zero-copy PCM sharing with a JS waveform render worker
- An OffscreenCanvas-based waveform render worker
- An integrated loudness/LRA/peak summary panel backed by `libebur128`
- A fullscreen preview without scrollbars
- Drag-to-seek, `Shift`+drag loop selection, zoom/pan, overview thumb scrolling, and quick jump buttons
- `Space` to play/pause, `←/→` to seek 5 seconds, and double-click to play/pause
- The `Wave Scope: Open Active Audio File in Wave Scope` command
- Automatic opening of the bundled sample WAV when debugging starts

Supported file patterns:

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

## Run

```bash
npm install
git submodule update --init --recursive
npm run compile
```

`npm run compile` requires `zig` 0.15+. The FFT backend uses the original Bitbucket `pffft` submodule, and loudness summaries use the `libebur128` submodule. The build targets `wasm32-freestanding`, producing `dist/wasm/wave_core_simd.wasm` and `dist/wasm/wave_core_fallback.wasm`, while the webview bundles are emitted to `dist/webview/`. The webview runtime selects the appropriate module depending on SIMD support.

At the moment, the loudness summary reuses the same mono downmixed PCM used for waveform and spectrogram analysis. Stereo and multichannel files are displayed correctly, but LUFS/LRA/peak values are based on the downmix rather than channel-preserving measurement.

Then open this folder in VS Code and press `F5` to launch the Extension Development Host.
In development mode, `exampleFiles/sample-tone.wav` opens automatically in `Wave Scope`.
If you do not want that behavior, set `waveScope.openSampleOnStartupInDevelopment` to `false` in VS Code settings.

The runtime supports two paths:

- When `crossOriginIsolated + SharedArrayBuffer` is available: SAB fast path
- Otherwise in VS Code desktop environments: transferable fallback path

The custom editor is registered with `default` priority, so supported audio files open in `Wave Scope` automatically. You can also reopen files manually through:

- The Command Palette: `Wave Scope: Open Active Audio File in Wave Scope`
- The editor tab menu: `Reopen Editor With...` then `Wave Scope`

## Project Structure

- `src/extension.ts`: extension activation entry
- `src/waveScopeEditor.ts`: custom editor provider and webview bootstrap
- `src-webview/waveScope.ts`: playback, waveform interaction, and spectrogram drawing source
- `src-webview/waveScope.css`: fullscreen webview style source
- `dist/webview/`: generated webview bundles
- `wasm/wave_core.zig`: freestanding wasm export entry
- `wasm/wave_core/`: Zig modules split by session, waveform, loudness, and spectrogram responsibilities
- `wasm/freestanding/include`: minimal C/NEON compatibility headers for freestanding PFFFT builds
- `wasm/third_party/libebur128`: `libebur128` submodule used for EBU R128 loudness summaries
- `wasm/third_party/pffft`: original Bitbucket `pffft` submodule
- `src-webview/sharedBuffers.ts`: SAB/control slot layout helper
- `src-webview/interactiveWaveformWorker.ts`: worker source that reads PCM directly, builds the waveform pyramid, and renders waveform data only
- `src-webview/audioAnalysisWorker.ts`: orchestration for the unified Zig/WASM spectrogram and loudness compute worker
- `dist/wasm/wave_core_simd.wasm`, `dist/wasm/wave_core_fallback.wasm`: generated freestanding Zig wasm artifacts
- `exampleFiles/sample-tone.wav`: sample audio used for debugging

## Acknowledgements

- `scalogram` optimization was informed by the public implementation and documentation of [`fCWT`](https://github.com/fastlib/fCWT), especially around precomputed `scale/frequency` mappings, wavelet kernel reuse, and vectorization-friendly computation structure.
- This project does not embed or depend on `fCWT` directly at runtime. It only adapts the underlying ideas to fit the current Zig/WASM renderer.

## Next Ideas

- marker, cue, transcript overlay
- larger-file spectrogram optimization with workers
- editable annotations persisted in sidecar JSON
