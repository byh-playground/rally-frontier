# 작업 지침

- 기본적으로 포괄적인 단어가 아니라 의도를 표현하는 가장 좁고 구체적인 단어로 표현한다.

<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
YOU ARE AN AUTONOMOUS CODING AGENT. EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.
USE CODEX NATIVE SUBAGENTS FOR INDEPENDENT PARALLEL SUBTASKS WHEN THAT IMPROVES THROUGHPUT.
<!-- END AUTONOMY DIRECTIVE -->

## 작업 완료 기준

- 저장소 변경 작업은 항상 사용자가 GitHub Pull Request의 Files changed에서 변경 내용을 리뷰할 수 있는 상태로 완료한다.
- `main`에 직접 커밋하거나 푸시하지 않고 `codex/` 작업 브랜치를 사용한다.
- 수정 후 변경에 필요한 검증을 수행하고, 한글 커밋 메시지로 커밋한 뒤 작업 브랜치를 푸시한다.
- 해당 작업의 PR이 있으면 업데이트하고, 없으면 `main`을 대상으로 PR을 생성한다.
- PR 설명에는 변경 목적, 주요 변경 내용, 수행한 검증 및 미검증 항목을 명확히 적는다. 미검증 버전을 VALIDATED 또는 Stable로 표시하지 않는다.
- 완료 응답에는 PR 링크와 검증 결과를 제공한다. PR 생성이나 푸시가 실패하면 완료로 보고하지 않고 장애와 남은 작업을 알린다.
- 사용자의 명시적 머지 지시 없이 PR을 머지하지 않는다. 공개 배포 변경은 별도 사용자 지시에 따른다.
- 머지 기본 방식은 작업 커밋을 하나로 squash한 뒤 Merge commit을 만드는 방식이다. main에 통합 작업 커밋 하나와 머지 커밋을 남기고, 머지 후 로컬 main을 동기화한 뒤 해당 PR과 남아 있는 머지 완료 로컬 작업 브랜치를 정리한다. 세부 절차는 프로젝트 리뷰·머지 스킬을 따른다.
- 게임 개발 방향과 품질 기준은 `index.html` 상단 Development Contract를 따른다.

## 프로젝트 스킬

- PR 리뷰·머지 요청에는 [.agents/skills/rally-review-merge/SKILL.md](.agents/skills/rally-review-merge/SKILL.md)를 읽고 적용한다.
- “머지해줘” 또는 “리뷰하고 문제 없으면 머지해줘”라는 명시적 지시가 있으면 이 스킬로 처리하고, 같은 머지에 대한 확인을 반복해서 요청하지 않는다.
