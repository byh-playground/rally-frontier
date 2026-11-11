# 작업 지침

작업 전에 [최신 BLOOM 공통 규칙](https://raw.githubusercontent.com/byh-playground/bloom-reference/main/AGENTS.md) 전체와 [.agents/AGENTS.common.md](.agents/AGENTS.common.md)를 읽는다. 사용자 지시가 우선이며, 버전·검증·운영의 공통 정책은 최신 원본을 따른다. 아래는 그 정책 안에서 정하는 쌀콩팡! 전용 설정이다. 보고에는 적용하거나 위반한 AI-/DEV-/PM- 규칙 ID를 명시한다.

<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->

YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT.
<!-- END AUTONOMY DIRECTIVE -->

## 저장소와 개발 계약

- 저장소는 `byh-playground/rally-frontier`, 통합·PR 대상은 `main`, 작업 브랜치는 `codex/` 접두사다. 커밋 형식은 공통 PM-007을 따른다.
- 현재 제품은 쌀·콩·팥을 대포로 투입하고 거점을 건설·점령하는 게임이다. 제품 조작·수치는 인게임 도움말과 Definition, 프로젝트별 구조 계약은 `index.html` 상단 Development Contract가 담당한다. 실행 원본은 `index.html`·`src/`·원본 자산이며 배포용 번들을 만들지 않는다.
- 사용자 지시에 따라 게임 버전은 `src/core/product-version.js`의 SemVer `PRODUCT_VERSION` 한 곳을 SSOT로 사용한다. 화면·배포 기록·방 발견·세션·snapshot·리플레이의 게임 버전이 모두 이 원본을 직접 읽고 정확한 문자열 일치로 호환성을 판정한다. 별도 시뮬레이션 버전 정수나 동의어 상수를 만들지 않는다. `build.json`의 Git 커밋·복사 시각은 버전이 아닌 배포 출처다.
- 제품 세대 전환은 MAJOR, 비호환 변경은 MINOR, 호환되는 의미 있는 기능·표현 수정은 PATCH, 외부 동작이 같은 내부 정리·문서 정리는 버전을 유지한다. 하드코딩된 유닛·발사 수치 변경도 동일 입력의 시뮬레이션 결과나 과거 리플레이 해석을 바꾸면 호환 변경으로 간주하지 않는다. 그때는 게임 MINOR를 올려 모든 게임 호환 소비자에 같은 버전이 반영되게 한다.
- 최초 제품 버전 `0.1.0`은 기존 SemVer가 없던 저장소의 기준선이다. 과거 내부 카운터에서 제품 이력을 역산하지 않는다. `0.2.0`은 게임 규칙과 호환 계약의 비호환 변경, `0.3.0`은 방 발견 및 리플레이 식별자 변경을 반영한다. 버전 변경이 정식 출시나 Stable 승격을 뜻하지 않는다.
- **Area of Effect · 주변 범위 기본 반경** — 새 흡수·주변 범위 공격의 크기가 따로 지정되지 않았으면, 기본 카메라의 설계 가로 폭(`VIEW_W`)의 절반을 기준 반지름으로 보고 그 3분의 1을 월드 반경의 초안으로 쓴다. 확정한 수치는 해당 Definition에 두고 기기·뷰포트·줌과 독립적으로 적용한다.
- 검증은 변경 범위에 맞춰 AI-013~AI-017·PM-009·PM-010·PM-014를 적용한다. 게임 동작·화면 변경은 실제 UI E2E와 실제 렌더 관찰을 정적 검사로 대체하지 않는다. 문서만 바꾸는 작업에 매번 한 판 플레이를 강제하지 않는다. 성능 작업은 AI-019의 레퍼런스·기존 기록을 먼저 읽고 별도 실행으로 측정한다.
- CI의 PR 검사는 1~2초 수준의 문법·정적 검사만 수행한다. 단위·회귀·E2E 테스트와 성능 측정은 CI에 넣지 않으며, 필요한 사용자 시나리오 검증과 벤치마크는 담당자가 머지 전에 별도로 실행한다. 배포용 원본 준비는 main 반영 후 배포 작업에서 수행한다.

## 디버그 장면

- 검증·측정은 임시 스크립트에서 `StrategySim`을 만들어 유닛을 손으로 배치하지 않고 디버그 장면 주소를 쓴다. 같은 주소는 같은 틱에 같은 체크섬·같은 그림이라 작업 사이의 수치를 비교할 수 있다. 필요한 장면이 없으면 [src/debug-scenes.js](src/debug-scenes.js)에 추가하고 이 목록에 적는다. 영구 시험이 아니다(판정 없음, test 목록에 넣지 않음).
- 주소는 `?debug=1&scene=<이름>&tick=<N>&…`이다. GameKit `installDebugHost`가 `debug`·`scene`·`tick`만 읽고 나머지는 장면에 문자열로 넘기며, 잘못된 값은 대신 고치지 않고 실패한다. 장면은 카드 시연과 같은 [src/ui/sim-scene.js](src/ui/sim-scene.js) 경로(GameKit scenario + 경기 렌더러)로 돌고, 디버그 주소는 타이틀·경기 흐름과 저장(캠페인 진행·덱)을 열지 않는다.
- 장면: `melee`(`map`·`seed`·`units` 한쪽 수·`mix` 쉼표로 나눈 병종), `walnut-melee`(melee + `walnuts` 한쪽 호두 수), `march`(`map`·`seed`·`unit`·`count`, 본진 앞에서 적 본진으로 행군), `unit`(`map`·`seed`·`unit`·`count`·`x`·`y`, 선택 `enemy`·`enemyCount`, `outposts=1`이면 모든 점령 지점에 가까운 쪽의 완성된 거점, 상태의 `knockback`은 자폭·회전 공격에 처음 맞은 유닛별 충격 속도·띄움·최고 높이·이동 거리·비행 틱), `ai-match`(`map`·`seed`, 양쪽 경기 AI), `card`(`unit`, 카드 시연 그대로). `map`은 `standard`·`twin-gates`·`artillery-basin`. 카드 외 장면은 `fog=host|guest`로 그 진영의 안개를 그리고, 모든 장면은 `times=1`이면 틱별 시간 배열을 함께 낸다.
- `window.__bloomDebug.state()`는 틱·체크섬·진영별 유닛 수, 틱 시간(평균·p95·최대·최대 틱), 1초마다 1틱 표본의 단계별 시간(`stageMs`: 교전·표적 선택·충돌·충돌 풀이 등, 길찾기는 교전 안에 포함), 접촉 통계(예산 초과로 건너뛴 쌍 합·최대 등), 지금 겹친 유닛 쌍과 지형·건물에 반 단위 넘게 박힌 유닛 수(`overlap.embedded`)를 돌려준다. `march`는 행군 진척(`march`: 출발 방향 평균·선두 거리, 적 본진까지 가장 가까운 거리), `melee`·`walnut-melee`는 굴러가는 호두 수와 평균·최고 속도(`walnuts`)를 함께 낸다. `__bloomDebug.step(n)`은 정확히 n틱 진행한다. 표시는 가상 시계, 틱 시간은 실제 시계다.
- 실제 사례 주소:
    - 호두 난전(PR #327 재현 구성): `?debug=1&scene=walnut-melee&map=artillery-basin&seed=1&units=150&mix=rice,pea&walnuts=5&tick=300`
    - 호두 길찾기(가운데 바위벽): `?debug=1&scene=unit&map=twin-gates&seed=1&unit=walnut&count=1&x=1400&y=2900&tick=150`
    - 검은콩 앞쪽 대포 탑승: `?debug=1&scene=unit&map=artillery-basin&seed=1&unit=black-bean&count=6&x=1000&y=3200&outposts=1&tick=150`
    - 찹쌀 거점 포구 막기: `?debug=1&scene=unit&map=artillery-basin&seed=1&unit=sticky-rice&count=4&x=2800&y=1250&outposts=1&tick=60`
    - 감자 전진 대포: `?debug=1&scene=unit&map=artillery-basin&seed=1&unit=potato&count=3&x=1700&y=2600&enemy=rice&enemyCount=6&tick=120`
    - 양쪽 AI 대전: `?debug=1&scene=ai-match&map=standard&seed=7&tick=900`, 카드 시연: `?debug=1&scene=card&unit=walnut&tick=60`
- 명령줄: `node scripts/debug-scene.cjs "<주소의 debug=1& 뒤>" [--ticks N] [--capture out.png] [--compare <다른 worktree>] [--repeat N] [--gpu]`. 상태 JSON을 출력하고, `--compare`는 같은 주소를 다른 체크아웃(비교 대상에도 이 장면이 있어야 함)에서 돌려 체크섬·틱 시간·충돌 시간을 나란히 보인다(`--repeat`로 교대 반복). 기본은 SwiftShader라 같은 주소 캡처가 픽셀까지 같고, 타이밍·체감은 `--gpu`(ANGLE D3D11)로 본다.

## 그래픽 원본과 시안 검수

- **Sprite Sheet · SVG 우선** — 캐릭터·장비처럼 파츠를 조립하는 신규 게임 그래픽은 편집 가능한 도형과 경로로 그린 SVG 파츠 시트를 기본 원본으로 사용한다. 회화적 질감이나 복잡한 음영처럼 SVG로 원하는 표현을 만들기 어려우면 투명 PNG 이미지 파츠 시트를 사용하고 선택 이유를 PR에 적는다.
- **파츠 분리 · 공용 아틀라스** — 몸통·팔다리·표정·장비처럼 따로 움직이거나 교체할 요소는 독립 영역에 배치하고, 좌우에 같은 그림을 쓰면 파츠 하나를 재사용한다. 두 형식 모두 병종 스프라이트는 로딩 때 정해진 픽셀 크기로 준비해 기존 GPU 아틀라스와 포즈 애니메이션에 연결한다. 신규 병종 원본은 manifest의 파일 크기와 SHA-256으로 검증한다. [수박 SVG 파츠 시트](assets/sprites/watermelon/parts.svg)가 SVG 방식의 예다.
- **작업 중 목업 공유** — 기존 쌀콩팡! HTML Share 페이지에 분리 파츠 시트, 조립한 모습, 실제 표시 크기를 나란히 올리고 작업 중에 사용자에게 링크를 보낸다. 기존 아트 수정은 바뀐 부위를 같은 크기로 전후 비교한다. 요청받은 범위는 계속 진행하며 도착한 피드백을 반영하고, 실제 게임 렌더러에서 검증한 뒤 머지한다. 사용자가 반영 전 승인을 명시한 경우에만 해당 반영을 승인까지 보류한다.

## PR·머지·배포

- 브랜치·PR·검증 후 머지는 PM-006과 [.agents/skills/rally-review-merge/SKILL.md](.agents/skills/rally-review-merge/SKILL.md)를 따른다. 검증한 구현 PR은 별도 확인 없이 머지한다. 등록·푸시·리뷰만 요청한 경우나 사용자가 직접 머지하겠다고 한 경우는 그 범위를 지킨다.
- 이 저장소는 작업 커밋을 하나로 squash한 뒤 **Merge commit**으로 통합한다. 검증한 head SHA를 고정하고, 머지 후 로컬 `main` 동기화와 완료 브랜치 정리를 해당 스킬로 수행한다. 다른 담당자의 worktree와 미반영 변경은 보존한다.
- `main` 푸시는 Pages 배포와 Nightly 태그 생성을 유발한다. Stable은 PM-005에 따라 검증·승인한 커밋을 불변 태그로 명시 승격할 때만 만든다. 제품 버전·빌드 성공·배포 완료·검증 완료를 Stable과 동일시하지 않는다.
- 개선 항목 등록·관리·배정·인계 요청은 [.agents/skills/pr-task-manager/SKILL.md](.agents/skills/pr-task-manager/SKILL.md)를 적용한다. 같은 업무의 의도·담당·상태는 PR 본문 하나에서 관리한다.

## 보존하는 작업 공간

- `docs/handoff/`는 사용자 인계 자료이며 미추적 상태를 유지하고 커밋하지 않는다.
- `legacy/`는 실행·배포 대상이 아닌 과거 코드 보관소다. 그 안의 규칙·버전·테스트 설명을 현행 지침으로 적용하지 않는다. 옛 규칙 정리가 보관 코드 전체의 삭제 허가를 의미하지 않는다.
- 블룸 세계관의 새 작품·파생 실험은 주 작업 폴더의 `.temp-projects/<프로젝트명>/`에서 시작한다. `.temp-projects/README.md`가 있으면 먼저 읽고 참고 저장소·재사용 원칙을 확인한다. 원본·도구·실행 결과물을 해당 폴더에 모으고 중첩 Git 저장소를 만들지 않는다.
- `.temp-projects/`는 Git에서 제외하고 강제로 추가하지 않는다. 독립 개발·배포가 필요할 때 별도 저장소로 분리한다. 이 부모 저장소의 PR에는 실험 내용 대신 요청한 운영 설정 변경만 포함한다.
