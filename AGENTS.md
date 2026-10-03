# 작업 지침

작업 전에 [.agents/AGENTS.common.md](.agents/AGENTS.common.md)를 읽고 공통 운영 규칙을 적용한다. 아래는 RALLY FRONTIER 전용 설정이며, 공통 규칙의 프로젝트별 선택을 구체화한다.

<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT.
<!-- END AUTONOMY DIRECTIVE -->

## 프로젝트 설정

- 대상 저장소는 `byh-playground/rally-frontier`, 통합 브랜치와 PR 대상은 `main`이다.
- 작업 브랜치는 `codex/` 접두사를 사용하고 커밋 메시지는 한글로 작성한다.
- 게임 개발 방향과 품질·검증 기준은 `index.html` 상단 Development Contract를 따른다. 게임 변경의 실제 UI E2E와 시각 확인을 정적 검사만으로 대체하지 않는다. 미검증 게임 버전을 VALIDATED 또는 Stable로 표시하지 않는다.
- 단일 `index.html` 안의 병렬 작업은 수정 함수·Definition·상태 소유자·공통 mechanic과 호출 관계로 겹침을 판단한다.
- 머지 기본 방식은 작업 커밋을 하나로 squash한 뒤 Merge commit을 만드는 방식이다. `main`에 통합 작업 커밋 하나와 머지 커밋을 남긴다. 머지 후 로컬 `main`을 동기화하고 해당 PR 및 남아 있는 머지 완료 로컬 작업 브랜치를 정리한다. 미반영 변경과 다른 worktree에서 사용하는 브랜치는 보존한다. 세부 절차는 프로젝트 리뷰·머지 스킬을 따른다.
- 공개 배포 변경은 별도 사용자 지시에 따른다.

## 임시 프로젝트

- 이 프로젝트에서 파생한 실험·예제는 주 작업 폴더의 `.temp-projects/<프로젝트명>/`에서 관리한다. 시작 전에 `.temp-projects/README.md`가 있으면 읽고 공통 참조 저장소와 재사용 원칙을 확인한다.
- 임시 프로젝트의 소스·빌드·검사 도구·참조 라이브러리·실행 결과물을 해당 폴더에 모은다. 다운로드·시스템 임시 폴더를 개발 원본 위치로 쓰지 않으며, 단일 HTML 요청에는 그 폴더 안에 실행 파일 하나를 생성한다.
- `.temp-projects/` 전체는 Git에서 제외하고 강제로 추가하지 않는다. 임시 프로젝트 내용은 부모 저장소의 PR에 포함하지 않으며, 부모 저장소의 제외 규칙·운영 지침 변경만 별도 작업 브랜치와 PR로 관리한다.
- 독립적인 개발·배포가 필요해지면 해당 프로젝트 디렉터리를 별도 위치와 새 저장소로 분리한다. 분리 전에는 `.temp-projects/` 안에 중첩 Git 저장소를 만들지 않는다.

## 프로젝트 스킬

- 개선 인벤토리 등록, 관리 대화 운영, 개발 대화의 업무 배정·인계 요청에는 [.agents/skills/pr-task-manager/SKILL.md](.agents/skills/pr-task-manager/SKILL.md)를 읽고 적용한다. 스킬은 공통 절차를 제공하며 저장소 설정은 이 파일에서 읽는다.
- PR 리뷰·머지 요청에는 [.agents/skills/rally-review-merge/SKILL.md](.agents/skills/rally-review-merge/SKILL.md)를 읽고 적용한다.
- “머지해줘” 또는 “리뷰하고 문제 없으면 머지해줘”라는 명시적 지시가 있으면 해당 스킬로 처리하고 같은 머지에 대한 확인을 반복해서 요청하지 않는다.
