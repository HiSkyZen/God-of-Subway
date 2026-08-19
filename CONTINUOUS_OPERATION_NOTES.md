# Continuous Operation Notes

현재 운영 기준은 Bun/TypeScript `dev/ts-bun` 계열입니다. Python/FastAPI 시절의 프로세스 관리 지침은 더 이상 기준이 아닙니다.

## 운영 확인 순서

```bash
bun run doctor
bun run check
bun run build:all
bun run verify:pwa
bun run verify:aot
```

런타임 `/api/health`에는 데이터/실시간/캐시/GTX-A/환승 정책 상태가 포함됩니다. 서울 실시간 API가 장애여도 정적 시간표 fallback으로 서비스를 유지해야 하며, `realtime_available`/오류 진단을 통해 degraded 상태를 구분합니다.

데이터 파일을 교체한 뒤에는 반드시 `src/engine/data-metadata.ts`의 기대 바이트 크기를 갱신하고 `bun run doctor`를 통과시켜야 합니다. 환승 데이터 변경은 `bun run audit:transfers` 결과와 `docs/TRANSFERS.md`의 물리 구조 예외를 같이 검토하십시오.

운영 중 성능/데이터 이상은 `src/infra/observability.ts`와 캐시 상태를 먼저 확인하고, 경로 오류는 `routing-service → transfer-policy/rapid-service → eta-service` 순으로 분리해 재현합니다.
