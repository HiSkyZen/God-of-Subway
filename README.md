# 지금타 (God-of-Subway, Bun/TypeScript)

수도권 전철의 **빌드 시 생성 SQLite 시간표**, 서울시 실시간 열차 위치, 환승 동선 데이터를 결합해 도착시각 기준 경로를 계산하는 Bun + TypeScript 서비스입니다. `unending314/God-of-Subway` Python/FastAPI 구현을 Bun 런타임으로 이식한 다운스트림입니다.

## 지원 범위

- 실시간 + 시간표: 1~9호선, 경의중앙선, 공항철도, 경춘선, 수인분당선, 신분당선, 경강선, 서해선, GTX-A
- 시간표: 인천1·2호선, 용인에버라인, 의정부경전철, 우이신설선, 신림선, 김포골드라인
- `DAY/SAT/END` 독립 시간표, 일반/급행/직통 서비스 구분, 실시간 장애 시 시간표 fallback
- 환승 거리·시간·방향별 빠른 환승 위치, 동명이의역 분리, 공용선로/승강장 예외 정책
- React PWA UI, 여정 추적, 즐겨찾기, 실험 기록, 푸시 알림

## 데이터 아키텍처

기존 `data/*.json` 시간표/그래프/환승 런타임 의존성은 제거했습니다. 사람이 검토할 수 있는 코드/매핑/환승 원천은 `datasets/*.tsv`로 정리하고, 대용량 시간표는 저장소에 복제하지 않습니다.

프로덕션 `bun run build:data`는 KRIC OpenAPI에서 시간표/환승을 받아 `data/transit.sqlite`를 생성합니다. 런타임은 `bun:sqlite`로 이 DB만 읽습니다. 서울 실시간 위치 API는 별도 네트워크 계층입니다.

자세한 스키마와 출처 정책은 [`docs/SQLITE_TRANSIT_DATA.md`](docs/SQLITE_TRANSIT_DATA.md), 데이터셋 설명은 [`datasets/README.md`](datasets/README.md)를 참고하십시오.

## 빠른 시작

```bash
bun install
TRANSIT_DATA_MODE=fixture bun run build:data   # 외부 API 없는 개발/테스트 DB
bun run check
bun run dev
```

실데이터 빌드는 환경변수 `KRIC_API_KEY`가 필요합니다. 실시간 서울 지하철 위치는 `SEOUL_API_KEY`를 사용합니다. 실제 키를 저장소·로그·DB 메타데이터에 기록하지 마십시오.

```bash
bun run build:data       # production/live KRIC build
bun run build
bun run build:client
bun run scripts/promote-static.ts
```

Vercel의 `build:all`은 데이터 DB 생성을 포함합니다.

## 저장소 구조

```text
api/          Vercel Function 진입점
src/
  api/        HTTP 계약과 핸들러
  client/     React PWA UI
  engine/     시간표, 실시간 ETA, 라우팅, 환승/급행 정책
  infra/      SQLite 스키마, 캐시, 관측성, 푸시
datasets/     사람이 읽을 수 있는 KRIC 코드/매핑/환승 TSV 원천
data/         빌드 시 생성되는 transit.sqlite (Git 미추적)
scripts/      DB 생성·빌드·검증·감사 도구
tests/        API·클라이언트·엔진 테스트
docs/         설계·운영 문서
```
