# RALLY FRONTIER

호환 식별자 `SIM_VERSION`은 `src/main.js`에, 고정한 GameKit source/dist는 `gamekit.lock.json`에 있습니다. protocol이 같은 세션에 참여하는 모든 클라이언트는 같은 배포본을 써야 합니다. 게임 규칙·유닛 수치·조작법은 인게임 도움말이 원본입니다.

RALLY FRONTIER는 브라우저에서 바로 실행할 수 있는 실시간 전략 게임(RTS) 프로젝트입니다.

별도의 설치 없이 브라우저에서 실행할 수 있으며, WebRTC 기반 P2P 멀티플레이와 싱글 플레이를 지원합니다.


## 플레이

GitHub Pages로 현재 배포본(`main`의 Nightly)을 바로 실행할 수 있습니다. 불변 Stable 태그는 아래 배포 채널을 따릅니다.

**https://byh-playground.github.io/rally-frontier/**

## 배포 채널

* `main`에 푸시하면 Pages가 자동 배포하고 Nightly 태그가 만들어집니다. 이 상태가 곧 검증 완료나 Stable을 뜻하지 않습니다.
* Stable은 검증·승인한 커밋을 `.github/workflows/release-tags.yml`로 명시 승격할 때만 만들어지는 불변 태그입니다. 과거 태그는 옮기거나 지우지 않습니다.
* 빌드 성공이나 업데이트 시각 갱신이 게임 검증을 의미하지 않습니다. 실제 모바일 기기와 서로 다른 외부 NAT 사이의 두 기기 플레이는 정적 CI와 별도로 확인합니다.

## 업데이트 시각과 배포

`.github/workflows/pages.yml`과 `npm run build`는 동일한 원본 검사·복사 도구를 사용합니다. `index.html`·`src/`·`gamekit.lock.json`·`assets/`·`campaign/`·아이콘·manifest를 그대로 `_site/`에 복사하며 게임 소스와 `BUILD_ID`를 변경하지 않습니다. `_site/build.json`은 복사한 소스의 Git 커밋·복사 시각·고정 SDK 출처를 기록하는 별도 진단 정보입니다. 실행 화면의 업데이트/검증 상태와 별개이며, 검사 또는 복사 실패 시 이전 `_site`를 남겨 새 결과로 오인하지 않게 제거합니다.

PR에서는 검사·복사·원본 ESM/SVG 부팅 검사를 수행하고 공개 배포하지 않습니다. main 게시 경로는 기존 GitHub Actions Pages 정책을 유지합니다. 로컬 원본 확인은 `npm ci`, `npm run test:build`, `npm run build`, `npm run test:startup -- _site/index.html`, `npm run test:ui -- _site/index.html` 순서로 실행합니다. 원본 복사 명령 자체는 다운로드/SDK 번들링을 하지 않습니다. `test:build`, `test:startup`, `test:ui`는 최초에 `setup:gamekit`으로 불변 dist와 manifest의 SHA-256을 검증하며 정상 cache는 재사용합니다.

UI 검사는 127.0.0.1 HTTP 서버에서 실제 ESM·CSS·SVG·캠페인을 제공하고 `src/main.js`의 실제 app scope에 관찰자만 주입합니다. 게임 조작은 기존 UI를 통합니다. 재현 가능한 검사를 위해 게임의 정확한 고정 jsDelivr SDK URL만 검증한 cache bytes로 응답하며 브라우저의 SHA-256 검사는 그대로 실행합니다. 따라서 이 검사는 SDK CDN 가용성·외부 NAT·소개영상 CDN의 오프라인 실행을 보증하지 않습니다. 실제 제품 부팅은 계속 공식 CDN에 접속해야 하며 `file://` 또는 단일 HTML 오프라인 실행을 지원한다고 표시하지 않습니다.

## 프로젝트 구조

게임 엔진과 UI의 실행 코드는 `src/main.js`에, 공통 게임 규칙/메타데이터는 `src/core/`에, 스타일은 `src/styles/`에 두며, 현재 캠페인 데이터 전체는 `campaign/campaigns.js` 한 JavaScript 모듈에 둡니다.

유닛 벡터 아트의 원본은 `assets/units/*.svg`에 두고, `assets/units/manifest.json`에서 각 파일의 크기와 SHA-256을 고정합니다. 부팅 시 고정된 GameKit `vector-assets-loader.js`가 원본 bytes의 SHA-256을 확인한 뒤 한 번만 geometry를 만들고, loader의 bounded cache를 재사용합니다. source checkout과 Pages 복사본 모두 원본 manifest와 SVG 파일을 읽습니다. 이 경로는 프레임 렌더링 중 SVG를 다시 읽거나 변환하지 않습니다.

캠페인 메뉴를 열 때 native ES import로 데이터를 읽습니다. 기본 게임 부팅은 캠페인 모듈 로드에 의존하지 않으며, 각 미션은 자체 시작 상태를 선언합니다. 개발용 신뢰 Mission JS의 파일/URL Preview도 유지합니다.

덱 편집의 작업 사본·카드 변경·저장 결과는 `DeckBuilderState`가 소유합니다. `DeckPresentation`은 입력과 화면 표시를 조정하고, 저장 형식과 브라우저 저장소 접근은 기존 `DeckRecord`가 담당합니다.

```text
rally-frontier/
├── index.html             # 원본 ESM 진입점과 UI 마크업
├── src/                   # main.js, core/, styles/, 소개영상
├── gamekit.lock.json      # 공통 모듈의 고정 source/dist 커밋·SHA-256
├── assets/units/          # 원본 유닛 SVG와 크기·SHA-256 manifest
├── campaign/
│   └── campaigns.js       # 현재 정식 캠페인 데이터 전체 (default manifest)
├── scripts/setup-gamekit.cjs # 불변 dist 다운로드·무결성 검증
├── scripts/vector-assets-manifest.cjs # 원본 SVG 목록·무결성 검사
├── scripts/build-pages.cjs # 원본 검사·동일 bytes 복사·별도 출처 정보
├── .github/workflows/pages.yml # PR 빌드 검사 및 main Pages 배포
├── .cache/gamekit/        # setup이 가져온 원본 dist bytes (Git 제외)
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
* 원본 브라우저 ESM 엔진과 하나의 캠페인 데이터 모듈

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

공통 모듈 원본은 [bloom-gamekit](https://github.com/byh-playground/bloom-gamekit)에서만 관리합니다. Rally는 코드 복사본 대신 `gamekit.lock.json`에 source/dist의 전체 커밋 SHA와 manifest·사용 모듈별 SHA-256을 기록합니다. `npm run setup:gamekit`은 정확한 불변 dist 커밋의 `manifest.json`과 필요한 파일을 받아 모든 hash를 확인하고 Git 제외 `.cache/gamekit/`에 원본 bytes 그대로 저장합니다. QA는 같은 lock으로 cache를 다시 검증합니다. 새 checkout의 최초 QA setup에는 GitHub 접근이 필요하며, 검증한 cache가 있으면 QA의 게임 SDK 요청을 로컬 응답할 수 있습니다. 원본 복사는 SDK를 포함하지 않고, 실제 제품 부팅에는 고정 CDN 접근이 필요합니다. 업그레이드는 upstream dist 검증 후 lock을 변경하는 작업이고 Rally에서 모듈 사본을 수정하는 방식으로 하지 않습니다. 모듈 로드 실패는 오류로 표시하며 CDN/다른 버전 fallback은 없습니다.


`rollback`, `deterministic`, `simloop`, `transport`의 조합이 기존 `GameSession` 실행 경로를 담당합니다. `interpolation.PresentationRuntime`의 한 표시 프레임이 유닛·투사체·깃발의 위치와 생성·제거 시점을 샘플링합니다. 선택 TPS의 한 tick을 표시 버퍼로 사용하며 도약 높이·잔상과 추적 표적도 같은 모델을 읽습니다. 신규 투사체는 launchX/Y에서 첫 구간을 시작합니다. 게임은 도약 곡선·lockedPoint/trackingTarget 의미·식별자·스냅거리 정책을 소유합니다. 시야 판정은 권위 좌표를 유지합니다. `rendering.WebGLDevice`가 shader/program/buffer/texture 수명주기와 실제 GPU 제출을 소유합니다. 게임에는 아트 기하 생성, 지형 깊이, Fog 마스크, 알파 패스·스텐실 실루엣 및 최종 화면 흔들림 정책이 남습니다. `camera`는 안정 화면/월드 평면 변환, `input`은 포인터 capture·document fallback·취소·blur 정리를 담당합니다. `presentation-events`는 확정 효과 중복 제거, `hud`는 절대 고도 anchor, `debug-tools`는 오류 기록·리플레이 탐색 UI를 담당합니다.

공통 createValueCodec의 기본 바이너리 코덱을 상태와 명령에 조합하고 Core에는 opaque bytes만 전달합니다. 선택 JSON 코덱은 비교·진단용입니다.

```text
src/main.js
  RallyNetcode                 고정 gamekit rollback/deterministic/simloop/transport 조합
  GameSession                  경기 Coordinator
  RallySimulationAdapter       게임 상태와 명령을 SDK 계약에 연결
  RallyStateCodec / CommandCodec
  StrategySim                  게임 규칙과 Authoritative State
scripts/netcode-ui-e2e.cjs      실제 UI·RTC·WebGL·종료·리플레이 검사
scripts/netcode-qa-module.cjs   원본 ESM 서버와 고정 SDK 로컬 응답
```

## 개발 흐름

작업 순서, 브랜치·PR·머지, 커밋 메시지 형식은 [AGENTS.md](AGENTS.md)와 [공통 규칙](https://github.com/byh-playground/bloom-reference/blob/main/AGENTS.md)을 따릅니다. 이 문서에 규칙을 복제하지 않습니다.

개발할 때는 빌드 없이 저장소 폴더를 정적 HTTP 서버로 제공해 실행할 수 있습니다(예: `python -m http.server 8000` 후 `http://localhost:8000/`). 개발 소스를 `file://`로 직접 열면 상대 ES module 보안 제한을 받습니다. 복사한 `_site` 역시 같은 원본 ESM이므로 HTTP 서버가 필요합니다.

기존 실제 RTC UI 흐름은 `QA_NETCODE_MODE=lockstep|rollback QA_ROLES=host node scripts/netcode-ui-e2e.cjs _site/index.html`로 모드를 선택해 확인합니다(PowerShell에서는 `$env:`로 설정). 결과는 `.qa/netcode-ui-e2e-<mode>/`에 생성됩니다. 기본 모드는 lockstep입니다.
