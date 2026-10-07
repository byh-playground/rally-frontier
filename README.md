# RALLY FRONTIER

RALLY FRONTIER는 브라우저에서 바로 실행할 수 있는 실시간 전략 게임(RTS) 프로젝트입니다.

별도의 설치 없이 브라우저에서 실행할 수 있으며, WebRTC 기반 P2P 멀티플레이와 싱글 플레이를 지원합니다.

> **이 저장소는 개발 중인 최신 작업본이 아니라, 테스트와 검증을 완료한 Stable 버전을 관리하고 배포하기 위한 저장소입니다.**

## 플레이

GitHub Pages를 통해 현재 Stable 버전을 바로 실행할 수 있습니다.

**https://byh-playground.github.io/rally-frontier/**

## 버전 관리

개발 중인 후보 버전은 별도의 개발·검증 환경에서 테스트합니다.

실제 플레이, 주요 기능, 회귀 및 네트워크 동작 등의 검증을 통과하여 **VALIDATED** 상태가 된 버전만 이 저장소의 `main` 브랜치에 반영합니다.

```text
개발 및 수정
    ↓
개발·검증 환경 배포
    ↓
플레이 및 회귀 검증
    ↓
VALIDATED
    ↓
GitHub main 소스
    ↓
Actions 빌드 (업데이트 시각·소스 커밋 자동 주입)
    ↓
GitHub Pages (Stable)
```

`main`은 검증한 배포 소스를 관리하며, 공개 페이지는 Actions에서 생성한 `_site/index.html`입니다. 빌드 성공이나 업데이트 시각 갱신이 게임 검증 또는 **VALIDATED** 승격을 자동으로 의미하지는 않습니다.

## 업데이트 시각과 배포

업데이트 시각은 수동으로 수정하지 않습니다. `.github/workflows/pages.yml`이 `main` 변경 또는 `main` 대상 수동 실행마다 `scripts/build-pages.cjs`를 실행하여 빌드 시각과 전체 Git 커밋 SHA를 `_site/build.json`에 기록하고, 같은 빌드 식별자를 `_site/index.html`에 주입합니다. 공개 화면의 업데이트 표시는 이 실행물의 빌드 정보를 사용합니다. 생성된 `_site`만 Pages artifact로 배포하며 소스 `index.html`에는 `BUILD_ID = 'development'`를 유지합니다.

PR에서는 동일한 빌드 검사와 생성만 수행하고 배포하지 않습니다. Pages 게시 소스는 저장소 **Settings → Pages → Build and deployment → GitHub Actions**를 사용해야 합니다. 브랜치의 원본 HTML을 직접 게시하면 이 자동 빌드 과정이 적용되지 않습니다. 빌드·배포가 실패하면 기존 공개 실행물이 유지되므로 업데이트 표시도 바뀌지 않습니다.

로컬에서 배포 실행물을 확인하려면 `node --test scripts/build-pages.test.cjs`와 `node scripts/build-pages.cjs`를 실행하고 `_site`를 정적 HTTP 서버로 제공합니다. 시각·커밋 정보는 빌드 시점에 고정되며 브라우저 접속 시각으로 바뀌지 않습니다. 게임 검증 기록의 날짜와 결과는 실제 검증 근거로 별도 관리합니다.

## 프로젝트 구조

게임 엔진과 UI는 `index.html` 안에 유지하고, 현재 캠페인 데이터 전체는 `campaign/campaigns.js` 한 JavaScript 모듈에 둡니다.

캠페인 메뉴를 열 때 native ES import로 데이터를 읽습니다. 기본 게임 부팅은 캠페인 모듈 로드에 의존하지 않으며, 각 미션은 자체 시작 상태를 선언합니다. 개발용 신뢰 Mission JS의 파일/URL Preview도 유지합니다.

```text
rally-frontier/
├── index.html             # 게임 엔진·UI 소스 (development 빌드)
├── campaign/
│   └── campaigns.js       # 현재 정식 캠페인 데이터 전체 (default manifest)
├── scripts/build-pages.cjs # 배포 HTML·메타데이터·정적 리소스 생성
├── .github/workflows/pages.yml # PR 빌드 검사 및 main Pages 배포
└── _site/                 # 자동 생성한 배포 실행물 (Git 제외)
```

## 주요 특징

* 브라우저 기반 실시간 전략 게임
* 싱글 플레이 지원
* WebRTC 기반 P2P 멀티플레이
* 별도 게임 서버 없이 플레이어 간 직접 통신
* 모바일 및 PC 브라우저 지원
* 전장의 안개(Fog of War)
* 건설 및 자원 채취
* 유닛 생산 및 테크 시스템
* 다양한 유닛과 특수 능력
* 중립 오브젝트 및 점령 시스템
* 리플레이 지원
* HTML 안의 게임 엔진과 하나의 캠페인 데이터 모듈

## 공통 동기화 라이브러리 적용

게임은 [bloom-gamekit 동기화 모듈](https://github.com/byh-playground/bloom-gamekit)의 공개 계약을 사용합니다. `GameSession`은 경기의 로비·UI·수명주기를 조정하며, Core와 게임 Adapter, Transport를 **Has-a**로 소유합니다.

| 관계 | 구현과 사용 시나리오 |
| --- | --- |
| **Is-a** | `GameSession`은 경기 Coordinator, `StrategySim`은 게임 Simulation입니다. 둘을 Netcode 타입별로 상속하지 않습니다. |
| **Has-a** | Coordinator가 `RollbackSession`, `RallySimulationAdapter`, 전송 capability를 조합합니다. 온라인·싱글 WebRTC·LOCAL 2P가 같은 경로를 사용합니다. |
| **Can-be** | prediction·hold·resimulation·recovery는 Core의 실행 상태입니다. 별도 게임 모드나 동기화 구현으로 분기하지 않습니다. |

개발자가 새 게임 명령을 추가할 때는 UI와 AI 모두 `GameSession.command(action)`에 제출합니다. SDK의 player-local sequence를 받은 뒤, Core가 결정한 실행 프레임에서 Adapter가 `StrategySim.queueCommand()`와 `step()`을 호출합니다. 입력 지연, 상대 틱 차이, 롤백과 복구를 게임 명령 처리에 다시 구현하지 않습니다.

`RallySimulationAdapter`는 `save / load / step / validateSnapshot` capability를 제공합니다. Core의 프레임 `t`는 게임의 step 이전 상태 `S[t]`이며, 그 입력으로 게임 틱 `t+1`을 실행합니다. 저장 대상은 `StateContract`가 선언한 전체 Authoritative 상태입니다. 렌더·캐시·AI 명령 예약은 Runtime 또는 Presentation이며, 새 타임라인에서 재생성합니다. 재실행 결과는 확정된 프레임부터 UI 효과와 리플레이에 한 번만 공개합니다.

전송은 `send(Uint8Array)`와 `subscribe(listener)` capability로 연결합니다. Nostr는 방 발견·RTC 협상에만 사용하고, 게임 입력·시계·해시·복구는 SDK의 `WebRTCTransport`가 실제 입력·제어 DataChannel로 전송합니다. 게임은 SDK의 바이너리 헤더나 내부 필드를 해석하지 않습니다.

게임은 이제 [bloom-gamekit](https://github.com/byh-playground/bloom-gamekit)의 고정 source/dist 커밋에서 가져온 분리 모듈을 사용합니다. `vendor/gamekit/provenance.json`이 파일별 SHA-256과 정확한 출처를 기록하며 빌드는 원본 배포 bytes의 무결성을 확인합니다. 기존의 변경 가능한 rollback-netcode Pages URL 직접 import 계약은 사용자 요청의 공통 모듈 마이그레이션과 단일 HTML 배포로 대체합니다. 기존 SDK의 예제·검증 자료·출처는 gamekit으로 이관하며, 이 게임의 고정 배포본은 별도 업그레이드 전까지 유지합니다. 모듈 로드 실패는 오류로 표시하며 CDN/다른 버전 fallback은 없습니다.

`rollback`, `deterministic`, `simloop`, `transport`의 조합이 기존 `GameSession` 실행 경로를 담당합니다. `interpolation`이 단위·투사체·깃발의 목표 보간을 소유하고 게임 어댑터는 식별자·TPS·불연속 정책만 제공합니다. `rendering.WebGLDevice`가 shader/program/buffer/texture 수명주기와 실제 GPU 제출을 소유합니다. 게임에는 아트 기하 생성, 지형 깊이, Fog 마스크, 알파 패스·스텐실 실루엣 및 최종 화면 흔들림 정책이 남습니다. `camera`는 안정 화면/월드 평면 변환, `input`은 포인터 capture·document fallback·취소·blur 정리를 담당합니다. `presentation-events`는 확정 효과 중복 제거, `hud`는 절대 고도 anchor, `debug-tools`는 오류 기록·리플레이 탐색 UI를 담당합니다.

Rally의 적응형 A*/공유 A*/Flow-field, 게임 규칙과 체크포인트 리플레이 포맷은 변경하지 않습니다. 공통 `playReplay`는 SDK의 연속 frame 파일을 위한 API이므로 기존 Rally의 독립 체크포인트·캠페인 저장 포맷을 억지로 변환하지 않습니다. 체크포인트 검증/복원은 게임 소유이고 공통 `ReplayTimeline`이 탐색 범위·재생 조작을 담당합니다.

배포 빌드는 검증한 모듈, 캠페인 JS, 아이콘과 manifest를 `_site/index.html`에 넣습니다. 실제 file://에서 HTTP/WebSocket과 외부 DNS를 차단하고 STUN/TURN 없이 같은 기기의 실제 RTC host 후보로 캠페인 시작·종료를 검사합니다. 이는 외부 네트워크 없는 단일 HTML 실행 검증이며 브라우저 전체 Network.offline 또는 네트워크 어댑터가 꺼진 상태의 RTC 시작 성공을 뜻하지 않습니다. 엄격한 Network.offline 진단 모드는 유지하며 해당 모드에서는 ICE 연결이 대기하는 것이 관측됐습니다. 소스 `index.html` 개발 실행은 HTTP 서버 및 vendor 디렉터리가 필요합니다. PWA 설치 주소는 기존 Pages 주소로 유지하며 멀티플레이는 여전히 네트워크가 필요합니다.
공통 createValueCodec의 기본 바이너리 코덱을 상태와 명령에 조합하고 Core에는 opaque bytes만 전달합니다. 선택 JSON 코덱은 비교·진단용입니다.

```text
index.html
  RallyNetcode                 고정 gamekit rollback/deterministic/simloop/transport 조합
  GameSession                  경기 Coordinator
  RallySimulationAdapter       게임 상태와 명령을 SDK 계약에 연결
  RallyStateCodec / CommandCodec
  StrategySim                  게임 규칙과 Authoritative State
scripts/netcode-qa-module.cjs   과거 HTML의 SDK 요청을 로컬 고정 모듈/명시적 후보로 응답 (외부 배포 의존 없음)
scripts/netcode-*-regression.cjs 집중 회귀 검사
scripts/netcode-ui-e2e.cjs      실제 UI·RTC·WebGL·종료·리플레이 검사
```

장기 개발 계약은 `index.html` 상단이 SSOT이며, 이 절은 사용 경로와 소스 위치를 안내합니다. 검증 범위와 미검증 항목은 실행물의 안정화 기록과 해당 PR에서 확인합니다.

## 개발 원칙

개발 중인 소스를 바로 `main`에 반영하지 않습니다.

별도의 환경에서 충분히 검증된 버전만 Stable 버전으로 승격하며, `main/index.html`은 항상 플레이 가능한 검증 완료 상태를 유지하는 것을 원칙으로 합니다.

공개 배포는 빌드가 생성한 `_site` 전체를 사용하며 게임 HTML, 캠페인, PWA manifest와 아이콘을 함께 배포합니다. 개발할 때는 빌드 없이 저장소 폴더를 정적 HTTP 서버로 제공해 실행할 수 있습니다(예: `python -m http.server 8000` 후 `http://localhost:8000/`). 이때 업데이트 표시는 개발 소스임을 나타냅니다. 개발 소스를 `file://`로 직접 열면 상대 ES module 보안 제한을 받습니다. 파일 하나로 실행하려면 빌드한 `_site/index.html`을 사용합니다.

## 커밋 메시지

### 작업 및 리뷰 흐름

저장소 변경은 항상 별도의 `codex/` 작업 브랜치에서 진행합니다. 수정과 필요한 검증을 마친 뒤 커밋·푸시하고, `main`을 대상으로 GitHub Pull Request(PR)를 생성하거나 기존 PR을 업데이트합니다.

작업 완료 기준은 사용자가 PR의 **Files changed**에서 변경 내용을 리뷰할 수 있는 상태입니다. PR 설명과 완료 응답에 검증 결과 및 미검증 항목을 명시하며, 사용자 리뷰와 명시적인 머지 지시 전에는 머지하지 않습니다. 검증되지 않은 개발 후보를 PR에 올리는 것은 Stable 승격을 의미하지 않습니다.

머지는 기본적으로 **작업 커밋을 하나로 squash한 뒤 Merge commit**을 만드는 방식입니다. `main`에는 통합 작업 커밋 하나와 별도의 머지 커밋이 남습니다. 머지 후 로컬 `main`을 동기화하고 해당 PR과 남아 있는 머지 완료 로컬 작업 브랜치를 정리합니다. 미반영 커밋이나 다른 worktree에서 사용 중인 브랜치는 보존하며, 원격 브랜치는 별도 지시 없이 삭제하지 않습니다.

커밋 메시지는 기본적으로 **한글**로 작성합니다.

기본 형식:

```text
[타입] 변경 내용 요약

- 변경 사항에 대한 간단한 설명
- 필요한 경우 추가 설명
```

예시:

```text
[bug-fix] 싱글 게임 시작 불가 버그 수정

- 게임 초기화 과정에서 발생하던 오류 수정
- 싱글 게임 정상 시작 확인
```

주요 타입:

```text
[feature]      기능 추가
[bug-fix]      버그 수정
[refactor]     코드 구조 개선 및 리팩터링
[performance]  성능 최적화
[ui]           UI/UX 개선
[balance]      게임 밸런스 조정
[network]      P2P 및 동기화 관련 변경
[docs]         문서 변경
[test]         테스트 및 검증 관련 변경
[chore]        기타 유지보수 작업
```

하나의 커밋에 여러 변경이 포함된 경우 가장 핵심적인 변경을 타입으로 사용합니다.

## 저장소

이 저장소는 BYH Playground의 게임 프로젝트 중 하나입니다.

RALLY FRONTIER의 **검증 완료 Stable 버전 및 GitHub Pages 배포 소스**를 이 저장소의 `main` 브랜치에서 관리합니다.

### URL·바이너리 통합 검증 (2026-10-03)

라이브러리 tests85/85와 실제 Edge 상태11/AI9/RTC 수명주기6 검사를 통과했습니다. 412px native NVIDIA WebGL의 Host/Guest 덱·건설·생산·전투·종료·replay 탐색을 확인했고 오류0, 종료/replay checksum 일치입니다. 실제 RTC depth5 롤백과 snapshot 복구, 손상 후보 거부를 확인했습니다. 렌더 arcHeight/drawRadius/visualTag는 권위 상태에서 제외하고 impactEventKind와 burstIndex로 표현을 재생성합니다. 명령14종은 허용 Authoritative 필드만 받습니다.

동일 상태/35tick 게임 결과를 JSON과 binary로 비교했습니다. 78/158유닛은126427→43675B,232165→75253B로 약65~68% 줄었습니다. 기존 중복 JSON 복사를 포함한 경로 대비 저장 median4.9→3.4ms/8.5→5.9ms, 복원4.8→3.9ms/6.8→6.2ms, step+save9.3→5.4ms/19.7→16.3ms였습니다. 중복복사를 제거한 JSON restore2.9/4.9ms는 binary3.9/6.2ms보다 빠릅니다. 고정 맵과 복제 유닛의 CPU 비교로 렌더·실제망·FPS 개선을 주장하지 않으며, 구조/입력이 같은 복원 상태와 게임 결과를 비교하고 포맷이 다른 byte hash는 비교하지 않습니다. 재현: QA_SDK_PATH를 후보 원본 모듈 경로로 명시하고 node scripts/netcode-codec-benchmark.cjs를 실행합니다. 공개 URL을 검증할 때는 QA_SDK_PATH를 설정하지 않습니다.

실제 모바일 기기, 다른 엔진 장시간 결정론, 서로 다른 외부 NAT의 두 기기는 미검증입니다. Stable로 승격하지 않았습니다.

최종 main36c29a5 통합·실제 공개 SDK URL 검사에서도 Host1220틱/af1574ea, Guest1361틱/27148070의 종료와 replay가 일치했습니다. 유닛 표시102case, 캠페인 모듈, startup, 상태11, 실제 RTC수명주기6 및 transport를 통과했습니다.

### 공통 실행·연결·진단 capability (2026-10-03)

GameSession은 공통 createLoop의 수동 pulse를 사용합니다. 시간 누적·pacing·따라잡기는 라이브러리가 소유하며 게임은 종료/로비/표현 callback만 조정합니다. 롤백은 과거 상태를 복원한 호출 안에서 원래 현재 틱까지 재실행하며 여러 pulse로 나누지 않습니다. snapshot 복구도 필요한 입력 이력이 준비되면 목표 틱까지 같은 호출에서 재실행합니다. 실행 시간이 12ms를 넘었다는 이유로 정상 틱을 미루던 작업 예산 검사는 제거했습니다. 경기 중 별도 heartbeat/silence timeout 판단과 임의 수신의 생존 연장은 제거하고 Core의 peer-interrupted/timeout/disconnected/resumed 이벤트 및 Transport 상태 capability를 사용합니다. 보류 중에도 poll은 계속하여 같은 Core의 재개와 snapshot 복구를 처리합니다.

동기화 진단 패널은 두 SDK 결과를 구분합니다. Session.metrics/status/getPeerState는 RTT·지터·입력 지연·prediction·hold/stall·rollback/resimulation·hash/recovery·송수신·이력 지표입니다. Synctest.metrics는 실제 확정 입력의 시작 구간 최대32틱을 저장·복원·재실행한 결과입니다. 자체 checksum/보정 카운터와 임계치 판정을 제거했으며 game perf/FPS와 경기 balance는 별도로 표시하는 게임 소유 계측입니다.

검사 버튼은 Core.exportSyncTestFrames의 제한된 prefix와 공통 runSyncTestAsync를 사용합니다. 실제 게임과 같은 StrategySim.createForMatch/RallySimulationAdapter를 별도 시뮬레이션에서 사용하며 캠페인·디버그 초기화도 공유합니다. 검사 틱 경계에서 SDK가 실행을 양보하고 검사 취소·세션 종료 시 shadow를 정리합니다. 각 검사 틱의 내부 재실행은 동기식이라 무거운 게임에는 부하가 남으며, 정상 게임에 매틱 진단을 자동 추가하지 않습니다. 검사 시간은 SDK가 필수 forward 상태 복원까지 측정한 실행 시간이고, 양보 대기 및 batch 준비/정리 시간은 제외합니다. 검사한 구간의 일치가 다른 엔진·모바일·NAT 환경의 결정론까지 증명하지 않습니다.

라이브러리96검사·strict TS·생성물 검사 및 actual RTC240tick을 통과했습니다. 랠리는 실제 RTC lifecycle7(깊이5 종료 rollback/recovery/replay, 공통 loop interruption→timeout→resumption), 상태11/AI9/transport를 통과했습니다. 412px WebGL의 Synctest32틱/177재실행 통과·고의불일치 최초바이트/해시 표시·검사 중 live progression/running·취소/종료·캠페인 runtime 보존·cleanup 오류 경합을 확인했습니다. 단일 synchronous live 검사 후보의 약1초 block/interruption 결과는 최종 PASS 근거에서 제외했습니다.

이전 공개 SDK5ee7b30와 native WebGL Host2022틱/72c36eab, Guest1178틱/1c7e9d1b 종료·replay 일치와 오류0을 확인했습니다. 정상 wall-clock 따라잡기는 pulse당 최대 3틱이며, 이는 롤백 재실행을 나누는 제한이 아닙니다. 초기 표시 뒤 Core clock/liveness를 시작하며 로비 heartbeat가 gameplay를 판정하지 않는 느린 시작 회귀도 통과했습니다. UI RTT badge는 Session.metrics의 현재 값을 읽습니다.

분할 제거 후보 SDK는 명시적 QA URL 라우팅으로 검증했습니다. 실제 RTC lifecycle 7개 시나리오에서 지연·손실에 의한 깊이 5 롤백이 한 poll 안에 기존 현재 틱 16까지 완료되고, 종료·복구·replay 상태가 일치했습니다. 통합 검사는 입력 손실·재정렬·손상 snapshot 거부 및 이력 순환 후 복구/replay 일치를 통과했습니다. 412×915 native WebGL UI에서 Host 1315틱/ca749c02, Guest 869틱/9a21fd81 종료와 replay가 일치했고 오류는 0개였습니다. UI 검사는 동기 재실행 중 상태 플래그 보완 직전 후보에서 수행했으며, 최종 플래그 보완 뒤 lifecycle·통합 검사를 다시 통과했습니다. 이 결과는 공개 배포 검증이나 독립적인 성능 비교를 의미하지 않습니다.

### PWA 설치 (2026-10-03)

기존 설치 버튼 DOM만 있고 manifest/아이콘/설치 이벤트 코드가 없어 공개 페이지가 no-manifest를 보고했습니다. 상대경로 manifest.webmanifest와192/512 PNG·180px Apple icon을 연결하고 beforeinstallprompt/appinstalled와 기존 설치/안내 버튼을 연결했습니다. manifest start_url/id/scope는 모두 저장소 경로를 기준으로 하며 standalone으로 실행합니다. 실제 프롬프트가 제공되면 설치 버튼을 표시하고 그 외에는 Chrome/Edge 또는 iOS Safari의 수동 설치 안내를 제공합니다. 브라우저 설치 이벤트는 사용 조건·기설치 여부·탐색 환경에 따라 달라집니다.

일반 persistent Edge profile의 CDP manifest/installability 오류0과 실제 beforeinstallprompt, 설치 버튼 노출, 안내 열기/닫기·프롬프트1회/취소·prompt 오류·appinstalled 숨김을 확인했습니다. 최초 incognito 진단의 in-incognito는 별도 환경 제한이며 사이트 원인은 no-manifest입니다. 실제 모바일 기기/iOS 및 OS 설치 완료까지 검증한 것으로 확대하지 않습니다. 서비스 워커와 오프라인 게임을 추가하지 않았으며 넷코드는 기존 원본 URL import를 유지합니다.

틱 진단은 허용시간(1000/TPS), 게임step EWMA 사용시간/사용률, 남은 틱 여유/여유율을 분리합니다. 싱글은 같은 프로세스의 두 세션 step을 합산합니다. 여유는 게임step만 뺀 추정치이며 Adapter 저장·Core·렌더 비용을 포함한 전체 CPU 여유가 아닙니다. 초과는 남은0과 초과ms로 표시하고 미측정 상태는 표본 수집 중으로 표시합니다.


### 건설 미리보기와 국소 내비게이션 갱신

건설 미리보기는 지형·간격·자원·시야만 검사하고 NavMesh를 만들지 않습니다. 일꾼 접근면과 도달 가능성은 BUILD가 실행되는 권위 시뮬레이션에서 검증합니다. 건물 장애물이 바뀌면 이전/새 확장 경계와 겹치는 1,024×1,024 월드 영역만 기하를 다시 만듭니다. 다른 타일의 셀·포털·이동용 노드·내부 연결 객체와 ID는 그대로 보존하고 변경 타일과 맞닿는 경계의 연결만 교체합니다. 공간 인덱스도 타일별로 유지합니다. 삭제한 메모리 슬롯은 재사용하며, 경로 동률은 슬롯 할당 순서 대신 타일·지역·포털의 정규 순서로 결정합니다. 통로 개폐가 먼 경로에도 영향을 주므로 연결 성분 판정과 목표 경로 캐시 무효화는 전체에 적용하되, 그래프 객체를 다시 생성하지 않습니다. 초기화·증분 갱신·롤백의 경로와 권위 상태가 같아야 합니다. 새 건물이 일꾼과 겹칠 때의 바깥 좌표 투영도 경로 그래프 없이 필요한 주변 기하만 조회하며, 기존 전체 메쉬 투영과 같은 고정소수점 결과를 유지합니다. 이번 실행 계약의 SIM_VERSION은186입니다.

`node scripts/local-navigation-regression.cjs`는 추가·이동·철거·재추가, 타일 모서리, 좁은 통로, 지상 잠복, 되감기 복원과 cold rebuild를 비교합니다. `node scripts/construction-latency-regression.cjs`는 고정 seed20261003에서 같은 위치5곳을400ms 간격의 실제 캔버스 클릭으로 건설합니다. 자원부족과 상대AI 건설을 배제한 명시적 테스트 fixture이며 두 실제 RTC 시뮬레이션을 유지합니다. `QA_MOBILE=1`은412×915 터치 입력으로 실행합니다. 미리보기 메쉬0회, 다섯 건물의 양쪽 생성, 접근 불가능한 건설의 권위 거절을 검사합니다.

PR32에서 미리보기와 기하 갱신을 개선한 뒤에도 전체 graph 재조립 비용이 남아 있어, PR34에서 연결 자료까지 국소 교체하도록 변경했습니다. 48회 건설·철거 뒤 먼 셀/포털/노드/연결 배열/각 edge의 identity와 슬롯 용량을 검사하고, 실제 게임160틱 실행 중10틱 간격으로 준비된 캐시와 주기적으로 초기화한 캐시의 권위 바이너리 상태가 같음을 확인합니다. 전체 connect 호출을 금지한 상태로 국소 갱신 검사가 통과해야 합니다. 시간 측정은 실제 캔버스5회 입력의 .qa/five-builds 산출물에 기록하며, graph.connect/nav.rebuild 비용과 보존·교체 개수를 구분합니다.


증분 연결 변경의 최종 A/B는 같은5좌표에400ms 간격으로 입력하고 마지막 입력 뒤4초까지 포함합니다(지연된 명령 실행을 빼지 않음). 로컬 Edge에서 양쪽10회 BUILD의 합계936→359ms, 최대165→45ms, 충돌 겹침 복구 최대178→6.6ms, 화면 갱신 최대간격575→183ms를 기록했습니다. 절대값은 실행 환경에 따라 달라지며 순간 지연이 완전히 없어졌다는 뜻은 아닙니다. 최종 건설 구간의 전체graph connect 호출은0회이고,10회 메쉬 갱신 모두 타일1개만 교체했습니다. 매 갱신에서 먼 셀1507개와 포털2834개, 노드8502개를 보존했습니다. 전역 component 판정과 목표 경로 필드 계산은 남습니다.

### 유닛별 탐색 정책과 건설 예약

`UnitDefinition.all[type].navigationPlanner`에서 `astar`, `shared-astar`, `flow-field`를 선택합니다. 설정이 없으면 `flow-field`, 일꾼의 기본 설정은 `shared-astar`입니다. 이동뿐 아니라 건설 일꾼 선정, 자원 선택, 도달 가능성 질의가 같은 정책을 사용합니다. 서로 다른 목표를 가진 일꾼이 목표마다 전체 역방향 경로장을 만드는 비용을 줄이고, 공통 목표로 이동하는 전투 유닛에는 기존 경로장을 유지합니다.

공유 A*는 목표·이동 반경·연결 성분이 같은, 이미 확정된 최적 경로의 다음 노드와 남은 비용을 재사용합니다. 첫 캐시 접점에서 탐색을 끝내지 않고 전체 비용이 최소인 경로를 확정한 뒤 공통 funnel을 적용합니다. 동률 경로도 일반 A*와 같아야 합니다. 건물 토폴로지가 바뀌면 해당 레이어의 공유 경로를 무효화하며 목표 16개, 목표당 노드 2,048개로 메모리를 제한합니다. 캐시 유무·퇴출·유닛 질의 순서가 게임 결과를 바꾸지 않는 순수 계산 캐시입니다. 자원 후보는 직선거리 하한 순서로 검사하고 정확한 경로 거리와 ID 동률 규칙으로 선택합니다.

GameSession의 실제 경기 시작 단계에서 시나리오 적용 후 현재 지상 유닛과 덱의 이동 반경 메쉬를 준비합니다. 같은 반경·건물 무시 조합은 공유하고 현재 유닛을 우선해 기존 상한 12개까지만 준비합니다. 경로장이나 A* 탐색 결과를 미리 만들지는 않습니다. 첫 건설·첫 생산 시 전체 메쉬를 처음 만드는 비용을 초기화로 옮기므로 시작 시간과 메모리 사용은 늘어납니다. 계산이 사라진 것으로 집계하지 않고 벤치마크의 `initializations`와 `preparationMs`에 별도로 기록합니다. Synctest용 임시 시뮬레이션 생성에는 이 사전 준비를 적용하지 않습니다.

건설 명령이 승인되면 비용을 먼저 차감하고 `constructionOrders`에 예약합니다. 예약 이미지는 일꾼이 도착할 때까지 유지되고 건설 위치의 중복 배치를 막지만 이동 장애물, 공격 대상, 시야, 보급, 완성 기술에는 포함되지 않습니다. 일꾼이 도착해야 같은 ID의 실제 건물이 생성되고 주변 내비게이션을 갱신합니다. 착공 전 취소 또는 착공 위치 무효화는 지불액 전액을 환불합니다. 착공 후 취소는 기존 50% 환불 규칙을 유지합니다. 예약도 스냅샷·롤백·리플레이의 권위 상태이며 AI는 지불한 비용을 중복 차감하거나 같은 건물을 중복 발주하지 않습니다.

`node scripts/worker-navigation-regression.cjs`는 독립 Dijkstra 비용, 세 정책 전환, 공유 경로 순서·상한·퇴출·토폴로지 변경, 실제 채집·건설 게임의 캐시 유무에 따른 상태 동등성을 검사합니다. 건설 성능 검사는 마지막 클릭 뒤 기본 20초까지 측정하고 양쪽 시뮬레이션의 실제 건물 5개 생성과 예약 소진을 요구하므로 착공 비용을 측정 밖으로 미룰 수 없습니다. `BUILD_SETTLE_MS`로 측정 시간을 지정할 수 있습니다.

최종 로컬 Edge A/B는 main `a0f2e23`와 변경 버전을 각각 2회, 동일 덱·방어 카드·seed·맵 hash3736933243·5좌표·400ms 입력 간격으로 번갈아 실행했습니다. AI 경기 명령은 첫 스냅샷부터 차단하고0건을 검증합니다. 아래는 마지막 입력 뒤 20초까지 포함한 평균이며 양쪽 RTC 시뮬레이션의 5개 실제 착공을 모두 확인했습니다. 중첩 계측 항목은 서로 더하지 않습니다.

| 항목 | 기존 | 변경 후 |
|---|---:|---:|
| 시뮬레이션 CPU 합계 | 1,988ms | 1,351ms |
| 단일 시뮬레이션 틱 최대 | 167ms | 50ms |
| BUILD 명령 CPU 합계 | 218ms | 98ms |
| 화면 갱신 최대 간격 | 317ms | 83ms |
| 화면 갱신 p95 간격 | 24.9ms | 16.7ms |

플레이 구간의 CPU는 약32%, 최대 화면 간격은 약74% 감소했습니다. 일꾼 경로장 호출은0이며 전투 유닛 경로장은 유지됩니다. 플레이 구간의 내비게이션 갱신12회 모두 국소 타일1개만 교체했고, 첫 사용의 전체 메쉬 생성은 플레이 구간에서 발생하지 않았습니다. 대신 시뮬레이션당 메쉬7개 준비에695~762ms가 초기화로 이동했습니다. 두 피어의 경기 초기화 합계는 약1.13→2.55초로 늘었습니다. 이는 로컬 PC의 특정 장면 측정이며 모바일 기기 전체에 대한 수치나 모든 순간 지연이 사라졌다는 주장은 아닙니다.

### 지상 탐색기 규모·지형·단건 비교 (2026-10-03)

일반 검병에 A*, 공유 A*, Flow-field를 적용했다. 게임 기본 정책은 일꾼 공유 A*, 일반 부대 Flow-field를 유지한다. CPU 프로파일러의 독점 시간이 아니라 동기 게임/질의 함수의 `performance.now()` 경과시간이며 GC·OS 스케줄링 영향이 포함된다.

맵은4200×4800, 출발·목표 위치·건물을 고정하고 일반 장애물과 고저차·경사로를 함께 늘렸다. 시작 고지(+1, 높이48)와 더 높은 +2 고지로 이어지는 경사로의 목표(높이75)를 사용한다. 중간/높음에는 저지(-1)도 포함한다. 모든 출발점 연결·직선 차단과 실제 경사 이동을 검사했다.

| 복잡도 | 일반 장애물 | 고지·저지 영역 | 경사로 | 경로 노드 | 방향 간선 |
|---|---:|---:|---:|---:|---:|
| 낮음 | 1 | 2 | 2 | 4,107 | 111,798 |
| 중간 | 15 | 4 | 6 | 6,324 | 180,972 |
| 높음 | 49 | 8 | 14 | 8,508 | 172,386 |

**전체 게임의 밀집 이동 부하 시험.** 아래는 한 시뮬레이션 틱 실행시간(ms), 각 조건2회 평균이다. i7-9750H / GTX1660Ti / Edge154 native WebGL에서 한 브라우저의 실제 두 RTC 피어가 각각 같은N기 게임을 계산했다. 같은 초기 권위 상태와10TPS에서 각 피어의 첫10틱을 정확히 처리한다. 간격30·검병 반경20.25이므로 초기 접촉 정리도 포함된 밀집 조건이다. 생산·AI는 정지하며 고정 시작 건물은 포함한다. 경로 질의만의 비교는 아래 별도 시험에서 분리한다.

| 복잡도 | 유닛 수 | 일반 A* | 공유 A* | Flow-field |
|---|---:|---:|---:|---:|
| 낮음 | 100 | 86.6 | 55.9 | 12.9 |
| 낮음 | 200 | 169.9 | 81.0 | 19.6 |
| 낮음 | 400 | 351.5 | 164.4 | 40.6 |
| 중간 | 100 | 357.1 | 200.4 | 14.7 |
| 중간 | 200 | 683.5 | 337.6 | 25.5 |
| 중간 | 400 | 1384.9 | 599.9 | 54.5 |
| 높음 | 100 | 477.8 | 320.5 | 23.6 |
| 높음 | 200 | 934.2 | 485.2 | 49.1 |
| 높음 | 400 | 1850.1 | 915.7 | 93.2 |

현재 구현의 공통 목표 이동에서는 Flow-field가 우세했다. 높음400기에서 일반 A*/공유 A*/Flow-field의 최대 rAF 콜백 간격은 각각 4137/2603/510ms였다. Flow도 93.2ms/틱으로 부담이 크다. 초기 겹침을 없앤 간격48.5의 높음400기 보조 시험1회도 각각 1839.6/665.7/81.4ms로 순위가 유지됐다. 이 보조1회는 위2회 평균에 섞지 않았다.

가까운 경사로 교전400기 별도2회 평균은 106.3/95.2/97.6ms였다. 이동 질의7044건(두 피어 합계)이 모두 직선 처리되어 탐색기 호출0이었다. 이 차이를 탐색 알고리즘 효과로 해석하지 않는다. 실제 타격·체력 감소와 세 정책의 같은 종료 체크섬을 확인했다.

54개 이동 실행에서 두 피어 및 동일 모드 반복의 종료 체크섬이 일치했고 A*/공유 A*도 같았다. 경로 실패0, 병력·체력 보존을 검사했다. Flow는9개 맵/규모 조합에서 경로 선택이 달랐다. 낮음100기의 각 정책은 라이브러리 Synctest10틱도 통과했다. 첫10틱은 초기 이동 구간이며 도착 완료·장기 전투 성능으로 일반화하지 않는다.

프레임은 rAF가 전달한 프레임 시작 타임스탬프 대신 **관측 콜백의 실제 시각**으로 계산한다. 마지막 긴 틱 뒤 콜백까지 포함하며 전체 경과시간과 구간 합계 오차5ms 미만을 검사한다. 상태 해시는 측정 종료 후 수집한다. 짧은 관측TPS는1틱 완료→10틱 완료 구간으로 catch-up 때문에 명목값을 넘을 수 있다. renderer 작업 시간은 CPU 제출 시간이며 GPU 완료시간은 아니다.

**단건과 조회 수 교차점.** 같은 맵·반경20.25에서 원거리/근거리, 같은 목표/서로 다른 목표, cold/warm을 분리했다. 원거리는 지도 횡단, 근거리는 직선거리271~450·표본 A* 실제 경로612~725의 고지 우회다. 네이티브 경기의 상태·그래프와 같은 독립 시뮬레이션을 만들고 원래 세션·렌더 콜백을 정리한 뒤 `nextPoint`만 측정한다. 메쉬 생성·캐시 비우기는 타이머 밖, 질의 중 할당·탐색은 타이머 안이다. JIT는 예열됐고 cold는 목표 관련 캐시가 비어 있다는 의미다. warm은 오직 같은N건을 바로 다시 조회한다.

총4104 cold/warm 쌍(8208 timed batch)을 실측했다. 작은 묶음은12회, 큰 묶음은3회, 근거리 교차점은12회로 재검사했다. 시작점은 동일한400개 풀의 공간 분산 순서이며 근거리 점은 질의 입력이므로 물리 유닛 배치를 뜻하지 않는다.

새 단건(cold) 중앙값(ms):

| 경로 | 복잡도 | 일반 A* | 공유 A* | Flow-field |
|---|---|---:|---:|---:|
| 근거리 | 낮음 | 0.40 | 0.40 | 4.60 |
| 근거리 | 중간 | 0.40 | 0.50 | 6.15 |
| 근거리 | 높음 | 0.40 | 0.45 | 6.35 |
| 원거리 | 낮음 | 1.55 | 1.40 | 6.15 |
| 원거리 | 중간 | 3.85 | 4.75 | 15.60 |
| 원거리 | 높음 | 4.60 | 4.85 | 9.50 |

새로운 **동일 목표** 조회 묶음에서 Flow가 더 낮은 중앙값을 보이기 시작한 인접 실측 구간:

| 경로 | 복잡도 | 일반 A* 대비 | 공유 A* 대비 |
|---|---|---:|---:|
| 원거리 | 낮음 | 6→8건 | 10→20건 |
| 원거리 | 중간 | 4→5건 | 5→6건 |
| 원거리 | 높음 | 2→3건 | 2→3건 |
| 근거리 | 낮음 | 30→40건 | 40→50건 |
| 근거리 | 중간 | 40→50건 | 60→80건 |
| 근거리 | 높음 | 40→50건 | 60→80건 |

경계는 보편적인 유닛 수 제한이 아니다. 같은 목표·이동 반경·토폴로지를 공유하고 실제 우회가 필요한 **조회 수**의 구간이다. 한 유닛도 여러 틱에 반복 조회하고 직선 이동은 세 탐색기를 모두 건너뛴다. 원거리 중간의 공유 A* 대비6건, 근거리 높음의 일반 A* 대비50건은 IQR이 겹친다. 각각8건·60건에서는 분포가 분리됐지만 통계적 유의성이나 이후 모든 값에 대한 보장은 아니다.

판단 기준은 새 단건·매번 다른 목표에 A*계열, 같은 목표의 작은 묶음에 공유 A*, 충분히 재사용되는 공통 목표에 Flow-field다. 이미 필드가 남아 있으면 단건에서도 Flow의 warm 중앙값이 가장 낮았다. 약0.1ms 타이머 해상도보다 작은0/0.05ms 값은 `<0.1ms`로 읽는다. 지형의 노드 수 외에 간선 밀도·목표 위치도 비용에 영향을 주므로 '높음'이 모든 지표에서 항상 느리지는 않는다.

현재 반경층별 목표 캐시는 필드48개, 공유 A*16개(FIFO)다. 중간 맵의 서로 다른 목표를 순서대로 재조회하면 필드는48건 warm0.9ms→49건276.1ms(49개 재생성), 같은 조건 일반 A*는7.0→7.3ms였다. 같은 목표400기는 필드1개를 공유한다. 이 결과는 목표 작업 집합·조회 순서의 효과이며 자동 정책 전환은 추가하지 않는다.

모든 timed batch의 cold/warm 및 A*/공유 A* waypoint 해시가 일치하고 경로 실패·직선 우회·타이머 안 메쉬 생성이0이었다. fresh/reset 동등성은 모드·패턴별5개 질의 표본6건으로 검사했다. 보고서는 전체 실행 수·반복·프레임 합계·피어 체크섬을 재검사하여 부분 결과를 완료로 게시하지 않는다.

자료: [이동27조건](benchmarks/ground-planners-20261003.json), [교전](benchmarks/ground-battle-20261003.json), [간격 확보 보조](benchmarks/ground-clear-20261003.json), [단건·교차점·IQR](benchmarks/ground-query-20261003.json).

Playwright와 Edge가 준비된 환경에서 재현한다:

```sh
node scripts/ground-planner-benchmark.cjs --output .qa/ground-planners
node scripts/ground-planner-benchmark.cjs --scenario battle --counts 400 --complexities high --output .qa/ground-battle
node scripts/ground-planner-benchmark.cjs --formation clear --counts 400 --complexities high --runs 1 --output .qa/ground-clear
node scripts/ground-planner-benchmark.cjs --counts 100 --complexities low --runs 1 --synctest 1 --output .qa/ground-synctest
node scripts/report-ground-planner-benchmark.cjs .qa/ground-planners benchmarks/ground-planners-20261003.json
node scripts/ground-query-benchmark.cjs --distance far --counts 1,2,3,4,5,6,8,10,20,50,100,200,400 --output .qa/query-far
node scripts/ground-query-benchmark.cjs --distance near --counts 1,2,5,10,16,17,20,48,49,50,100,200,400 --output .qa/query-near
node scripts/ground-query-benchmark.cjs --distance near --patterns same --counts 20,30,40,50,60,80,100 --large-runs 12 --output .qa/query-near-refine
node scripts/report-ground-query-benchmark.cjs .qa/query-far/results.json .qa/query-near/results.json .qa/query-near-refine/results.json benchmarks/ground-query-20261003.json
```

### 적응형 길찾기와 소규모 지연 확인

이제 지상 유닛의 기본 `navigationPlanner`는 `adaptive`다. 직선으로 갈 수 있는 요청은 기존처럼 NavMesh를 건너뛰고, 막힌 실제 이동 요청만 목표·반경·건물 무시 여부·연결 성분으로 묶는다. 첫 요청은 A*, 같은 틱의 두 번째 요청부터는 shared A*를 사용하며, 원거리 요청 20개 또는 같은 목표 요청 80개가 확인된 목표군은 다음 틱부터 Flow-field를 사용한다. 승격된 목표군 목록은 권위 상태에 포함되므로 롤백·스냅샷·두 피어의 선택이 같다. 거리 계산·UI 조회·캐시 존재 여부·벽시계 시간은 집계에 참여하지 않는다. 건물의 통행 토폴로지가 바뀌면 승격 목록을 지운다. `astar`, `shared-astar`, `flow-field`를 유닛 Definition에 명시하면 적응형 선택을 사용하지 않는다.

이 경계는 CPU 예산 게이트가 아니라 2026-10-03의 동일 목표 조회 교차점에서 얻은 보수적 초기 보정값이다. 맵 간선 밀도와 목표 위치에 따라 달라지므로 모든 맵의 최적 경계라고 주장하지 않는다. 다음 시험으로 두 피어가 같은 체크섬을 내는지, 첫 틱의 승격 비용과 다음 틱의 steady-state 비용을 나누어 확인한다.

```sh
node scripts/ground-planner-benchmark.cjs --modes adaptive --counts 2,10,20,100 --complexities low,medium,high --runs 2 --output .qa/adaptive-planners
node scripts/worker-navigation-regression.cjs
node scripts/navigation-spatial-index-regression.cjs --benchmark
```

소수 유닛 지연은 길찾기만의 문제가 아니었다. 생산과 AI를 멈춘 검병 5기/피어의 실제 Edge/WebGL 시험에서 조용한 장면은 틱 약 3.70ms, `nextPoint` 합계 약 0.2ms였고, 명령으로 이동시킨 경우에도 경로 질의는 약 55.4ms/5초였다. 같은 시험에서 `NavigationObstacleIndex.query`는 주로 렌더 지형·Fog 샘플링 경로에서 약 562ms/5초를 차지했고, 상태 캡처도 약 422ms inclusive였다. 따라서 NavMesh 생성만 줄여서는 소수 유닛의 체감 지연을 설명할 수 없으며, 이번 변경은 공간 인덱스의 문자열 셀 키와 단일 셀 중복 검사를 제거하고 동일 렌더 높이 샘플을 한 번만 계산한다. 기존 반환 순서·체크섬·경계 판정은 회귀 스크립트로 비교한다.


### 공통 모듈 마이그레이션 검증

`npm ci`, `npx playwright install chromium`, `node scripts/build-pages.cjs` 후 `QA_BROWSER_CHANNEL=chromium QA_SOFTWARE_GPU=1 node scripts/netcode-ui-e2e.cjs _site/index.html`로 실제 게임 UI·RTC·WebGL·결과·리플레이를 검사합니다. `.github/workflows/gamekit-validation.yml`은 이 경로와 기존 회귀 검사를 실행합니다. 소프트웨어 GPU의 CPU/FPS 수치는 물리 GPU 성능으로 일반화하지 않습니다. 새 보간은 전체 scalar snapshot의 원자적 교체에 O(NF) 할당이 발생하고 GPU 모듈은 제출별 계약 검사를 수행하므로 동일 fixture A/B 결과를 확인하기 전 성능 개선을 주장하지 않습니다.


### 동기화 모드

고급 테스트 설정의 **동기화 모드**는 다음 경기부터 적용됩니다. 기본은 **락스텝**이며, 필요한 경우 같은 SDK의 **롤백**으로 바꿀 수 있습니다. 코드 기본값은 `CONFIG.netcode.mode` 한 곳에서 관리합니다. 진행 중인 경기의 설정은 고정되며, 온라인 양쪽이 서로 다른 모드를 선택하면 게임을 진행하지 않고 새로고침·설정 일치 안내를 표시합니다.

락스텝은 실제 입력이 모일 때까지 기다립니다. 매 틱 예측 상태를 실행하거나 롤백용 전체 상태를 저장하지 않습니다. 기존 RTS 입력 지연·페이싱은 유지하고, 20틱마다 체크섬용 복구 체크포인트를 보관합니다. 현재 상태 hash·SDK replay 요청에는 필요 시 현재 완료 경계의 정규 bytes를 저장합니다. 게임 replay 체크포인트·종료 상태·복구와 기존 저장 schema는 유지합니다. 선택한 TPS, 렌더·보간, 밸런스 및 아트는 변경하지 않습니다.

`netcode-integration-regression.cjs`는 기본 락스텝의 입력 지연·유실·역순·확정 명령·희소 체크포인트 복구를 검사합니다. `QA_NETCODE_MODE=rollback`으로 기존 지연 입력 롤백 검사를 명시적으로 실행합니다. `netcode-session-lifecycle-regression.cjs`는 반복 모드 전환, 설정 불일치, 두 모드의 종료 상태 복구를 포함합니다. `netcode-mode-benchmark.cjs`는 동일 seed·개체수·틱별 입력에서 실제 게임/어댑터/SDK의 snapshot 저장 횟수·bytes와 advance/step/save CPU 비용을 분리합니다. WebGL 값은 별도 CPU 제출시간이며 GPU 완료시간·기기 FPS가 아닙니다.

현재 CI 성능 job은 이번 모드 선택의 동일 입력 비교를 실행합니다. 이전 마이그레이션의 긴 `c6106ee6` 비교는 매 변경마다 반복하지 않으며, `game-performance-benchmark.cjs`와 기존 기록은 수동 역사 비교용으로 그대로 보존합니다. 기능·픽셀·실제 RTC 검증은 유지합니다.
