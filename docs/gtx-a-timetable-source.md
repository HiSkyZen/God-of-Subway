# GTX-A 시간표/토폴로지 데이터

GTX-A는 북부(운정중앙–서울역)와 남부(수서–동탄)가 분리 운행되므로 엔진에서도 `GTX-A(북부)`, `GTX-A(남부)` 두 논리 계통으로 관리합니다. 일반 지하철 그래프와 후보 생성 단계에서 함께 비교하지만 두 구간 사이를 존재하지 않는 직통 서비스로 연결하지 않습니다.

## 시간표 원천

GTX-A 시간표는 더 이상 `src/engine`의 하드코딩 배열이나 별도 JSON을 기준으로 하지 않습니다. Production `bun run build:data`가 `datasets/kric/line-sources.tsv` 및 역사 코드 스냅샷을 이용해 KRIC 시간표를 수집하고 `data/transit.sqlite`의 `trip`/`stop_time`/`ride_edge`에 적재합니다.

CI와 secret 없는 Vercel Preview는 같은 스키마의 deterministic fixture를 사용합니다. 시간표 변경은 소스 코드를 직접 편집하는 대신 KRIC 원천/정규화 결과와 SQLite 빌드를 검증합니다.

## 토폴로지와 실시간

`src/engine/gtx-topology.ts`는 북부/남부 물리 구간 분리와 실시간 매칭 경계를 유지합니다. 서울 실시간 위치 API의 GTX-A 노선 ID와 SQLite 열차를 매칭해 지연을 보정하되, 실시간 데이터가 없거나 매칭되지 않으면 SQLite 시간표를 사용합니다.

GTX-A 열차번호는 내부 추적 식별자와 UI 표시값을 분리합니다. 경로 후보의 도착시각이 완전히 같으면 불필요한 GTX-A 사용을 피하도록 비GTX 경로를 우선할 수 있지만, 실제 ETA가 더 빠른 GTX-A 경로를 인위적으로 낮추지는 않습니다.

## 변경 시 검증

- 운영 구간/역 순서 변경: `datasets/kric/*`, `src/engine/gtx-topology.ts`, 관련 테스트를 함께 검토
- KRIC 시간표 정규화 변경: `scripts/transit-build/timetable.ts`와 SQLite fixture/live 결과 비교
- 실시간 노선 ID/응답 변경: `src/engine/realtime-service.ts` 매칭 규칙 검토
- 모든 변경 후 `bun run check`, `verify:pwa`, `verify:aot` 통과 확인
