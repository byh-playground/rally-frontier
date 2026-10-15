# Physics controller comparison

These tools inject alternative unit-collision controllers into the real game for
QA. Production `index.html` does not import them. Game intentions, combat, terrain,
rendering and the public netcode Core remain the game's implementations. Results
and vendor dependencies stay in ignored `.qa/` folders. Current findings and work
status belong to [PR #46](https://github.com/byh-playground/rally-frontier/pull/46).

Install the pinned, experiment-only Matter 0.20.0 and Rapier 2D compat 0.21.0:

```powershell
node scripts/physics-controller-probe/setup.cjs
```

`original` runs the current controller. `matter-full-1`, `matter-full-6`,
`rapier-full-1`, and `rapier-full-6` replace unit collision with the engine's dynamic
body response, using one or six physical steps per game tick. Those are diagnostic
controls: they can change enemy pressure, collision response and tunneling.

`matter-guarded` and `rapier-guarded` replace allied Jacobi separation inside the
original eight outer iterations. Original initial enemy sweeps, per-iteration
enemy sweeps, terrain and SAP recovery remain. `-guarded-lite` additionally removes
unused Jacobi grid/accumulator preparation and stops when integer writeback no
longer changes any position. Matter lite uses one position iteration and no
velocity/constraint iterations; Rapier lite uses one solver iteration. Rapier's
guarded contact recovery is stiffened and its tolerance is set to 0.01 game units.
The game radius cap applies to each allied correction. This preserves the common
guard paths, not identical allied contact response; for example Matter positional
resolution does not honor the game's inverse-mass correction split.

Matter lite clears the pinned `body.positionImpulse` on projection-only calls to
avoid replaying a prior positional displacement after an external correction.
Matter's complete graph snapshot omits render settings and wall-clock elapsed
time. Rapier snapshots include native world bytes and handle metadata. Both are
included in QA authoritative snapshots/checksums, never dropped for a faster score.
Generated non-original HTML uses a distinct simulation version per controller.

Run small fixtures, actual 400-supply game steps and cold restore:

```powershell
node scripts/physics-controller-probe/benchmark.cjs --only original,matter-guarded-lite,rapier-guarded-lite
```

Run identical recorded controller inputs in both variant orders:

```powershell
node scripts/physics-controller-probe/benchmark.cjs --fixed-only --only original,matter-full-1,matter-full-6,rapier-full-1,rapier-full-6,matter-guarded-lite,rapier-guarded-lite
```

The circle-only recorded-input lab disables static terrain; actual game-loop and
RTC comparisons retain it. It records original movement/steering intentions and
measures exact-circle penetration outside the timing interval. A successful tool
exit means the experiment ran, not that every candidate passed. Inspect each
fixture's `accepted`/`failures` and dense-frame quality together with timings.

Run two independent Edge/WebRTC peers with the same variant on both sides:

```powershell
node scripts/physics-controller-probe/rtc-benchmark.cjs --variant rapier-guarded-lite --run physics-example-unique --duration 30000
node scripts/physics-controller-probe/ui-e2e.cjs
```

Use a fresh `--run` per repeat. Optional `--map` accepts a saved canonical map and
`--cases` accepts the roster JSON used by `target-refresh-rtc-benchmark.cjs`.
Keep performance runs serialized; do not run other browser benchmarks alongside
them. The UI test covers start, combat, a ground-click command, surrender and replay.
No controller is selected or deployed by these tools in the production game.
