# Wave Preview

VS Code의 `custom-editor-sample` 구조를 참고해 만든 오디오 전용 커스텀 에디터 스캐폴드입니다.

현재 셋업에는 아래가 포함되어 있습니다.

- `CustomReadonlyEditorProvider` 기반 오디오 미리보기 에디터
- 단일 `wave_core.wasm` 기반 compute pipeline
- `SharedArrayBuffer` 기반 zero-copy waveform/spectrogram worker 통신
- OffscreenCanvas 기반 waveform render worker
- 스크롤 없는 전체화면 미리보기
- 드래그 시크, `Shift`+드래그 루프 선택, 줌/팬, overview thumb 스크롤, 빠른 이동 버튼
- `Space` 재생/일시정지, `←/→` 5초 이동, 더블클릭 재생/일시정지
- `Wave Preview: Open Active Audio File in Wave Preview` 명령
- 디버그 시작 시 번들된 샘플 WAV 자동 오픈

지원 파일 패턴:

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
npm run compile
```

`npm run compile`은 `emcc`가 필요합니다. 현재 빌드는 `emsdk`/Homebrew Emscripten이 설치되어 있고, Python 3.11+가 잡혀 있다는 전제를 둡니다.

그다음 VS Code에서 이 폴더를 열고 `F5`로 Extension Development Host를 실행하면 됩니다.
개발 모드에서는 `exampleFiles/sample-tone.wav`가 `Wave Preview`로 자동으로 열립니다.
원하지 않으면 VS Code 설정에서 `wavePreview.openSampleOnStartupInDevelopment`를 `false`로 바꾸면 됩니다.

런타임은 두 경로를 지원합니다.

- `crossOriginIsolated + SharedArrayBuffer` 가능 시: SAB fast path
- 그 외 VS Code desktop 환경: transferable fallback path

기본 등록 우선순위는 `option`이라서, 오디오 파일을 연 뒤 아래 중 하나로 미리보기를 사용할 수 있습니다.

- Command Palette에서 `Wave Preview: Open Active Audio File in Wave Preview`
- 에디터 탭에서 `Reopen Editor With...` 후 `Wave Preview`

## Project Structure

- `src/extension.ts`: extension activation entry
- `src/audioPreviewEditor.ts`: custom editor provider와 webview bootstrap
- `media/audioPreview.js`: 재생, waveform interaction, spectrogram drawing
- `media/audioPreview.css`: 전체화면 웹뷰 스타일
- `native/wave_core.c`: waveform/spectrogram numeric kernels가 들어간 단일 wasm 코어
- `src-webview/sharedBuffers.js`: SAB/control slot layout helper
- `src-webview/interactiveWaveformWorker.js`: shared waveform slice를 읽는 render-only worker
- `src-webview/audioAnalysisWorker.js`: wasm compute worker orchestration
- `media/wave_core.js`, `media/wave_core.wasm`: Emscripten 산출물
- `exampleFiles/sample-tone.wav`: 디버그용 샘플 오디오

## Next Ideas

- marker, cue, transcript overlay
- larger-file spectrogram optimization with workers
- editable annotations persisted in sidecar JSON
