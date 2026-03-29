# Wave Preview

VS Code의 `custom-editor-sample` 구조를 참고해 만든 오디오 전용 커스텀 에디터 스캐폴드입니다.

현재 셋업에는 아래가 포함되어 있습니다.

- `CustomReadonlyEditorProvider` 기반 오디오 미리보기 에디터
- Zig freestanding `wave_core` 기반 compute pipeline
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
git submodule update --init --recursive
npm run compile
```

`npm run compile`은 `zig` 0.15+가 필요합니다. FFT 백엔드는 Bitbucket 원본 `pffft` submodule을 사용하고, 빌드는 `wasm32-freestanding` 타깃으로 `wave_core_simd.wasm`과 `wave_core_fallback.wasm`을 함께 생성합니다. 웹뷰 런타임은 SIMD 지원 여부에 따라 적절한 모듈을 고릅니다.

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
- `native/wave_core.zig`: waveform/spectrogram numeric kernels가 들어간 freestanding wasm 코어
- `native/freestanding/include`: freestanding PFFFT 빌드를 위한 최소 C/NEON 호환 헤더
- `native/third_party/pffft`: Bitbucket 원본 `pffft` submodule
- `src-webview/sharedBuffers.js`: SAB/control slot layout helper
- `src-webview/interactiveWaveformWorker.js`: shared waveform slice를 읽는 render-only worker
- `src-webview/audioAnalysisWorker.js`: wasm compute worker orchestration
- `media/wave_core_simd.wasm`, `media/wave_core_fallback.wasm`: Zig freestanding wasm 산출물
- `exampleFiles/sample-tone.wav`: 디버그용 샘플 오디오

## Acknowledgements

- `scalogram` 최적화는 [`fCWT`](https://github.com/fastlib/fCWT)의 공개 구현과 문서를 참고해 `scale/frequency` 사전계산, wavelet kernel 재사용, 벡터화 친화적인 연산 구조 아이디어를 반영했습니다.
- 이 프로젝트는 `fCWT` 코드를 직접 포함하거나 런타임 의존성으로 사용하지 않고, 현재 Zig/WASM 렌더러에 맞게 아이디어만 재구성해 적용합니다.

## Next Ideas

- marker, cue, transcript overlay
- larger-file spectrogram optimization with workers
- editable annotations persisted in sidecar JSON
