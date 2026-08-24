# Operations

## Daily transit database

교통 DB 갱신은 배포와 독립적입니다. GitHub Actions가 매일 03:00 KST에 live KRIC 데이터를 수집하고 검증된 SQLite만 commit합니다.

운영 점검:
```bash
bun run doctor
bun run audit:transfers
```

핵심 확인사항:
- schema/integrity/FK 정상
- KRIC dayCd 8/9 coverage
- SAT=END clone
- AREX direct 0
- nC2 transfer mismatch 0
- KRIC-distance-derived transfer row 0
- missing transfer pair는 JSON diagnostic으로 확인

Scheduled workflow가 실패하면 기존 DB를 계속 사용합니다. 먼저 Actions의 `KRIC_API_KEY` secret, KRIC 응답, timetable coverage 로그를 확인합니다.

## Runtime

`/api/health`에서 SQLite, 실시간 위치, cache, GTX/transfer policy 상태를 확인합니다. 서울 실시간 API 장애 시 SQLite timetable fallback으로 degraded service를 유지해야 합니다.

Vercel에서는 deployment READY, `/api/health`, DB가 public static asset으로 노출되지 않는지 확인합니다.
