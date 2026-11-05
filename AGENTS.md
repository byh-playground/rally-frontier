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
- 검증은 변경 범위에 맞춰 AI-013~AI-017·PM-009·PM-010·PM-014를 적용한다. 게임 동작·화면 변경은 실제 UI E2E와 실제 렌더 관찰을 정적 검사로 대체하지 않는다. 문서만 바꾸는 작업에 매번 한 판 플레이를 강제하지 않는다. 성능 작업은 AI-019의 레퍼런스·기존 기록을 먼저 읽고 별도 실행으로 측정한다.

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
