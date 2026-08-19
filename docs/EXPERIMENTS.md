# Experiment Guide

클라이언트의 실험 모드는 추천 ETA와 실제 탑승/도착 결과를 비교하기 위한 로컬 기록 기능입니다. 실험 데이터는 브라우저 저장소에 보관되며 CSV/JSON으로 내보낼 수 있습니다.

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

실험 기록은 운영 정답 데이터로 자동 승격되지 않습니다. 데이터 보정이 필요하면 별도 검증 후 `data/transfer_data.json` 또는 `transfer-policy.ts`에 provenance와 함께 반영하십시오.
