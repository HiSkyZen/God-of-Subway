# 실시간 여정 진행 상태

여정은 `planned → ride/transfer → done` 상태로 관리합니다. 각 세그먼트는 실제 추적 열차번호, 위치, 지연, 신뢰도를 표시하며 사용자가 다른 열차를 탔을 경우 주변 후보로 추적 대상을 교체할 수 있습니다.

실시간 위치 API가 비어 있거나 실패하면 시간표 ETA를 유지합니다. 실시간 장애 자체가 경로 계산 실패로 전파되지 않도록 `realtime_available`과 오류 진단을 결과에 남깁니다.

환승 상태는 `transfer_info`의 `mode`, `seconds`, `crowding_multiplier`를 UI에 전달합니다. `mode=same-platform`은 0초를 유효한 값으로 취급하여 “정보 없음” 대신 `제자리 환승`으로 표시합니다. 일반 환승은 출퇴근 시간 혼잡 가중치가 적용된 시간을 카운트다운합니다.

모션은 `src/client/motion.css`에 집중되어 있고 `prefers-reduced-motion: reduce`를 존중합니다.
