# 로컬 개발

## 요구사항

- Bun 1.3.14 이상
- TypeScript는 `devDependencies` 버전을 사용

정적 철도 데이터는 런타임 JSON이 아니라 빌드 산출물 `data/transit.sqlite`를 사용합니다.

### 외부 API 없는 개발

```bash
bun install --frozen-lockfile
TRANSIT_DATA_MODE=fixture bun run build:data
bun run doctor
bun run dev
```

fixture 모드는 실제 런타임과 동일한 SQLite 스키마를 사용하되 외부 KRIC API와 secret이 필요하지 않습니다.

### live 데이터 개발

실제 시간표를 재생성할 때만 `KRIC_API_KEY`를 로컬 secret 환경에 설정하고 다음을 실행합니다.

```bash
bun run build:data
bun run doctor
bun run dev
```

키 값은 `.env.example`, Git 추적 파일, 로그, SQLite metadata에 기록하지 않습니다.

## 원천 데이터 수정

사람이 검토하는 정적 원천은 `datasets/` 아래 TSV로 관리합니다.

- `datasets/kric/line-sources.tsv`: 논리 노선 ↔ KRIC 운영기관/노선 코드
- `datasets/kric/stations/stations-*.tsv`: 역사 코드/순서 스냅샷
- `datasets/transfers/seoul-metro-transfer-times.tsv`: 서울교통공사 환승 거리/시간
- `datasets/calendar/kr-holidays.tsv`: 서비스 운행일 판정용 휴일

원천을 수정한 뒤 `bun run build:data`로 DB를 다시 만들고 `doctor`/테스트를 통과시킵니다. 과거처럼 JSON 바이트 크기나 `src/engine/data-metadata.ts`의 파일 크기를 수동 갱신하지 않습니다.

## 검증

```bash
TRANSIT_DATA_MODE=fixture bun run build:data
bun run check
bun run build
bun run build:client
bun run scripts/promote-static.ts
bun run verify:pwa
bun run verify:aot
```

GitHub Actions는 `TRANSIT_DATA_MODE=fixture`를 사용해 외부 API와 secret 없이 동일 검증을 수행합니다.

개별 데이터 감사:

```bash
bun run audit:transfers
```

`doctor`와 `audit:transfers`는 SQLite 무결성, FK, 노선/운행일 커버리지, 환승 provenance와 KRIC `round(distance_m / 1.2)` 산식을 직접 확인합니다.

## 모듈 추가 원칙

- 철도 규칙은 `src/engine`에 둡니다.
- SQLite 스키마/인프라는 `src/infra`에 둡니다.
- 데이터 수집·정규화는 `scripts/transit-build`에 둡니다.
- UI 표시 규칙은 `src/client`에 둡니다.
- 캐시/푸시/관측성은 `src/infra`에 둡니다.
- 사람이 검토해야 하는 원천은 `datasets/`에 둡니다.
- 생성된 `data/*.sqlite`와 대용량 시간표 JSON/CSV는 Git에 커밋하지 않습니다.
- provenance가 필요한 보정은 정책 모듈 또는 감사 가능한 생성 스크립트에 둡니다.
