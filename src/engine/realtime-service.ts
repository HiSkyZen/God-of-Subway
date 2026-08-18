import { LINE_NAMES, type LineName, type PositionCache, type PositionCacheEntry, type PositionRow, type RealtimeEnvelope } from "../types/domain";
import { parseDt, nowKst } from "./timetable-service";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export const SEOUL_REALTIME_BASE = "https://swopenAPI.seoul.go.kr/api/subway";

function apiKey(): string { const value = Bun.env.SEOUL_API_KEY?.trim() ?? ""; if (!value) throw new Error("SEOUL_API_KEY 환경변수가 설정되지 않았습니다."); return value; }
function cacheGet(cache: PositionCache, line: string): PositionCacheEntry | PositionRow[] | undefined { return cache instanceof Map ? cache.get(line) : cache[line]; }
function cacheSet(cache: PositionCache, line: string, value: PositionCacheEntry): void { if (cache instanceof Map) cache.set(line, value); else cache[line] = value; }

export async function fetchPosition(line: string, timeout = 5, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; error: string | null; data: RealtimeEnvelope | null }> {
  const key = apiKey(); const encoded = encodeURIComponent(line); const url = `${SEOUL_REALTIME_BASE}/${key}/json/realtimePosition/0/300/${encoded}`; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try { const response = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "JigeumTa-V13.3.1/1.0", Accept: "application/json" } }); const data = await response.json() as RealtimeEnvelope; if (data && typeof data === "object" && data.RESULT) return { ok: false, error: String(data.RESULT.message ?? "실시간 위치 조회 실패"), data }; return { ok: response.ok, error: response.ok ? null : `${response.status} ${response.statusText}`, data }; } catch (error) { const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error); return { ok: false, error: message, data: null }; } finally { clearTimeout(timer); }
}
export function positionRows(data: RealtimeEnvelope | null): PositionRow[] { return Array.isArray(data?.realtimePositionList) ? data.realtimePositionList : []; }

export async function prefetchPositionCache(lines: Iterable<string>, timeout = 5, fetchImpl: FetchLike = fetch): Promise<PositionCache> {
  const unique = [...new Set([...lines].filter((line): line is LineName => (LINE_NAMES as readonly string[]).includes(line)))].sort(); const cache: PositionCache = new Map(); if (!unique.length) return cache;
  const values = await Promise.all(unique.map(async (line): Promise<readonly [string, PositionCacheEntry]> => { try { const result = await fetchPosition(line, timeout, fetchImpl); const value: PositionCacheEntry = result.ok ? { rows: positionRows(result.data), error: "", available: true } : { rows: [], error: result.error ?? "실시간 위치 조회 실패", available: false }; return [line, value]; } catch (error) { const value: PositionCacheEntry = { rows: [], error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), available: false }; return [line, value]; } }));
  for (const [line, value] of values) cacheSet(cache, line, value); return cache;
}

export async function cachedPositionRows(line: string, cache: PositionCache, timeout = 5, fetchImpl: FetchLike = fetch): Promise<{ rows: PositionRow[]; error: string; available: boolean }> {
  let value = cacheGet(cache, line); if (!value) { const result = await fetchPosition(line, timeout, fetchImpl); value = result.ok ? { rows: positionRows(result.data), error: "", available: true } : { rows: [], error: result.error ?? "실시간 위치 조회 실패", available: false }; cacheSet(cache, line, value); }
  if (Array.isArray(value)) return { rows: value, error: "", available: true }; return { rows: value.rows ?? [], error: value.error ?? "", available: Boolean(value.available) };
}

export function apiKeyConfigured(): boolean { return Boolean(Bun.env.SEOUL_API_KEY?.trim()); }
export function healthRealtimeSnapshot(): { configured: boolean; baseUrl: string } { return { configured: apiKeyConfigured(), baseUrl: SEOUL_REALTIME_BASE }; }

export { nowKst, parseDt };
