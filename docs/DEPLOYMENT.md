# Vercel Deploy

이 저장소의 Vercel 배포 산출물은 Bun Function, React PWA 정적 파일, 그리고 빌드 시 생성되는 `data/transit.sqlite`입니다. 런타임은 레거시 `data/*.json`을 사용하지 않습니다.

## 빌드 경로

```bash
bun install --frozen-lockfile
bun run build:all
bun run verify:pwa
bun run verify:aot
```

`build:all`은 먼저 `bun run build:data`로 SQLite를 만든 뒤 서버를 `dist/server`, 브라우저/PWA 파일을 `dist/public`으로 구성합니다. `scripts/promote-static.ts`가 Bun HTML 번들러의 해시 CSS/JS를 공개 디렉터리로 정리하고 manifest/icon URL을 안정화합니다.

Vercel Function은 `vercel.json`의 `includeFiles: "data/*.sqlite"`로 SQLite를 내부 런타임 파일로 포함합니다. `/data/*` 요청은 API router에서 빈 404로 차단하여 DB를 정적 자산으로 노출하지 않습니다.

## 데이터 빌드 모드

### Production

기본값은 `live`입니다. `KRIC_API_KEY`가 반드시 필요하며 KRIC 필수 시간표가 비거나 API 호출이 실패하면 배포를 실패시킵니다. Production에서는 키가 없다는 이유로 fixture로 자동 강등하지 않습니다.

### Preview

Vercel은 빌드 시 `VERCEL_ENV=preview`를 제공합니다. `TRANSIT_DATA_MODE`가 명시되지 않았고 Preview에 `KRIC_API_KEY`가 없는 경우에만 deterministic fixture SQLite를 사용합니다. 이 정책은 PR UI/Function/AOT 검증을 secret 배포 여부와 분리하기 위한 것입니다.

Preview에도 `KRIC_API_KEY`를 설정하면 기본 live 빌드를 수행할 수 있습니다. `TRANSIT_DATA_MODE=live`를 명시한 Preview는 키가 없으면 의도적으로 실패합니다.

### CI/local

- GitHub Actions: `TRANSIT_DATA_MODE=fixture`
- 로컬 fixture: `TRANSIT_DATA_MODE=fixture bun run build:data`
- 로컬 live: `KRIC_API_KEY`를 로컬 secret 환경에만 설정하고 `bun run build:data`

## 필수/선택 환경변수

- `KRIC_API_KEY`: Production live SQLite 생성에 필수. Preview live 빌드에도 필요합니다.
- `SEOUL_API_KEY`: 서울 열린데이터광장 실시간 지하철 위치 API 키. 미설정 시 실시간 위치 기능이 degraded 상태가 됩니다.
- `TRANSIT_DATA_MODE`: `live` 또는 `fixture`. Production에서는 특별한 조사 목적이 아니면 `live`를 유지합니다.
- `TRANSIT_BUILD_CONCURRENCY`: KRIC station/day 호출 동시성.
- `TRANSIT_BUILD_HTTP_TIMEOUT_MS`: KRIC HTTP 요청 timeout.
- `TRANSIT_BUILD_ALLOW_PARTIAL`: 조사용 partial build 전용. 정상 Production에는 설정하지 않습니다.
- `SEOUL_REALTIME_BASE_URL`, `KRIC_API_BASE_URL`: 기본 API endpoint를 교체할 때만 사용합니다.
- 캐시/푸시 관련 환경변수는 실제 배포 환경의 연결 방식을 따르며, 푸시 키는 `bun run generate:vapid` / `bun run verify:vapid`로 검증합니다.

실제 API 키 값은 저장소, 빌드 로그, SQLite `metadata/build_source`, PR 본문에 기록하지 않습니다.

## 배포 후 확인

1. Vercel deployment state가 `READY`인지 확인합니다.
2. `/api/health`가 `ok: true`인지 확인합니다.
3. `/data/transit.sqlite`가 404인지 확인합니다.
4. 역 검색에서 신촌/양평이 노선별 후보로 분리되는지 확인합니다.
5. 대곡 경의중앙선↔서해선이 `제자리 환승`으로 표시되지 않는지 확인합니다.
6. PWA manifest/service worker가 정상 로드되는지 확인합니다.

Vercel 계정/프로젝트 ID와 secret 값은 저장소에 하드코딩하지 않습니다.
