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

## 프로젝트 스킬

- 개선 인벤토리 등록, 관리 대화 운영, 개발 대화의 업무 배정·인계 요청에는 [.agents/skills/pr-task-manager/SKILL.md](.agents/skills/pr-task-manager/SKILL.md)를 읽고 적용한다. 스킬은 공통 절차를 제공하며 저장소 설정은 이 파일에서 읽는다.
- PR 리뷰·머지 요청에는 [.agents/skills/rally-review-merge/SKILL.md](.agents/skills/rally-review-merge/SKILL.md)를 읽고 적용한다.
- “머지해줘” 또는 “리뷰하고 문제 없으면 머지해줘”라는 명시적 지시가 있으면 해당 스킬로 처리하고 같은 머지에 대한 확인을 반복해서 요청하지 않는다.
