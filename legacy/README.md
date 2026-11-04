# legacy

Code the launch game no longer reaches. Nothing here is imported, built or shipped
(`scripts/build-pages.cjs` copies only `index.html`, `src`, `assets`, `icons` and the manifests).

It is kept only so the parts can be looked up while the launch UI replaces them (D-196, D-197).
Delete a folder once nothing in the launch game needs to look at it.

| Folder | What it was | Replaced by |
| --- | --- | --- |
| `showcase/` | Auto-played intro (`?showcaseDemo=1`, `#/showcase`) driving the old start → role → draft flow. Its scenario module came from jsDelivr outside `gamekit.lock.json`. | Title → 대전 시작 goes straight into an AI match (`src/ui/launch-screens.js`). |
| `start-dialog/` | The old 게임 시작 dialog (draft/deck selection, single/create/join, advanced test settings) and the Host/Guest role dialog. | Title buttons; test-only settings come from the address (`src/ui/dev-query.js`, D-202). |
| `rts-sim/` | The old RTS: workers, minerals/gas, production buildings, research, spells, neutral camps, campaigns and 50+ unit types with their behaviors, mixins, AI policy, definitions, unit SVGs (`assets/units/`), the matching `main.js` renderer and the session validation. Kept for reusing unit logic. | The launch sim (`src/sim/strategy-sim.js`): grains only, cannons fire them, capture points spawn outposts. |
