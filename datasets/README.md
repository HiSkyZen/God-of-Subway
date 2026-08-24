# Transit source datasets

Runtime reads only `data/transit.sqlite`. Files under this directory are build inputs or reviewable fallbacks.

## KRIC timetable

Production daily build uses KRIC as the primary timetable source. Only `dayCd=8` (weekday) and `dayCd=9` (weekend/holiday) are requested; `dayCd=9` is copied to both `SAT` and `END`. `dayCd=7` is intentionally never requested. AREX direct trains are excluded.

## Transfer duration precedence

1. `transfers/seoul-metro-transfer-times.tsv` — Seoul Metro authoritative distance/time rows.
2. `transfers/upstream-pairs/*.tsv` — reviewable upstream fallback snapshot, inserted only when Seoul has no pair.
3. During a live scheduled build, current upstream `transfer_data.json` is fetched and normalized with `INSERT OR IGNORE`, so it can add missing pairs/details but never replace Seoul rows.
4. Any pair still missing after those sources is emitted as non-fatal JSON diagnostic and receives only the conservative topology fallback.

KRIC `stationTransferInfo.chtnDst` and station coordinates are **not** used to calculate transfer duration.

## Transfer position precedence

Where available, position information is ordered conceptually as Seoul detailed data → MOLIT fast-transfer → upstream verified detail → KRIC/KR static detail → KRIC live `stLocCont`/`clsLocCont` raw hint. The live KRIC hint is non-semantic and lowest priority. Its distance field is ignored.

## Station coordinates

`stations/coordinates/*.tsv` is normalized from the supplied 2026-06-30 MOLIT urban-rail station workbook. Coordinates are used only to estimate fare distance when the public settlement/operating distance is unavailable. They are never converted into transfer walking time.
