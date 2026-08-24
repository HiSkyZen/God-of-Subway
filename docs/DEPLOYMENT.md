# Deployment

## 데이터 갱신과 배포 분리

Vercel deployment는 KRIC API를 호출하거나 SQLite를 생성하지 않습니다. `bun run build:all`은 서버/클라이언트/PWA만 빌드합니다.

교통 DB는 `.github/workflows/update-transit-data.yml`이 매일 **03:00 KST (`0 18 * * *` UTC)** 생성합니다.

1. `KRIC_API_KEY` repository secret 확인
2. `TRANSIT_DATA_MODE=live bun run build:data`
3. `doctor`, transfer audit, data regression
4. 검증 실패 시 기존 DB untouched
5. 검증된 DB가 변경됐을 때만 `data/transit.sqlite` bot commit

Function bundle은 `vercel.json`의 SQLite include 설정으로 검증된 DB를 포함합니다. runtime에서는 immutable bundle의 DB를 `/tmp`로 복사해 read-only로 엽니다.

## 환경변수

- `KRIC_API_KEY`: daily data workflow / 수동 live build
- `SEOUL_API_KEY`: runtime 서울 실시간 위치
- `TRANSIT_DATA_MODE`: 개발/수동 빌드의 `fixture` / `live`
- `TRANSIT_BUILD_CONCURRENCY`, `TRANSIT_BUILD_HTTP_TIMEOUT_MS`: scheduled builder 조정

키 값은 저장소·로그·SQLite metadata에 저장하지 않습니다.

## 운영 전제

GitHub repository Actions secret에 `KRIC_API_KEY`가 설정되어 있어야 scheduled live refresh가 성공합니다. secret이 없으면 workflow는 명시적으로 실패하며 기존 DB를 변경하지 않습니다.

배포 후에는 Vercel READY, `/api/health`, SQLite bundle 접근, 최신 GitHub data workflow 상태를 확인합니다.
