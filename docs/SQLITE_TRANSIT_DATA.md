# SQLite Transit Data

## 런타임 계약

런타임 정적 교통 데이터의 단일 source of truth는 `data/transit.sqlite`입니다. JSON/CSV 시간표를 runtime에서 읽지 않습니다.

주요 테이블은 `source_registry`, `station`, `station_source`, `trip`, `trip_source`, `stop_time`, `ride_edge`, `transfer_pair`, `transfer_detail`, `transfer_location_hint`, `holiday`, `metadata`, `build_source`입니다.

## 시간표 수집

Production daily builder는 KRIC 시간표를 최우선으로 사용합니다.
- 평일: `dayCd=8`
- 주말·공휴일: `dayCd=9`
- SAT row는 END(dayCd=9)를 복제
- `dayCd=7` 요청 없음

지원역 전체를 대상으로 endpoint를 탐색한 뒤 fan-out합니다. KRIC에서 특정 source를 얻지 못한 경우에만 보유한 fallback timetable을 사용할 수 있습니다.

KRIC 급행 표시는 보조정보입니다. 서비스 종류는 검증된 열번, 중간역 skip, 추월 관계 같은 구조적 timetable 증거로 보완합니다. 종착/분기 때문에 뒤 역이 없는 열차를 급행으로 오판하지 않아야 합니다. 공항철도 직통은 DB 생성에서 제외합니다.

## 환승

시간/거리: 서울교통공사 → upstream fallback. KRIC 거리나 좌표로 환승시간을 계산하지 않습니다.

위치: 서울 상세 → MOLIT 빠른환승 → upstream → KRIC/KR 정적 위치 → KRIC live raw 위치 hint.

각 물리역의 서로 다른 노선쌍은 nC2로 검증합니다. 그래도 없는 pair는 non-fatal JSON diagnostic과 보수적 topology fallback으로 남깁니다.

## 운임 좌표

MOLIT 역사 좌표 snapshot은 `station.latitude/longitude`에 적재되며 **예상 운임거리**에만 사용합니다. 플랫폼 보행거리나 환승시간에는 사용하지 않습니다.

## 생성/검증

개발/CI fixture:
```bash
TRANSIT_DATA_MODE=fixture bun run build:data
bun run doctor
bun run audit:transfers
```

수동 live:
```bash
KRIC_API_KEY=... TRANSIT_DATA_MODE=live bun run build:data
```

생성은 temporary SQLite에 수행한 뒤 integrity/FK/coverage 검증을 통과해야 기존 DB를 교체합니다. Production deployment 자체는 `build:data`를 실행하지 않습니다.
