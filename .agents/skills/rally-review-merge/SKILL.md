---
name: rally-review-merge
description: Review and merge GitHub pull requests for the rally-frontier project when the user asks for PR review, review then merge, or merging an identified PR. Merge only when the user explicitly instructs it.
---

# RALLY FRONTIER PR 리뷰·머지

이 프로젝트에서 “PR 리뷰해줘”, “리뷰하고 문제 없으면 머지해줘”, “이 PR 머지해줘”를 처리한다. 저장소는 `byh-playground/rally-frontier`이며 기본 대상 브랜치는 `main`이다. 실행 전에 로컬 Git 원격과 PR의 실제 저장소·대상 브랜치를 확인한다.

## 요청과 대상

- 리뷰 요청만 있으면 리뷰 결과를 전달하고 머지하지 않는다.
- “머지해줘”는 해당 PR의 머지 실행과 머지 후 해당 작업의 로컬 브랜치 정리 권한이다. 이미 받은 명시적 지시를 다시 확인받지 않는다.
- “내가 머지할게”는 사용자가 직접 수행한다는 의미다. “머지함”은 상태 확인과 로컬 동기화 요청으로 처리한다.
- PR 번호/링크가 있으면 그것을 사용한다. 없으면 현재 대화에서 다루는 열린 PR 또는 현재 브랜치의 PR을 확인한다. 대상이 여러 개여서 특정할 수 없을 때만 질문한다.
- “리뷰하고 문제 없으면 머지”는 리뷰와 필요한 검증 후 실행한다. 수정이 필요한 결함 또는 결과를 판단할 수 없는 중요한 미검증 항목이 있으면 머지하지 않고 구체적으로 보고한다. 이미 리뷰한 PR의 단순 머지 요청에는 전체 검증을 불필요하게 반복하지 않는다.

## 리뷰

1. `gh pr view <번호> --repo byh-playground/rally-frontier --json state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url`로 현재 상태와 head SHA를 확인한다.
2. 변경 내용을 읽고 프로젝트 `AGENTS.md`, README의 Stable 정책, `index.html` 상단 Development Contract에 따라 정확성·회귀와 검증 범위를 평가한다. 정적 검사만으로 실제 플레이 PASS를 주장하지 않는다.
3. GitHub diff가 크기 제한으로 표시되지 않으면 Git으로 해당 PR의 base/head를 가져와 로컬에서 diff를 확인한다. 사용자에게도 로컬 리뷰 패널 등 실제 전체 diff를 볼 수 있는 경로를 제공한다. PR이 존재한다는 이유만으로 리뷰 가능하다고 보고하지 않는다.
4. 발견 사항은 파일·줄·재현 조건과 함께 이 대화에 정리한다. GitHub 리뷰/댓글 게시 요청이 없다면 대화에서 보고한다. 결함 없음과 미검증 항목을 구분한다.

## 머지

- PR이 이미 머지됐으면 중복 요청하지 않고 결과와 로컬 상태를 확인한다. 닫힌 PR을 임의로 다시 열지 않는다.
- 충돌, Draft, 실패하거나 진행 중인 필수 검사, 브랜치 보호 차단을 우회하지 않는다. 상태가 UNKNOWN이면 한 번 재조회하고 여전히 불명확하면 원인을 보고한다.
- 기본 방식은 **작업 커밋을 하나로 squash한 뒤 Merge commit**이다. main에는 통합 작업 커밋 하나와 두 부모를 가진 머지 커밋이 남도록 한다. GitHub의 `gh pr merge --squash`는 별도의 머지 커밋을 만들지 않으므로 이 기본 흐름을 대체하지 못한다. 사용자가 해당 PR에 다른 방식을 명시하면 따른다. Merge commit이 금지돼 있으면 차단 이유를 보고한다.
- 사용자의 머지 지시에는 해당 PR 작업 커밋의 squash도 포함된다. 여러 커밋이면 최신 base/head를 fetch하고 검토한 원본 head SHA를 기록한다. 깨끗한 임시 브랜치 또는 worktree에서 base를 시작점으로 `git merge --squash <원본-head>`를 실행해 한글 메시지의 통합 커밋 하나를 만든다. 원본 head와 통합 커밋의 tree가 같은지 확인한다. base 변경 때문에 tree가 달라지면 그 차이를 검토하고 필요한 검증을 수행한 뒤 계속한다.
- PR head 갱신 직전에 서버 head가 기록한 SHA와 같은지 다시 확인한다. 해당 PR head 브랜치에만 `git push --force-with-lease=refs/heads/<headRefName>:<원본-head-SHA> origin <통합-커밋-SHA>:refs/heads/<headRefName>`으로 갱신한다. 이 제한된 squash 갱신 외 강제 푸시는 금지한다. lease 실패 시 다른 변경을 덮어쓰지 않는다. 원본 head를 복구할 수 있도록 로컬 참조를 유지하고, 미푸시 로컬 작업 커밋이나 다른 작업자의 진행 중 변경을 squash에 포함하지 않는다.
- head 갱신 후 새 SHA의 PR diff, 필수 검사, 승인 및 mergeability를 다시 확인한다. squash로 승인이 무효화되거나 검사가 진행 중이면 머지를 보류하고 이유를 보고한다. 통합 커밋이 이미 하나라면 불필요하게 재작성하지 않는다.
- 검토한 head SHA를 `--match-head-commit`에 지정해 실행한다:

  ```powershell
  gh pr merge <번호> --repo byh-playground/rally-frontier --merge --match-head-commit <검토한-SHA>
  ```

- head가 바뀌면 새 변경을 확인하기 전에는 머지하지 않는다. `--admin`, 보호 설정 변경, 자동 머지 예약, 원격 브랜치 삭제를 기본 흐름에 추가하지 않는다. `gh pr merge --delete-branch`는 원격까지 삭제하므로 사용하지 않는다.
- Codex 앱 머지 버튼의 일반 오류는 `gh`로 실제 PR 상태·권한·허용 방식·차단 조건을 확인한다. 명시적 머지 지시가 있으면 CLI로 실행하며, diff 크기만으로 머지 실패 원인을 단정하지 않는다.
- 실패 시 PR 상태를 다시 확인해 서버에서 실제 머지됐는지 확인한다. 여전히 열려 있으면 구체적인 오류와 남은 작업을 보고하고 무한 재시도하지 않는다.
- main 머지는 기존 GitHub Pages 설정에 따라 배포를 유발할 수 있다. 해당 결과를 설명하되 Pages 소스나 release 브랜치를 이 스킬에서 별도로 변경하지 않는다.

## 완료 및 로컬 브랜치 정리

`gh pr view`로 `state`, `mergedAt`, `mergeCommit`, `url`을 확인한 뒤 머지 성공을 보고한다. 로컬 작업 트리가 깨끗하면 `git fetch origin`, `git switch main`, `git pull --ff-only origin main`으로 동기화한다. 미커밋 변경이나 로컬 main 분기가 있으면 그대로 보존하고 동기화하지 못한 이유를 보고한다. reset, 자동 stash, 변경 삭제로 정리하지 않는다.

동기화 성공 후 해당 PR의 `headRefName`과 일치하는 로컬 작업 브랜치만 정리한다. main 또는 다른 작업의 브랜치를 삭제하지 않는다. `git worktree list --porcelain`로 다른 worktree에서 사용 중인지 확인하고, `git merge-base --is-ancestor <작업-브랜치> main`으로 로컬 tip까지 main에 포함되는지 확인한 뒤 `git branch -d <작업-브랜치>`로 삭제한다. 브랜치가 없으면 이미 정리된 것으로 처리한다. 로컬에 추가 커밋이 있거나 다른 worktree가 사용 중이면 브랜치를 보존하고 이유를 보고한다. `-D`로 강제 삭제하지 않는다. 이미 머지된 PR을 확인하는 경우에도 같은 절차를 적용한다.

squash 전 커밋을 가리키는 로컬 브랜치는 main의 조상이 아니므로 조상 검사만으로 미반영이라고 판단하지 않는다. 로컬 tip이 기록한 원본 head SHA와 같고, 원본 head와 통합 커밋의 tree가 같으며, 통합 커밋이 main에 포함되고 다른 worktree에서 사용하지 않는 경우에만 복구용 원본 head 참조를 남긴 뒤 해당 로컬 브랜치를 통합 커밋으로 갱신하고 `git branch -d`로 삭제한다. tree 차이나 추가 로컬 커밋이 있으면 보존한다. 이번 squash를 위해 만든 임시 브랜치/worktree도 검증 후 정리한다.

완료 응답에는 PR 링크, 리뷰/검증 결과, 머지 커밋, 로컬 동기화 및 브랜치 정리 결과를 간결하게 포함한다.
