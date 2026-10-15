# SIM198 통합 재검증 — PR46 병합 후

## 고정한 소스

대조군은 PR46이 main에 병합된 `4dadd30744e4b3b2fc4040c0da18355d31aaf5c6`입니다. 후보는 이 커밋 위로 PR59를 리베이스한 코드 커밋 `9c66912a0350ea8fe19cc492ada157dc587b2e77`이며, 부모는 대조군 SHA입니다. 대조군 `index.html` blob/SHA-256은 `6b88d095938f914436849fa1570dfe432fa00ea8` / CRLF `1fec5c457b9127f65b9f18d6d12a12dceda602537edb1a460efbb4d86e297e57`, 후보는 `0d8cacb9951adae41d9b0fb244d04d8b08a3b033` / CRLF `0aad614325140cb6333bfe45ceacd93de5d13c9fc8d9239d6397bfcf244d33fc`입니다. 두 파일은 Git blob에서 동일하게 CRLF로 동결해 측정했습니다.

SIM198 이전 보고서의 3bd1acd 대조 결과는 [이 보고서](2026-10-15-sim198.md)에 보존했습니다. 이번 결과는 PR46 물리 변경이 들어간 4dadd307 기준이며, 두 기준의 숫자를 직접 섞지 않았습니다.

## Worker 이동과 체크포인트 비용

동일 canonical map/seed `3919536611`, 빈 입력, 장애물 1개, Edge, 300 tick, 매 10 tick checkpoint, steady 구간 101–300, ABBA 두 반복으로 비교했습니다. `sim.step`은 전체 시뮬레이션 스텝이며 렌더링/RTC 지연을 뜻하지 않습니다.

| 편성 | 4dadd main step ms/tick | PR59 step ms/tick | main snapshot 저장 ms | PR59 저장 ms | main bytes | PR59 bytes | 수입 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Worker 1기 | 0.142 | 0.188 (+33.0%) | 0.395 | 0.423 (+7.0%) | 5,531 | 5,468 (−1.1%) | 3 → 3 |
| Worker 20기 | 0.844 | 0.915 (+8.4%) | 1.730 | 1.190 (−31.2%) | 23,487 | 16,948 (−27.8%) | 31 → 40 |

20-worker steady 구간에서 대조군은 route query 8회/A* 3회였습니다. PR59는 route build/A* 0회였고, 목표·이탈 invalidation 뒤 cache lookup/join 140회(목표 74, 이탈 66)가 발생했습니다. 별도 일반 추종 98 tick 회귀에서는 경로 요청 0, cache lookup 0, 전체 경로 스캔 0, 인접 구간 검사 3회였습니다. 즉 정상 경로를 따라가는 동안에는 재조회하지 않지만, 실제 목표 변경과 이탈 때는 재획득합니다.

## 400-supply 전투 RTC

같은 map seed `2617977013`/map hash `1323913035`, swordsman 90기(400 supply), Edge, run당 12초, quiet input, ABBA 두 반복입니다. 틱 수는 main `118/119`, `119/119`, 후보 `113/114`, `120/119`로 겹쳐 throughput 우열이 뚜렷하지 않았습니다. 네 run 모두 peer hash mismatch 0, recovery 0, page error 0이었습니다.

양 peer를 합친 A* 평균은 main 약 1,499회/peer에서 후보 약 499회/peer로 줄었습니다. 후보에서는 route build 약 1,848회, cache lookup 약 6,187회, join 약 4,339회/peer였고, 목표 invalidation 약 6,073회 및 물리 이탈 invalidation 약 107회/peer였습니다. 움직이는 전투 목표로 반복 재획득이 계속 발생하는 점은 안정된 일반 추종 비용과 구분해야 합니다.

RTC checkpoint 크기는 같은 tick의 peer/run 평균으로 tick 40: `111,108 → 125,098` bytes (+12.6%), tick 60: `101,126 → 119,694` (+18.4%), tick 80: `96,529 → 112,539` (+16.6%)였습니다. 이 quiet-input fixture는 사용자 명령 지연 샘플을 만들지 않아 500 ms 입력 목표나 command p95를 검증한 결과는 아닙니다.

## 결합 검증

- `npm run build` 성공; standalone build provenance는 코드 커밋 `9c66912`입니다. `npm run test:build` 32/32 통과.
- 접촉 차등 검사: 20,000 primitive 비교 identical, 12종 유닛 시나리오에서 후보 틱별 결정성 확인. 단 shelltitan 시나리오는 frozen pre-grid oracle과 tick 47, byte 69,393에서 차이가 기록됐습니다. 이를 무차이로 해석하지 않습니다. 별도 RTC lockstep/rollback peer 검사는 모두 hash mismatch 0이었습니다.
- 공통 경로 회귀 통과: 일반 추종 98 tick 동안 요청/cache lookup/full-route scan 0; 목적지 변경과 이탈 재획득, 합류 및 경로 프로파일 분리 확인.
- 경로 checkpoint 회귀 통과: root 점 4,013개와 공유 suffix 3,813개 무손실 복원, 22개 malformed/limit 사례 거절, codec 500,000-node 예산 유지, checkpoint 105,081 bytes.
- worker cold restore 1/2기 통과: 각각 495/498 비교 tick 동안 전체 상태 바이트 동일, income 6/12회. worker navigation 36 A* oracle 사례, 8개 churn 단계 통과; 실제 economy 152 tick·mine hit 78·return 26, warm/cold 전체 게임 바이트 동일.
- netcode-state 11개 사례 통과, malformed snapshot 17개 원자적 거절. RTC lockstep은 손실·순서변경·손상 패킷 뒤 snapshot recovery 및 replay hash 일치; rollback 모드는 양 peer rollback/resimulation 및 recovery hash 일치, 양쪽 모두 hash mismatch/page error 0.

세부 로그와 고정 소스는 현재 worktree의 `.qa/sim198-pr46-integration/`에 있습니다. 성능 수치는 workload별 trade-off입니다. 20-worker snapshot 시간/크기와 경로 탐색은 감소했지만 `sim.step`은 늘었고, 전투 RTC snapshot은 커졌습니다. PR46의 frozen-oracle 차이는 별도 물리 변경 대조군으로 분리해서 귀속해야 합니다.

## 경로 저장과 checkpoint 표현

실행 중 `StrategySim`이 canonical 경로 본문을 `routePathStore` 한 곳에 보관합니다. 각 유닛의 이동 상태에는 `{ pathId, cursor, legX, legY, retained }` 참조만 있고, 점 배열을 별도로 복사해 두지 않습니다. 합류 경로는 새로 계산한 로컬 prefix와 root 경로 참조(`tailId`, `tailStart`)를 저장하므로, 바뀌지 않은 suffix는 root 경로에서 읽고 합류 경로마다 복사하지 않습니다. 좌표는 양자화하지 않고 정확히 보존합니다.

Checkpoint export는 canonical 경로를 `[id, profileId, topologyId, exactFlatPoints, tailId, tailStart]` 행으로 직렬화하며, 경로 profile과 topology는 별도 테이블에서 중복 제거합니다. 유닛 행에는 handle/cursor만 기록합니다. 복원 시 참조 ID, profile/topology 소유 관계, root suffix offset, 배열 예산을 검증한 뒤 테이블과 유닛 참조를 재구성합니다. 이 방식은 worker checkpoint에서 유닛별 중복 경로 좌표를 제거하지만, 혼잡한 RTC 사례에서는 테이블·profile·topology 메타데이터와 root 참조 비용 때문에 checkpoint 크기가 오히려 증가했습니다.

## 병합 권고: 현시점 보류

이 결과를 일반적인 성능 향상으로 간주해 지금 병합하는 것은 권하지 않습니다. 측정된 손익은 workload별로 다릅니다. Worker 1기에서는 step 비용이 33.0%, snapshot 저장 시간이 7.0% 늘었습니다. Worker 20기에서는 step 비용이 8.4% 늘었지만 snapshot 저장 시간은 31.2%, 크기는 27.8% 줄었습니다. 혼잡 RTC의 A* 작업은 크게 줄었으나 tick throughput 우열은 분명하지 않고 RTC checkpoint는 12.6–18.4% 커졌습니다. 경로/A* 감소와 결정성·snapshot·rollback·브라우저 UI 검증 통과는 유의미하지만, 모든 목표 workload에서 비용 증가를 상쇄하지는 않습니다. step/RTC checkpoint 비용을 분석·축소한 뒤 다시 판단하거나, 제품 담당자가 단일 worker와 RTC 비용을 감수하고 20-worker checkpoint 절감을 우선한다고 명시적으로 선택한 후 재검토할 것을 권합니다. 이번 quiet-input RTC fixture로 500 ms 명령 지연 목표는 입증되지 않았습니다.

## 브라우저 UI E2E

rebased 후보 빌드에서 `node scripts/netcode-ui-e2e.cjs _site/index.html` 통과했습니다. Host와 guest 모두 매치 및 replay를 완료했고 각 역할의 checksum이 일치했으며 `pageErrors`는 비어 있었습니다. Build provenance는 `20261015T065239+0000-rf-9c66912a0350`입니다.