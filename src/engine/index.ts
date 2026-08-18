import { DATASET_METADATA } from "./data-metadata";
import { apiKeyConfigured, fetchPosition, healthRealtimeSnapshot, prefetchPositionCache, cachedPositionRows, type FetchLike } from "./realtime-service";
import { calculateAutoRoute as calculateAutoRouteImpl, calculateLiveTrip as calculateLiveTripImpl, calculateRoute as calculateRouteImpl } from "./eta-service";
import { calculateGtxAuto, calculateGtxRoute, calculateGtxTrip, GTX_LINES } from "./gtx-service";
import { nowKst, resolveServiceMode, holidayInfo, stationOptions, formatKst } from "./timetable-service";
import { cacheSnapshot } from "../infra/cache";
import { debugEnabled } from "../infra/observability";
import type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionCache, Serialized } from "../types/domain";

export type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionCache, Serialized } from "../types/domain";
export { nowKst, formatKst, fetchPosition, prefetchPositionCache, cachedPositionRows };
export async function calculateRoute(payload: Record<string, unknown>, positionCache?: PositionCache, fetchImpl: FetchLike = fetch): Promise<Serialized> { const typed = payload as unknown as CalculateRoutePayload; const gtx = await calculateGtxRoute(typed, fetchImpl); return gtx ?? calculateRouteImpl(typed, positionCache, fetchImpl); }
export async function calculateAutoRoute(payload: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<Serialized> { const typed = payload as unknown as AutoRoutePayload; const gtx = await calculateGtxAuto(typed, fetchImpl); return gtx ?? calculateAutoRouteImpl(typed, fetchImpl); }
export async function calculateLiveTrip(payload: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<Serialized> { const typed = payload as unknown as LiveTripPayload; const gtx = await calculateGtxTrip(typed, fetchImpl); return gtx ?? calculateLiveTripImpl(typed, fetchImpl); }

export function healthSnapshot(): Record<string, unknown> {
  const now = nowKst(); const [mode, reason] = resolveServiceMode("AUTO", now); const holiday = holidayInfo(now); const extra: Record<string, unknown> = {};
  for (const [line, counts] of Object.entries(DATASET_METADATA.extra)) extra[line] = { weekday_trains: counts.weekday, holiday_trains: counts.holiday };
  return { ok: true, version: "V14.1.0-bun", upstream_parity: "V13.4.8", today_service_mode: mode, today_service_reason: reason, today_is_holiday: Boolean(holiday), line1_weekday_trains: DATASET_METADATA.line1.weekday, line1_holiday_trains: DATASET_METADATA.line1.holiday, metro_source: DATASET_METADATA.official.version, extra_lines: extra, api_key_configured: apiKeyConfigured(), realtime: healthRealtimeSnapshot(), cache: cacheSnapshot(), debug_enabled: debugEnabled(), station_line_count: Object.keys(stationsByLine).length, gtx_a: { mode: "live-first", sections: Object.fromEntries(Object.entries(GTX_LINES).map(([line, cfg]) => [line, cfg.stations])) } };
}
export const stationsByLine: Record<string, string[]> = { ...stationOptions(), ...Object.fromEntries(Object.entries(GTX_LINES).map(([line, cfg]) => [line, [...cfg.stations]])) };
export const API_KEY_CONFIGURED = apiKeyConfigured;
