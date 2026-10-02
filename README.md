# RALLY FRONTIER

RALLY FRONTIER는 브라우저에서 바로 실행할 수 있는 실시간 전략 게임(RTS) 프로젝트입니다.

별도의 설치 없이 브라우저에서 실행할 수 있으며, WebRTC 기반 P2P 멀티플레이와 싱글 플레이를 지원합니다.

> **이 저장소는 개발 중인 최신 작업본이 아니라, 테스트와 검증을 완료한 Stable 버전을 관리하고 배포하기 위한 저장소입니다.**

## 플레이

GitHub Pages를 통해 현재 Stable 버전을 바로 실행할 수 있습니다.

**https://byh-playground.github.io/rally-frontier/**

## 버전 관리

개발 중인 후보 버전은 별도의 개발·검증 환경에서 테스트합니다.

실제 플레이, 주요 기능, 회귀 및 네트워크 동작 등의 검증을 통과하여 **VALIDATED** 상태가 된 버전만 이 저장소의 `main` 브랜치에 반영합니다.

```text
개발 및 수정
    ↓
개발·검증 환경 배포
    ↓
플레이 및 회귀 검증
    ↓
VALIDATED
    ↓
GitHub main/index.html
    ↓
GitHub Pages (Stable)
```

따라서 이 저장소의 `main/index.html`은 **현재 검증이 완료된 최신 Stable 버전**을 의미합니다.

## 프로젝트 구조

게임 엔진과 UI는 `index.html` 안에 유지하고, 현재 캠페인 데이터 전체는 `campaign/campaigns.js` 한 JavaScript 모듈에 둡니다.

캠페인 메뉴를 열 때 native ES import로 데이터를 읽습니다. 기본 게임 부팅은 캠페인 모듈 로드에 의존하지 않으며, 각 미션은 자체 시작 상태를 선언합니다. 개발용 신뢰 Mission JS의 파일/URL Preview도 유지합니다.

```text
rally-frontier/
├── index.html             # 게임 엔진·UI 및 GitHub Pages 진입점
└── campaign/
    └── campaigns.js       # 현재 정식 캠페인 데이터 전체 (default manifest)
```

## 주요 특징

* 브라우저 기반 실시간 전략 게임
* 싱글 플레이 지원
* WebRTC 기반 P2P 멀티플레이
* 별도 게임 서버 없이 플레이어 간 직접 통신
* 모바일 및 PC 브라우저 지원
* 전장의 안개(Fog of War)
* 건설 및 자원 채취
* 유닛 생산 및 테크 시스템
* 다양한 유닛과 특수 능력
* 중립 오브젝트 및 점령 시스템
* 리플레이 지원
* HTML 안의 게임 엔진과 하나의 캠페인 데이터 모듈

## 개발 원칙

개발 중인 소스를 바로 `main`에 반영하지 않습니다.

별도의 환경에서 충분히 검증된 버전만 Stable 버전으로 승격하며, `main/index.html`은 항상 플레이 가능한 검증 완료 상태를 유지하는 것을 원칙으로 합니다.

게임 실행 파일은 `index.html`과 `campaign/campaigns.js`를 함께 배포합니다. 로컬에서도 저장소 폴더를 정적 HTTP 서버로 제공하여 실행하세요(예: `python -m http.server 8000` 후 `http://localhost:8000/`). 브라우저의 native ES module 보안 정책 때문에 `file://`로 직접 연 파일에서는 정식 캠페인을 불러올 수 없습니다. 빌드 과정은 필요하지 않습니다.

## 커밋 메시지

### 작업 및 리뷰 흐름

저장소 변경은 항상 별도의 `codex/` 작업 브랜치에서 진행합니다. 수정과 필요한 검증을 마친 뒤 커밋·푸시하고, `main`을 대상으로 GitHub Pull Request(PR)를 생성하거나 기존 PR을 업데이트합니다.

작업 완료 기준은 사용자가 PR의 **Files changed**에서 변경 내용을 리뷰할 수 있는 상태입니다. PR 설명과 완료 응답에 검증 결과 및 미검증 항목을 명시하며, 사용자 리뷰와 명시적인 머지 지시 전에는 머지하지 않습니다. 검증되지 않은 개발 후보를 PR에 올리는 것은 Stable 승격을 의미하지 않습니다.

머지는 기본적으로 **작업 커밋을 하나로 squash한 뒤 Merge commit**을 만드는 방식입니다. `main`에는 통합 작업 커밋 하나와 별도의 머지 커밋이 남습니다. 머지 후 로컬 `main`을 동기화하고 해당 PR과 남아 있는 머지 완료 로컬 작업 브랜치를 정리합니다. 미반영 커밋이나 다른 worktree에서 사용 중인 브랜치는 보존하며, 원격 브랜치는 별도 지시 없이 삭제하지 않습니다.

커밋 메시지는 기본적으로 **한글**로 작성합니다.

기본 형식:

```text
[타입] 변경 내용 요약

- 변경 사항에 대한 간단한 설명
- 필요한 경우 추가 설명
```

예시:

```text
[bug-fix] 싱글 게임 시작 불가 버그 수정

- 게임 초기화 과정에서 발생하던 오류 수정
- 싱글 게임 정상 시작 확인
```

주요 타입:

```text
[feature]      기능 추가
[bug-fix]      버그 수정
[refactor]     코드 구조 개선 및 리팩터링
[performance]  성능 최적화
[ui]           UI/UX 개선
[balance]      게임 밸런스 조정
[network]      P2P 및 동기화 관련 변경
[docs]         문서 변경
[test]         테스트 및 검증 관련 변경
[chore]        기타 유지보수 작업
```

하나의 커밋에 여러 변경이 포함된 경우 가장 핵심적인 변경을 타입으로 사용합니다.

## 저장소

이 저장소는 BYH Playground의 게임 프로젝트 중 하나입니다.

RALLY FRONTIER의 **검증 완료 Stable 버전 및 GitHub Pages 배포 소스**를 이 저장소의 `main` 브랜치에서 관리합니다.
