# Operations

## Daily transit database

GitHub Actions가 매일 03:00 KST에 수도권 지원 범위의 live KRIC timetable을 **처음부터 전체 재생성**합니다. 완전 검증을 통과한 경우에만 `data/transit.sqlite`를 새 live DB로 교체합니다.

운영 점검:
```bash
bun run doctor
bun run audit:transfers
```

핵심 확인사항:
- schema/integrity/FK 정상
- KRIC dayCd 8/9 coverage
- SAT=END clone
- KRIC timetable station failure 0
- AREX direct 0
- nC2 transfer mismatch 0
- KRIC-distance-derived transfer row 0
- missing transfer pair는 JSON diagnostic으로 확인

### Daily build 부분 실패

일부 KRIC station/day 요청만 retry를 소진한 경우:
- 부분 성공 live DB는 `data/transit.pending.sqlite`로 보존
- 실패 단위는 `data/transit-refresh-failure.json > failed_timetable_units`에 `{source_id, station_code, day}`로 기록
- `data/transit.sqlite`는 LKG로 유지
- Vercel deployment 안에서 pending DB의 실패 단위만 다시 KRIC에 요청
- targeted retry 후 전체 live 검증이 성공하면 deployment bundle에서 repaired DB 사용
- targeted retry가 다시 실패하면 pending DB는 사용하지 않고 LKG/fixture로 fallback

따라서 daily workflow failure 로그를 볼 때는 먼저 `pending_candidate`와 `failed_timetable_units`를 확인합니다. Secret 값은 failure marker에 기록하지 않습니다.

### KRIC 요청 이상

브라우저에서 동일 파라미터 URL이 성공하는데 builder에서 실패할 경우 다음을 확인합니다.
- service key 이중 URL encoding 여부
- `railOprIsttCd`, `dayCd`, `lnCd`, `stinCd` 값
- HTTP status / JSON parse / timeout 진단
- KRIC response body가 BOM-prefixed JSON인지
- CI와 deploy의 timeout/retry/concurrency 설정

Builder의 KRIC URL 생성과 BOM parsing은 회귀 테스트로 고정되어 있습니다.

## Runtime

`/api/health`에서 SQLite, 실시간 위치, cache, GTX/transfer policy 상태를 확인합니다. 서울 실시간 API 장애 시 SQLite timetable fallback으로 degraded service를 유지해야 합니다.

Vercel에서는 deployment READY, `/api/health`, DB가 public static asset으로 노출되지 않는지 확인합니다.
