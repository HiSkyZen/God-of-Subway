# SQLite 철도 데이터 아키텍처

## 목표

정적 시간표·노선 그래프·환승 JSON을 런타임 의존성에서 제거하고, 매 빌드마다 검증 가능한 원천 데이터와 KRIC OpenAPI로 단일 SQLite 데이터베이스를 생성한다. 서울 열린데이터광장 실시간 위치 API는 정적 DB와 분리한다.

## 빌드 경로

`datasets/*.tsv` → 역사/노선 식별자 및 검토 가능한 환승 자료

KRIC OpenAPI → `subwayTimetableExp`(DAY=8, SAT=7, END=9), `stationTimetable` fallback, `stationTransferInfo`

`bun run build:data` → `data/transit.sqlite`

Vercel Function → 읽기 전용 `bun:sqlite`

CI는 외부 API/시크릿 없이 동일 스키마를 검증하기 위해 `TRANSIT_DATA_MODE=fixture`를 사용한다. 프로덕션은 기본 `live` 모드이며 `KRIC_API_KEY`가 없거나 필수 노선 시간표가 비어 있으면 빌드를 실패시킨다. `TRANSIT_BUILD_ALLOW_PARTIAL=1`은 조사 목적에만 사용한다.

## 정규형

- `source_registry`: 운영기관/노선 코드와 논리 노선의 관계
- `station`, `station_source`: 물리 역사와 각 소스의 역사 코드
- `trip`, `trip_source`, `stop_time`: 운행일·열차·정차시각
- `ride_edge`: 실제 시간표에서 집계한 인접 정차역 운행시간
- `transfer_pair`, `transfer_detail`: 환승시간/거리와 방향별 빠른 환승 위치
- `holiday`: 서비스 운행일 판정
- `metadata`, `build_source`: 재현성/출처/빌드 상태

`DAY`, `SAT`, `END`는 별도 저장한다. 자정 이후 02:00 이전 운행은 전일 서비스의 24시간 초과 시각으로 정규화한다.

## 급행/완행/직통

KRIC `exptCd`를 우선해 `local`, `express`, `direct`로 정규화하며 각각 우선순위 10/20/30을 가진다. 경로 선택의 제1 기준은 실제 예상 도착시각이고, 급행/직통 표지는 동률/대안 탐색과 동일 노선 서비스 전환에 사용한다. 공항철도 직통도 급행 계열로 취급한다.

## 실시간 결합

서울 실시간 API는 기존 노선 ID(1001~1009, 1063, 1065, 1067, 1075, 1077, 1081, 1093, GTX-A 1032)를 유지한다. 실시간 열차번호/역명을 SQLite `trip`/`station`과 매칭해 지연을 계산한다. 실시간이 없는 인천1·2호선, 에버라인, 의정부경전철, 우이신설선, 신림선, 김포골드라인은 SQLite 시간표만 사용한다.

GTX-A도 더 이상 별도 하드코딩 시간표를 사용하지 않고 SQLite 시간표를 사용하되, 서울 실시간 위치와 북부/남부 토폴로지 분리는 유지한다.

## 시크릿

`SEOUL_API_KEY`, `KRIC_API_KEY`는 환경변수에서만 읽는다. DB의 `metadata/build_source`, 로그, PR 본문, 원천 TSV에 키나 키가 포함된 URL을 저장하지 않는다.
