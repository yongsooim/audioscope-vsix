# Praat에서 참고할 만한 분석 기능

조사일: 2026-09-23. Praat 공식 매뉴얼만 기능 근거로 사용했다. 아래 우선순위와 audioscope 적용 방식은 매뉴얼을 바탕으로 한 제품 판단이다.

**구현 반영:** 음성 스펙트로그램 프리셋, 구간 주파수 분석, 영점 교차점 맞춤, 선택 구간 측정은 이 조사 후 앱에 추가했다. 아래의 저장소 현황은 조사 당시 기준이다. F0 윤곽선과 TextGrid 읽기는 별도 후속 설계 과제로 남는다.

## 현재 제품과 맞는 지점

audioscope는 읽기 전용 VS Code 오디오 에디터이며 파형, 스펙트로그램, mel/MFCC/scalogram/chroma, LUFS와 메타데이터를 제공한다. 현재의 시간 선택은 루프 구간도 겸한다 ([README](README.md), [설정과 분석 유형](package.json), [선택 상태](src-webview/app.ts), [현재 툴바](src/audioscope-editor/webviewHtml.ts)). Praat도 동일한 시간축 위에 파형과 스펙트로그램을 놓고, 선택 또는 커서를 분석의 기준으로 쓴다 ([Praat 스펙트로그램 소개](https://praat.org/manual/Intro_3_1__Viewing_a_spectrogram.html), [Praat SoundEditor](https://praat.org/manual/SoundEditor.html)). 따라서 새 기본 패널보다 **현재 커서/선택에 반응하는 명령과 필요할 때만 켜는 오버레이**가 자연스럽다.

## 제안 순서

| 순위 | 기능 | Praat 근거 | audioscope에 맞는 최소 UX와 유의점 |
| --- | --- | --- | --- |
| 1 | **음성 분석용 스펙트로그램 프리셋** | Praat은 약 5 ms 넓은 대역(시간 해상도)과 약 30 ms 좁은 대역(주파수 해상도)을 구분한다 ([설정 설명](https://praat.org/manual/Intro_3_2__Configuring_the_spectrogram.html)). | 기존 설정 안에 `Speech: formants`와 `Speech: harmonics` 같은 프리셋을 둔다. 현재 FFT 최소 1024는 44.1 kHz에서 약 23 ms, 기본 4096은 약 93 ms라 넓은 대역 음성 분석에는 짧은 창/FFT 크기 지원이 먼저 필요하다 ([현재 설정](package.json)). 샘플레이트별로 실제 창 길이를 ms로 표시하고 주파수 범위도 함께 조정한다. |
| 2 | **선택 구간의 주파수 단면(Spectral slice)** | Praat은 커서 주변이나 시간 선택의 주파수 스펙트럼을 별도 SpectrumEditor에서 보여준다 ([보기](https://praat.org/manual/Intro_3_6__Viewing_a_spectral_slice.html), [선택 구간 계산](https://praat.org/manual/Intro_3_7__Configuring_the_spectral_slice.html)). | 기존 선택을 만든 뒤 `… → Spectrum of selection`으로 작은 접이식 그래프를 연다. 기존 FFT 관련 자산을 활용할 여지가 크다. 선택 전체를 한 번 윈도잉한 FFT와 여러 STFT 프레임의 평균은 다른 값이므로 어떤 정의를 쓰는지 표시한다. |
| 3 | **선택 경계의 영점 교차점 맞춤** | Praat은 커서 및 선택의 시작·끝을 가장 가까운 zero crossing으로 이동하는 명령을 제공한다 ([단축키 목록](https://praat.org/manual/Keyboard_shortcuts.html)). | 이미 존재하는 루프 핸들에 `… → Snap loop edges to zero crossing` 한 동작으로 붙인다. 현재 오디오 내보내기와 루프 미세 조정에 바로 도움이 될 것으로 예상된다. 자동 스냅을 기본값으로 두면 사용자가 지정한 시간과 달라질 수 있으므로 명시적 명령이 적합하다. 스테레오에서는 두 채널의 교차점이 다를 수 있어 경계 선택 규칙이 필요하다. |
| 4 | **선택/커서 측정값 카드와 복사** | Praat의 Get pitch는 커서에서 값을, 선택에서 평균값을 반환한다 ([pitch query](https://praat.org/manual/Intro_4_3__Querying_the_pitch_contour.html)). intensity도 선택 평균을 보여주며 ([intensity query](https://praat.org/manual/Intro_6_3__Querying_the_intensity_contour.html)), 로그 기능은 선택 시작·끝·길이 및 pitch/formant/intensity 값을 기록한다 ([log files](https://praat.org/manual/Log_files.html)). | 선택이 있을 때만 작은 `Measure` 액션을 보여주고 시간, 길이 및 현재 구현으로 신뢰성 있게 계산 가능한 수치부터 표시한다. `Copy values`로 TSV/JSON을 복사하면 별도 결과 창이 필요 없다. Praat의 intensity는 **dB SPL**이며 audioscope의 LUFS/dBFS와 같은 단위로 표기해서는 안 된다 ([Intensity](https://praat.org/manual/Intensity.html)). |
| 5 | **선택적으로 켜는 F0(pitch) 윤곽선** | Praat은 시간에 따른 pitch 선/점을 분석 영역에 겹쳐 그리고 커서 또는 선택 평균을 표시한다 ([pitch contour](https://praat.org/manual/Intro_4_1__Viewing_a_pitch_contour.html)). pitch floor/ceiling은 분석 창 길이와 검출 범위에 영향을 준다 ([pitch 설정](https://praat.org/manual/Intro_4_2__Configuring_the_pitch_contour.html)). | `Analysis` 설정에 `Pitch overlay` 스위치를 추가하고 꺼짐을 기본으로 한다. 켠 경우에만 분석하며 F0 축과 단위를 명시한다. 음성 중심 기능이므로 음악/혼합 신호에는 무성 구간과 불확실한 값을 분명히 표시해야 한다. |
| 6 | **TextGrid 주석 읽기** | Praat TextGrid는 경계로 나뉜 interval tier와 시점의 point tier를 갖고, 소리와 같은 시간축에서 편집된다 ([TextGrid](https://praat.org/manual/TextGrid.html), [TextGridEditor](https://praat.org/manual/TextGridEditor.html)). 텍스트 파일 형식은 공식 문서에 설명되어 있다 ([파일 형식](https://praat.org/manual/TextGrid_file_formats.html)). | 우선 같은 이름의 `.TextGrid`를 **읽기 전용 오버레이**로 보여주고 접을 수 있는 단일 주석 레인을 고려한다. 주석 생성·편집은 현재의 읽기 전용 에디터 모델과 저장 UX를 바꾸므로 별도 설계가 필요하다. |

## 뒤로 미룰 기능

- **Formant F1–F3 오버레이:** Praat은 스펙트로그램 위에 formant 점을 보여주지만 ([formant 보기](https://praat.org/manual/Intro_5_1__Viewing_formant_contours.html)), LPC 결과는 설정 및 음성 특성에 민감하다 ([공식 FAQ](https://praat.org/manual/FAQ__Formant_analysis.html)). F0와 측정 UX가 자리 잡은 뒤 추가하는 편이 낫다.
- **Jitter/shimmer/voice report:** Praat도 성문 펄스와 선택 영역을 기반으로 하며, 일반적으로 길게 지속한 모음을 대상으로 측정한다고 안내한다 ([voice](https://praat.org/manual/Voice), [jitter](https://praat.org/manual/Voice_2__Jitter.html), [shimmer](https://praat.org/manual/Voice_3__Shimmer.html)). 범용 오디오 뷰어의 기본 UI에 두기에는 적용 조건과 결과 해석 부담이 크다.

가장 작은 구현 실험은 **zero-crossing snap**이며, 음성 분석에서 가장 큰 시각적 개선 후보는 **짧은 창을 지원하는 스펙트로그램 프리셋**이다. 그다음 **spectral slice**를 선택 구간에 연결하면 기존 화면을 크게 늘리지 않고 분석 능력을 확장할 수 있다. Pitch와 TextGrid는 음성 분석 사용자에게 더 큰 가치를 줄 수 있지만 계산 방식·저장 모델을 먼저 결정해야 한다.
