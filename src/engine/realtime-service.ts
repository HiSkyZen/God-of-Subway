import { LINE_NAMES, type LineName, type PositionCache, type PositionCacheEntry, type PositionRow, type RealtimeEnvelope, type Train } from "../types/domain";
import { cacheGetJson, cacheSetJson } from "../infra/cache";
import { logEvent } from "../infra/observability";
import { allTrains, canonStation, firstCurrentIndex, parseDt, resolveServiceMode, stopTimeSec, nowKst } from "./timetable-service";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export const SEOUL_REALTIME_BASE = (Bun.env.SEOUL_REALTIME_BASE_URL || "http://swopenAPI.seoul.go.kr/api/subway").replace(/\/$/, "");
export const REALTIME_QUERY_ALIASES: Record<string, readonly string[]> = {
  "신분당선": ["1077:신분당선", "신분당선"],
  "GTX-A(북부)": ["1032:GTX-A", "GTX-A"],
  "GTX-A(남부)": ["1032:GTX-A", "GTX-A"],
};
const LINE_IDS: Record<string, string> = {
  "1호선": "1001", "2호선": "1002", "3호선": "1003", "4호선": "1004", "5호선": "1005", "6호선": "1006", "7호선": "1007", "8호선": "1008", "9호선": "1009",
  "경의중앙선": "1063", "공항철도": "1065", "경춘선": "1067", "수인분당선": "1075", "신분당선": "1077", "경강선": "1081", "서해선": "1093", "GTX-A(북부)": "1032", "GTX-A(남부)": "1032",
};
const GTX_NORTH = new Set(["운정중앙", "킨텍스", "대곡", "연신내", "서울역"]);
const GTX_SOUTH = new Set(["수서", "성남", "구성", "동탄"]);
const sinbundangFormationByScheduleId = new Map<string, string>();

function digitsOnly(value: unknown): string { return String(value ?? "").replace(/\D/g, ""); }
/** Seoul's Shinbundang trainNo is a formation number (1~20), not a timetable train number. */
export function formatSinbundangFormationNumber(value: unknown): string {
  const digits = digitsOnly(value); if (!digits) return "";
  return `D0${digits.slice(-2).padStart(2, "0")}`;
}
/** Rail.Blue exposes GTX-A service numbers with an X prefix and four digits. */
export function formatGtxTrainNumber(value: unknown): string {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw || /^(GTXN|GTXS|GTX-SCHED|GTX_INTERNAL)/.test(raw)) return "";
  const digits = digitsOnly(raw); if (!digits) return "";
  return `X${digits.slice(-4).padStart(4, "0")}`;
}
/** Convert an engine tracking id to the public-facing train number, if known. */
export function publicTrainNumber(line: string, trackingId: unknown): string {
  const id = String(trackingId ?? "").trim();
  if (!id) return "";
  if (line === "신분당선") return sinbundangFormationByScheduleId.get(id) ?? "";
  if (line.startsWith("GTX-A")) return formatGtxTrainNumber(id);
  return id;
}
function rememberSinbundangPublicNumbers(rows: PositionRow[]): void {
  for (const row of rows) {
    const scheduleId = String(row._jigeumta_schedule_id ?? "").trim();
    const display = String(row._jigeumta_display_train_no ?? "").trim();
    if (scheduleId && display) sinbundangFormationByScheduleId.set(scheduleId, display);
  }
}

function apiKey(): string { const value = Bun.env.SEOUL_API_KEY?.trim() ?? ""; if (!value) throw new Error("SEOUL_API_KEY 환경변수가 설정되지 않았습니다."); return value; }
function cacheGet(cache: PositionCache, line: string): PositionCacheEntry | PositionRow[] | undefined { return cache instanceof Map ? cache.get(line) : cache[line]; }
function cacheSet(cache: PositionCache, line: string, value: PositionCacheEntry): void { if (cache instanceof Map) cache.set(line, value); else cache[line] = value; }
function queries(line: string): readonly string[] { return REALTIME_QUERY_ALIASES[line] || [line]; }
function filteredRows(line: string, rows: PositionRow[]): PositionRow[] {
  const id = LINE_IDS[line]; let filtered = id ? rows.filter((row) => !row.subwayId || String(row.subwayId) === id) : rows;
  if (line === "GTX-A(북부)") filtered = filtered.filter((row) => GTX_NORTH.has(canonStation(row.statnNm)));
  if (line === "GTX-A(남부)") filtered = filtered.filter((row) => GTX_SOUTH.has(canonStation(row.statnNm)));
  return filtered;
}
function directionPenalty(train: Train, row: PositionRow): number {
  const raw = String(row.updnLine || ""); if (!raw) return 0;
  if (/상행/.test(raw) && train.direction && train.direction !== "UP") return 1800;
  if (/하행/.test(raw) && train.direction && train.direction !== "DOWN") return 1800;
  return 0;
}
function occurrenceGap(actualSec: number, scheduleSec: number): number {
  const choices = [actualSec - 86400, actualSec, actualSec + 86400, actualSec + 172800];
  return Math.min(...choices.map((x) => Math.abs(x - scheduleSec)));
}
function matchSinbundangRow(row: PositionRow): PositionRow {
  const current = canonStation(row.statnNm); if (!current) return row;
  const observed = parseDt(row.recptnDt ?? row.lastRecptnDt); const [mode] = resolveServiceMode("AUTO", observed);
  const actualSec = observed.getUTCHours() * 3600 + observed.getUTCMinutes() * 60 + observed.getUTCSeconds(); const target = canonStation(row.statnTnm);
  let best: { train: Train; score: number } | null = null;
  for (const train of allTrains("신분당선", mode)) {
    const index = firstCurrentIndex(train.stops, current); if (index === null) continue;
    const ref = stopTimeSec(train.stops[index]); if (ref === null) continue;
    let score = occurrenceGap(actualSec, ref) + directionPenalty(train, row);
    if (target && canonStation(train.dest) !== target) score += 900;
    if (!best || score < best.score) best = { train, score };
  }
  if (!best || best.score > 3600) return row;
  const apiFormation = String(row.trainNo ?? row.btrainNo ?? "").trim();
  const displayTrainNo = formatSinbundangFormationNumber(apiFormation);
  if (displayTrainNo) sinbundangFormationByScheduleId.set(best.train.train_no, displayTrainNo);
  return {
    ...row,
    _jigeumta_raw_train_no: apiFormation,
    _jigeumta_api_train_no: apiFormation,
    _jigeumta_display_train_no: displayTrainNo,
    _jigeumta_schedule_id: best.train.train_no,
    trainNo: best.train.train_no,
    _jigeumta_context_match_score: best.score,
  };
}
function normalizeRows(line: string, rows: PositionRow[]): PositionRow[] { const filtered = filteredRows(line, rows); return line === "신분당선" ? filtered.map(matchSinbundangRow) : filtered; }

export async function fetchPosition(line: string, timeout = 5, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; error: string | null; data: RealtimeEnvelope | null }> {
  const persistent = fetchImpl === fetch; const cacheKey = `realtime:${line}`;
  if (persistent) {
    const fresh = await cacheGetJson<RealtimeEnvelope>(cacheKey);
    if (fresh) {
      const rows = positionRows(fresh.value); if (line === "신분당선") rememberSinbundangPublicNumbers(rows);
      return { ok: true, error: null, data: { ...fresh.value, _jigeumta_cache_state: fresh.stale ? "stale" : "hit" } };
    }
  }
  const key = apiKey(); let lastError = "실시간 위치 조회 실패"; let lastData: RealtimeEnvelope | null = null;
  for (const query of queries(line)) {
    const url = `${SEOUL_REALTIME_BASE}/${key}/json/realtimePosition/0/300/${encodeURIComponent(query)}`; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout * 1000); const started = performance.now();
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "JigeumTa-V14.1/1.0", Accept: "application/json" } }); const data = await response.json() as RealtimeEnvelope; lastData = data;
      if (data && typeof data === "object" && data.RESULT) { lastError = String(data.RESULT.message ?? "실시간 위치 조회 실패"); continue; }
      const rows = normalizeRows(line, Array.isArray(data.realtimePositionList) ? data.realtimePositionList : []); if (!rows.length && queries(line).length > 1) { lastError = `${query}: 0 rows`; continue; }
      const envelope: RealtimeEnvelope = { ...data, realtimePositionList: rows, _jigeumta_query: query, _jigeumta_cache_state: "miss" };
      if (persistent) await cacheSetJson(cacheKey, envelope, Number(Bun.env.REALTIME_CACHE_TTL_SECONDS || 12), Number(Bun.env.REALTIME_STALE_TTL_SECONDS || 90));
      const contextMatched = rows.filter((row) => row._jigeumta_schedule_id !== undefined).length;
      logEvent("info", "realtime_fetch", { line, query, rows: rows.length, context_matched: contextMatched, status: response.status, duration_ms: Math.round(performance.now() - started) });
      return { ok: response.ok, error: response.ok ? null : `${response.status} ${response.statusText}`, data: envelope };
    } catch (error) { lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error); logEvent("warn", "realtime_fetch_failure", { line, query, error: lastError, duration_ms: Math.round(performance.now() - started) }); }
    finally { clearTimeout(timer); }
  }
  if (persistent) {
    const stale = await cacheGetJson<RealtimeEnvelope>(cacheKey, true);
    if (stale) {
      const rows = positionRows(stale.value); if (line === "신분당선") rememberSinbundangPublicNumbers(rows);
      logEvent("warn", "realtime_stale_cache", { line, error: lastError }); return { ok: true, error: lastError, data: { ...stale.value, _jigeumta_cache_state: "stale" } };
    }
  }
  return { ok: false, error: lastError, data: lastData };
}
export function positionRows(data: RealtimeEnvelope | null): PositionRow[] { return Array.isArray(data?.realtimePositionList) ? data.realtimePositionList : []; }
export async function prefetchPositionCache(lines: Iterable<string>, timeout = 5, fetchImpl: FetchLike = fetch): Promise<PositionCache> {
  const unique = [...new Set([...lines].filter((line): line is LineName => (LINE_NAMES as readonly string[]).includes(line)))].sort(); const cache: PositionCache = new Map(); if (!unique.length) return cache;
  const values = await Promise.all(unique.map(async (line): Promise<readonly [string, PositionCacheEntry]> => { try { const result = await fetchPosition(line, timeout, fetchImpl); const data = result.data; return [line, result.ok ? { rows: positionRows(data), error: result.error ?? "", available: true, query: String(data?._jigeumta_query || ""), cache_state: String(data?._jigeumta_cache_state || "") } : { rows: [], error: result.error ?? "실시간 위치 조회 실패", available: false }]; } catch (error) { return [line, { rows: [], error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), available: false }]; } }));
  for (const [line, value] of values) cacheSet(cache, line, value); return cache;
}
export async function cachedPositionRows(line: string, cache: PositionCache, timeout = 5, fetchImpl: FetchLike = fetch): Promise<PositionCacheEntry> {
  let value = cacheGet(cache, line); if (!value) { const result = await fetchPosition(line, timeout, fetchImpl); value = result.ok ? { rows: positionRows(result.data), error: result.error ?? "", available: true, query: String(result.data?._jigeumta_query || ""), cache_state: String(result.data?._jigeumta_cache_state || "") } : { rows: [], error: result.error ?? "실시간 위치 조회 실패", available: false }; cacheSet(cache, line, value); }
  if (Array.isArray(value)) return { rows: value, error: "", available: true }; return { rows: value.rows ?? [], error: value.error ?? "", available: Boolean(value.available), query: value.query, cache_state: value.cache_state };
}
export function apiKeyConfigured(): boolean { return Boolean(Bun.env.SEOUL_API_KEY?.trim()); }
export function healthRealtimeSnapshot(): Record<string, unknown> { return { configured: apiKeyConfigured(), baseUrl: SEOUL_REALTIME_BASE, query_aliases: REALTIME_QUERY_ALIASES, line_ids: LINE_IDS, sinbundang_train_number_policy: "timetable_internal_index_api_formation_display" }; }
export { nowKst, parseDt };
