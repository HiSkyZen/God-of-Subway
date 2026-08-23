# SQLite 철도 데이터 아키텍처

## 목표

정적 시간표·노선 그래프·환승 JSON을 런타임 의존성에서 제거하고, 검토 가능한 TSV와 KRIC OpenAPI를 바탕으로 `data/transit.sqlite`를 생성합니다. 서울 열린데이터광장 실시간 위치 API와 KRIC 환승거리 런타임 조회는 정적 DB와 분리합니다.

## 시간표 빌드

KRIC 공식 요일 코드는 다음과 같습니다.

```text
DAY = 8   # 평일
SAT = 7   # 토요일
END = 9   # 휴일
```

live 빌드는 운영기관/노선/요일별 대표 역에서 먼저 endpoint를 probe합니다.

1. `trainUseInfo/subwayTimetableExp`
2. `trainUseInfo/subwayTimetable`
3. `convenientInfo/stationTimetable`

작동하는 endpoint를 source/day마다 한 번 결정한 뒤 해당 endpoint로 역별 fan-out을 수행합니다. 따라서 지원되지 않는 endpoint를 모든 역에서 반복 재시도하지 않습니다. 기본 동시성은 live timetable build에서 16이며 `TRANSIT_BUILD_CONCURRENCY`로 조정할 수 있습니다.

KRIC가 `dayCd=7`에 대해 모든 대표 source에서 빈 응답을 돌려주는 경우 수백 건의 SAT 요청을 계속하지 않습니다. SAT fan-out을 중단하고 해당 논리 노선에 대해 END 시간표를 명시적 fallback으로 복제하며 `metadata.sat_schedule_fallback`에 기록합니다. 이는 upstream KRIC SAT 데이터가 비어 있는 경우에만 작동하는 fail-safe입니다.

CI는 `TRANSIT_DATA_MODE=fixture`로 동일 스키마를 외부 API 없이 검증합니다.

## 환승 데이터: build-time 토폴로지, runtime 거리

제공된 서울교통공사 2025-12-31 환승거리/시간은 build-time authoritative source입니다.

KRIC `convenientInfo/stationTransferInfo`는 **배포 시 전수 호출하지 않습니다**. 각 물리 `station_id`에 연결된 논리 노선이 `n`개라면 `n*(n-1)/2`개의 unordered transfer pair를 생성하고, 서울교통공사에 없는 directed row를 `runtime-kric-pending`으로 저장합니다.

실제 경로 후보가 이 pending pair를 사용할 때만 KRIC를 조회합니다. 응답의 `chtnLn`으로 대상 노선을 구분하고 `chtnDst`를 pair별로 선택한 뒤 다음 산식을 적용합니다.

```text
seconds = round(chtnDst_m / 1.2)
```

결과는 pair 단위로 Valkey/메모리에 캐시합니다. 한 환승역의 여러 노선쌍을 하나의 거리로 축약하지 않습니다.

## SQLite 정규형

- `source_registry`: 운영기관/노선 코드와 논리 노선
- `station`, `station_source`: 물리 역사와 각 데이터 소스 역사 코드
- `trip`, `trip_source`, `stop_time`: DAY/SAT/END 열차/정차시각
- `ride_edge`: 시간표에서 집계한 인접역 운행시간
- `transfer_pair`: authoritative transfer 또는 runtime KRIC pending pair
- `transfer_detail`: 방향별 빠른 환승 위치
- `holiday`: 운행일 판정
- `metadata`, `build_source`: provenance와 build diagnostics

## 공항철도 직통

공항철도 직통열차는 수도권 전철 급행으로 취급하지 않으며 생성 DB에서 제외합니다. 공항철도 일반열차만 경로 계산에 사용합니다.

## Vercel

Function bundle에는 `data/*.sqlite`만 내부 파일로 포함합니다. immutable deployment filesystem에서 SQLite를 직접 열지 않고 cold start 시 `/tmp`로 복사한 뒤 read-only로 엽니다.

Preview에 KRIC 키가 없으면 fixture DB를 생성할 수 있습니다. KRIC 키가 제공된 live Preview/Production은 위 최적화된 timetable builder를 사용합니다. 환승거리 KRIC 호출은 live build 시간에 포함되지 않습니다.

## 시크릿

`SEOUL_API_KEY`, `KRIC_API_KEY`는 환경변수에서만 읽습니다. 키 값이나 키가 포함된 URL을 로그, DB metadata, TSV, PR 본문에 저장하지 않습니다.
