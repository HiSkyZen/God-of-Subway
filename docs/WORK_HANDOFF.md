# God-of-Subway 후속 에이전트 작업 지시서

## 0. 기준점

- Repository: `HiSkyZen/God-of-Subway`
- Draft PR: **#7** — `feat(data): build transit datasets into SQLite`
- Base: `dev/ts-bun`
- Head branch: `feat/sqlite-transit-data`
- 현재 확인된 원격 head: `e53dbf0cf51b2c04c81997d44e5af9faef90aa30`
- PR은 open / draft / mergeable=true 상태.
- Vercel status는 현재 head에서 success.
- 임시 `Source Snapshot` workflow가 아직 존재하며 최종 정리 시 삭제해야 함.

## 1. 절대 유지해야 할 사용자 요구사항

### 데이터/SQLite
1. Runtime은 JSON/CSV 원천 데이터를 읽지 않는다. Runtime persistence는 SQLite.
2. 사람이 검토 가능한 정적 source dataset은 TSV 등으로 유지 가능.
3. KRIC 시간표가 **최우선 source**.
4. KRIC 시간표는 모든 지원역을 대상으로 매일 갱신.
5. `dayCd=8`은 평일, `dayCd=9`는 토/일/공휴일 공통으로 사용.
6. `dayCd=7`은 호출하지 않는다.
7. 공항철도 **직통열차는 제외**. 일반열차만 사용.
8. 배포 시 `build:data`를 하지 않는다.
9. 매일 **KST 03:00 = UTC 18:00 전날**에 데이터 갱신 작업을 실행.
10. 갱신은 GitHub Actions 또는 기존 `dev/cf-workers`의 Cloudflare Worker cron 방식을 이용 가능. 현재 우선 구현은 GitHub Actions가 단순.
11. KRIC 갱신 실패 시 기존 정상 SQLite DB를 그대로 보존한다. 실패한 임시 DB를 배포/commit하지 않는다.
12. KRIC에서 특정 시간표를 못 받은 경우에만 기존 기본 제공 timetable/fixture/static backup을 사용한다.

### KRIC 환승정보
1. KRIC의 `chtnDst` 또는 정적 좌표/거리로 **환승시간을 계산하지 않는다**.
2. 경전철 환승정보는 KRIC에서 사실상 제공되지 않는 것으로 간주.
3. 광역/도시철도도 KRIC 환승거리 신뢰 불가.
4. KRIC `stationTransferInfo`는 `stLocCont`, `clsLocCont`, `chtnLn` 등 **비정형 위치 힌트만** 추출.
5. 위치 우선순위:
   - 서울교통공사 상세
   - 국토교통부 빠른환승
   - upstream 검증 데이터
   - 국가철도공단/KRIC 정적 위치자료
   - KRIC live raw location hint
6. KRIC 위치정보를 semantically over-interpret하지 말 것.
7. 위치좌표는 운임거리 근사에만 사용할 수 있으며 환승시간 추정에는 사용 금지.

### 환승 pair
1. 물리 역에 서로 다른 환승가능 노선이 `n`개면 unordered pair는 정확히 `nC2`.
2. SQLite는 directed edge를 가져도 되지만 물리 pair identity는 unordered.
3. 서울교통공사 authoritative row는 덮어쓰지 않는다.
4. upstream fallback은 서울 데이터가 없는 pair에만 사용.
5. 그래도 없는 pair은:
   - CI/build/deploy log에 JSON으로 출력
   - 오류를 발생시키지 않음
   - 보수적인 topology fallback만 허용
6. 동명이의 물리역(신촌, 양평 등)은 station_id를 분리.

### 동일노선 분기/다중승강장
다음 역을 `same line == 0초`로 절대 처리하지 말 것:
- 가좌 경의중앙선 서울역 지선 ↔ 본선/문산 계통
- 성수 2호선 본선 ↔ 성수지선
- 신도림 2호선 본선 ↔ 신정지선
- 구로 1호선 경부/경인 계통
- 금천구청 1호선 광명셔틀
- 병점 1호선 서동탄지선
- 그 외 다중 승강장/분기역도 topology와 timetable을 근거로 판정

가좌는 upstream 최신 데이터에 `경의중앙선 → 경의중앙선`, 약 220초의 검증 fallback이 있음.

### Shared-track
구간 전체를 0초 처리하거나 중간역을 통째로 삭제하면 안 됨. **역 by 역**으로 후보를 유지하고 물리 이동시간 + 실제 다음 열차 대기시간 + 종착/분기 여부를 평가한다.

특히:
- 경의중앙선 ↔ 서해선
  - 일산: 일산발 서해선이면 매우 편리할 수 있음
  - 대곡: 대곡발/방향에 따라 평면환승 유리
  - 능곡: 승강장 분리, 불편
  - 곡산/백마/풍산/일산: 공용선로/승강장 특성 고려
- 4호선 ↔ 수인분당선
  - 한대앞: 편리
  - 안산: 4호선 안산 종착 편성/별도 홈 때문에 비효율 가능
  - 오이도: 플랫폼 공유/평면환승 가능하지만 시종착·착발순서 때문에 항상 최적은 아님
  - 중앙/고잔/초지/능길/정왕도 실제 timetable로 비교
- shared-track 후보 선택은 임의 penalty가 아니라 실제 timetable score로 결정.
- 같은 두 노선을 짧게 A→B→A로 왕복하는 topology artifact만 제거.

### 급행/완급
KRIC `exptCd`는 신뢰 가능한 노선이 적으므로 보조정보.
급행 판단 우선순위:
1. 기존 검증된 열번 규칙
2. 앞선 열차보다 늦게 출발했으나 뒤 역에서 더 빨리 도착하는 **추월 증거**
3. 같은 source/branch의 중간역을 건너뛰는 **비정차 증거**
4. 종착/분기 때문에 중간역이 사라진 경우는 급행으로 오판하지 말 것.
공항철도 직통은 급행이 아니라 완전히 제외.

### GTX-A — 남은 항목
1. GTX 토글 기본값 ON으로 UI에 연결.
2. 동탄 등 GTX 전용 목적지에서도 토글 UI를 표시.
3. 운정→동탄 실제 회귀테스트에서 수서 환승이 신사→판교→성남 우회와 ETA가 같거나 빠르면 수서 경로가 선택되는지 검증. 하드코딩된 수서 bonus 금지.

### 운임
공식 수도권 통합요금 기준을 사용:
- 일반 수도권 전철: 기본 10km까지 1,550원, 10~50km 5km마다 100원, 50km 초과 8km마다 100원.
- GTX-A: 통합환승 대상. 별도 GTX 기본/거리운임 적용.
- 신분당선: 구간별 별도운임 적용.
- 공개 데이터에 영업거리 완전자료가 없으면 UI에서 반드시 **예상 운임**으로 표시.
- 역사 좌표는 운임거리 근사에만 사용.
- 환승시간 추산에는 좌표 사용 금지.

### UI/설정
1. 시간 컨트롤 아래 새 행:
   - 최단시간
   - 최소환승
   - 최소비용
2. 기본은 최단시간.
3. 설정에는 오직:
   - 운행일: 평일 / 주말·공휴일
   - 디버그모드 조회
   - GTX 이용 토글 (기본 ON)
4. AUTO/SAT/END 세분화 UI 제거. 내부 DB는 DAY/SAT/END를 가질 수 있으나 사용자 선택은 2개.
5. 기말시험 관련 기능/문구/localStorage/ExperimentRecord/export 전부 삭제.
6. Google Analytics/gtag/GTM/CSP 허용 전부 삭제.
7. 기존 앱 예상 총시간/baseline 비교 전부 삭제.
8. 검색 버튼과 메인 안내 메시지 영역에 dark mode에서도 보이는 외곽선 추가.
9. GTX 전용 목적지에서도 GTX 토글 표시.

## 2. 원격에 이미 반영된 핵심 커밋

확인된 원격 PR head는 `e53dbf0cf51b2c04c81997d44e5af9faef90aa30`.

직전 작업에서 사용자에게 보고된 단계 커밋:
- `07316492` — KRIC timetable / transfer pipeline 방향
- `f836c839` — shared-track 물리 정책
- `011fda6f` — shared-track/fewest-transfer 후보 확장, auto route 연결
- `95a91f8` — schema v2/KRIC location-only 정책에 맞춘 doctor/audit/fixture CI 계약 (`Bun CI #467` green)
- `3fcade7` + `e53dbf0` — 예상 운임·3개 목적함수·GTX preference 및 회귀테스트 (`Bun CI #471` green)

반드시 `git log` / GitHub PR diff로 실재 내용 확인 후 이어갈 것. 이전 에이전트 보고를 맹신하지 말 것.

## 3. 반드시 단계별 commit/push

사용자 최신 지시:
> 작업 진행 중 단계별로 모두 커밋 및 푸시하고 원격 PR에 반영

따라서 다음처럼 진행:
1. 정규화 dataset + station coordinates → DB fixture 검증 → commit → push
2. UI/설정/analytics/experiment/baseline 제거 → client tests/build → commit → push
3. daily KRIC 03:00 + deploy-time build 제거 → workflow/verify → commit → push
4. docs/legacy cleanup/source-snapshot 삭제 → full CI → commit → push
5. 최종 regression fixes → commit/push
6. PR body를 WIP 문구에서 실제 구현/검증 결과로 갱신. Draft 해제는 사용자 요청 없으면 하지 말 것.

각 push 후:
- PR head SHA 확인
- GitHub Actions workflow run 확인
- 실패 시 해당 단계에서 바로 수정 커밋 추가
- 다음 단계로 넘어가기 전 최소 관련 테스트 green 확인

## 4. 데이터 파일/첨부 자료

초기 대화에서 제공된 `DataSet.zip`에는 최소 다음 유효 source가 있었음:
- `서울교통공사_서울 도시철도 환승정보_20260303.csv`
- `서울교통공사_환승역거리 소요시간 정보_20251231.csv`
- `국토교통부_철도역 빠른 환승 정보_20250923.csv`
- `국가철도공단_*환승정보_20250630.csv`
- `운영기관_역사_코드정보_2026.02.28.xlsx`
- `전국 도시광역철도 역사 역사정보_20260701.xlsx`
- `전체_도시철도노선정보_20260630.xlsx`
- `전체_도시철도역사정보_20260630.xlsx`
- `전체_도시철도운행정보_20260228.xlsx`

정적 제공 timetable은 **KRIC 실패 시 fallback**으로만 사용.
운행 XLSX에는 일반/급행/직통 레코드가 있으나 production 우선순위는 KRIC.

## 5. 저장소에서 제거해야 할 레거시

`rg`로 다시 전수 검색:
```bash
rg -n "Experiment|experiment|기말|baseline|baseline_minutes|analytics|gtag|googletag|GTM|Google Analytics|예상 총시간|runtime-kric|chtnDst|1.2" \
  src tests scripts docs README.md vercel.json package.json .github
```

최종적으로 제품 코드/문서에 남아선 안 되는 것:
- `src/client/analytics.ts`
- Google Analytics 초기화/이벤트/CSP
- Experiment panel/storage/export
- 기말시험 localStorage key
- baseline ETA UI/API payload/type
- runtime KRIC transfer distance enrichment service
- deploy-time KRIC DB generation 설명

## 6. 일일 03:00 KST 데이터 갱신 권장 구조

GitHub Actions 기준 cron:
```yaml
schedule:
  - cron: "0 18 * * *"
```
UTC 전날 18:00 = KST 03:00.

권장 workflow:
1. checkout `feat/sqlite-transit-data` 개발 중에는 해당 branch, merge 후 최종 target branch 정책에 맞춤
2. setup Bun
3. install
4. `TRANSIT_DATA_MODE=live bun run build:data`
5. `bun run doctor`
6. `bun test` 또는 최소 data regression
7. 생성된 `data/transit.sqlite`만 기존 정상 DB와 교체
8. DB가 실제 변경된 경우 bot commit/push
9. 실패 시 기존 DB commit untouched
10. secret `KRIC_API_KEY` 사용
11. secret 값/URL query를 로그에 출력하지 않음

주의:
- bot commit으로 workflow 무한 루프가 생기지 않도록 push-trigger와 schedule-trigger 분리
- `[skip ci]` 또는 paths 조건 고려
- deploy는 SQLite commit 이후 Vercel/CF가 새 DB를 소비
- `vercel.json` / package `build:all`에서 `build:data` 제거

Cloudflare Workers cron을 택하면 GitHub에 SQLite push가 어려운 구조일 수 있으므로 현재 repository-based SQLite 배포에는 GitHub Actions가 더 단순.

## 7. Shared-track 테스트 케이스 — 반드시 추가/유지

최소:
- 일산 → 공유구간/서해: 일산 환승 후보가 존재
- 대곡발/대곡 접근: 대곡 환승 후보 존재
- 능곡: 후보는 존재하나 물리 walking allowance가 더 큼
- 한대앞: 편리한 shared-platform 후보
- 안산: 4호선 안산 종착편 때문에 실제 outgoing connection을 확인
- 오이도: 평면환승 가능하나 시종착 대기시간 평가
- A→B→A line-pair ping-pong 후보 제거
- shared-track 모든 역을 0초 처리하지 않음
- shared-track 중간역을 전부 삭제하지 않음

운정→동탄:
- 수서 환승 경로가 신사→판교→성남 우회와 ETA가 같거나 빠르면 수서 선택
- exact ETA tie에서 non-GTX 우선
- GTX OFF + 동탄 목적지 = 남부 GTX 유지, 북부 GTX 제거

## 8. Same-line branch 테스트

최소:
- 가좌 문산/서울역 계통 변경 != 0초
- 성수 본선↔지선 != 0초
- 신도림 본선↔신정지선 != 0초
- 구로 경부↔경인 계통 변경 != 0초
- 금천구청 광명셔틀 변경 != 0초
- 병점 서동탄지선 변경 != 0초
- 실제 동일 train through-running이면 가짜 환승을 만들지 않음

## 9. 완급 분류 테스트

- verified train-number express fallback
- later departure / earlier downstream arrival → express
- internal stop skip → express
- termination before skipped station → express 아님
- branch divergence → express 아님
- AREX direct → DB에서 제외
- local/express route choice에서 express 우선 가능하되 실제 ETA가 최종 기준

## 10. 보안

사용자가 과거 대화에서 API key를 직접 제공했으나:
- 키 값을 source/PR/log/metadata/TSV에 절대 저장하지 말 것.
- env var 이름만 사용:
  - `KRIC_API_KEY`
  - `SEOUL_API_KEY`
- URL 전체를 logging할 때 query string에 key가 포함되지 않도록 할 것.

## 11. 최종 완료 조건

아래 모두 충족해야 “완료” 보고:
- PR head에 모든 product changes push
- 임시 Source Snapshot workflow 삭제
- Bun CI complete green
- Vercel/target deployment green
- `build:data`가 deploy-time command에서 제거됨
- daily 03:00 KST update workflow 존재
- fixture 및 live-policy doctor 통과
- no runtime KRIC transfer-distance
- SAT uses dayCd=9
- no AREX direct
- no analytics/experiment/baseline remnants
- 3 route objectives end-to-end UI/API/engine 동작
- GTX toggle semantics regression green
- shared-track / same-line branch regression green
- missing transfer pairs JSON diagnostic is non-fatal
- PR body에 architecture, sources, fallback order, tests, known limitations 기재
- 사용자가 Draft 해제를 요청하지 않았으면 Draft 유지
