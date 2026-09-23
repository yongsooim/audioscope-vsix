# Adobe Audition과 비교한 audioscope의 검사 UX

조사일: 2026-09-23. **Audition 기능 사실은 Adobe 공식 도움말**, **audioscope 현황은 이 저장소의 README와 UI 코드**를 근거로 했다. 우선순위·구현 방식·난도는 제품 판단이며 Adobe의 권고가 아니다. 비교 범위는 Audition의 **단일 파일 Waveform Editor에서 검사에 쓸 수 있는 흐름**이다. audioscope는 VS Code의 읽기 전용 오디오 인스펙터다 ([README](README.md)).

**구현 반영:** 선택과 루프 상태 분리, 숫자 구간 입력·확대, 구간 스펙트럼과 진폭 통계, 측정 위치 이동, 챕터 타임라인 탐색, 주파수 축 드래그 확대는 이 조사 후 추가했다. 아래의 빈틈 표는 조사 당시 기준이다. 위상 검사와 시간×주파수 ROI는 후속 검토 과제다.

## 이미 잘 대응하는 부분

- **파형과 스펙트로그램을 같은 시간축에서 보기:** Audition은 두 보기를 동시에 놓고 경계선을 드래그하거나 스펙트럼 보기를 숨길 수 있다 ([Adobe: Waveform Editor 표시](https://helpx.adobe.com/audition/desktop/editing-audio-files/displaying-audio-waveform-editor.html)). audioscope도 동기화된 파형·스펙트로그램과 높이 조절 경계선을 갖는다 ([README](README.md), [현재 UI](src/audioscope-editor/webviewHtml.ts)). 따라서 기본 화면을 다시 설계할 필요는 작다.
- **시간 탐색과 루프:** Audition에는 개요 영역을 통한 이동, 확대·축소, 재생 중 자동 스크롤, 루프 재생이 있다 ([Adobe: 보기·확대·이동](https://helpx.adobe.com/audition/desktop/workspace-and-setup/viewing-zooming-navigating-audio.html), [Adobe: 시간 탐색·재생](https://helpx.adobe.com/audition/desktop/importing-recording-and-playing/navigating-time-playing-audio.html)). audioscope에도 개요 스트립, 샘플 수준 줌, Follow, 구간 루프가 있다 ([README](README.md)).
- **기본 음량 분석:** Audition의 진폭 통계는 피크와 RMS 등을 보여 준다 ([Adobe: 위상·주파수·진폭 분석](https://helpx.adobe.com/audition/desktop/editing-audio-files/analyzing-phase-frequency-amplitude.html)). audioscope에는 전체 파일의 integrated LUFS, LRA, sample/true peak와 시간별 LUFS 곡선이 이미 있다 ([README](README.md), [현재 UI](src/audioscope-editor/webviewHtml.ts)). **음량 분석 전체가 비어 있다는 평가는 부정확**하다.

## 가장 큰 상호작용 차이

Audition은 먼저 시간 구간을 선택하고 **Loop Playback 버튼을 별도로 켠다** ([Adobe: 시간 탐색·재생](https://helpx.adobe.com/audition/desktop/importing-recording-and-playing/navigating-time-playing-audio.html)). audioscope는 파형에서 구간 드래그를 끝내면 곧바로 `loopRangeFrames`를 설정하고 transport에 `setLoop`를 보낸다 ([현재 선택 처리](src-webview/audioEngineWorker.ts)). 선택 구간이 측정·주파수 분석·내보내기의 공통 입력으로 늘어나면 이 결합이 혼란을 줄 수 있다. **제품 제안:** 내부 상태에서 `선택 범위`와 `루프 재생 여부`를 분리하고, 현재의 빠른 루프 사용자는 기존 동작을 유지할 수 있도록 컨트롤 문구와 토글 흐름을 설계한다. 이 상태 구분은 아래 기능들의 선행 설계 과제다.

## 개선 우선순위 — 제품 판단

| 우선 | 확인된 Audition 방식 | 이 저장소에서 관찰한 빈틈 | audioscope에 맞는 최소 UX |
| --- | --- | --- | --- |
| **1. 숫자로 구간·화면 범위 지정** | Selection/View 패널에서 선택과 현재 화면의 시작·끝·길이를 보고 숫자로 수정할 수 있고, 선택 구간으로 바로 확대할 수 있다 ([Adobe: 보기·확대·이동](https://helpx.adobe.com/audition/desktop/workspace-and-setup/viewing-zooming-navigating-audio.html)). | 현재는 드래그와 루프 핸들 중심이며, 선택 구간을 숫자로 입력하거나 `Zoom to selection`하는 UI가 보이지 않는다 ([현재 UI](src/audioscope-editor/webviewHtml.ts), [웹뷰 이벤트](src-webview/app.ts)). | 선택/루프 라벨에서 **시작·끝·길이** 입력과 `선택 구간 확대`를 연다. 샘플 경계로 반올림하고 입력값과 실제 경계를 함께 보여 준다. 앞서 설명한 선택·루프 상태 분리를 함께 설계한다. 작은 UI 변경에 비해 반복 검사의 정확도가 크게 좋아질 가능성이 있다. |
| **2. 구간 주파수 분석 그래프** | Frequency Analysis 패널은 커서·재생 위치의 스펙트럼과 `Scan Selection`의 구간 평균을 구분한다. FFT 크기·창 함수·채널 표시, 주파수별 값, 데이터 복사, 여러 스냅샷 비교도 있다 ([Adobe: 위상·주파수·진폭 분석](https://helpx.adobe.com/audition/desktop/editing-audio-files/analyzing-phase-frequency-amplitude.html)). | 시간·주파수 스펙트로그램과 여러 변환 유형은 있지만, **선택 구간의 주파수 대 진폭 그래프**는 없다 ([README](README.md), [현재 UI](src/audioscope-editor/webviewHtml.ts)). | `… → 구간 주파수 분석`으로 필요할 때만 작은 그래프를 연다. 첫 버전은 `커서 프레임`과 `구간 평균`을 명확히 구분하고 dBFS·FFT·창 함수·채널 출처를 표시한다. `복사`는 CSV/TSV로 제공할 수 있다. Praat 조사 노트의 spectral slice와 겹치는 **공통 우선 과제**다 ([Praat 조사](PRAAT_FEATURE_RESEARCH.md)). |
| **3. 구간 진폭 통계와 문제 위치로 이동** | Amplitude Statistics는 파일이나 선택 구간을 스캔해 피크, RMS, 클리핑 의심 샘플, DC 오프셋 등을 보여 주고 일부 값에서 해당 위치로 이동한다 ([Adobe: 위상·주파수·진폭 분석](https://helpx.adobe.com/audition/desktop/editing-audio-files/analyzing-phase-frequency-amplitude.html)). Diagnostics 패널은 클릭·왜곡·무음 등을 스캔한 후 결과 목록에서 선택할 수 있다 ([Adobe: Diagnostics](https://helpx.adobe.com/in/audition/desktop/effects-reference/diagnostics-effects-waveform-editor-only.html)). | 현재 전체 파일의 LUFS·피크 요약은 있지만, 구간별 RMS·DC·클리핑 후보 목록과 해당 시점 탐색은 확인되지 않는다 ([README](README.md), [현재 UI](src/audioscope-editor/webviewHtml.ts)). | 선택 시 `측정` 액션에서 peak dBFS, RMS dBFS, DC offset, 의심 클리핑 수를 계산한다. 의심 지점은 짧은 결과 목록에서 클릭해 이동한다. **클리핑은 확정 판정이 아니라 후보**로 표기한다. 자동 수리 기능은 이 인스펙터의 범위 밖이다. |
| **4. 참조 마커와 빠른 탐색** | Audition의 point/range marker는 타임라인과 Markers 패널에 나타나며 이름·시간을 관리하고 다음/이전 마커로 이동한다. 구간 마커별 내보내기도 가능하다 ([Adobe: 마커](https://helpx.adobe.com/audition/desktop/editing-audio-files/markers.html)). | 현재의 `timeline-current-marker`는 재생 위치 표시다. 파일의 chapter 정보는 메타데이터 상세에 텍스트 목록으로 표시되지만 타임라인 마커나 다음/이전 탐색에 쓰이지 않는다 ([현재 UI](src/audioscope-editor/webviewHtml.ts), [chapter 표시](src-webview/audioscope/controllers/media.ts)). | 먼저 chapter를 **읽기 전용 타임라인 표시**와 다음/이전 이동에 연결한다. 일반 사용자 마커는 원본 오디오를 바꾸지 않는 sidecar 저장 형식과 파일 이동 시 동기화 규칙이 정해진 뒤 제공한다. 기본 화면에는 작은 타임라인 눈금만 놓고 목록은 접는다. |
| **5. 주파수 축 직접 탐색** | Audition은 스펙트럼의 수직 눈금에서 드래그로 특정 주파수 대역을 확대하고 이동할 수 있으며, 표시 해상도·색 강도·로그/선형 축을 조절한다 ([Adobe: 보기·확대·이동](https://helpx.adobe.com/audition/desktop/workspace-and-setup/viewing-zooming-navigating-audio.html), [Adobe: Waveform Editor 표시](https://helpx.adobe.com/audition/desktop/editing-audio-files/displaying-audio-waveform-editor.html)). | audioscope의 설정에는 min/max Hz, FFT, dB 범위, 축 종류가 이미 있지만, 주파수 축에서 직접 대역을 드래그해 확대하는 빠른 조작은 없다 ([현재 UI](src/audioscope-editor/webviewHtml.ts)). | 기존 Hz 설정과 연결되는 **수직 축 드래그 확대/더블클릭 복귀**를 검토한다. 이 기능은 새 분석 패널 없이도 좁은 대역 검사 속도를 높일 수 있다. |

## 후순위 또는 별도 설계

- **위상 검사:** Audition의 Phase Meter는 두 채널의 상관 정도를 재생 중 표시해 모노 합산 문제를 확인하게 한다 ([Adobe: 위상·주파수·진폭 분석](https://helpx.adobe.com/audition/desktop/editing-audio-files/analyzing-phase-frequency-amplitude.html)). audioscope에는 채널 분리 보기가 있으나 현재 실험 설정이고, 위상 미터는 없다 ([package.json](package.json), [현재 UI](src/audioscope-editor/webviewHtml.ts)). 스테레오 파일에서만 여는 `채널 검사` 팝오버의 상관 계수/미터가 적당하다. 모노에는 노출하지 않는다.
- **시간×주파수 사각형 선택과 선택 주파수만 듣기:** Audition은 Marquee/Lasso/Paintbrush로 스펙트럼 일부를 선택하고 그 주파수만 재생할 수 있다 ([Adobe: 오디오 선택](https://helpx.adobe.com/audition/desktop/editing-audio-files/selecting-audio.html)). audioscope에선 분석 목적의 **사각형 ROI**가 먼저 유용할 수 있다. 그러나 현재 드래그가 시간 루프 선택이므로 명시적인 선택 모드가 필요하다. 선택 대역만 듣는 기능은 필터링·역변환·원본 재생과 결과가 다를 수 있어 별도 설계가 필요하다. Lasso/브러시와 복원 편집은 이 제품 목표에 비해 무겁다.
- **다중 파일 음량 일치와 복원 효과:** Audition의 Match Loudness는 여러 파일을 스캔하고 표준에 맞게 실제 음량을 수정하며 ([Adobe: Match Loudness](https://helpx.adobe.com/audition/desktop/editing-audio-files/match-loudness.html)), Diagnostics는 감지 결과를 복구·삭제할 수 있다 ([Adobe: Diagnostics](https://helpx.adobe.com/in/audition/desktop/effects-reference/diagnostics-effects-waveform-editor-only.html)). audioscope의 읽기 전용 단일 파일 검사와는 제품 경계가 다르므로 기능 격차 목록에는 넣되 구현 우선순위는 낮다. 문제 **탐지와 위치 이동**까지가 자연스러운 경계다.

## 화면 공간에 관한 UX 판단

Audition의 작업 영역은 패널을 도킹·그룹화·크기 조절해 분석 결과를 띄운 채 편집 화면을 볼 수 있다 ([Adobe: 작업 영역 맞춤](https://helpx.adobe.com/audition/desktop/workspace-and-setup/customizing-workspaces.html)). audioscope의 [전체 화면 예시](images/audioscope-full.png)에서는 메타데이터와 설정 팝오버를 동시에 열면 파형·스펙트로그램의 큰 부분을 덮는다. 이는 화면 예시의 관찰이며 현재 모든 화면 크기에서의 사용성 측정은 아니다. **제품 제안:** 숫자 선택값과 측정/주파수 결과처럼 계속 보며 비교할 정보는 필요할 때만 여는 **작은 고정 서랍**에 둘 수 있게 하고, 일회성 설정은 기존 팝오버에 둔다. VS Code 웹뷰에 Audition의 자유 도킹 시스템을 복제할 필요는 없다.

## UX 결론

기본 화면은 현재의 파형·분석 그래프·개요·전송 컨트롤을 유지하고, **기존 선택과 연동되는 명령**을 우선 추가하는 것이 적절하다. 첫 구현 묶음은 `선택과 루프의 상태 분리 + 선택 구간 숫자 입력 + 선택 확대 + 구간 측정`이다. 그다음 `주파수 분석`을 기존 `…`에서 여는 접이식 결과 뷰로 넣고, 마커와 진단 결과가 생기면 동일한 탐색 목록 구조를 재사용한다. 검사 작업에서 자주 반복되는 **정확한 범위 지정 → 측정 → 문제 지점 이동**이 읽기 전용 VS Code UI에 맞는 핵심 흐름이라는 판단이다.
