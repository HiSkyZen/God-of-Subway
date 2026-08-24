# Architecture

## Data boundary

- 정적 timetable/transfer topology: SQLite
- 서울 실시간 위치: runtime API/cache 계층
- 사람이 검토하는 mapping/fallback source: `datasets/`

Runtime routing은 SQLite graph와 timetable을 읽고 JSON/CSV source 파일을 직접 읽지 않습니다. Production SQLite 생성은 deployment가 아니라 daily data workflow가 담당합니다.

## Routing

자동경로 후보는 시간 최단 후보, `(환승횟수, 정적시간)` lexicographic 후보, 공용선로의 유효 환승역 후보를 합친 뒤 실제 timetable ETA로 재평가합니다.

목적함수:
- `fastest`: 실제 도착시각 → 동률이면 비GTX → 최소환승
- `fewest_transfers`: 환승횟수 → 실제 도착시각
- `lowest_cost`: 예상 운임 → 실제 도착시각

공용선로에는 임의의 역 bonus/penalty를 사용하지 않습니다. 물리 이동시간과 실제 연결열차 대기를 분리해 평가합니다.

## Transfer boundary

환승시간은 Seoul authoritative → upstream fallback이며 KRIC 거리/좌표 기반 환승시간 모델은 없습니다. KRIC transfer API는 낮은 우선순위 raw 위치 hint만 제공합니다. 물리 환승쌍은 nC2로 검증합니다.

동일노선 분기와 다중 승강장은 단순 `same line = 0s`로 처리하지 않습니다. 공용선로도 역·방향·실제 열차 연결별로 평가합니다.

## Timetable boundary

KRIC timetable은 dayCd 8/9만 사용하며 SAT=END입니다. 급행은 KRIC 표기를 보조적으로 사용하고 열번/skip/추월 구조로 보완합니다. 공항철도 직통은 생성 DB에서 제외합니다.

## Fare boundary

역 좌표는 예상 운임거리 전용입니다. 환승 보행시간이나 플랫폼 이동거리에는 사용하지 않습니다.
