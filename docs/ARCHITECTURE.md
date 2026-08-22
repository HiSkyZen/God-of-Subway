# Architecture

## 목표

지금타는 “정적 시간표로 가능한 경로를 만들고, 실시간 관측으로 실제 도착시각을 다시 채점한다”는 원칙으로 구성됩니다. 라우팅 그래프의 정적 비용은 후보 생성용이며 최종 추천은 ETA 계산 결과가 결정합니다.

## 데이터 경계

정적 철도 데이터의 런타임 단일 소스는 `data/transit.sqlite`입니다. 사람이 검토해야 하는 운영기관·노선·역 코드, 휴일, 서울교통공사 환승 원천은 `datasets/*.tsv`에 유지하고 `scripts/build-transit-db.ts`가 빌드 시 SQLite로 컴파일합니다. 대용량 시간표 JSON/CSV는 저장소에 두지 않습니다.

프로덕션 live 빌드는 KRIC `subwayTimetableExp`를 우선 사용하고 `convenientInfo/stationTimetable`로 보완합니다. 환승은 서울교통공사 정규화 원천을 먼저 적재하고 누락된 노선쌍만 KRIC `convenientInfo/stationTransferInfo`로 보완합니다. 서울 열린데이터광장 실시간 열차 위치는 SQLite와 분리된 네트워크 계층입니다.

## 계층

### `src/api`
HTTP 입력을 검증해 엔진 함수에 전달합니다. API 계층은 철도 규칙을 소유하지 않습니다.

### `src/engine`
- `data-repository.ts`: `bun:sqlite` 기반 읽기 전용 repository. 시간표·역·그래프·환승·휴일 view를 엔진 계약으로 물질화합니다.
- `timetable-service.ts`: 노선별 `DAY/SAT/END` 시간표, 역 정규화, 열차 조회
- `realtime-service.ts`: 서울시 실시간 위치와 캐시
- `eta-service.ts`: 시간표 열차와 실시간 열차 매칭, 지연 관측, 구간 ETA
- `routing-service.ts`: SQLite `ride_edge`/`transfer_pair` 기반 후보 경로, 동명이의역 물리 분리, 환승 세그먼트
- `transfer-policy.ts`: 물리 승강장 오버라이드와 혼잡 가중치
- `rapid-service.ts`: 급행/완행 서비스 분류와 교체 가능성
- `gtx-service.ts`, `gtx-topology.ts`: GTX-A 구간과 일반 노선 혼합 후보

### `src/client`
React PWA입니다. 검색 후보는 `노선 아이콘 + 노선명 + 역명`으로 표시하여 같은 역명을 가진 물리적으로 다른 역을 구분합니다. 선택값에 노선 식별자를 보존하여 엔진이 잘못된 자동 환승을 만들지 않습니다.

### `src/infra`
`transit-schema.ts`가 SQLite 정규형과 스키마 버전을 소유합니다. 그 외 라우팅 규칙과 분리된 캐시, 관측성, 푸시 등 운영 기능을 둡니다.

## 자동 경로 흐름

1. 검색 입력을 역명/노선 선택자로 해석합니다.
2. SQLite `ride_edge`를 승차 엣지로, `transfer_pair`와 감사된 물리 공용선로 정책을 환승 엣지로 구성합니다.
3. Yen/Dijkstra 기반으로 다수 후보를 만듭니다.
4. 급행 운영 노선에서는 실제 시간표의 서비스/정차 패턴을 보고 급행↔완행 분할 후보를 추가합니다.
5. 환승 세그먼트에 물리 승강장 정책과 혼잡 가중치를 적용합니다.
6. `eta-service`가 SQLite 시간표와 가능한 경우 실시간 위치를 이용해 후보별 도착시각을 계산합니다.
7. 가장 이른 실제 ETA를 선택하고 동일 ETA에서는 불필요한 GTX-A 사용을 피합니다.

## 빌드/배포 모드

- 로컬/Production 기본값: `live`. `KRIC_API_KEY`가 없거나 필수 노선 시간표가 비면 빌드 실패.
- CI: `TRANSIT_DATA_MODE=fixture`로 외부 API 없이 동일 스키마를 검증.
- Vercel Preview: 명시한 `TRANSIT_DATA_MODE`가 없고 `KRIC_API_KEY`도 없으면 deterministic fixture SQLite로 빌드. Preview에 키가 있으면 기본 live 빌드.

Preview fallback은 PR 검증을 비밀키 배포 여부와 분리하기 위한 것이며 Production의 fail-closed live 정책을 약화하지 않습니다.

## 중요한 불변조건

- 런타임은 레거시 `data/*.json`을 읽지 않습니다.
- 동일한 한글 역명만으로 환승 가능성을 추론하지 않습니다.
- `0초`는 유효한 제자리 환승 값이며 falsy로 버리지 않습니다.
- 공용선로도 반대 방향이면 자동으로 제자리 환승이 아닙니다.
- 대곡 경의중앙선↔서해선은 0초가 아닙니다.
- 서울교통공사 환승 원천은 KRIC fallback보다 우선합니다.
- KRIC 거리 fallback은 `round(distance_m / 1.2)`를 사용합니다.
- 공항철도 직통열차는 급행↔완행 교체 후보 및 생성 시간표에서 제외합니다.
- 측정값과 모델링/추정값의 provenance를 구분합니다.
- 혼잡 가중치는 1.75를 넘지 않습니다.
