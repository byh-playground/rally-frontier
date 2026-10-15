# SIM199 route recipe checkpoint

## Design

Runtime route geometry remains owned by StrategySim in routePathStore. A unit's serialized movement route stores a compact semantic recipe and its cursor, current leg, and retained flag. Runtime pathId and the decoded recipe are non-enumerable handles rebound or reconstructed after restore. Snapshots do not copy route point bodies, route profile/topology rows, path IDs, or the path ID allocator.

A joined route stores its local starting point and the root plan's acquisition inputs. During a live run, its local prefix points to a root path and offset; the joined suffix is read from that root without copying the suffix coordinates. Restore deterministically rematerializes the root and validates that the joined route resolves to the same recipe.

The recipe keeps the original plan origin, goal key, traversal radius, building-ignore policy, and selected planner. Goal-only storage is insufficient: goal 1800:1500:0:0:0:1 at radius 13.5 with A* and buildings enabled produced 10 waypoints from 900,1500 and 5 different waypoints from 900,2500. Repeating either origin reproduced its exact path. The origin is therefore part of the semantic checkpoint rather than an incidental cache detail.

## Functional evidence

- common-route-regression: 98 ticks; one initial A*; zero route requests, cache lookups, and whole-route scans during normal follow; three local segment checks; goal-change and deviation reacquisition and shared-route joins exercised.
- route-checkpoint-regression: 20 workers, 18 joined routes, two plan roots; 10-point root route with a one-point local prefix and nine-point shared suffix; checkpoint 17,366 bytes. Warm and cold save-load-save bytes matched; 18 further ticks had matching checksums. An unused 4,013-point runtime route did not change checkpoint size. Normal follow after restore made no acquisitions. Fourteen malformed or limit cases were rejected, including the 500,000-node codec budget.
- worker-route-reuse-regression: one- and two-worker cold restores matched continuous runs for 495 and 498 ticks respectively. Incomes were six and twelve; errors were empty.
- test:build: 32/32 passed on the candidate source.
- netcode-state-regression on the committed build: 11/11 passed, including exact save-load bytes and next-step equivalence at tick 50, atomic rejection of 17 malformed snapshots, same-tick rollback navigation epoch reset, and procedural-map rollback with exact bytes. Page errors were empty.
- netcode-ui-e2e on the committed build: both host and guest completed the match and replay; each replay checksum matched its result checksum, page errors were empty, and WebGL battle/replay screenshots were inspected.
- npm run build succeeded with provenance 20261015T092411+0000-rf-686531537365, commit 68653153736554f9983d9c65945f4ba48fa4bd45.

## Matched worker cost

Controlled Edge runs used the same canonical map and seed, both sources normalized to CRLF, a full StrategySim.step measurement, fixed checkpoints, and ABBA ordering. Baseline source hash: 0aad614325140cb6333bfe45ceacd93de5d13c9fc8d9239d6397bfcf244d33fc. Candidate source hash: 1421f4080ff951891fc335a377969bcca752a636073d62c8136619ccec2c96d7.

| Scenario | Baseline step | Candidate step | Baseline save / bytes | Candidate save / bytes | Route activity |
|---|---:|---:|---:|---:|---|
| 1 worker | 0.1685 ms/tick | 0.1665 ms/tick (-1.2%) | 0.3975 ms / 5,468 B | 0.3325 ms / 5,004 B (-16.4% / -8.5%) | Candidate had four steady A* route acquisitions; baseline had none. |
| 20 workers | 1.0973 ms/tick | 0.8350 ms/tick (-23.9%) | 1.535 ms / 16,948 B | 1.140 ms / 16,393 B (-25.7% / -3.3%) | Both had zero steady A*; lookups/joins were 140/140 baseline and 139/139 candidate. |

These are two ABBA repeats in this fixture, not a general performance guarantee. One-worker route acquisition is slightly higher despite comparable step cost. The 20-worker case showed lower step and save cost with only a small byte reduction.

## Real two-peer RTC

The actual Edge peers used WebRTC data channels with bridged local signaling, the same 12-second 400-supply swordsman fixture, seed 2617977013, and map hash 1323913035. The sequence was baseline, candidate, candidate, baseline, followed by one additional candidate repeat because the first candidate run was an outlier.

| Arm | Host/guest ticks | Max heartbeat gap | Max confirmed command | Max long task | Hash mismatch / recovery |
|---|---:|---:|---:|---:|---:|
| Baseline run 1 | 113 / 113 | 259 / 302 ms | 200 / 216 ms | 140 / 170 ms | 0 / 0 |
| Candidate run 1, outlier | 40 / 42 | about 1,510 / 1,500 ms | 3,350 / 2,153 ms | 1,270 / 1,378 ms | 0 / 0 |
| Candidate run 2 | 114 / 114 | 305 / 265 ms | 171 / 207 ms | 166 / 166 ms | 0 / 0 |
| Baseline run 2 | 115 / 114 | 247 / 298 ms | 204 / 186 ms | 151 / 154 ms | 0 / 0 |
| Candidate run 3 | 116 / 115 | 250 / 255 ms | 217 / 182 ms | 133 / 143 ms | 0 / 0 |

Candidate runs 2 and 3 tracked baseline tick throughput and command latency. Same-tick checkpoint payloads were smaller in the candidate: 130,593 vs 134,508 bytes at tick 20, about 124,157-124,406 vs 126,592-126,944 bytes at tick 40, and about 108,945-109,061 vs 116,844-117,582 bytes at tick 80. Snapshot save latency was comparable in the normal runs. In the outlier run, one tick-40 snapshot save reached 60.6 ms. The candidate's first run had a severe, non-reproduced stall; its cause is not established, so the result remains an explicit residual risk rather than being discarded.

All peer runs agreed on seed and map hash, confirmed player commands, and recorded zero page errors, hash mismatches, or recoveries. The fixture includes large-scale combat and contact but does not isolate collision displacement as a separate RTC variable.

## Decision

Recommend merging this follow-up. Built-artifact state/rollback and real UI checks passed. The measured result supports the snapshot representation change: deterministic restore passed, worker step/save cost improved in the measured fixtures, and normal RTC repetitions showed no throughput regression with smaller checkpoint payloads. Do not advertise it as an unconditional performance win: one worker showed four additional A* acquisitions, RTC timing is noisy, and one candidate run stalled for over a second without a confirmed cause.

## Built UI evidence

Build provenance is 20261015T092411+0000-rf-686531537365 for commit 68653153736554f9983d9c65945f4ba48fa4bd45. The lockstep UI E2E completed in both human roles; host result/replay checksum was 5eeccb08 and guest result/replay checksum was c87b9c80. Both roles recorded zero page errors. The battle and replay screenshots under .qa/netcode-ui-e2e-lockstep were visually inspected.
