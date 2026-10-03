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

게임은 [rollback-netcode](https://github.com/byh-playground/rollback-netcode)의 공개 계약을 사용합니다. `GameSession`은 경기의 로비·UI·수명주기를 조정하며, Core와 게임 Adapter, Transport를 **Has-a**로 소유합니다.

| 관계 | 구현과 사용 시나리오 |
| --- | --- |
| **Is-a** | `GameSession`은 경기 Coordinator, `StrategySim`은 게임 Simulation입니다. 둘을 Netcode 타입별로 상속하지 않습니다. |
| **Has-a** | Coordinator가 `RollbackSession`, `RallySimulationAdapter`, 전송 capability를 조합합니다. 온라인·싱글 WebRTC·LOCAL 2P가 같은 경로를 사용합니다. |
| **Can-be** | prediction·hold·resimulation·recovery는 Core의 실행 상태입니다. 별도 게임 모드나 동기화 구현으로 분기하지 않습니다. |

개발자가 새 게임 명령을 추가할 때는 UI와 AI 모두 `GameSession.command(action)`에 제출합니다. SDK의 player-local sequence를 받은 뒤, Core가 결정한 실행 프레임에서 Adapter가 `StrategySim.queueCommand()`와 `step()`을 호출합니다. 입력 지연, 상대 틱 차이, 롤백과 복구를 게임 명령 처리에 다시 구현하지 않습니다.

`RallySimulationAdapter`는 `save / load / step / validateSnapshot` capability를 제공합니다. Core의 프레임 `t`는 게임의 step 이전 상태 `S[t]`이며, 그 입력으로 게임 틱 `t+1`을 실행합니다. 저장 대상은 `StateContract`가 선언한 전체 Authoritative 상태입니다. 렌더·캐시·AI 명령 예약은 Runtime 또는 Presentation이며, 새 타임라인에서 재생성합니다. 재실행 결과는 확정된 프레임부터 UI 효과와 리플레이에 한 번만 공개합니다.

전송은 `send(Uint8Array)`와 `subscribe(listener)` capability로 연결합니다. Nostr는 방 발견·RTC 협상에만 사용하고, 게임 입력·시계·해시·복구는 SDK의 `WebRTCTransport`가 실제 입력·제어 DataChannel로 전송합니다. 게임은 SDK의 바이너리 헤더나 내부 필드를 해석하지 않습니다.

게임은 [GitHub Pages의 원본 단일 ES module](https://byh-playground.github.io/rollback-netcode/rollback-netcode.js)을 직접 import합니다. 필수 API 확인 후 초기화하며 로딩 실패나 미배포 API는 사용자에게 오류로 표시합니다. 내장 Core와 로컬 fallback은 없습니다. 이 URL은 버전 고정 URL이 아닙니다. 2026-10-03 라이브러리 PR #2 머지 후 실제 공개 URL에서 새 코덱 API와 초기화 성공을 확인했습니다. 존재하지 않는 versions URL이나 쿼리스트링을 버전 고정으로 사용하지 않습니다. 이후에도 필수 API가 없으면 게임 시작이 차단됩니다.

공통 createValueCodec의 기본 바이너리 코덱을 상태와 명령에 조합하고 Core에는 opaque bytes만 전달합니다. 선택 JSON 코덱은 비교·진단용입니다.

```text
index.html
  RallyNetcode                 공개 URL에서 직접 import한 공통 ES module
  GameSession                  경기 Coordinator
  RallySimulationAdapter       게임 상태와 명령을 SDK 계약에 연결
  RallyStateCodec / CommandCodec
  StrategySim                  게임 규칙과 Authoritative State
scripts/netcode-qa-module.cjs   검증용 후보 URL 응답 (제품 fallback 아님)
scripts/netcode-*-regression.cjs 집중 회귀 검사
scripts/netcode-ui-e2e.cjs      실제 UI·RTC·WebGL·종료·리플레이 검사
```

장기 개발 계약은 `index.html` 상단이 SSOT이며, 이 절은 사용 경로와 소스 위치를 안내합니다. 검증 범위와 미검증 항목은 실행물의 안정화 기록과 해당 PR에서 확인합니다.

## 개발 원칙

개발 중인 소스를 바로 `main`에 반영하지 않습니다.

별도의 환경에서 충분히 검증된 버전만 Stable 버전으로 승격하며, `main/index.html`은 항상 플레이 가능한 검증 완료 상태를 유지하는 것을 원칙으로 합니다.

공개 배포는 빌드가 생성한 `_site` 전체를 사용하며 게임 HTML, 캠페인, PWA manifest와 아이콘을 함께 배포합니다. 개발할 때는 빌드 없이 저장소 폴더를 정적 HTTP 서버로 제공해 실행할 수 있습니다(예: `python -m http.server 8000` 후 `http://localhost:8000/`). 이때 업데이트 표시는 개발 소스임을 나타냅니다. 브라우저의 native ES module 보안 정책 때문에 `file://`로 직접 연 파일에서는 정식 캠페인을 불러올 수 없습니다.

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

건설 미리보기는 지형·간격·자원·시야만 검사하고 NavMesh를 만들지 않습니다. 일꾼 접근면과 도달 가능성은 BUILD가 실행되는 권위 시뮬레이션에서 검증합니다. 건물 장애물이 바뀌면 이전/새 확장 경계와 겹치는 1,024×1,024 월드 영역만 기하를 다시 만듭니다. 다른 영역은 재사용하며, 통로 개폐가 먼 경로에도 영향을 주므로 연결 성분과 경로 필드는 갱신합니다. 타일 순서·문자열 건물 ID·포털 순서를 고정하고 동일한 포털 기하의 거리 연산을 재사용합니다. 초기화와 증분 갱신의 경로·권위 상태가 같아야 합니다. 새 포털 분할에 따라 경로 선택이 달라질 수 있어 SIM_VERSION을184로 올렸습니다.

`node scripts/local-navigation-regression.cjs`는 추가·이동·철거·재추가, 타일 모서리, 좁은 통로, 지상 잠복, 되감기 복원과 cold rebuild를 비교합니다. `node scripts/construction-latency-regression.cjs`는 고정 seed20261003에서 같은 위치5곳을400ms 간격의 실제 캔버스 클릭으로 건설합니다. 자원부족과 상대AI 건설을 배제한 명시적 테스트 fixture이며 두 실제 RTC 시뮬레이션을 유지합니다. `QA_MOBILE=1`은412×915 터치 입력으로 실행합니다. 미리보기 메쉬0회, 다섯 건물의 양쪽 생성, 접근 불가능한 건설의 권위 거절을 검사합니다.

동일 지도·동일5좌표의 로컬 Edge 측정에서 건설 구간 메쉬 기하 합계는1,206→103ms, BUILD 처리 합계는991→390ms, 미리보기 최대94→0.2ms였습니다. 화면 갱신 최대간격은317→242ms로 줄었지만 순간 지연이 완전히 없어졌다는 의미는 아닙니다. 양쪽 시뮬레이션과 미리보기 비용의 합이며 실행 환경에 따라 달라집니다. 타일 연결과 경로필드 계산은 남아 있고, 합성 지도와 실제 지도 비교 후 영역 크기를 선택했습니다. 상태·롤백·복구·리플레이·캠페인·경사로/하천 검사와 모바일5회 건설을 검증했습니다.
