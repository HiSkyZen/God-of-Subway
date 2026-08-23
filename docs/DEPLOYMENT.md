# Vercel Deploy

이 저장소의 Vercel 배포 산출물은 Bun Function, React PWA 정적 파일, 그리고 빌드 시 생성되는 `data/transit.sqlite`입니다.

## 빌드 경로

```bash
bun install --frozen-lockfile
bun run build:all
bun run verify:pwa
bun run verify:aot
```

`build:all`은 `build:data` → 서버 build → PWA build → 정적 파일 promotion 순서입니다. Function bundle은 `vercel.json`의 `includeFiles: "data/*.sqlite"`로 SQLite를 내부 파일로 포함합니다. Vercel의 immutable deployment filesystem 때문에 runtime에서는 이 파일을 `/tmp`로 한 번 복사한 뒤 `bun:sqlite` read-only 모드로 엽니다.

## live KRIC 시간표 빌드 최적화

KRIC 시간표 API는 역 코드가 포함된 station-level API이므로 live DB 생성 비용의 대부분이 시간표 요청입니다. 빌더는 모든 역에서 endpoint fallback 체인을 반복하지 않습니다.

1. 운영기관/노선/요일(source/day)마다 최대 2개 대표 역으로 endpoint를 probe합니다.
2. `subwayTimetableExp` → `subwayTimetable` → `stationTimetable` 중 실제 data를 반환하는 endpoint 하나를 선택합니다.
3. 선택한 endpoint를 해당 source/day의 나머지 역에 병렬 fan-out합니다.
4. 개별 역이 선택 endpoint에서 비는 경우에만 다른 endpoint를 fallback합니다.
5. 기본 timetable concurrency는 16이며 `TRANSIT_BUILD_CONCURRENCY`를 명시하면 그 값을 사용합니다.

KRIC 공식 `dayCd`는 `8=평일`, `7=토요일`, `9=휴일`입니다. 모든 대표 source에서 `dayCd=7`이 빈 결과이면 기존처럼 수백 개 역을 3-endpoint로 재시도하지 않습니다. SAT fan-out을 즉시 중단하고 해당 논리 노선에 대해 END를 명시적 fail-safe로 복제합니다. 사용된 노선은 SQLite `metadata.sat_schedule_fallback`과 build log에 기록합니다.

## 환승거리는 deploy-time에 수집하지 않음

KRIC `stationTransferInfo`는 Vercel build 중 전수 호출하지 않습니다. Build-time에는:

- 서울교통공사 authoritative transfer row를 적재하고,
- 각 물리 `station_id`의 `n`개 논리 노선으로 `n*(n-1)/2` unordered pair 토폴로지를 만들고,
- 서울교통공사에 없는 directed row를 `runtime-kric-pending` placeholder로 저장합니다.

따라서 `metadata.runtime_kric_transfer_build_requests=0`이어야 정상입니다.

실제 경로가 pending pair를 사용할 때 Function이 KRIC `stationTransferInfo`를 조회하고 `round(chtnDst / 1.2)`를 계산합니다. 결과는 pair 단위로 캐시됩니다.

## 데이터 빌드 모드

### Production

기본값은 `live`입니다. `KRIC_API_KEY`가 필요합니다. 키가 없다고 fixture로 자동 강등하지 않습니다.

### Preview

`TRANSIT_DATA_MODE`가 없고 Preview에 `KRIC_API_KEY`도 없을 때만 fixture SQLite를 사용합니다. Preview에 KRIC 키가 있으면 live 시간표 빌드를 수행하되, 환승거리 전수 조회는 하지 않습니다.

### CI/local

- GitHub Actions: `TRANSIT_DATA_MODE=fixture`
- 로컬 fixture: `TRANSIT_DATA_MODE=fixture bun run build:data`
- 로컬 live: secret 환경에 `KRIC_API_KEY`를 설정하고 `bun run build:data`

## 관련 환경변수

- `KRIC_API_KEY`: live 시간표 빌드 및 runtime pending transfer 조회
- `SEOUL_API_KEY`: 서울 실시간 열차 위치
- `TRANSIT_DATA_MODE`: `live` / `fixture`
- `TRANSIT_BUILD_CONCURRENCY`: live timetable station fan-out 동시성
- `TRANSIT_BUILD_HTTP_TIMEOUT_MS`: build-time KRIC HTTP timeout
- `KRIC_RUNTIME_TIMEOUT_MS`: runtime transfer KRIC timeout, 기본 3500ms
- `KRIC_RUNTIME_TRANSFER_CONCURRENCY`: 한 요청에서 필요한 transfer pair 동시 조회 수, 기본 4
- `TRANSIT_BUILD_ALLOW_PARTIAL`: 조사 전용

API key 값은 로그, SQLite metadata/build_source, 저장소, PR 본문에 기록하지 않습니다.

## 배포 후 확인

1. deployment가 `READY`인지 확인합니다.
2. build log의 `KRIC timetable` 통계에서 request 수와 SAT fallback 여부를 확인합니다.
3. `KRIC transfer build requests=0`인지 확인합니다.
4. `/api/health`가 `ok: true`인지 확인합니다.
5. `transfer_policy.kric_runtime`의 endpoint/cache 상태를 확인합니다.
6. 내부 SQLite가 정적 자산으로 노출되지 않는지 확인합니다.
