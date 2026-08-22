# Experiment Guide

클라이언트의 실험 모드는 추천 ETA와 실제 탑승/도착 결과를 비교하기 위한 로컬 기록 기능입니다. 실험 데이터는 브라우저 저장소에 보관되며 CSV/JSON으로 내보낼 수 있습니다. 여기서 CSV/JSON은 **사용자 실험 내보내기 형식**일 뿐 런타임 철도 데이터 저장 형식이 아닙니다.

## 기록 항목

- 검색 시 추천 ETA와 신뢰도
- 세그먼트별 추천 열차와 실제 선택 열차
- 실시간 갱신 시 ETA 변화
- 실제 도착 시각
- 추천 열차 일치 여부와 지연 관측

## 사용 절차

1. 설정에서 실험 기록을 활성화합니다.
2. 평소처럼 경로를 검색하고 이동을 시작합니다.
3. 추천과 다른 열차를 탔다면 `다른 열차를 탔어요`에서 실제 열차를 선택합니다.
4. 도착 후 실제 도착을 기록합니다.
5. 실험 목록에서 CSV 또는 JSON으로 내보냅니다.

환승시간 비교 실험에서는 `transfer_info.base_seconds`, `transfer_info.seconds`, `crowding_multiplier`, `mode`를 함께 확인해야 합니다. `mode=same-platform`은 0초가 정상 값입니다.

## 운영 데이터 반영

실험 기록은 운영 정답 데이터로 자동 승격되지 않습니다. 보정 후보는 공식/현장 근거를 별도로 검증한 뒤 다음 경로 중 적절한 곳에 provenance와 함께 반영합니다.

- 공식 환승 거리/시간 원천 변경: `datasets/transfers/`의 검토 가능한 TSV
- 승강장 구조·공용선로 같은 물리 예외: `src/engine/transfer-policy.ts`
- 수집/정규화 규칙 변경: `scripts/transit-build/`

변경 후 `bun run build:data`, `bun run doctor`, `bun run audit:transfers`, 전체 테스트를 통과시켜 SQLite 산출물과 런타임 정책이 일치하는지 확인합니다. 생성된 `data/transit.sqlite` 자체나 과거 런타임 JSON을 수동 편집하지 않습니다.
