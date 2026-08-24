# Transfer Data Policy

## 시간/거리 우선순위

1. 서울교통공사 환승거리·소요시간 데이터
2. upstream에서 검증된 fallback pair
3. 그래도 없는 pair는 보수적 topology fallback

서울교통공사 row는 fallback이 덮어쓰지 않습니다. 물리역에 논리 노선이 `n`개면 unordered 환승쌍은 정확히 `n*(n-1)/2`개여야 합니다. SQLite는 routing을 위해 directed row를 가질 수 있습니다.

KRIC `stationTransferInfo`의 거리값 및 역사 좌표는 **환승시간 계산에 사용하지 않습니다**. 미확인 pair는 JSON diagnostic으로 빌드 로그에 기록하지만 빌드를 실패시키지 않습니다.

## 위치정보 우선순위

1. 서울교통공사 방향별 빠른 환승 정보
2. 국토교통부 빠른 환승 위치
3. upstream 검증 위치
4. 국가철도공단/KRIC 정적 위치자료
5. KRIC live `stLocCont` / `clsLocCont` raw hint

KRIC 위치 문자열은 비정형이므로 의미를 과도하게 추론하지 않습니다. 확실하게 파싱 가능한 호차/문 정도만 낮은 우선순위 hint로 사용할 수 있습니다.

## 동일노선 분기

`from_line == to_line`이라고 해서 0초 환승으로 간주하지 않습니다. 가좌, 성수, 신도림, 구로, 금천구청, 병점 등은 실제 계통·승강장 변경 여부를 확인합니다. 한 열차가 그대로 through-running하는 경우에만 가짜 환승을 생성하지 않습니다.

## 공용선로

공용선로 전체를 0초로 처리하거나 중간 환승역을 삭제하지 않습니다. 각 역의 물리 이동 최소시간을 후보에 반영하고 **실제 다음 열차 대기시간과 종착/분기 여부**를 timetable에서 평가합니다.

- 경의중앙↔서해: 일산/풍산/백마/곡산은 공유 승강장 성격, 대곡은 방향에 따라 평면환승 가능, 능곡은 승강장 분리
- 4호선↔수인분당: 한대앞 등 공유구간은 편리할 수 있으나 안산 종착·오이도 시종착/착발 순서를 실제 시간표로 평가

A→B→A처럼 같은 두 노선을 짧은 구간에서 왕복 전환하는 topology artifact만 제거합니다.

## 검증

`bun run doctor`와 `bun run audit:transfers`는 SQLite 무결성/FK, 서울교통공사 authoritative row, nC2 mismatch 0, KRIC 거리 기반 환승시간 row 0, 누락 pair diagnostic, 공항철도 직통 제외를 확인합니다.
