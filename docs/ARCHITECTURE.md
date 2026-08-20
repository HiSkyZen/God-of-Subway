# 지금타 아키텍처

## 목표와 기존 병목

이 프로젝트의 기존 운영 경로는 Python FastAPI와 로컬
`ThreadingHTTPServer`가 병존하고, 엔진·정적 HTML·HTTP 오류 처리가 한 파일에
강하게 결합된 형태였다. 배포 진입점과 로컬 진입점의 응답 차이를 만들기 쉽고,
프론트엔드가 소스 파일 경로를 직접 캐시하면 번들 이후 PWA가 설치 실패하는
문제도 있었다. Python 런타임, 서버 프레임워크, 번들러, 정적 파일 배포를 각각
관리해야 하므로 타입 계약과 재현 가능한 빌드 경계가 약했다.

현재 목표는 모든 운영 코드를 TypeScript로 타입화하고 Bun을 단일 런타임으로
사용하는 것이다. 시간표/실시간 ETA 계산의 도메인 의미는 `src/engine`에 남기고,
HTTP와 배포 어댑터가 엔진 내부 구현을 알지 않도록 경계를 둔다.

## 레이어와 의존 방향

```text
Browser / PWA
      │ Fetch + Web Push
      ▼
HTTP adapter: src/server.ts, api/index.ts
      ▼
API/application: src/api/router.ts, handlers.ts, push.ts
      ▼
Engine port: src/api/engine-adapter.ts
      ▼
Domain services: src/engine/*
      │
      ├─ timetable/realtime data (root JSON, Seoul Open API)
      └─ push repositories (dev JSON / production Redis REST)
```

`src/api/types.ts`의 `EnginePort`가 공개 계약이다. API 레이어는 엔진 모듈을
직접 import하지 않고 `engine-adapter.ts`만 의존한다. 엔진은 HTTP Request/Response나
VAPID/Redis를 알지 않는다. 이 방향은 엔진을 결정적 테스트 double로 교체하거나
향후 별도 worker로 분리할 수 있게 한다.

## HTTP 계약

`createFetchHandler`가 Bun.serve와 Vercel Function에서 공유되는 Fetch handler다.
공개 경로는 다음과 같다.

| 경로 | 메서드 | 목적 | 오류 |
| --- | --- | --- | --- |
| `/`, `/logo` | GET/HEAD | HTML 및 로고 | 알 수 없는 정적 경로는 404 빈 body |
| `/api/health`, `/api/stations` | GET | 상태·역 목록 | 예외는 일반화된 500 |
| `/api/route`, `/api/auto_route`, `/api/trip_update` | POST | 엔진 연산 | 잘못된 JSON/도메인 결과 422 |
| `/api/push/public-key` | GET | Web Push capability/public key | 미설정 capability는 `false` |
| `/api/push/subscriptions` | POST/DELETE | 구독 등록·폐기 | 소유 token 없이는 403 |
| `/api/push/alerts` | POST/DELETE | 목적지 ETA alert 등록·취소 | trip schema/소유권 검증 |
| `/api/push/alerts/status` | POST | 인증된 alert active/expiry reconcile | token은 JSON body 전용 |
| `/api/push/dispatch` | GET/POST | ETA 재평가·1회 발송 | GET은 Bearer `CRON_SECRET` |
| `/api/push/test` | POST | 개발 전용 실제 push test | 운영에서는 404 |

모든 JSON body는 1 MiB로 제한한다. 내부 예외와 secret은 응답/health/log에
노출하지 않으며, `api_key_configured`, `push_capable`,
`subscription_capable`, `arrival_alert_capable`은 boolean만 반환한다. VAPID와
영속 저장소가 준비되면 subscription capability가 켜지고, 여기에
`PUSH_SCHEDULER_MODE=external`+`CRON_SECRET` 또는 실제 interval 설정까지 있어야
arrival alert capability가 켜진다. 따라서 Hobby처럼 scheduler가 선언되지 않은
배포는 구독 공개키는 제공할 수 있어도 도착 알림을 성공으로 표시하지 않는다.
정적 파일은 HTML, SW, manifest, 세 아이콘, 로고의 allowlist만 제공한다. Bun/API와
Vercel static 모두 `object-src 'none'`, `frame-ancestors 'none'`, self-only worker와
manifest, no-inline script를 포함한 CSP 및 nosniff/referrer/permissions headers를
적용한다. GA4는 Tag Manager script와 필요한 Analytics connect/img origin만 허용한다.

## PWA 빌드와 정적 배포

canonical build graph는 다음과 같다.

1. `bun build --target=bun --production --outdir=dist/server ./src/server.ts`가
   Bun AOT 서버와 HTML import 중간 산출물을 만든다.
2. `build:client`가 `src/client/sw.ts`를 browser target으로 번들해
   `dist/public/sw.js`를 만들고 manifest/icons를 복사한다.
3. `promote-static.ts`가 HTML import의 hashed JS/CSS/manifest/logo를
   `dist/public`으로 옮기고 `dist/server`에서 임시 정적 산출물을 제거한다.

최종 결과는 `dist/server/server.js`와 `dist/public/*`으로 분리된다. Vercel의
`outputDirectory`는 `dist/public`이므로 AOT 서버와 원본 경로가 static hosting으로
노출되지 않는다. `/api/:path*` rewrite가 단일 `api/index.ts` Function으로
모일 때는 Vercel wildcard query를 adapter가 원래 API pathname으로 복원한다.
일반 Bun 호스팅은 private server bundle을 실행하며, AOT
서버의 asset provider는 `dist/public`을 읽는다. 개발에서는 Bun HTML import와
TypeScript service-worker transpile을 사용한다.

Vercel Function은 서울 Open API와 주 사용자의 왕복 지연을 줄이기 위해 단일
`icn1` region에 둔다. 이는 한국 외 사용자의 지연보다 외부 데이터 source 근접성을
우선하는 선택이며, failover가 필요해지면 별도 multi-region 데이터/Redis 일관성
설계를 먼저 마련해야 한다.

서비스 워커 precache는 `app.tsx`나 `sw.ts` 같은 소스 모듈이 아니라 `/`,
`/manifest.webmanifest`, `/icons/*`, 로고 등 안정 경로만 사용한다. 해시 JS/CSS는
동일 origin runtime cache로 처리한다. `verify:pwa`는 실제 HTML 참조, MIME,
manifest 필수 필드, HTML이 실제 참조한 manifest 파일, icon PNG 실제 dimensions와
maskable purpose, JS size budget, orphan hashed asset을 확인하고
`verify:aot`는 서버를 기동해 정적/API/비밀 경로를 HTTP로 검증한다.

## Push lifecycle과 저장소

브라우저는 `/sw.js`를 등록하고 `PushManager.subscribe` 결과를
`POST /api/push/subscriptions`로 보낸다. 서버는 endpoint와 Web Push key를
검증하고 management token을 반환한다. 기존 endpoint reconcile은 올바른 token을
제출하면 token을 회전하지 않는다. localStorage token을 잃었을 때만 동일
endpoint+p256dh+auth의 timing-safe possession proof로 새 token을 발급하며, key가
다르면 403이다. 저장소에는 token의 SHA-256 hash만 남긴다. 이후 alert
생성/삭제/status 조회는 endpoint와 management token을 JSON body로 함께
요구하므로 임의 endpoint가 다른 사용자의 alert를 바꿀 수 없다. management token
검증은 두 SHA-256 digest를 고정 길이 byte로 변환한 뒤 timing-safe 비교한다.

alert 등록 payload는 1~8개 segment, `line/from/to`, active index,
`boarded_train_no`, destination, 30~3600초 threshold를 검증한다. endpoint당
active alert는 하나이며 새 등록은 기존 것을 교체한다. `expires_at`은 기본
24시간, 최대 7일이다. dispatch는 호출당 batch와 worker concurrency를 제한하고,
엔진 오류는 alert를 보존한다. threshold 도달 후 실제 `web-push` 발송에 성공하면
alert를 삭제하여 1회만 알린다. payload에는 server-generated `alert_id`와 stable
notification `tag`가 포함된다. 구독 DELETE 및 delivery 404/410은 구독과 연결된
alert를 함께 정리한다.

구독 key는 decoded p256dh 65바이트(첫 byte `0x04`)와 auth 16바이트만 허용하고,
endpoint/key/trip payload 크기를 제한한다. 등록은 전체/source별 quota와 TTL rate
limit을 거친다. Production Redis adapter는 `HLEN`과 source별 HASH를 Lua quota
write와 함께 사용해 동시 등록으로 한도가 무한히 초과되지 않게 한다. Vercel에서만
플랫폼 forwarded address를 신뢰하며, generic Bun은 `PUSH_TRUST_PROXY=1`과 trusted
proxy header rewrite가 함께 있을 때만 forwarded address를 사용한다.

개발은 absolute file path별 module-level promise mutex/singleton과 unique 임시
파일→rename 방식의 ignored JSON 저장소를 사용한다.
Production은 `PUSH_REDIS_URL`/`PUSH_REDIS_TOKEN` 기반 Redis REST HASH adapter를
사용한다. subscription/alert 교체는 HASH field 단일 HSET이며, alert 삭제는
alert ID와 endpoint를 비교하는 Redis EVAL compare-and-delete로 교체 alert 삭제
race를 막는다. Redis URL은 credential/fragment 없는 parse 가능한 HTTPS만
허용하며, 검증에 실패하면 client를 만들지 않아 bearer token이 전송되지 않는다.
Dispatch는 HGETALL 대신 persistent HSCAN cursor로 다음 bounded
batch를 순환하며, tokenized `SET NX EX` global lease(최소 90초)와 compare-token
release로 serverless cron 중첩을 막는다. ETA 평가 후에는 alert ID를 원자적으로
재확인하고 endpoint별 NX claim을 획득한 뒤 발송한다. claim 중 교체는 409로
재시도시키고 성공한 발송은 같은 ID·claim token일 때만 완료 처리하므로 오래된
dispatch가 새 alert를 발송하거나 삭제할 수 없다. claim TTL은 Vercel 60초 실행
한도에 여유를 둔 최소 90초다. Redis가 없으면 production capability가 실행되지
않고 503으로 실패한다.

Push 구현은 `push.ts` 공개 façade에서 handlers, dispatch, delivery, stores,
auth/config/validation/contracts로 단방향 의존한다. `check:architecture`는 façade
50줄, 책임 모듈 600줄 상한과 이 경계 내부 import cycle 부재를 지속 검증한다.

VAPID private key는 서버 설정과 `web-push` 발송에만 쓰며 응답·로그·저장소에
기록하지 않는다. `POST /api/push/test`는 `PUSH_TEST_ENABLED=1`과 개발 token이
필요하고 실제 notification payload를 전송한다.

## Scheduler와 Vercel 경계

`GET /api/push/dispatch`는 Vercel Cron 규약인
`Authorization: Bearer <CRON_SECRET>`을 받는다. 기본 `vercel.json`에는
minute cron을 넣지 않는다. Hobby 플랜의 cron 빈도/실행 시각 제약은 ETA 알림에
부적합하고, 이를 기본 설정하면 배포 자체가 실패할 수 있기 때문이다. Pro 또는
외부 scheduler가 1분 이상 주기로 GET endpoint를 호출해야 background ETA 알림이
동작한다. 장기 실행 Bun 호스팅에서는 `PUSH_SCHEDULER_INTERVAL_SECONDS >= 60`과
운영 `CRON_SECRET`(또는 개발 `PUSH_CRON_TOKEN` + `PUSH_CRON_ENABLED=1`)을
동시에 설정하면 opt-in interval worker가 동작한다. `VERCEL=1`에서는 Function이
상주하지 않으므로 interval capability와 worker를 강제로 비활성화한다.

이 구조는 request handler가 무한 scheduler를 암묵적으로 시작하지 않는다는
trade-off가 있다. Vercel Function은 장기 프로세스가 아니므로 외부 scheduler가
필수이고, 단일 Function 호출은 batch/concurrency 한계를 넘지 않는다.

## 배포·환경변수

- `SEOUL_API_KEY`: 실시간 Seoul Open API 인증키
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: Web Push capability
- `PUSH_REDIS_URL`, `PUSH_REDIS_TOKEN`: production persistent repository
- `CRON_SECRET`: Vercel/외부 dispatch 인증
- `PUSH_DISPATCH_BATCH_SIZE`, `PUSH_DISPATCH_CONCURRENCY`: dispatch 보호 한계
- `PUSH_DISPATCH_LEASE_SECONDS`(최소 90), `PUSH_REDIS_SCAN_COUNT`: overlap/fair scan 보호
- `PUSH_MAX_SUBSCRIPTIONS`, `PUSH_MAX_SUBSCRIPTIONS_PER_SOURCE`, `PUSH_MAX_ALERTS`: 저장 quota
- `PUSH_REGISTRATION_RATE_LIMIT`, `PUSH_REGISTRATION_RATE_WINDOW_SECONDS`: source rate limit
- `PUSH_TRUST_PROXY=1`: 신뢰할 수 있는 generic Bun reverse proxy에서만 forwarded IP 허용
- `PUSH_SCHEDULER_MODE=external`: Pro/외부 scheduler가 dispatch를 호출한다는 선언
- `PUSH_SCHEDULER_INTERVAL_SECONDS`: generic Bun hosting opt-in scheduler

Bun은 `.env`를 자동 로드한다. `.env*`, push JSON store, `node_modules`, `dist`,
`.vercel`은 gitignore 대상이다. 공개된 API key는 폐기·교체해야 한다.

## 검증 전략과 trade-off

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:sw
bun test
bun run build:all
bun run verify:pwa
bun run verify:aot
```

API tests는 status/method/body limit/health redaction/404와 Push ownership,
trip schema, expiry, one-shot delivery, 404/410 pruning, cron auth, batch,
concurrency, Redis HASH command shape를 주입된 store/delivery/clock으로
검증한다. 엔진 계산은 public port를 통해 교체한다.

개발 JSON 저장소는 단일 프로세스에 적합하고 운영 영속성은 Redis가 담당한다.
Redis REST는 지연과 공급자 종속성이 생기는 대신 serverless 환경에서 별도
연결 pool 없이 동작한다. Vercel Bun runtime은 Function 요청 경계이고,
일반 Bun AOT는 장기 프로세스라는 실행 모델 차이를 문서와 adapter로 명시한다.
