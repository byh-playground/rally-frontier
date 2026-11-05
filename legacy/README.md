# legacy

이 폴더는 현재 게임의 실행·빌드·배포에서 제외한 과거 코드 보관소입니다. 하위 코드·문서의 규칙, 버전, 테스트 설명은 당시 기록이며 현행 지침이 아닙니다. 현재 작업에는 루트의 [AGENTS.md](../AGENTS.md), [README.md](../README.md), `index.html`의 Development Contract를 적용합니다.

과거 구현을 참고하기 위해 보존합니다. 옛 규칙 정리를 보관 코드의 일괄 삭제 허가로 해석하지 않으며, 보관·삭제 범위는 별도 작업에서 결정합니다. 실제 배포 복사 목록은 [빌드 도구](../scripts/build-pages.cjs)가 소유합니다.

| Folder | What it was | Replaced by |
| --- | --- | --- |
| `showcase/` | Auto-played intro (`?showcaseDemo=1`, `#/showcase`) driving the old start → role → draft flow. Its scenario module came from jsDelivr outside `gamekit.lock.json`. | Title → 대전 시작 goes straight into an AI match (`src/ui/launch-screens.js`). |
| `start-dialog/` | The old 게임 시작 dialog (draft/deck selection, single/create/join, advanced test settings) and the Host/Guest role dialog. | Title buttons; test-only settings come from the address (`src/ui/dev-query.js`, D-202). |
| `rts-sim/` | The old RTS: workers, minerals/gas, production buildings, research, spells, neutral camps, campaigns and 50+ unit types with their behaviors, mixins, AI policy, definitions, unit SVGs (`assets/units/`), the matching `main.js` renderer and the session validation. Kept for reusing unit logic. | The launch sim (`src/sim/strategy-sim.js`): grains only, cannons fire them, capture points spawn outposts. |
