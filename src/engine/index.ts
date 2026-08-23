import { datasetMetadata } from "./data-metadata";
import { repository } from "./data-repository";
import {
  apiKeyConfigured,
  fetchPosition,
  healthRealtimeSnapshot,
  prefetchPositionCache,
  cachedPositionRows,
  publicTrainNumber,
  type FetchLike,
} from "./realtime-service";
import {
  calculateLiveTrip as calculateLiveTripImpl,
  calculateRoute as calculateRouteImpl,
} from "./eta-service";
import {
  calculateGtxHybridAuto,
  calculateGtxHybridRoute,
  calculateGtxHybridTrip,
  GTX_LINES,
  isGtxLine,
} from "./gtx-service";
import {
  nowKst,
  resolveServiceMode,
  holidayInfo,
  stationOptions,
  formatKst,
  canonStation,
} from "./timetable-service";
import { stationSelector } from "./routing-service";
import { DISJOINT_HOMONYM_STATIONS } from "./station-identity";
import {
  prepareRuntimeTransfersForResult,
  prepareRuntimeTransfersForSegments,
  runtimeKricTransferSnapshot,
} from "./kric-transfer-service";
import { cacheSnapshot } from "../infra/cache";
import { debugEnabled } from "../infra/observability";
import type {
  AutoRoutePayload,
  CalculateRoutePayload,
  LiveTripPayload,
  PositionCache,
  Serialized,
} from "../types/domain";

export type {
  AutoRoutePayload,
  CalculateRoutePayload,
  LiveTripPayload,
  PositionCache,
  Serialized,
} from "../types/domain";
export {
  nowKst,
  formatKst,
  fetchPosition,
  prefetchPositionCache,
  cachedPositionRows,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function publicStationName(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return stationSelector(value).station || value;
}

function publicizeSegment(
  value: Record<string, unknown>,
  inheritedLine = "",
): Record<string, unknown> {
  const line = String(value.line ?? inheritedLine);
  const result: Record<string, unknown> = { ...value };
  if (Array.isArray(value.nearby_candidates)) {
    result.nearby_candidates = value.nearby_candidates.map((candidate) =>
      isRecord(candidate) ? publicizeSegment(candidate, line) : candidate
    );
  }
  if (isRecord(value.previous_candidate)) {
    result.previous_candidate = publicizeSegment(value.previous_candidate, line);
  }
  const trackingId = String(value.tracking_id ?? value.train_no ?? "").trim();
  if (trackingId && (line === "신분당선" || isGtxLine(line))) {
    result.tracking_id = trackingId;
    result.train_no = publicTrainNumber(line, trackingId);
  }
  return result;
}

function publicizeResult(value: Serialized): Serialized {
  const result: Serialized = { ...value };
  if ("from" in result) result.from = publicStationName(result.from);
  if ("to" in result) result.to = publicStationName(result.to);
  if (Array.isArray(value.segments)) {
    result.segments = value.segments.map((segment) =>
      isRecord(segment) ? publicizeSegment(segment) : segment
    );
  }
  if (Array.isArray(value.alternatives)) {
    result.alternatives = value.alternatives.map((alternative) =>
      !isRecord(alternative)
        ? alternative
        : {
            ...alternative,
            ...(Array.isArray(alternative.segments)
              ? {
                  segments: alternative.segments.map((segment) =>
                    isRecord(segment) ? publicizeSegment(segment) : segment
                  ),
                }
              : {}),
          }
    );
  }
  return result;
}

function usesGtx(result: Serialized): boolean {
  return Array.isArray(result.segments)
    && result.segments.some(
      (segment) => isRecord(segment) && isGtxLine(String(segment.line ?? "")),
    );
}

export function shouldPreferNonGtxTie(
  withGtx: Serialized,
  withoutGtx: Serialized,
): boolean {
  return withGtx.ok !== false
    && withoutGtx.ok !== false
    && usesGtx(withGtx)
    && !usesGtx(withoutGtx)
    && Boolean(String(withGtx.arrival_time ?? ""))
    && String(withGtx.arrival_time ?? "") === String(withoutGtx.arrival_time ?? "");
}

export async function calculateRoute(
  payload: Record<string, unknown>,
  positionCache?: PositionCache,
  fetchImpl: FetchLike = fetch,
): Promise<Serialized> {
  const typed = payload as unknown as CalculateRoutePayload;
  await prepareRuntimeTransfersForSegments(typed.segments, fetchImpl);
  const result = !typed.segments.some((segment) => isGtxLine(String(segment.line)))
    ? await calculateRouteImpl(typed, positionCache, fetchImpl)
    : await calculateGtxHybridRoute(
        typed,
        (next) => calculateRouteImpl(next, positionCache, fetchImpl),
        fetchImpl,
      );
  return publicizeResult(result);
}

async function calculateAutoRouteOnce(
  typed: AutoRoutePayload,
  fetchImpl: FetchLike,
): Promise<Serialized> {
  return calculateGtxHybridAuto(
    typed,
    (next) => calculateRouteImpl(next, undefined, fetchImpl),
    fetchImpl,
  );
}

export async function calculateAutoRoute(
  payload: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<Serialized> {
  const typed = payload as unknown as AutoRoutePayload;
  let result = await calculateAutoRouteOnce(typed, fetchImpl);

  if (
    result.ok !== false
    && await prepareRuntimeTransfersForResult(result as Record<string, unknown>, fetchImpl)
  ) {
    result = await calculateAutoRouteOnce(typed, fetchImpl);
  }
  return publicizeResult(result);
}

export async function calculateLiveTrip(
  payload: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<Serialized> {
  const typed = payload as unknown as LiveTripPayload;
  await prepareRuntimeTransfersForSegments(typed.segments, fetchImpl);
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
  const db = repository.validate();
  return {
    ok: true,
    version: "V14.4.0-bun-sqlite",
    upstream_parity: "V13.4.8",
    today_service_mode: mode,
    today_service_reason: reason,
    today_is_holiday: Boolean(holiday),
    data: datasetMetadata(),
    api_key_configured: apiKeyConfigured(),
    realtime: healthRealtimeSnapshot(),
    cache: cacheSnapshot(),
    debug_enabled: debugEnabled(),
    station_line_count: Object.keys(stationsByLine).length,
    sqlite: {
      schema_version: db.schemaVersion,
      build_mode: db.buildMode,
      stations: db.stations,
      trips: db.trips,
      stop_times: db.stopTimes,
      transfers: db.transfers,
    },
    transfer_policy: {
      upstream: "normalized-SQLite",
      completion_overlay: false,
      runtime_missing_duration: 0,
      crowding_cap: 1.75,
      homonym_line_selection: true,
      kric_runtime: runtimeKricTransferSnapshot(),
    },
    gtx_a: {
      mode: "sqlite-timetable+realtime",
      sections: Object.fromEntries(
        Object.entries(GTX_LINES).map(([line, cfg]) => [line, cfg.stations]),
      ),
    },
  };
}

function publicStationOptions(): Record<string, string[]> {
  const result: Record<string, string[]> = {
    ...stationOptions(),
    ...Object.fromEntries(
      Object.entries(GTX_LINES).map(([line, cfg]) => [line, [...cfg.stations]]),
    ),
  };
  for (const entry of DISJOINT_HOMONYM_STATIONS) {
    for (const line of entry.lines) {
      const stations = result[line] ?? [];
      if (!stations.some((station) => canonStation(station) === canonStation(entry.station))) {
        stations.push(entry.station);
      }
      result[line] = stations.sort((a, b) => a.localeCompare(b, "ko"));
    }
  }
  return result;
}

export const stationsByLine: Record<string, string[]> = publicStationOptions();
export const API_KEY_CONFIGURED = apiKeyConfigured();
