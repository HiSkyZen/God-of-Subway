import type { AutoRouteResponse, LiveTripState, RouteRequest, RouteSegment, RouteSegmentInput, TripUpdateRequest } from "./contract";

export function transferSeconds(segment: RouteSegmentInput | undefined): number {
  if (!segment) return 0;
  return Math.max(0, Number(segment.transfer_seconds) || Math.round(Number(segment.transfer_walk || 0) * 60));
}

export function alightTrip(trip: LiveTripState, now: Date): LiveTripState {
  if (trip.phase !== "ride") return trip;
  if (trip.activeIndex >= trip.segments.length - 1) {
    return { ...trip, phase: "done", transferEndsAt: null };
  }
  const seconds = transferSeconds(trip.segments[trip.activeIndex]);
  return { ...trip, phase: "transfer", boardedTrainNo: "", boardedAt: null, transferEndsAt: localDateTime(now.getTime() + seconds * 1_000) };
}

export function completeTransfer(trip: LiveTripState): LiveTripState {
  if (trip.phase !== "transfer" || trip.activeIndex >= trip.segments.length - 1) return trip;
  return {
    ...trip,
    activeIndex: trip.activeIndex + 1,
    phase: "waiting",
    boardedTrainNo: "",
    boardedAt: null,
    transferEndsAt: null,
  };
}

export function boardWaitingTrain(trip: LiveTripState, index: number, trainNo: string, now: Date): LiveTripState {
  const normalizedTrainNo = trainNo.trim();
  if (trip.phase !== "waiting" || index !== trip.activeIndex || !normalizedTrainNo) return trip;
  return {
    ...trip,
    phase: "ride",
    boardedTrainNo: normalizedTrainNo,
    boardedAt: localDateTime(now.getTime()),
    transferEndsAt: null,
  };
}

export function remainingRouteStartIndex(trip: LiveTripState): number {
  return trip.phase === "transfer" ? Math.min(trip.segments.length, trip.activeIndex + 1) : trip.activeIndex;
}

export function remainingRouteRequest(trip: LiveTripState, now: Date): RouteRequest {
  const startIndex = remainingRouteStartIndex(trip);
  return {
    start_time: trip.phase === "transfer" && trip.transferEndsAt ? trip.transferEndsAt : localDateTime(now.getTime()),
    day: trip.day,
    segments: trip.segments.slice(startIndex),
    refresh_only: false,
  };
}

export function mergeCalculatedSegments(existing: RouteSegment[], startIndex: number, calculated: RouteSegment[]): RouteSegment[] {
  const merged = [...existing];
  calculated.forEach((segment, offset) => { merged[startIndex + offset] = segment; });
  return merged;
}

export function tripUpdatePayload(trip: LiveTripState): TripUpdateRequest {
  return {
    segments: trip.segments,
    active_index: trip.activeIndex,
    boarded_train_no: trip.boardedTrainNo,
    boarded_at: trip.boardedAt,
    day: trip.day,
  };
}

export function restoredRouteResult(trip: LiveTripState): AutoRouteResponse {
  const first = trip.segments[0];
  const last = trip.segments.at(-1);
  const lastDisplay = trip.displaySegments.at(-1);
  return {
    ok: true,
    from: first?.from || "",
    to: last?.to || "",
    start_time: trip.platformStart || trip.journeyStartedAt,
    arrival_time: lastDisplay?.alight_dt || "",
    segments: trip.displaySegments,
    transfer_count: Math.max(0, trip.segments.length - 1),
    service_mode: trip.day,
  };
}

function localDateTime(timestamp: number): string {
  const value = new Date(timestamp);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
