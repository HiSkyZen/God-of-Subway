# 문서 인덱스

이 디렉터리는 현재 Bun/TypeScript + SQLite 구현의 기준 문서입니다. 레거시 런타임 JSON/FastAPI 데이터 경로는 기준으로 사용하지 않습니다.

- [`SQLITE_TRANSIT_DATA.md`](SQLITE_TRANSIT_DATA.md): build-time SQLite 스키마, KRIC 수집, fixture/live 모드, provenance
- [`ARCHITECTURE.md`](ARCHITECTURE.md): 서버, 클라이언트, 엔진, SQLite 데이터 흐름과 모듈 경계
- [`TRANSFERS.md`](TRANSFERS.md): 서울교통공사/KRIC 환승 데이터 우선순위, 1.2m/s fallback, 동명이의역·공용선로 정책
- [`RAPID_SERVICE.md`](RAPID_SERVICE.md): 급행 운행 노선과 급행↔완행 후보 생성 방식, 공항철도 직통 제외 정책
- [`DEVELOPMENT.md`](DEVELOPMENT.md): fixture/live 로컬 개발, 데이터 감사, 테스트
- [`OPERATIONS.md`](OPERATIONS.md): SQLite 운영 점검 순서와 장애/데이터 확인 기준
- [`DEPLOYMENT.md`](DEPLOYMENT.md): Vercel Preview/Production 데이터 빌드 정책과 배포 후 확인 절차
- [`gtx-a-timetable-source.md`](gtx-a-timetable-source.md): GTX-A SQLite 시간표, 북부/남부 토폴로지, 실시간 결합
- [`EXPERIMENTS.md`](EXPERIMENTS.md): 실험 기록과 보정 데이터 취급 원칙
- [`realtime-progress-design.md`](realtime-progress-design.md): 실시간 여정 진행 상태와 시간표 fallback

데이터 원천 파일 자체의 설명은 [`../datasets/README.md`](../datasets/README.md)를 참고하십시오.
