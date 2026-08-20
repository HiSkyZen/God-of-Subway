<p align="center">
  <img src="jigeumta_logo_140.png" width="90" alt="지금타">
</p>

<h1 align="center">지금타</h1>

<p align="center">
  실시간 운행정보를 반영한 수도권 전철 ETA 서비스<br>
  <a href="https://god-of-subway.vercel.app/"><b>god-of-subway.vercel.app</b></a>
</p>

---

## 개발 동기

지도 앱에서는 "곧 도착"이라고 하는데, 정작 그 열차가 어디 있는지는 알 수 없습니다. 환승역에 도착해 보면 타야 할 열차는 이미 떠난 뒤인 경험, 한 번쯤 있으셨을 겁니다.

기존 길찾기 서비스는 대부분 **정적 시간표**를 기준으로 경로를 계산합니다. 그래서 1호선 단전, 경의중앙선 선행 열차 대피처럼 배차가 통째로 꼬이는 상황에서는 안내 시간과 실제가 크게 어긋납니다.

지금타는 **지금 실제로 운행 중인 열차의 위치**를 반영해 도착 예정 시간을 계산합니다.

## '지금타'의 차별점

**1. 실제 열차 위치를 반영합니다**
시간표상 도착시간만 계산하지 않습니다. 현재 열차가 어디에 있는지 확인하고 실제 지연 상황을 반영합니다.

**2. 환승까지 고려한 최종 ETA를 계산합니다**
"이 열차를 타면 환승 열차를 잡을 수 있을까?" — 현재 열차 위치와 환승 소요시간을 함께 계산해 최종 목적지 도착 예정 시간을 보여줍니다.

**3. 탑승 후에도 계속 추적합니다**
탑승한 열차를 20초마다 추적해 ETA를 자동 재계산합니다. 이동 중 지연이 발생해도 바뀐 도착 시간을 확인할 수 있습니다.

**4. 예측 신뢰도를 함께 보여줍니다**
하나의 도착시간만 던져주지 않고, 현재 확보된 운행정보를 바탕으로 예측이 얼마나 믿을 만한지 표시합니다.

## 지원 노선

경로 탐색과 실시간 지연 반영이 모두 제공되는 노선입니다.

| | |
| :-- | :-- |
| 수도권 전철 | 1 · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9호선 |
| 광역 · 간선 | 경의중앙선 · 수인분당선 · 경춘선 · 경강선 · 서해선 · 공항철도 |

**제외 노선** — 인천1호선, 인천2호선, 김포도시철도, 의정부경전철, 용인경전철은 운영기관 사정으로 실시간 지연정보 제공이 어렵습니다.

서울교통공사 운영구간이 아닌 경우 제공정보의 한계로 역 출발 현황은 안내되지 않습니다.

## 로컬 실행 (Bun)

서울 열린데이터광장 인증키가 필요합니다. [data.seoul.go.kr](https://data.seoul.go.kr)에서 무료로 발급받을 수 있습니다.

```powershell
bun install
bun run dev
```

Windows에서는 `run.bat`도 사용할 수 있습니다. Bun은 `.env`를 자동 로드합니다.
환경변수 예시는:

```
SEOUL_API_KEY=<서울 열린데이터광장 인증키>
```

서버는 `src/server.ts`의 `Bun.serve`이며, API 엔진은 `src/engine` public export
경계만 사용합니다.

## 배포

Vercel은 `api/index.ts`의 Bun Function adapter를 실행합니다. `vercel.json`의
`bunVersion: "1.x"`는 Vercel 공식 Bun runtime 설정입니다. 일반 Bun 호스팅은
`bun run build:all` 후 `bun run start`를 사용합니다.

필수 환경변수는 `SEOUL_API_KEY` 하나이며, **Production뿐 아니라 Preview 환경에도 설정해야** 브랜치 미리보기에서 조회가 동작합니다.

자세한 설정은 [VERCEL_DEPLOY.md](VERCEL_DEPLOY.md)를 참고하세요.

Web Push 선택 기능은 `GET /api/push/public-key`, `POST/DELETE
/api/push/subscriptions`, `POST/DELETE /api/push/alerts`, `POST
/api/push/alerts/status`를 제공합니다. VAPID
환경변수와 운영용 Redis REST 저장소가 없으면 health의 `push_capable`이 false가
되며 구독 저장은 거부됩니다. 개발 전용 `POST /api/push/test`는 실제 `web-push`
발송과 만료(404/410) 구독 정리를 검증할 때만 활성화합니다. ETA 알림은
`POST /api/push/dispatch`로 구현되어 있으며 Vercel Pro/외부 cron의 `GET` +
`Authorization: Bearer $CRON_SECRET` 또는 장기 실행 Bun의 opt-in interval로
호출합니다. `arrival_alert_capable`은 scheduler가 명시된 경우에만 true이며,
Hobby에는 분 단위 cron을 설정하지 않습니다.

구독·알림 등록은 decoded Web Push key 길이, endpoint/payload 크기, 요청 빈도,
source별/전체 저장 한도를 검증합니다. Redis dispatch는 영속 HSCAN cursor와
tokenized lease를 사용해 앞 alert 고착과 중복 발송을 막습니다. ETA 계산 뒤에도
현재 alert ID를 원자적으로 재확인·claim하므로 그 사이 교체된 alert를 잘못
발송하지 않습니다. 운영 Redis REST URL은 credential 없는 HTTPS만 허용하며,
유효하지 않으면 token을 전송하지 않고 capability를 비활성화합니다. 관리 token은
URL이 아닌 JSON body로만 전달하고 SHA-256 digest를 고정 길이 timing-safe 비교하며,
보안 헤더는 inline script 없는 CSP를 포함합니다.

> API 키는 저장소에 커밋하지 않습니다. 이미 노출된 키는 새 키로 교체하세요.

## 구성

| 파일 | 역할 |
| :-- | :-- |
| `src/server.ts` | Bun.serve entrypoint 및 공용 Fetch handler |
| `api/index.ts` | Vercel Bun Function adapter |
| `src/engine` | 타입화된 경로 탐색 · ETA 계산 엔진 |
| `src/client` | React/PWA frontend, manifest, service worker |
| `route_graph.json` | 공식 시간표 기반 역-노선 그래프 |
| `stations.json` · `transfer_data.json` | 역 정보 · 환승 소요시간 |
| `schedule_*.json` · `official_2to9_schedule.json` | 공식 시간표 |
| `kr_holidays_2026_2035.json` | 공휴일 · 대체공휴일 |

## 알려진 한계

- 즐겨찾기는 브라우저 `localStorage` 기반이라 다른 기기·브라우저와 동기화되지 않습니다.
- 환승 정보가 없는 일부 역은 기본값 **4분**으로 계산됩니다.
- 자동 경로 탐색은 번들된 공식 시간표 그래프를 기준으로 하며, 실제 도착시간은 이후 실시간 위치로 다시 계산됩니다.
- 이름이 같지만 서로 다른 역인 5호선 양평과 경의중앙선 양평은 환승 연결에서 제외됩니다.
- 모든 운행 계산의 현재시각은 `Asia/Seoul`로 고정됩니다. Vercel 런타임 기본값이 UTC이기 때문입니다.

## 면책

본 서비스가 제공하는 정보는 실제 운행정보와 다를 수 있습니다. 잘못된 정보의 표출로 인한 피해에 대해 개발자는 책임지지 않습니다. 또한 본 서비스를 근거로 운영기관에 민원을 제기하는 행위는 삼가주시기 바랍니다.

데이터 출처: 서울특별시 열린데이터광장 — 지하철 실시간 도착정보

## 스크린샷
<img width="1280" height="2510" alt="image" src="https://github.com/user-attachments/assets/4a983127-a931-432f-b1a9-e23dd68e8851" />
초기화면
<br/>
<img width="1280" height="6114" alt="image" src="https://github.com/user-attachments/assets/2fe0128f-eb8a-44e2-8765-f7c9bd941d67" />
<br/>
출발지와 목적지를 입력하면 이동 경로가 산출됨
<br/>
<img width="1280" height="549" alt="image" src="https://github.com/user-attachments/assets/f83e96de-f860-47d8-b251-82f146588ecd" />
열차 탑승시 추적 버튼을 누르면 실시간으로 내 위치를 알 수 있고, 이 열차의 지연 상황에 따라 후행 열차 일정도 결정됨
<br/>
<img width="1280" height="2510" alt="image" src="https://github.com/user-attachments/assets/93c07e37-135e-4d56-a166-9ba7433b900f" />
환승 중에는 환승 정보도 알 수 있음
<br/>

## 변경 기록

[CHANGELOG.md](CHANGELOG.md) — V13.3.0부터는 [Releases](https://github.com/unending314/God-of-Subway/releases)에서 관리합니다.
