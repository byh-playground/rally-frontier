# RALLY FRONTIER

쌀·콩·팥 병력을 대포로 투입하고 거점을 건설·점령하는 브라우저 전략 게임입니다. 병력 투입과 진영 공통 발사 사거리 강화에 같은 자원을 사용합니다. 싱글은 AI와, 친구 대전은 실제 WebRTC P2P로 플레이하며 결과·리플레이를 확인할 수 있습니다.

[현재 배포본 실행](https://byh-playground.github.io/rally-frontier/)

## 버전과 배포 출처

| 식별자 | 원본과 의미 |
| --- | --- |
| 제품 SemVer | [`PRODUCT_VERSION`](src/core/product-version.js). 제품 변경의 호환성을 나타냅니다. 최초 기준선은 `0.1.0`이며 과거 제품 버전 이력을 추정하지 않습니다. |
| 시뮬레이션 호환성 | [`SIM_VERSION`](src/core/config.js). 동일 입력·상태·리플레이/통신 계약의 호환성 판정용 정수입니다. 제품 버전과 별개이며 기준선 도입 당시의 `209`를 제품 `0.209.0`으로 해석하지 않습니다. |
| 배포 출처 | `_site/build.json`의 Git 커밋·복사 시각·SDK 출처. 실행 모듈 bytes 일치 검증이나 제품 버전·Stable 승격의 증거가 아닙니다. |

제품 버전 판단은 [최신 공통 PM-001·PM-002](https://github.com/byh-playground/bloom-reference/blob/main/AGENTS.md)를 따릅니다. 제품 세대 전환은 MAJOR, 비호환 변경은 MINOR, 호환되는 의미 있는 기능·표현 수정은 PATCH입니다. 외부 동작이 같은 내부 정리와 문서 정리는 버전을 유지합니다. 하드코딩된 유닛·발사 수치 변경이 동일 입력의 결과나 과거 리플레이 해석을 바꾸면 호환되는 밸런스 수정으로 분류하지 않습니다. 제품 MINOR와 별도로 `SIM_VERSION` 변경 필요성을 판단합니다.

`0.1.0`은 기존 SemVer가 없던 제품의 첫 기준선입니다. 도입·규칙 문서 정리 자체로 게임 호환 정수를 올리지 않으며 정식 출시나 Stable 승격을 선언하지 않습니다. 고정 SDK의 버전·source/dist 커밋·해시는 [`gamekit.lock.json`](gamekit.lock.json)이 관리합니다.

`main` 푸시는 Pages 배포와 Nightly 태그 생성을 유발합니다. Stable은 PM-005에 따라 검증·승인한 커밋을 [release-tags 워크플로](.github/workflows/release-tags.yml)에서 명시 승격한 불변 태그입니다. 제품 버전·빌드 성공·배포 시각·게임 검증·Stable을 서로 구별합니다.

## 현재 플레이

- 쌀은 5갈래 산탄, 콩은 단발 중심 강타, 팥은 같은 지점에 3연사로 병력을 보냅니다. 전장을 길게 눌러 거리를 조절하고 놓으면 발사하며, 너무 오래 누르면 과열됩니다.
- 기본 인컴은 초당 3원이며 완성한 점령지마다 초당 1원이 더해집니다. 진영 공통 최대 발사 거리는 쌀 기준 500→1,000→1,500, 강화 비용은 50원·75원입니다. 콩 85%·팥 75% 비율을 적용합니다. 완성한 아군 대포의 원은 선택 병종의 최대 발사 거리입니다.
- 중립 거점에 진입하면 체력 10%로 공사를 시작합니다. 거점은 75원·375작업이 필요하고 일반 유닛은 1초마다 몸통 박치기로 1작업을 더합니다. 비용·필요 작업량·타격당 작업량은 독립 설정입니다. 전체 작업 진행률·투입 자원과 다음 정수 지출까지의 5칸을 구분해 표시합니다.
- 누적 지출은 `floor(cost * workDone / workRequired)`입니다. 기본 거점은 첫 4작업까지 추가 지출이 없고 5작업마다 1원이 듭니다. 다른 설정도 같은 비례 계산을 사용하며 자원이 허용하는 정수 작업까지만 반영합니다. 여러 작업자는 각자 기여하고 최종 적중은 남은 작업까지만 처리합니다.
- 작업자가 이탈·사망하거나 교전·공중 이동·충격 회복 중이면 기여하지 않습니다. 누적 공사와 피해는 보존되며 파괴된 투자금은 환불하지 않습니다. 완공하면 소유·인컴·발사와 사거리 250의 단일 기본 공격(피해 10/초)이 활성화됩니다.

조작 설명은 인게임 도움말, 실제 수치는 [`LaunchRules`](src/sim/launch-rules.js)·[`ConstructionRules`](src/sim/construction-rules.js)·[`Definition`](src/definitions/)이 원본입니다.

## 원본과 실행

```text
index.html                 브라우저 ESM 진입점·UI·프로젝트 개발 계약
src/main.js                화면·입력·실제 WebGL renderer
src/core/                  제품 버전·호환 식별자·SDK 로딩·배포 정보
src/definitions/           유닛·건물·전투 수치
src/sim/                   권위 판정·지형·이동·충격·건설
src/session/               경기·명령·리플레이 조정
src/render/                공통 표시 track·곡물 방출·분할 대포 아트
assets/units/              원본 SVG·크기와 SHA-256 manifest
scripts/                   SDK 준비·원본 복사·고정 시나리오 검사
legacy/                    현재 실행·배포에서 제외한 과거 코드 보관소
```

저장소를 정적 HTTP 서버로 제공하면 빌드 없이 실행할 수 있습니다. 예: `python -m http.server 8000` 후 `http://localhost:8000/`. `file://` 실행이나 단일 HTML 오프라인 실행을 보장하지 않습니다. 최초 제품 부팅은 lock으로 고정한 CDN에 접속합니다.

`npm ci`와 `npm run setup:gamekit`은 Node 22 이상에서 QA 의존성과 검증한 SDK cache를 준비합니다. `setup:gamekit`은 불변 dist·manifest·사용 모듈의 SHA-256을 검사하고 Git 제외 `.cache/gamekit/`에 원본 bytes를 저장합니다. 정상 cache는 재사용합니다.

`npm run build`와 [Pages 워크플로](.github/workflows/pages.yml)는 같은 원본 검사·복사 도구를 사용합니다. 실행 원본과 원본 자산을 `_site/`로 복사하며 SDK를 번들링하거나 소스를 재작성하지 않습니다. 실제 복사 목록은 [`build-pages.cjs`](scripts/build-pages.cjs)가 소유합니다. 검사·복사에 실패하면 이전 `_site`를 새 결과로 오인하지 않도록 제거합니다.

화면의 배포 기록은 `build.json`을 페이지당 한 번, `cache: no-store`·3초 제한으로 읽습니다. 조회는 게임 시작을 막지 않으며 `pending`·`available`·`unavailable`을 구분합니다. 기록이 없거나 실패했다고 공개 게임을 미배포 개발본이라고 판단하지 않습니다. 제품 버전은 로딩한 원본 `PRODUCT_VERSION`을 유지하며, 배포 기록의 제품 버전이 일치하지 않으면 그 기록을 `unavailable`로 판정합니다. 초기 SDK 실패 진단에도 조회가 끝난 배포 정보를 반영합니다.

## 판정·표현·네트워크 경계

프로젝트 고유 계약은 [`index.html` 상단](index.html)에 둡니다. `StrategySim`·`StateContract`가 판정·저장·복원·체크섬을 소유하고, UI·렌더·캐시는 판정을 바꾸지 않습니다. 건설의 인스턴스 설정·작업 단계, 충격 운동과 방출 대기열, 진영별 사거리 레벨도 저장·복원합니다.

`UnitMotion.applyImpulse`는 `Δv=J/mass`를 기존 속도에 누적합니다. 실제 접촉 시각에서 법선·역질량으로 속도를 처리하고 남은 시간도 적분합니다. 목표 좌표로 밀어내거나 기존 외력을 덮지 않습니다. 공간이 막힌 병력 방출은 안전한 자리가 생길 때까지 보존합니다. 공통 박치기와 목재 틀·묶음 파편은 권위 상태/사건을 읽는 표현입니다.

SVG는 원본 manifest의 SHA-256 검증 후 고정 GameKit 로더가 시작 시 한 번 컴파일하고 cache를 재사용합니다. 프레임마다 SVG를 읽거나 생성된 메시를 배포하지 않습니다. 공통 표시 시계가 위치·높이·생성/제거·VFX endpoint를 샘플링하며 실제 판정 좌표는 유지합니다.

`GameSession`은 SDK의 Core·게임 Adapter·Transport를 조합합니다. 명령은 UI와 AI 모두 `GameSession.command(action)`에 제출하고, Core가 player-local sequence의 확정 입력을 게임 틱에 적용합니다. Core frame `t`는 step 이전 상태 `S[t]`입니다. 게임이 입력 지연·롤백·해시·복구를 다시 구현하지 않습니다.

기본 netcode는 lockstep이며 `?netcode=lockstep|rollback`은 다음 경기의 모드를 고릅니다. 온라인 양쪽의 설정 불일치는 HELLO에서 거부합니다. Nostr는 발견·협상, gameplay는 실제 RTCDataChannel의 바이너리입니다. 별도 게임 서버나 TURN fallback은 없습니다. 싱글도 같은 실제 WebRTC·Session을 쓰며 AI 세션은 Worker에서 실행합니다. 양쪽 세션 관찰용 UI 검사는 in-page AI를 사용하고 Worker 경로는 별도로 검증합니다.

## 검증과 개발

공통 완료·검증·PR 규칙은 [AGENTS.md](AGENTS.md)와 [최신 BLOOM 규칙](https://github.com/byh-playground/bloom-reference/blob/main/AGENTS.md)을 따릅니다. 게임 동작·시각 변경은 실제 플레이 UI 경로와 렌더 관찰을 포함하고, 문서·메타데이터 변경은 해당 범위의 정합성을 검사합니다. PM-009의 실행당 180초, PM-014의 정합성 게이트를 지키며 성능·부하는 별도 명령·실행으로 측정합니다.

| 명령 | 확인 범위 |
| --- | --- |
| `npm run test:build` | SDK·원본 복사·검사 도구의 정합성 |
| `npm run build` | 원본 ESM과 자산 복사 |
| `npm run test:startup -- _site/index.html` | 원본 SVG·ESM 부팅과 배포 기록 |
| `QA_NETCODE_MODE=lockstep QA_ROLES=host npm run test:ui -- _site/index.html` | 실제 UI·RTC·전투·종료·리플레이 (`rollback` 모드도 선택 가능) |
| `npm run test:worker` | 원본 checkout의 실제 Worker AI 세션·복구 |
| `npm run test:economy -- _site/index.html` | 고정 시나리오의 건설·비례 지출·다음 지출 표시·인컴·사거리·포탑·저장 복원 |
| `npm run test:impact -- _site/index.html` | 고정 시나리오의 비행·충격·접촉·병력 방출·저장 복원 |

환경 변수 예시는 Bash 형식이며 PowerShell에서는 `$env:`로 지정합니다. UI 검사는 127.0.0.1에서 실제 ESM·CSS·SVG와 실제 게임 scope의 관찰자를 사용합니다. 고정 SDK URL만 검증한 cache bytes로 응답해 브라우저 hash 검사를 유지합니다. 이 결과는 CDN 가용성·외부 NAT 두 기기 연결·물리 모바일 GPU 성공을 보장하지 않습니다. 소프트웨어 GL과 실제 GPU, 고정 시나리오와 실제 플레이 결과를 구별해 기록합니다.
