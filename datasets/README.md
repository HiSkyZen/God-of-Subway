# Transit source datasets

이 디렉터리는 사람이 검토할 수 있는 **원천 식별/정규화 데이터**만 보관합니다. 런타임은 이 TSV 파일을 직접 읽지 않으며, `scripts/build-transit-db.ts`가 배포 시 `data/transit.sqlite`로 컴파일합니다.

- `kric/line-sources.tsv`: 지금타 논리 노선 ↔ KRIC 운영기관/노선 코드 매핑, 실시간/시간표 역할, GTX-A 구간 분리.
- `kric/stations/stations-01.tsv` ~ `stations-10.tsv`: 2026-02-28 KRIC 운영기관·역사 코드 스냅샷에서 추출한 지원 노선 역사 코드.
- `transfers/seoul-metro-transfer-times.tsv`: 제공된 서울교통공사 2025-12-31 환승역 거리/소요시간 145개 방향별 레코드. SQLite 적재 시 KRIC보다 우선한다.
- `calendar/kr-holidays.tsv`: 2026~2035 대한민국 공휴일/대체공휴일 정규화본.

대용량 시간표는 저장소에 CSV/JSON 스냅샷으로 복제하지 않습니다. 프로덕션 빌드는 KRIC `trainUseInfo/subwayTimetableExp`를 우선 사용하고, 응답이 비거나 실패한 역사/요일 요청은 `convenientInfo/stationTimetable`로 보완해 SQLite에 직접 적재합니다.

환승은 먼저 서울교통공사 TSV를 적재한 뒤 해당 자료에 없는 환승쌍만 KRIC `convenientInfo/stationTransferInfo`로 채웁니다. KRIC 환승거리는 `round(distance_m / 1.2)`초로 변환하며 서울교통공사 레코드를 덮어쓰지 않습니다.

공항철도 직통열차는 생성 시간표와 도시철도 급행/완행 비교에서 제외하며 일반열차는 유지합니다.

실제 API 키는 어떤 TSV/문서/로그에도 기록하지 않습니다.
