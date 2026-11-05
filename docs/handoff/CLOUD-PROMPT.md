# 클라우드 인계 프롬프트 (전체를 복사해서 새 세션 첫 메시지로 붙여넣기)

```text
너는 byh-playground(사용자 dragonlake.bae)의 게임 레포 작업을 이어받는다. 모든 답변·커밋·PR 본문은 한국어. 이전 담당(Claude)이 로컬 PC에서 하던 일이고, 이 세션은 클라우드라 로컬 파일·ChatGPT·로컬 브라우저·메모리 폴더에는 접근할 수 없다. 아래에 "무엇이 GitHub에 올라와 있는지 / 올라오지 않아 새로 해야 하는지"를 구분해 두었다.

## 0. 먼저 할 것
1. 레포 3개를 받는다: byh-playground/rally-frontier, byh-playground/bloom-gamekit, byh-playground/budmori-io (add_repo가 필요하면 push 권한으로).
2. 각 레포의 AGENTS.md(와 CLAUDE.md)를 전부 읽고, bloom-reference 규칙도 읽는다: https://raw.githubusercontent.com/byh-playground/bloom-reference/main/AGENTS.md . 보고에서 규칙 ID(AI-/DEV-/PM-)를 인용한다. 성능 작업은 AI-019(레퍼런스 algorithms/index.html·성능 기록 먼저).
3. rally-frontier의 브랜치 handoff/cloud-resources 에 도구와 그림이 있다: docs/handoff/tools(검증 스크립트), docs/handoff/art(대포 그림). 이 브랜치는 main에 머지하지 않는다(참고용).

## 1. 사용자 기준 (메모리를 못 주는 대신 핵심만)
- 마인드: "이걸 당장 출시하려는 게 아니라 결국 해야 하는 일이다." 소비자 수·위험·당장 이득이 작다는 이유로 범위를 줄이거나 미루지 않는다. 대신 품질을 올린다.
- 모듈 우선, 소비자 코드의 단순함이 1순위. 게임은 미배포라 호환 래퍼·alias 없이 바로 바꿔도 된다.
- GameKit 모듈은 정책 없는 메커니즘. 게임 규칙·탐색 정책은 게임에 남긴다.
- 결정론 시뮬(Rally는 고정소수 FP=100, 정수 비용)은 이관 전후 결과가 비트 단위로 같아야 한다. 같으면 SIM_VERSION(현재 204)을 올리지 않는다. 다르면 이유를 설명하고 멈춰서 사용자에게 묻는다.
- 시각 변경은 같은 파라미터로 전후 캡처를 직접 눈으로 본 뒤에만 통과 보고(확인을 사용자에게 넘기지 않음). 숫자·종료 코드만으로 통과 금지.
- 영구 시험은 고정 사용자 시나리오 E2E만(부하·통계·성능 판정, 요청 없는 시험 추가 금지). 정밀 벤치는 하지 않고 경향만(전후 번갈아).
- 질문은 A/B 선택지(코드 as-is/to-be 첨부). 이미 확정된 방향을 뒤집는 안은 멈추고 묻는다.
- Git: 내 레포 요청은 커밋→푸시→PR→머지가 기본(되묻지 않음). 브랜치 codex/ 접두사. 커밋은 한국어 + [feature]/[refactor]/[bug-fix] 접두사, 끝에 Co-Authored-By 줄. PR 본문은 한국어로 의도/바뀐 것/검증/하지 않은 것·미검증(못 한 것은 정직하게), 끝에 "🤖 Generated with [Claude Code](https://claude.com/claude-code)". 머지는 CI 완료 뒤에만(gh pr checks N → gh pr merge N --merge --match-head-commit <sha>), 머지 뒤 로컬 main을 ff-only로 갱신.
- Rally 소스 다수가 CRLF. 줄 끝 보존. 파이썬 문자열 치환으로 메서드를 지울 때 "  }" 줄을 경계로 삼지 말 것(닫는 중괄호가 지워짐). 끝나면 node --input-type=module --check < 파일 로 확인.

## 2. 무엇이 GitHub에 올라와 있나 / 없나

### 올라와 있음 (그대로 이어서 하면 됨)
- rally-frontier main(4a09c68): GameKit 이관 geometry #121, spatial #122, transport #123, face #124 모두 머지·라이브 확인 완료. GameKit 핀 0.46.4.
- bloom-gamekit PR #216 (브랜치 codex/pathfield): pathfield 모듈(정수 비용 격자 거리장), CI 통과, 그러나 main과 충돌(main이 v0.46.7까지 감: tech-tree 0.46.6/0.46.7). 해야 할 일: fetch → rebase → 버전을 그 시점 main 최신 다음 번호로 재배치(예: 0.46.8) → 빌드 확인 → CI 통과 후 머지.
- bloom-gamekit PR #217 (브랜치 codex/gamekit-vision): vision 모듈(시야 격자), 상태 같음(충돌, 버전 재배치 필요). #216과 같은 파일(README 색인·버전·manifest류)을 건드려 서로 충돌하므로 하나 머지한 뒤 다른 하나를 rebase.
- budmori-io PR #530 (브랜치 codex/face-module): 얼굴 이관, CI 통과, main(0.67.57)과 충돌 → rebase + 버전 재배치.
- rally-frontier 브랜치 codex/gamekit-pathfield (PR 없음): Rally가 pathfield를 쓰도록 바꾼 커밋 1개(navigation-field.js 346줄→모듈 사용). 핀(gamekit.lock.json)은 로컬 빌드 임시값이었고 그 변경은 커밋되지 않았다. 지금 커밋된 핀은 0.46.4 그대로이므로 GameKit #216 머지 후 새 핀으로 올려야 빌드된다.
- rally-frontier 브랜치 codex/gamekit-vision (PR 없음): 시야 이관 작업 중간 저장 커밋([wip], 9파일, 미검증). 핀 파일 변경은 로컬 빌드 임시값이 섞여 있으니 GameKit #217 머지 후 다시 맞출 것. 먼저 diff를 읽고 의도를 확인할 것.
- budmori-io 브랜치 codex/spatial-module: face 커밋 위에 쌓인 spatial 이관 커밋 1개(PR 없음, 검증 미완). face PR #530을 먼저 머지·rebase한 뒤 이어서.

### 올라오지 않음 (여기부터는 새로 만들거나 사용자에게 받아야 함)
- 로컬 스크래치패드의 검증 스크립트 중 docs/handoff/tools에 없는 것(릴레이 복구 시험 reconnectcheck2/onlinecheck2·3, 캡처 스크립트 launchcap/vfxshot 등)은 없다. 필요하면 새로 만든다.
- 에이전트들이 로컬에서 돌린 검증 결과(해시·캡처)는 일부만 PR 본문에 있다. 이관 PR은 아래 검증을 이 세션에서 다시 해야 한다.
- 코드로 그린 1차 SVG 대포 시안은 폐기됐고 올라오지 않았다(art/round1-svg-A-discarded.png는 참고 이미지일 뿐).
- ChatGPT로 그림을 뽑는 작업은 사용자 계정의 로컬 Chrome이 필요해 클라우드에서 못 한다. 추가 그림은 사용자에게 프롬프트를 주고 이미지를 받는다.
- 로컬 메모리·교정 장부는 전달되지 않는다(위 1번 요약이 전부).
- 중단된 에이전트 3개의 작업트리에 커밋되지 않은 잔여 편집이 있을 수 있으나 올라오지 않았다(필요하면 해당 이관을 브랜치 기준으로 다시 확인).

## 3. 할 일 (순서대로)
A. GameKit PR #216, #217을 rebase·버전 재배치·CI 통과 확인·머지(위 2번). 머지 뒤 dist 브랜치의 새 커밋을 확인한다: git ls-remote origin dist, manifest는 git show origin/dist:manifest.json.
B. Rally 핀 올리기와 이관 검증·PR (codex/gamekit-pathfield, codex/gamekit-vision): 핀 갱신은 docs/handoff/tools/pinlock.cjs <repo> <distCommit> <sourceCommit> <manifest.json> [모듈명=파일], 그리고 scripts/setup-gamekit.cjs의 moduleFiles, src/core/gamekit.js의 RALLY_GAMEKIT_MODULES에 모듈을 추가, npm run setup:gamekit. 검증은 모두 이관 전후 동일해야 함: docs/handoff/tools/simhash.cjs <repo> 600 과 1500(결정론 시뮬 해시), terraindigest.cjs(지도 14시드 지형·접촉 해시), behave.cjs, vision은 진영별 가시 마스크 비교를 terraindigest를 본떠 추가, 장면 전후 캡처를 직접 눈으로 비교(모바일 390×844). npm run test:build, npm run build 뒤 test:startup, test:worker, test:ui(+롤백 모드). 시험이 흔들리면 단독 재실행으로 구분. 두 PR은 둘 다 src/sim을 바꾸니 하나씩 머지.
   (도구 스크립트는 playwright를 require한다: 레포에서 npm i 후 NODE_PATH 또는 상대 경로를 맞추고, 브라우저 채널은 클라우드에 맞게 chromium으로 바꾼다. 일부는 msedge 채널을 쓴다.)
C. budmori-io: PR #530(face) rebase·머지 → codex/spatial-module rebase(버전 재배치) → 검증(질의 결과 순서 전후 비교, 1000마리 규모 틱 시간 경향, main에서도 실패하는 core 시험은 기준선과 비교) → PR. 핀(gamekit-lock.json, distCommit 9c036d3으로 오래됨)을 최신으로 올리면 이미 쓰는 다른 모듈이 깨질 수 있으니 영향 확인. 유닛 상한은 500.
D. 대포(발사기) 그래픽 — 사용자 결정 대기. 그림은 handoff/cloud-resources의 docs/handoff/art에 있다: cannon-gpt-1-parts-sheet.png(곡물 스타일 부품 시트: 회전 받침, 수평 포신, 깃발, 섬광, 연기), cannon-gpt-2-8dir-turnaround.png(받침 + 포신 8방향 회전 프레임). 방식을 사용자에게 A/B로 묻는다: (A) 8방향 프레임을 스프라이트로 / (B) 그림을 보고 cradle(조준 회전)·barrel(반동)로 분리한 SVG를 다시 그려 회전. 사용자는 "그림 자체를 포신을 각도 조절할 수 있게 분리했어야지"라고 했으므로 (B) 가능성이 크지만 확정 아님. 새 아트는 초안 공유 → 스타일 승인 → 그다음 코드 연동 순서.
   인터페이스 계약: 파트 base→cradle(조준 회전, 피벗=포신 축)→barrel(반동), 소켓 muzzle·muzzle-dir·trunnion·ground, 클립 fire(약 260ms once)·idle(repeat), 진영색은 data-paint-region 3영역(파랑 #307af0/#91c7ff/#1f55b5, 빨강 #f04545/#ff9e99/#b32f2f). 곡물 에셋 형식은 rally-frontier의 assets/units/*.svg 와 manifest.json. 건물 그림은 새 파일(예: src/render/building-art.js)로, main.js의 BUILDING_VISUAL_RENDER_FNS 호출 자리에서 최소 변경으로 부른다. 새 그림은 기존 임시 도형(약 45px)보다 커서(약 80~90px) 선택 링·충돌 반경 확인, 대포 건물은 공용 토대·깃발 제거. 에셋을 추가하면 test:startup의 SVG 개수 하드코딩(현재 6)과 scripts/fixtures/vector-assets-geometry-fingerprints.json도 고친다.
E. 미착수 모듈화: StateContract(src/sim/components.js)와 리플레이 체크포인트(src/session/replay.js) — GameKit의 deterministic/replay/rollback과 겹치는지 먼저 확인. 릴레이 단절 복구 2/13 실패 원인 조사(GameKit transport createNostrRoom과 Rally src/net/rtc-transport.js; 실제 Nostr 릴레이 접근 가능할 때만). src/main.js(4833줄) 분리(동작 불변, 전후 캡처·해시로 증명).
F. 사용자 결정 필요(혼자 정하지 말 것): 발사 소리, 밸런스 초안(최대 100 기준 비용 25/50/50, 수입 3/s, 시작 50), 지도 생성의 광물·가스·중립 캠프 삭제(지우면 지도가 바뀜), 충돌 반경.

## 4. 보고 형식
한국어, 짧게. 만든 PR 링크, 검증한 것과 못 한 것, 사용자 결정이 필요한 것을 A/B로.
```
