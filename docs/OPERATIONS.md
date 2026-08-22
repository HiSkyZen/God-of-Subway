# Continuous Operation Notes

현재 운영 기준은 Bun/TypeScript + build-time SQLite입니다. Python/FastAPI 시절의 프로세스 관리 지침과 런타임 JSON 파일 크기 검증은 더 이상 기준이 아닙니다.

## 운영 확인 순서

```bash
bun run build:data
bun run doctor
bun run check
bun run build
bun run build:client
bun run scripts/promote-static.ts
bun run verify:pwa
bun run verify:aot
```

Production `build:data`는 live 모드이며 `KRIC_API_KEY`가 필요합니다. 필수 노선/운행일 시간표가 누락되거나 SQLite 무결성 검사가 실패하면 배포를 중단합니다. Vercel Preview는 키가 없고 `TRANSIT_DATA_MODE`가 명시되지 않은 경우에만 deterministic fixture DB로 빌드합니다.

## 데이터 운영

런타임 데이터의 단일 소스는 `data/transit.sqlite`입니다. DB는 매 빌드 새로 생성하며 Git에 커밋하지 않습니다.

사람이 검토하는 원천은 `datasets/`에 유지합니다. 다음 변경은 반드시 데이터 빌드와 감사를 함께 수행합니다.

- 노선/역 코드 변경 → `datasets/kric/*` + `bun run build:data` + `bun run doctor`
- 서울교통공사 환승 원천 변경 → `datasets/transfers/*` + `bun run audit:transfers`
- 스키마 변경 → `src/infra/transit-schema.ts`의 schema version과 repository query 동시 검토
- KRIC 정규화 변경 → `scripts/transit-build/*` + fixture/live 규칙 비교

과거처럼 `src/engine/data-metadata.ts`의 JSON 파일 바이트 크기를 수동 갱신하지 않습니다.

## 런타임 확인

`/api/health`에는 데이터/실시간/캐시/GTX-A/환승 정책 상태가 포함됩니다. 서울 실시간 API가 장애여도 SQLite 시간표 fallback으로 서비스를 유지해야 하며 `realtime_available`/오류 진단을 통해 degraded 상태를 구분합니다.

Vercel에서는 추가로 다음을 확인합니다.

1. deployment state가 `READY`인지 확인합니다.
2. `/api/health`가 정상인지 확인합니다.
3. `/data/transit.sqlite`가 404로 차단되는지 확인합니다.
4. Preview DB가 fixture인지 live인지 `/api/health`/metadata 진단에서 구분합니다.

운영 중 성능/데이터 이상은 `src/infra/observability.ts`와 SQLite build provenance를 먼저 확인하고, 경로 오류는 `routing-service → transfer-policy/rapid-service → eta-service` 순으로 분리해 재현합니다.
