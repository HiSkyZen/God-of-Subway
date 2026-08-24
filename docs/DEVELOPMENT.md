# 로컬 개발

## 요구사항

- Bun 1.3.14 이상
- TypeScript는 `devDependencies` 버전 사용

런타임 정적 데이터는 `data/transit.sqlite`입니다.

### 외부 API 없는 개발

```bash
bun install --frozen-lockfile
TRANSIT_DATA_MODE=fixture bun run build:data
bun run doctor
bun run dev
```

### live 데이터 개발

실제 KRIC 시간표를 수동 재생성할 때만 로컬 secret 환경에 `KRIC_API_KEY`를 설정합니다.

```bash
TRANSIT_DATA_MODE=live bun run build:data
bun run doctor
bun run audit:transfers
```

키 값은 Git 추적 파일, 로그, SQLite metadata에 기록하지 않습니다.

## 정적 원천

- `datasets/kric/*`: KRIC operator/line/station mapping
- `datasets/transfers/seoul-metro-transfer-times.tsv`: 서울교통공사 authoritative pair
- `datasets/transfers/upstream-pairs/*.tsv`: offline/fixture upstream fallback snapshot
- `datasets/stations/coordinates/*`: 예상 운임거리 전용 역사 좌표 snapshot
- `datasets/calendar/kr-holidays.tsv`: 서비스 운행일 판정

좌표는 환승시간 계산에 사용하지 않습니다.

## 검증

```bash
TRANSIT_DATA_MODE=fixture bun run build:data
bun run doctor
bun run audit:transfers
bun run typecheck
bun run typecheck:sw
bun run check:architecture
bun test
bun run build
bun run build:client
bun run scripts/promote-static.ts
bun run verify:pwa
bun run verify:aot
```

`doctor`와 `audit:transfers`는 SQLite 무결성/FK, 노선/운행일 커버리지, 환승 provenance, nC2 topology와 KRIC 거리 기반 환승시간 row가 없음을 확인합니다.
