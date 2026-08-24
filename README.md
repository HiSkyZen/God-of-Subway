# 지금타 (God-of-Subway)

수도권 전철의 SQLite 시간표, 실시간 열차 위치, 환승 동선을 결합해 **실제 도착시각 기준 경로**를 계산하는 Bun + TypeScript PWA입니다.

## 지원 범위

- 실시간 + 시간표: 1~9호선, 경의중앙선, 공항철도 일반열차, 경춘선, 수인분당선, 신분당선, 경강선, 서해선, GTX-A
- 시간표: 인천1·2호선, 용인에버라인, 의정부경전철, 우이신설선, 신림선, 김포골드라인
- 경로 목적: **최단시간 / 최소환승 / 최소비용**
- GTX 사용 토글: 기본 ON. GTX 전용 목적지에는 필요한 section만 유지할 수 있습니다.
- 공항철도 직통열차는 도시철도 경로/급행 비교 대상에서 제외합니다.

## 데이터 아키텍처

런타임은 JSON/CSV 시간표를 읽지 않고 `data/transit.sqlite`만 사용합니다. SQLite는 매일 **03:00 KST** GitHub Actions가 KRIC 시간표를 우선 수집해 검증한 뒤 갱신합니다. Vercel 배포는 DB를 새로 만들지 않고 검증된 SQLite를 패키징해 읽습니다.

KRIC 시간표는 `dayCd=8`(평일), `dayCd=9`(주말·공휴일)만 조회하며 토요일은 `dayCd=9` 결과를 사용합니다. `dayCd=7`은 조회하지 않습니다.

환승시간은 서울교통공사 authoritative 데이터가 우선이고 없는 pair만 upstream 검증값으로 보완합니다. KRIC `stationTransferInfo`의 거리값은 환승시간 계산에 사용하지 않습니다. KRIC에서는 위치 관련 raw hint만 낮은 우선순위로 보존합니다.

역 좌표는 예상 운임거리 계산에만 사용하며 환승 보행시간 추산에는 사용하지 않습니다.

자세한 내용:
- [`docs/SQLITE_TRANSIT_DATA.md`](docs/SQLITE_TRANSIT_DATA.md)
- [`docs/TRANSFERS.md`](docs/TRANSFERS.md)
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

## 개발

```bash
bun install
TRANSIT_DATA_MODE=fixture bun run build:data
bun run check
bun run dev
```

외부 KRIC live DB를 수동 생성하려면 `KRIC_API_KEY`가 필요합니다.

```bash
TRANSIT_DATA_MODE=live bun run build:data
bun run doctor
bun run audit:transfers
```

실제 키는 저장소·로그·SQLite metadata에 기록하지 않습니다.

## 빌드

```bash
bun run build:all
```

`build:all`은 서버/클라이언트/PWA만 빌드하며 **데이터 DB를 생성하지 않습니다**. 배포는 이미 검증된 `data/transit.sqlite`를 사용합니다.
