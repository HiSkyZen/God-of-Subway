import { DATASET_METADATA } from "./data-metadata";
import { apiKeyConfigured, fetchPosition, healthRealtimeSnapshot, prefetchPositionCache, cachedPositionRows, publicTrainNumber, type FetchLike } from "./realtime-service";
import { calculateLiveTrip as calculateLiveTripImpl, calculateRoute as calculateRouteImpl } from "./eta-service";
import { calculateGtxHybridAuto, calculateGtxHybridRoute, calculateGtxHybridTrip, GTX_LINES, isGtxLine } from "./gtx-service";
import { nowKst, resolveServiceMode, holidayInfo, stationOptions, formatKst } from "./timetable-service";
import { cacheSnapshot } from "../infra/cache";
import { debugEnabled } from "../infra/observability";
import type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionCache, Serialized } from "../types/domain";

export type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionCache, Serialized } from "../types/domain";
export { nowKst, formatKst, fetchPosition, prefetchPositionCache, cachedPositionRows };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function publicizeSegment(value: Record<string, unknown>, inheritedLine = ""): Record<string, unknown> {
  const line = String(value.line ?? inheritedLine);
  const result: Record<string, unknown> = { ...value };
  if (Array.isArray(value.nearby_candidates)) result.nearby_candidates = value.nearby_candidates.map((candidate) => isRecord(candidate) ? publicizeSegment(candidate, line) : candidate);
  if (isRecord(value.previous_candidate)) result.previous_candidate = publicizeSegment(value.previous_candidate, line);
  const trackingId = String(value.tracking_id ?? value.train_no ?? "").trim();
  if (trackingId && (line === "신분당선" || isGtxLine(line))) {
    result.tracking_id = trackingId;
    result.train_no = publicTrainNumber(line, trackingId);
  }
  return result;
}

function publicizeResult(value: Serialized): Serialized {
  const result: Serialized = { ...value };
  if (Array.isArray(value.segments)) result.segments = value.segments.map((segment) => isRecord(segment) ? publicizeSegment(segment) : segment);
  if (Array.isArray(value.alternatives)) {
    result.alternatives = value.alternatives.map((alternative) => {
      if (!isRecord(alternative)) return alternative;
      return {
        ...alternative,
        ...(Array.isArray(alternative.segments) ? { segments: alternative.segments.map((segment) => isRecord(segment) ? publicizeSegment(segment) : segment) } : {}),
      };
    });
  }
  return result;
}

function usesGtx(result: Serialized): boolean {
  return Array.isArray(result.segments) && result.segments.some((segment) => isRecord(segment) && isGtxLine(String(segment.line ?? "")));
}

export function shouldPreferNonGtxTie(withGtx: Serialized, withoutGtx: Serialized): boolean {
  return withGtx.ok !== false
    && withoutGtx.ok !== false
    && usesGtx(withGtx)
    && !usesGtx(withoutGtx)
    && Boolean(String(withGtx.arrival_time ?? ""))
    && String(withGtx.arrival_time ?? "") === String(withoutGtx.arrival_time ?? "");
}

export async function calculateRoute(payload: Record<string, unknown>, positionCache?: PositionCache, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  const typed = payload as unknown as CalculateRoutePayload;
  const result = !typed.segments.some((segment) => isGtxLine(String(segment.line)))
    ? await calculateRouteImpl(typed, positionCache, fetchImpl)
    : await calculateGtxHybridRoute(typed, (next) => calculateRouteImpl(next, positionCache, fetchImpl), fetchImpl);
  return publicizeResult(result);
}

export async function calculateAutoRoute(payload: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  const typed = payload as unknown as AutoRoutePayload;
  let result = await calculateGtxHybridAuto(typed, (next) => calculateRouteImpl(next, undefined, fetchImpl), fetchImpl);
  if (!Boolean(typed.exclude_gtx) && result.ok !== false && usesGtx(result)) {
    const withoutGtx = await calculateGtxHybridAuto({ ...typed, exclude_gtx: true }, (next) => calculateRouteImpl(next, undefined, fetchImpl), fetchImpl);
    if (shouldPreferNonGtxTie(result, withoutGtx)) {
      result = {
        ...withoutGtx,
        gtx_excluded: false,
        gtx_tie_preferred_non_gtx: true,
        selection_method: "동일 도착시각 GTX-A 비이용 경로 우선",
      };
    }
  }
  return publicizeResult(result);
}

export async function calculateLiveTrip(payload: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  const typed = payload as unknown as LiveTripPayload;
  const result = !typed.segments.some((segment) => isGtxLine(String(segment.line)))
    ? await calculateLiveTripImpl(typed, fetchImpl)
    : await calculateGtxHybridTrip(
      typed,
      (next) => calculateLiveTripImpl(next, fetchImpl),
      (next) => calculateRouteImpl(next, undefined, fetchImpl),
      fetchImpl,
    );
  return publicizeResult(result);
}

export function healthSnapshot(): Record<string, unknown> {
  const now = nowKst();
  const [mode, reason] = resolveServiceMode("AUTO", now);
  const holiday = holidayInfo(now);
  const extra: Record<string, unknown> = {};
  for (const [line, counts] of Object.entries(DATASET_METADATA.extra)) extra[line] = { weekday_trains: counts.weekday, holiday_trains: counts.holiday };
  return {
    ok: true,
    version: "V14.2.0-bun",
    upstream_parity: "V13.4.8",
    today_service_mode: mode,
    today_service_reason: reason,
    today_is_holiday: Boolean(holiday),
    line1_weekday_trains: DATASET_METADATA.line1.weekday,
    line1_holiday_trains: DATASET_METADATA.line1.holiday,
    metro_source: DATASET_METADATA.official.version,
    extra_lines: extra,
    api_key_configured: apiKeyConfigured(),
    realtime: healthRealtimeSnapshot(),
    cache: cacheSnapshot(),
    debug_enabled: debugEnabled(),
    station_line_count: Object.keys(stationsByLine).length,
    gtx_a: { mode: "integrated-route-graph", sections: Object.fromEntries(Object.entries(GTX_LINES).map(([line, cfg]) => [line, cfg.stations])) },
  };
}

export const stationsByLine: Record<string, string[]> = {
  ...stationOptions(),
  ...Object.fromEntries(Object.entries(GTX_LINES).map(([line, cfg]) => [line, [...cfg.stations]])),
};
export const API_KEY_CONFIGURED = apiKeyConfigured;
