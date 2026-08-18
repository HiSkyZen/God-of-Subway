import { DATASET_METADATA } from "./data-metadata";
import { apiKeyConfigured, fetchPosition, healthRealtimeSnapshot, prefetchPositionCache, cachedPositionRows, type FetchLike } from "./realtime-service";
import { calculateAutoRoute as calculateAutoRouteImpl, calculateLiveTrip as calculateLiveTripImpl, calculateRoute as calculateRouteImpl } from "./eta-service";
import { nowKst, resolveServiceMode, holidayInfo, stationOptions, STATIONS_BY_LINE, formatKst } from "./timetable-service";
import type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionCache, Serialized } from "../types/domain";

export type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionCache, Serialized } from "../types/domain";
export { nowKst, formatKst, fetchPosition, prefetchPositionCache, cachedPositionRows };
export function calculateRoute(payload: Record<string, unknown>, positionCache?: PositionCache, fetchImpl?: FetchLike): Promise<Serialized> {
  return calculateRouteImpl(payload as unknown as CalculateRoutePayload, positionCache, fetchImpl);
}
export function calculateAutoRoute(payload: Record<string, unknown>, fetchImpl?: FetchLike): Promise<Serialized> {
  return calculateAutoRouteImpl(payload as unknown as AutoRoutePayload, fetchImpl);
}
export function calculateLiveTrip(payload: Record<string, unknown>, fetchImpl?: FetchLike): Promise<Serialized> {
  return calculateLiveTripImpl(payload as unknown as LiveTripPayload, fetchImpl);
}

export function healthSnapshot(): Record<string, unknown> {
  const now = nowKst(); const [mode, reason] = resolveServiceMode("AUTO", now); const holiday = holidayInfo(now); const extra: Record<string, unknown> = {};
  for (const [line, counts] of Object.entries(DATASET_METADATA.extra)) extra[line] = { weekday_trains: counts.weekday, holiday_trains: counts.holiday };
  return { ok: true, version: "V13.3.1-bun", today_service_mode: mode, today_service_reason: reason, today_is_holiday: Boolean(holiday), line1_weekday_trains: DATASET_METADATA.line1.weekday, line1_holiday_trains: DATASET_METADATA.line1.holiday, metro_source: DATASET_METADATA.official.version, gyeongui_weekday_trains: DATASET_METADATA.extra["경의중앙선"].weekday, gyeongui_holiday_trains: DATASET_METADATA.extra["경의중앙선"].holiday, suin_weekday_trains: DATASET_METADATA.extra["수인분당선"].weekday, suin_holiday_trains: DATASET_METADATA.extra["수인분당선"].holiday, extra_lines: extra, api_key_configured: apiKeyConfigured(), realtime: healthRealtimeSnapshot(), station_line_count: Object.keys(STATIONS_BY_LINE).length };
}

export const stationsByLine: Record<string, string[]> = stationOptions();
export const API_KEY_CONFIGURED = apiKeyConfigured;
