# 쌀 캐릭터 움직임 목업

저장소 루트에서 `python -m http.server 18762 --bind 127.0.0.1 --directory prototypes/rice-animation`을 실행하고 `http://127.0.0.1:18762/`를 열어 대기·걷기·작업·공격·피격과 표정을 확인한다. `rice-body-hat.png`는 모자와 몸체가 처음부터 합쳐진 이미지 생성 시안이며, `rice-parts-refined.png`와 `rice-parts.png`는 별도 팔다리·표정용 시안이다. 세 파일은 실제 게임 아틀라스가 아니다. 목업은 통짜 몸체를 한 번 그리고 표정·팔다리·낫을 따로 배치한다.

대기·걷기·피격의 몸체 키프레임은 [버드모리 쌀 원본](https://github.com/byh-playground/budmori-io/blob/main/assets/troops/rice.svg)의 기존 동작을 참조했다. 공격은 버드모리의 `src/features/unit-attacks/rice/presentation.js`와 `src/features/species-growth/rice-attack.js`의 준비·접촉·복귀를, 작업은 `src/model/farm-work.js`의 별도 단계를 참고해 이 이미지에 맞춰 시각적으로 재구성했다. 이 목업은 독립 Canvas 2D이며 GameKit GPU 배치·실제 판정·성능 검증을 포함하지 않는다.
