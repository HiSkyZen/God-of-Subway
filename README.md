# 지금타 (God-of-Subway, Bun/TypeScript)

수도권 전철의 정적 시간표, 서울시 실시간 열차 위치, 환승 동선 데이터를 결합해 **도착시각 기준 경로**를 계산하는 Bun + TypeScript 서비스입니다. 이 저장소는 `unending314/God-of-Subway` Python/FastAPI 구현을 Bun 런타임으로 이식한 다운스트림이며, 현재 기본 개발선은 `dev/ts-bun`입니다.

## 현재 기능

- 1~9호선, 경의중앙선, 수인분당선, 경춘선, 경강선, 서해선, 공항철도, 신분당선, 인천1호선, 인천2호선, 용인에버라인, 김포골드라인, 의정부경전철, 우이신설선, 신림선, GTX-A 북부/남부 경로 계산
- 서울 열린데이터광장 실시간 위치를 이용한 지연/ETA 보정과 실시간 장애 시 시간표 fallback
- 실시간 위치를 직접 사용하지 않는 노선은 평일/휴일 시간표 기반으로 ETA와 자동경로 계산
- 업스트림 V13.5.4 환승 데이터 + 네트워크 토폴로지 completion + 물리 승강장 검증 오버라이드
- 동명이의역(예: 신촌, 양평) 노선 식별 검색 및 잘못된 자동 환승 차단
- 1호선·4호선·9호선·경의중앙선·수인분당선·경춘선 급행/완행 교체 후보 평가
- 공용선로의 동일 방향 제자리 환승과 반대 방향 승강장 이동 분리
- 평일 06:50–09:30 / 16:50–19:30 혼잡도 예측에 따른 환승시간 가중치(최대 1.75배)
- React PWA UI, 여정 추적, 즐겨찾기, 실험 기록, 푸시 알림

## 빠른 시작

```bash
bun install
bun run doctor
bun run dev
```

검증은 `bun run check`로 실행합니다. 실시간 서울 지하철 위치 조회에는 `SEOUL_API_KEY`가 필요하며, 키가 없거나 API가 실패하면 정적 시간표 기반으로 계산합니다.

## 저장소 구조

```text
api/          Vercel Function 진입점
src/
  api/        HTTP 계약과 핸들러
  client/     React PWA UI
  engine/     시간표, 실시간 ETA, 라우팅, 환승/급행 정책
  infra/      캐시·관측성·푸시 등 기반 기능
  types/      공유 도메인 타입
data/         빌드/런타임에서 읽는 정적 시간표·그래프·환승 JSON
scripts/      빌드·검증·데이터 감사 도구
tests/        API·클라이언트·엔진 테스트
docs/         아키텍처·데이터·개발·운영·실험·배포 문서
```

세부 설계는 [`docs/README.md`](docs/README.md)에서 시작하십시오.

## 데이터 정책

환승시간은 `data/transfer_data.json`의 기존 값을 우선하고, 지원 네트워크에서 빠진 동일역 노선 조합은 `data/transfer_overlay.json`으로 보완합니다. 실제 승강장 구조와 충돌하는 항목은 `src/engine/transfer-policy.ts`의 물리 정책 오버라이드가 우선합니다. 런타임 병합 데이터에서는 소요시간 누락과 고정 240초 placeholder를 허용하지 않습니다.

값이 존재하는 것과 현장 실측이 완료된 것은 구분합니다. 업스트림 V13.5.4 감사 기준 방향/위치 등 추가 검증 대상 124건은 별도 backlog로 유지합니다. 자세한 우선순위와 공용선로 예외는 [`docs/TRANSFERS.md`](docs/TRANSFERS.md)를 참고하십시오.

## 배포

```bash
bun run build:all
bun run verify:pwa
bun run verify:aot
```

Vercel 배포 절차는 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)에 정리되어 있습니다.

## 라이선스/데이터 취급

원본 코드 및 포함된 공공데이터의 라이선스 조건을 따릅니다. 일회성 외부 검증 과정에서 사용한 수집 경로·서비스별 메타데이터는 런타임 코드와 프로젝트 문서에 저장하지 않습니다.