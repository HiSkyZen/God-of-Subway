# 지금타 — Bun/Vercel 배포

현재 배포 진입점은 `api/index.ts`입니다. 로컬과 일반 Bun 호스팅은
`src/server.ts`의 `Bun.serve`를 사용하고, Vercel에서는 같은 Fetch handler를 Bun
Function으로 호출합니다.

## Vercel 런타임 근거

Vercel 공식 Bun runtime 문서(2025-11-10, 2026년 현재 확인)는 `vercel.json`에
`"bunVersion": "1.x"`를 지정하면 `/api/*.ts` Function을 Bun에서 실행한다고
명시합니다. Bun runtime은 Public Beta이므로 배포 전 Preview에서 계약 테스트를
수행합니다. Vercel Function은 장기 실행 `Bun.serve` 프로세스를 열지 않으며,
`api/index.ts`의 `default { fetch(request) }` 어댑터가 요청 단위로 실행됩니다.

공식 참고:
- https://vercel.com/docs/functions/runtimes/bun
- https://vercel.com/docs/functions/runtimes
- https://vercel.com/docs/cron-jobs
- https://vercel.com/docs/cron-jobs/manage-cron-jobs

## 로컬·AOT 실행

```powershell
bun install
bun run dev
bun run build:all
bun run start
```

서버 AOT는 다음 명령과 동일한 대상(비공개 `dist/server`)으로 빌드됩니다.

```powershell
bun build --target=bun --production --outdir=dist/server ./src/server.ts
```

`build:all`은 HTML import 산출물을 `dist/public`으로 승격하고, `dist/server`에는
서버 번들만 남깁니다. Vercel `outputDirectory`도 `dist/public`이므로 서버 번들과
소스 경로가 정적 파일로 노출되지 않습니다. `build:client`는 안정 경로
`/sw.js`, manifest, icons를 생성하며 `bun run verify:pwa`가 실제 참조 파일과
MIME/size/orphan을 확인합니다. `bun run verify:aot`는 AOT 서버를 기동해 정적/API
경로를 다시 요청합니다.

## GitHub 저장소 구조
저장소 루트에 이 폴더의 파일을 그대로 올립니다.

핵심 파일:
- `api/index.ts`: Vercel Bun Function adapter
- `src/server.ts`: 일반 Bun.serve/AOT entrypoint
- `src/engine`: 지하철 계산 엔진
- `src/client`: React/PWA frontend
- `*.json`: 공식 시간표 / 역 / 공휴일 데이터
- `vercel.json`: Bun runtime, static output, Function data include 목록

## Vercel Dashboard
1. https://vercel.com/new
2. GitHub 저장소 Import
3. Framework Preset은 Other 또는 Bun 호환 preset을 사용
   - 자동 감지가 안 되면 Other를 선택해도 됨
4. Root Directory: 저장소 루트
5. Build Command는 `bun run build:all` (저장소의 `vercel.json`에 포함)
6. Environment Variables:
   SEOUL_API_KEY = 서울 열린데이터광장 인증키
7. Deploy

## 배포 후 확인
- /
- /api/health
- /api/stations

/api/health에서:
- ok: true
- api_key_configured: true
인지 확인.

## 중요
Vercel은 `api/index.ts`의 Bun Function을 실행합니다. `src/server.ts`가 Vercel에서
직접 listener를 열지 않도록 `import.meta.main` 경계를 유지합니다.
`/api/:path*` rewrite가 `/api` Function으로 모일 때 Vercel이 전달하는 `path`
wildcard query를 `api/index.ts`가 원래 `/api/<path>`로 복원합니다. 이미 원래
pathname으로 들어온 Function 요청은 그대로 처리합니다. 이 두 경계는
`tests/api/vercel-adapter.test.ts`에서 각각 검증합니다.

## Web Push 환경변수

선택 기능인 Web Push를 사용하려면 다음을 설정합니다.

```text
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:owner@example.com
PUSH_REDIS_URL=<persistent Redis REST endpoint>
PUSH_REDIS_TOKEN=<Redis bearer token>
CRON_SECRET=<Vercel Pro 또는 외부 scheduler secret>
PUSH_SCHEDULER_MODE=external
PUSH_MAX_SUBSCRIPTIONS=5000
PUSH_MAX_SUBSCRIPTIONS_PER_SOURCE=20
PUSH_MAX_ALERTS=5000
PUSH_REGISTRATION_RATE_LIMIT=30
PUSH_REGISTRATION_RATE_WINDOW_SECONDS=3600
PUSH_REDIS_SCAN_COUNT=100
PUSH_DISPATCH_LEASE_SECONDS=90
PUSH_DELIVERY_CLAIM_SECONDS=90
```

VAPID public key는 canonical base64url 65바이트 uncompressed P-256(첫 byte
`0x04`), private key는 32바이트여야 하며 subject는 `mailto:` 또는 `https:` URI여야
합니다. 형식이 하나라도 틀리면 capability는 false입니다.
`VAPID_PRIVATE_KEY`와 `PUSH_REDIS_TOKEN`은 응답·로그·커밋에 절대 포함하지
않습니다. 개발 환경은 `.push-subscriptions.json` durable store를 사용하고,
Production은 Redis REST adapter가 없으면 capability를 비활성화합니다.
`PUSH_REDIS_URL`은 credential과 fragment가 없는 parse 가능한 `https://` URL이어야
합니다. HTTP, credential 포함, malformed URL은 저장소를 만들기 전에 거부하므로
해당 주소로 `PUSH_REDIS_TOKEN`이 전송되지 않습니다.
`/api/push/test`는 개발 환경에서만 `PUSH_TEST_ENABLED=1`과
`x-push-test-token` 인증으로 실제 `web-push` 발송을 수행합니다. ETA 알림은
`POST /api/push/alerts` 등록 후 `/api/push/dispatch`가 엔진 ETA를 재평가하고
임계값 도달 시 1회 발송합니다. Vercel Cron은 configured path에 GET을 보내며
`CRON_SECRET`을 Bearer로 전달하므로 `GET /api/push/dispatch`를 사용합니다.
기본 `vercel.json`에는 Hobby 배포를 깨뜨리는 분 단위 cron을 넣지 않았습니다.
Pro/외부 scheduler에서는 1분 이상 주기로 해당 GET을 호출하고, 일반 Bun
호스팅에서는 `PUSH_SCHEDULER_INTERVAL_SECONDS`(최소 60초)와 인증 환경변수를
함께 설정할 때만 프로세스 내 interval이 활성화됩니다. `PUSH_DISPATCH_BATCH_SIZE`
와 `PUSH_DISPATCH_CONCURRENCY`로 호출당 평가량과 동시성을 제한합니다. Vercel에서는
프로세스 상주 interval을 capability로 광고하거나 시작하지 않으며 external mode만
사용합니다. Redis의 영속 HSCAN cursor가 호출마다 다음 batch로 이동하고,
`SET NX EX` dispatch lease(최소 90초)와 token 비교 해제가 cron 중첩 발송을 막습니다.
각 alert는 ETA 계산 후 현재 ID를 원자적으로 다시 확인하고 endpoint별 claim을
획득한 뒤에만 발송합니다. claim 중 교체 요청은 409로 재시도하게 하며,
`PUSH_DELIVERY_CLAIM_SECONDS`는 Vercel 60초 실행 한도를 덮도록 최소 90초입니다.

Vercel에서는 플랫폼이 설정하는 forwarded client address만 source quota/rate-limit에
신뢰합니다. 일반 Bun을 reverse proxy 뒤에 둘 때만 `PUSH_TRUST_PROXY=1`을 설정하고
proxy가 외부의 `X-Forwarded-For`/`X-Real-IP`를 제거·재작성하도록 구성해야 합니다.
직접 Bun 노출에서는 모든 미확인 client를 하나의 보수적 bucket으로 취급합니다.
`POST /api/push/alerts/status`는 `{alert_id, subscription_endpoint,
management_token}` JSON body로 발송/만료 후 active 상태를 reconcile합니다. 관리
token을 query string이나 로그에 넣지 마십시오.

API 키는 GitHub에 절대 커밋하지 않습니다.
이미 외부에 공개된 키라면 새 키로 교체하는 것을 권장합니다.


## KST 시간 기준
Vercel 런타임은 기본 UTC이므로 서버 코드가 시스템 시각을 직접 사용하면
서울시 시간표/실시간 API(KST)와 9시간 차이가 발생합니다. 모든 운행 계산의
현재시각은 `Asia/Seoul`로 고정합니다.
- 실시간 열차 후보 판정
- API 데이터 freshness
- AUTO 공휴일 판정
- 라이브 추적
- 승차 가능시간 계산

프론트엔드의 사용자 입력시각도 한국시간 기준으로 동일한 시간축에서 비교됩니다.


## V10 UI 개선
- 열차 후보/선택 열차에 실제 운행 시발역 → 종착역 표시
- 일반열차 / 급행열차 구분을 텍스트로 명확히 표시
- 급행 배지는 기존처럼 유지
- 역 입력창 클릭만으로 전체 역 목록을 표시하지 않음
- 한 글자 이상 입력했을 때만 검색 후보 표시
- 초성 검색 지원
  · `ㅅ` → 초성이 ㅅ으로 시작하는 역
  · `ㅅㄱ` → 초성이 ㅅㄱ으로 시작하는 역
  · `성` → '성'으로 시작하는 역
- 최대 8개 후보 표시, ↑/↓/Enter/Esc 키보드 조작 지원


## V10 — 자동 지하철 길찾기
- 출발역/도착역만 입력하면 지원 노선 전체에서 빠른 경로 자동 탐색
- 공식 열차별 시간표에서 생성한 station-line 그래프를 Dijkstra로 탐색
- 비용 = 시간표 기반 차내 주행시간 + 환승 기본 4분
- 자동 생성 경로를 기존 구간 편집기에 바로 채움
- 이후 기존 realtimePosition ETA 엔진으로 즉시 재계산
- 자동 경로 생성 후에도 노선/역/환승시간을 사용자가 직접 수정 가능
- 초성 검색 지원
- 현재 지원: 1~9호선, 경의중앙선, 수인분당선, 경춘선, 경강선, 서해선, 공항철도

예:
마포구청 → 성균관대
6호선 마포구청→합정
2호선 합정→신도림
1호선 신도림→성균관대

주의:
- V10 자동 경로 탐색 자체는 번들된 공식 시간표 그래프 기준
- 이후 실제 도착시간은 실시간 열차 위치/지연으로 별도 재계산
- 같은 이름이지만 서로 다른 역인 5호선 양평 / 경의중앙선 양평은 환승 연결에서 제외
