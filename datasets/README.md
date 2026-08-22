# Transit source datasets

이 디렉터리는 사람이 검토할 수 있는 **원천 식별/정규화 데이터**만 보관합니다. 런타임은 이 TSV 파일을 직접 읽지 않으며, `scripts/build-transit-db.ts`가 배포 시 `data/transit.sqlite`로 컴파일합니다.

- `kric/line-sources.tsv`: 지금타 논리 노선 ↔ KRIC 운영기관/노선 코드 매핑, 실시간/시간표 역할, GTX-A 구간 분리.
- `kric/stations.tsv`: 2026-02-28 KRIC 운영기관·역사 코드 스냅샷에서 추출한 지원 노선 역사 코드.
- `transfers/pair-times.tsv`: 서울교통공사 환승역 거리/소요시간 정규화본.
- `transfers/quick-transfer.tsv`: 국토교통부 빠른 환승 승차위치 정규화본.

대용량 시간표는 저장소에 CSV/JSON 스냅샷으로 복제하지 않습니다. 프로덕션 빌드에서 KRIC `subwayTimetableExp`를 우선 사용하고, 필요한 경우 `stationTimetable`로 보완해 SQLite에 직접 적재합니다. 환승은 KRIC `stationTransferInfo`와 위 정적 검토자료를 병합합니다.

실제 API 키는 어떤 TSV/문서/로그에도 기록하지 않습니다.
