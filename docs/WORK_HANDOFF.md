# God-of-Subway 후속 작업 지시서

## 기준점

- Repository: `HiSkyZen/God-of-Subway`
- Draft PR: #7 `feat(data): build transit datasets into SQLite`
- Base: `dev/ts-bun`
- Head branch: `feat/sqlite-transit-data`
- 완료된 기능은 이 문서에서 제거한다. 아래에는 **미완료 또는 외부 검증이 필요한 항목만** 남긴다.

## 반드시 유지할 계약

- Runtime static transit data = SQLite only.
- KRIC timetable primary; dayCd 8/9 only; SAT=END; AREX direct excluded.
- Transfer time: Seoul authoritative → upstream fallback. KRIC distance/coordinates are never transfer-time inputs.
- KRIC transfer API contributes only low-priority non-semantic location hints.
- Physical transfer pairs satisfy nC2; missing pairs are non-fatal JSON diagnostics.
- Same-line branch/platform changes (가좌/성수/신도림/구로/금천구청/병점 등) are not automatic 0s.
- Shared-track stations compete by physical movement + actual timetable connection; no corridor-wide zero/no-transfer rule.
- Route objectives: fastest / fewest transfers / lowest cost. Exact fastest ETA ties prefer non-GTX.
- GTX OFF preserves a GTX section required by an exclusive endpoint.
- Fare coordinates are for estimated fare distance only.
- PR remains Draft unless user explicitly requests otherwise.
- Never expose/commit API key values.

## 미완료 작업

1. **Daily live DB 실운영 검증**
   - Repository Actions secret `KRIC_API_KEY`는 설정됨.
   - 03:00 KST workflow, deploy-time `build:data` 제거, runtime KRIC-distance 제거까지 구현됨.
   - bounded live refresh가 `data/transit.sqlite`를 실제 commit하는지 확인.
   - live KRIC 실패 시 첫 실행은 validated fixture SQLite를 bootstrap하고, 이후 실행은 last-known-good SQLite를 보존해야 함.
   - 실패 로그는 secret을 포함하지 않는 JSON 진단만 저장.

2. **최종 검증/PR 정리**
   - latest GitHub Bun CI와 Vercel success 확인.
   - `data/transit.sqlite` 존재 및 daily refresh 동작 확인.
   - PR #7 body를 WIP에서 최종 architecture/source precedence/fallback/test/known limitation으로 교체.
   - Draft 유지.

## 검증 명령

```bash
TRANSIT_DATA_MODE=fixture bun run build:data
bun run doctor
bun run audit:transfers
bun run typecheck
bun run typecheck:sw
bun run check:architecture
bun test
bun run build
bun run build:client
bun run scripts/promote-static.ts
bun run verify:pwa
bun run verify:aot
```
