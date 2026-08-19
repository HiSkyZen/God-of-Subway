# Vercel Deploy

이 저장소의 배포 산출물은 Bun 서버 번들과 React PWA 정적 파일입니다.

## 사전 검증

```bash
bun install --frozen-lockfile
bun run check
bun run build:all
bun run verify:pwa
bun run verify:aot
```

`build:all`은 서버를 `dist/server`, 브라우저/PWA 파일을 `dist/public`으로 구성합니다. `scripts/promote-static.ts`가 Bun HTML 번들러의 해시 CSS/JS를 공개 디렉터리로 정리하고 manifest/icon URL을 안정화합니다.

## 필수/선택 환경변수

- `SEOUL_API_KEY`: 서울 열린데이터광장 실시간 지하철 위치 API 키. 미설정 시 실시간 위치 기능이 degraded 상태가 됩니다.
- `SEOUL_REALTIME_BASE_URL`: 기본 실시간 API 엔드포인트를 교체할 때만 사용합니다.
- 캐시/푸시 관련 환경변수는 실제 배포 환경의 연결 방식을 따르며, 푸시 키는 `bun run generate:vapid` / `bun run verify:vapid`로 검증합니다.

## 배포 후 확인

1. `/api/health`가 `ok: true`인지 확인합니다.
2. `upstream_parity`와 `transfer_policy` 버전이 기대값인지 확인합니다.
3. 역 검색에서 신촌/양평이 노선별 후보로 분리되는지 확인합니다.
4. 대곡 경의중앙선↔서해선이 `제자리 환승`으로 표시되지 않는지 확인합니다.
5. PWA manifest/service worker가 정상 로드되는지 확인합니다.

Vercel 설정은 플랫폼 UI/CLI가 변경될 수 있으므로, 저장소에는 특정 계정/프로젝트 ID를 하드코딩하지 않습니다.
