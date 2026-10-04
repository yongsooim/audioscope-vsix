# Changelog

## 1.1.9 — 2026-10-05

- Accelerate metadata and export with bundled, compatible native media tools; retain WASM decoding and loudness as the default.
- Add optional experimental native decoding, with automatic codec threading where supported and WASM fallback.
- Build macOS binaries for 12.0 and gate native execution by OS/architecture/runtime compatibility.
- Stage platform-specific VSIX packages from persistent verified artifacts; add installed VSIX playback/export/fallback tests and a six-platform release workflow.

- Clarify the A/B Auto align control and keep automatic offsets at zero for silent or constant signals. Remove DC bias from alignment correlation and constrain sample refinement to the alignment search range.
- Clear the analysis-view loading spinner when the current canvas first presents audio content, including overview tiles and loudness curves, independently of detail-render request generations.
- Compute selection measurements in WASM using resident PCM, one combined statistics pass, and the spectrogram's pooled PFFFT resources. Derive frequency metrics from the same spectrum without extra FFTs or copying the selected audio.
- Use WebGPU automatically when available, with CPU/WASM fallback. Remove the Experimental section and WebGPU toggle; channel views now use the regular `audioscope.splitChannels` setting while honoring previously saved preferences.
- Open audio paths from text-file hovers, the editor context menu, or the Command Palette, with document-relative and workspace-relative resolution.
- Add clipping ratio, crest factor, zero-crossing rate, dominant frequency, and energy-weighted spectral centroid to selection analysis and copied measurements. Spectral estimates reuse the bounded FFT windows.

## 1.1.0 - Add experimental features (multichannel view, webgpu accelerate)
## 1.0.0 - Initial Release
