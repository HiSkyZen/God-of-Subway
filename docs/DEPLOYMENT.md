# Deployment

## Daily 전체 빌드와 deploy-time 부분 복구

교통 DB의 기준 생성은 `.github/workflows/update-transit-data.yml`이 매일 **03:00 KST (`0 18 * * *` UTC)** 수행합니다. Daily job은 이전 DB를 증분 갱신하지 않고 수도권 지원 범위의 live KRIC timetable을 매번 처음부터 수집해 새 SQLite를 만듭니다.

정상 경로:
1. `KRIC_API_KEY` repository secret 확인
2. `TRANSIT_DATA_MODE=live`로 전체 KRIC timetable 수집 (`dayCd=8/9`)
3. live SQLite integrity/FK/coverage, `verify-live-transit`, `doctor`, transfer audit 검증
4. 완전 성공 시 `data/transit.sqlite`로 승격하고 retry state 제거
5. 변경된 검증 DB만 bot commit

부분 실패 경로:
1. 전체 수집 중 일부 `{source_id, station_code, day}` KRIC 요청만 재시도 소진 시, 성공한 나머지 데이터가 들어 있는 candidate를 `data/transit.pending.sqlite`로 보존
2. 실패 단위를 `data/transit-refresh-failure.json`의 `failed_timetable_units`에 secret 없이 기록
3. 기존 `data/transit.sqlite`는 last-known-good(LKG)로 그대로 유지; 최초 실행이면 deterministic fixture SQLite를 fallback으로 생성
4. 그 commit으로 시작된 Vercel deployment의 `prepare:data:deploy`가 **전체 데이터를 다시 수집하지 않고 실패 단위만** KRIC에 재요청
5. deploy-time 부분 복구 후 `verify-live-transit`, `doctor`, transfer audit를 모두 통과하면 pending candidate를 해당 deployment의 `data/transit.sqlite`로 승격
6. deploy-time 재시도도 실패하면 pending candidate를 폐기하고 LKG/fixture SQLite로 빌드 계속 진행

즉 CI의 10회 재시도 소진은 해당 데이터를 영구 폐기한다는 의미가 아닙니다. CI의 부분 실패 단위를 deployment 안에서 다시 시도하고, 두 단계 모두 실패한 경우에만 fallback을 사용합니다.

Function bundle은 `vercel.json`의 SQLite include 설정으로 최종 선택된 DB를 포함합니다. runtime에서는 immutable bundle의 DB를 `/tmp`로 복사해 read-only로 엽니다.

## KRIC HTTP 계약

KRIC timetable 요청은 철도 데이터 포털의 요청 변수 계약에 맞춰 `serviceKey`, `format`, `railOprIsttCd`, `dayCd`, `lnCd`, `stinCd`를 구성합니다. Builder는 URL-encoded service key가 들어와도 이중 인코딩하지 않으며, JSON BOM을 허용하고, HTTP timeout/retry를 bounded하게 적용합니다.

전체 timetable fan-out 자체는 의도된 동작입니다. `TRANSIT_BUILD_CONCURRENCY`와 `TRANSIT_BUILD_KRIC_HTTP_CONCURRENCY`는 전체 빌드의 병렬성을 제어하고, deploy-time 부분 복구는 실패 단위 목록만 대상으로 별도 bounded concurrency를 사용합니다.

## 환경변수

- `KRIC_API_KEY`: daily data workflow / deploy-time failed-unit recovery / 수동 live build
- `SEOUL_API_KEY`: runtime 서울 실시간 위치
- `TRANSIT_DATA_MODE`: 개발/수동 빌드의 `fixture` / `live`
- `TRANSIT_BUILD_CONCURRENCY`: 전체 timetable job 병렬성
- `TRANSIT_BUILD_KRIC_HTTP_CONCURRENCY`: 실제 KRIC HTTP 동시 요청 수
- `TRANSIT_BUILD_HTTP_TIMEOUT_MS`: KRIC 요청 timeout
- `TRANSIT_BUILD_KRIC_RETRIES`: timetable 요청 retry 횟수
- `TRANSIT_DEPLOY_REPAIR_CONCURRENCY`: deploy-time 실패 단위 복구 병렬성

키 값은 저장소·로그·SQLite metadata에 저장하지 않습니다.

## 배포 검증

배포 후에는 다음을 확인합니다.
- latest Bun CI success
- latest daily transit workflow의 live/partial/fallback 상태
- Vercel deployment READY
- `/api/health`
- SQLite bundle 접근
- `data/transit-refresh-failure.json`이 남아 있다면 실패 단위가 deploy-time recovery 또는 fallback 계약대로 처리됐는지
