# 환승 데이터와 물리 환승 정책

## 데이터 우선순위

런타임은 레거시 환승 JSON을 읽지 않습니다. SQLite에는 환승 **토폴로지와 서울교통공사 원천**을 저장하고, 서울교통공사에 없는 KRIC 거리는 실제 경로 계산 시 필요한 pair만 조회합니다.

1. 물리 승강장 오버라이드 (`src/engine/transfer-policy.ts`)
2. `datasets/transfers/seoul-metro-transfer-times.tsv`의 서울교통공사 2025-12-31 방향별 거리/시간
3. KRIC `convenientInfo/stationTransferInfo` 런타임 거리 조회
4. KRIC 조회가 불가능할 때의 명시적 추정/placeholder 정책

서울교통공사 값은 KRIC가 덮어쓰지 않습니다. KRIC `chtnDst`를 사용한 경우 환승시간은 정확히 다음과 같습니다.

```text
seconds = round(chtnDst_m / 1.2)
```

과거 `distance / 1.1m/s + 25초`, `240→247초` 같은 별도 보정은 사용하지 않습니다.

## 한 역의 환승 pair 수: nC2

환승거리는 “역당 하나”가 아니라 **물리 역의 노선쌍마다 하나**입니다. 한 물리 역에 서로 환승 가능한 논리 노선이 `n`개이면 서로 다른 unordered pair 수는 다음과 같습니다.

```text
pair_count = n * (n - 1) / 2
```

예를 들어 2개 노선은 1개, 3개 노선은 3개, 4개 노선은 6개의 물리 환승 pair를 가집니다.

빌드 시 `station_id`별 논리 노선을 그룹화해 정확히 nC2 토폴로지를 생성합니다. SQLite `transfer_pair`는 경로 탐색을 위해 방향별 row를 가지므로 하나의 unordered pair가 최대 두 directed row로 표현됩니다. 서울교통공사 row가 이미 존재하면 유지하고 누락 방향만 `runtime-kric-pending` placeholder로 채웁니다.

신촌(2호선/경의중앙선), 양평(5호선/경의중앙선)처럼 이름만 같은 별도 물리 역은 서로 다른 `station_id`이므로 nC2 계산에 섞지 않습니다.

## KRIC 런타임 조회

배포 시 `stationTransferInfo`를 전수 호출하지 않습니다. 경로 후보에 실제로 등장한 `역 + 노선 A + 노선 B` pair가 `runtime-kric-pending`일 때만 다음 순서로 처리합니다.

1. SQLite의 해당 `station_id`에서 운영기관/노선/역 코드를 찾습니다.
2. KRIC `stationTransferInfo`를 호출합니다.
3. 응답의 `chtnLn`을 대상 노선에 매칭하고 해당 pair의 `chtnDst`만 사용합니다.
4. 같은 pair에 여러 거리 row가 있으면 중앙값을 사용합니다.
5. `round(chtnDst / 1.2)`를 계산해 현재 Function 인스턴스의 transfer pair를 갱신합니다.
6. Valkey/메모리 캐시에 저장해 같은 pair의 반복 API 호출을 피합니다.

한 역에 여러 환승 노선이 있어도 하나의 역 대표 거리로 합치지 않습니다. 캐시 키 역시 `station_id + 정렬된 두 노선`의 unordered pair 단위입니다.

KRIC 장애나 미설정 시에는 cached stale 값이 있으면 사용하고, 없으면 DB의 보수적 placeholder/모델값으로 경로 계산을 계속합니다.

## 공용선로와 제자리 환승

현재 서비스에서 별도 물리 정책을 적용하는 핵심 공용선로는 다음과 같습니다.

- 경의중앙선 ↔ 경춘선: 청량리–상봉
- 경의중앙선 ↔ 수인분당선: 청량리–왕십리
- 4호선 ↔ 수인분당선: 한대앞–오이도
- 경의중앙선 ↔ 서해선: 대곡–일산

동일 방향 동일 승강장 면처럼 검증된 경우에만 0초 제자리 환승을 허용합니다. 대곡·능곡 등 승강장이 분리된 역은 공용선로라는 이유만으로 0초가 되지 않습니다. 이러한 물리 override는 일반 KRIC 거리보다 우선합니다.

## 검증

`build:data`, `doctor`, `audit:transfers`는 다음을 검사합니다.

- 서울교통공사 row가 보존되는지
- deploy-time KRIC 환승거리 row가 0건인지
- 물리 역별 unordered pair 수가 정확히 nC2인지
- `runtime-kric-pending`이 유효한 directed routing row인지
- 공항철도 직통 또는 동명이의역 금지 연결이 환승 토폴로지에 섞이지 않는지
