import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "./api";
import type { AutoRouteResponse, LiveTripState, RouteResponse, ServiceMode } from "./contract";
import { localDateTimeString } from "./pure";
import { alertNeedsTripReplacement } from "./push-alert";
import { isRecord, readStorage, STORAGE_KEYS, writeStorage } from "./storage";
import { alightTrip, boardWaitingTrain, completeTransfer, mergeCalculatedSegments, remainingRouteRequest, remainingRouteStartIndex, restoredRouteResult, tripUpdatePayload } from "./trip-state";

export type StoredTrip = LiveTripState;

export interface LiveAlertSnapshot {
  alert_id: string;
  trip_snapshot?: string;
  pending_cancel?: boolean;
}

export interface LiveJourneyOptions {
  result: AutoRouteResponse | null;
  day: ServiceMode;
  alert: LiveAlertSnapshot | null;
  notify(message: string): void;
  onSyncAlert(trip: StoredTrip, quiet: boolean): Promise<unknown | null>;
  onClearAlert(quiet: boolean): Promise<void>;
}

export interface LiveJourneyController {
  liveTrip: StoredTrip | null;
  liveResult: RouteResponse | null;
  restoredResult: AutoRouteResponse | null;
  clearLiveResult(): void;
  startTracking(index: number, trainNo: string | number, displayLabel?: string): void;
  finishTransfer(): Promise<void>;
  handleAlight(): void;
  stopTracking(quiet?: boolean): void;
  refreshLiveJourney(): Promise<boolean>;
}

function isStoredTrip(value: unknown): value is StoredTrip {
  return isRecord(value) && typeof value.activeIndex === "number" && ["ride", "transfer", "waiting", "done"].includes(String(value.phase))
    && typeof value.boardedTrainNo === "string" && Array.isArray(value.segments) && Array.isArray(value.displaySegments)
    && typeof value.journeyStartedAt === "string";
}

function shouldAdvance(result: RouteResponse): boolean {
  return Boolean(result.segments?.[0]?.arrived) || Number(result.current_segment_remaining_seconds ?? result.remaining_seconds ?? 1) <= 0;
}

export function useLiveJourney(options: LiveJourneyOptions): LiveJourneyController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [liveTrip, setLiveTrip] = useState<StoredTrip | null>(() => readStorage<StoredTrip | null>(sessionStorage, STORAGE_KEYS.liveTrip, null, (value): value is StoredTrip | null => value === null || isStoredTrip(value)));
  const [liveResult, setLiveResult] = useState<RouteResponse | null>(null);
  const liveTripRef = useRef<StoredTrip | null>(liveTrip);
  liveTripRef.current = liveTrip;

  const persistLiveTrip = useCallback((trip: StoredTrip): void => {
    liveTripRef.current = trip;
    setLiveTrip(trip);
    writeStorage(sessionStorage, STORAGE_KEYS.liveTrip, trip);
  }, []);

  const clearLiveResult = useCallback((): void => { setLiveResult(null); }, []);

  const startTracking = useCallback((index: number, trainNo: string | number, displayLabel?: string): void => {
    const normalizedTrainNo = String(trainNo).trim();
    if (!normalizedTrainNo || normalizedTrainNo === "-") return;
    const currentOptions = optionsRef.current;
    const currentTrip = liveTripRef.current;
    const nowValue = new Date();
    const nowText = localDateTimeString(nowValue);
    let trip: StoredTrip;
    if (currentTrip?.phase === "waiting") {
      const next = boardWaitingTrain(currentTrip, index, normalizedTrainNo, nowValue);
      if (next === currentTrip) return;
      trip = next;
    } else if (currentTrip?.phase === "ride" && currentTrip.activeIndex === index) {
      trip = { ...currentTrip, boardedTrainNo: normalizedTrainNo, boardedAt: nowText };
    } else {
      const currentResult = currentOptions.result;
      if (!currentResult?.segments?.length) return;
      trip = {
        activeIndex: index,
        phase: "ride",
        boardedTrainNo: normalizedTrainNo,
        boardedAt: nowText,
        trackingStartedAt: nowText,
        platformStart: currentResult.start_time || null,
        segments: currentResult.segments.map((segment) => ({ line: segment.line, from: segment.from, to: segment.to, transfer_walk: segment.transfer_walk, transfer_seconds: segment.transfer_seconds, transfer_info: segment.transfer_info })),
        day: currentOptions.day,
        previousNextTrain: null,
        displaySegments: currentResult.segments,
        transferEndsAt: null,
        journeyStartedAt: nowText,
      };
    }
    persistLiveTrip(trip);
    setLiveResult(null);
    const publicLabel = String(displayLabel ?? "").trim();
    currentOptions.notify(publicLabel ? `${publicLabel}를 추적합니다.` : `${normalizedTrainNo}열차를 추적합니다.`);
    const alert = currentOptions.alert;
    if (alert && !alert.pending_cancel && alertNeedsTripReplacement(alert.trip_snapshot, trip)) {
      void currentOptions.onSyncAlert(trip, true).then((saved) => { if (!saved) optionsRef.current.notify("도착 알림 동기화 실패"); });
    }
  }, [persistLiveTrip]);

  const recalculateRemainingRoute = useCallback(async (trip: StoredTrip): Promise<RouteResponse | null> => {
    const startIndex = remainingRouteStartIndex(trip);
    if (!trip.segments.slice(startIndex).length) return null;
    const next = await apiClient.route(remainingRouteRequest(trip, new Date()));
    const latest = liveTripRef.current;
    if (!latest || latest.journeyStartedAt !== trip.journeyStartedAt || latest.phase === "ride" || latest.phase === "done" || remainingRouteStartIndex(latest) !== startIndex) return null;
    const updated = { ...latest, displaySegments: mergeCalculatedSegments(latest.displaySegments, startIndex, next.segments) };
    liveTripRef.current = updated;
    setLiveTrip(updated);
    writeStorage(sessionStorage, STORAGE_KEYS.liveTrip, updated);
    setLiveResult(next);
    return next;
  }, []);

  const autoBoardWaiting = useCallback((trip: StoredTrip, result: RouteResponse | null): void => {
    if (!result || trip.phase !== "waiting") return;
    const segment = result.segments?.[0];
    const candidateValue = segment?.tracking_id ?? segment?.train_no;
    const candidate = typeof candidateValue === "string" || typeof candidateValue === "number" ? candidateValue : "";
    if (!candidate) return;
    const latest = liveTripRef.current;
    if (!latest || latest.phase !== "waiting" || latest.activeIndex !== trip.activeIndex || latest.journeyStartedAt !== trip.journeyStartedAt) return;
    const publicNo = String(segment?.train_no ?? "").trim();
    startTracking(latest.activeIndex, candidate, publicNo ? `${publicNo}열차` : "시간표 열차");
  }, [startTracking]);

  const finishTransfer = useCallback(async (): Promise<void> => {
    const current = liveTripRef.current;
    if (!current || current.phase !== "transfer") return;
    const waiting = completeTransfer(current);
    if (waiting === current) return;
    persistLiveTrip(waiting);
    setLiveResult(null);
    try {
      const calculated = await recalculateRemainingRoute(waiting);
      autoBoardWaiting(waiting, calculated);
    } catch (caught: unknown) {
      optionsRef.current.notify(caught instanceof Error ? `다음 열차 계산 실패: ${caught.message}` : "다음 열차 계산 실패");
    }
  }, [autoBoardWaiting, persistLiveTrip, recalculateRemainingRoute]);

  const handleAlight = useCallback((): void => {
    const current = liveTripRef.current;
    if (!current || current.phase !== "ride") return;
    const next = alightTrip(current, new Date());
    if (next === current) return;
    persistLiveTrip(next);
    if (next.phase === "done") {
      void optionsRef.current.onClearAlert(true).catch(() => undefined);
      optionsRef.current.notify("목적지에 도착했습니다.");
    } else optionsRef.current.notify("하차했습니다. 환승을 이어갑니다.");
  }, [persistLiveTrip]);

  const stopTracking = useCallback((quiet = false): void => {
    void optionsRef.current.onClearAlert(true).catch(() => undefined);
    liveTripRef.current = null;
    setLiveTrip(null);
    setLiveResult(null);
    sessionStorage.removeItem(STORAGE_KEYS.liveTrip);
    if (!quiet) optionsRef.current.notify("추적을 종료했습니다.");
  }, []);

  const applyRideUpdate = useCallback((current: StoredTrip, next: RouteResponse): StoredTrip => {
    const merged = mergeCalculatedSegments(current.displaySegments, current.activeIndex, next.segments);
    const tracked = { ...current, displaySegments: merged, boardedTrainNo: String(next.boarded_train_no || current.boardedTrainNo) };
    return shouldAdvance(next) ? alightTrip(tracked, new Date()) : tracked;
  }, []);

  const refreshLiveJourney = useCallback(async (): Promise<boolean> => {
    const current = liveTripRef.current;
    if (!current) return false;
    if (current.phase === "ride") {
      const next = await apiClient.tripUpdate(tripUpdatePayload(current));
      const latest = liveTripRef.current;
      if (!latest || latest.journeyStartedAt !== current.journeyStartedAt || latest.phase !== "ride") return true;
      const updated = applyRideUpdate(latest, next);
      setLiveResult(next);
      persistLiveTrip(updated);
      if (updated.phase === "done") void optionsRef.current.onClearAlert(true).catch(() => undefined);
      return true;
    }
    if (current.phase === "transfer") {
      const end = current.transferEndsAt ? new Date(current.transferEndsAt).getTime() : Number.POSITIVE_INFINITY;
      if (Number.isFinite(end) && end <= Date.now()) await finishTransfer();
      else await recalculateRemainingRoute(current);
      return true;
    }
    if (current.phase === "waiting") {
      const next = await recalculateRemainingRoute(current);
      autoBoardWaiting(current, next);
    }
    return true;
  }, [applyRideUpdate, autoBoardWaiting, finishTransfer, persistLiveTrip, recalculateRemainingRoute]);

  useEffect(() => {
    if (!liveTrip || liveTrip.phase === "done") return undefined;
    let cancelled = false;
    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        const requestTrip = liveTripRef.current;
        if (!requestTrip || requestTrip.phase === "done") return;
        if (requestTrip.phase === "transfer") {
          const end = requestTrip.transferEndsAt ? new Date(requestTrip.transferEndsAt).getTime() : Number.POSITIVE_INFINITY;
          if (Number.isFinite(end) && end <= Date.now()) await finishTransfer();
          else await recalculateRemainingRoute(requestTrip);
          return;
        }
        if (requestTrip.phase === "waiting") {
          const next = await recalculateRemainingRoute(requestTrip);
          autoBoardWaiting(requestTrip, next);
          return;
        }
        const next = await apiClient.tripUpdate(tripUpdatePayload(requestTrip));
        if (cancelled) return;
        const latest = liveTripRef.current;
        if (!latest || latest.journeyStartedAt !== requestTrip.journeyStartedAt || latest.phase !== "ride" || latest.activeIndex !== requestTrip.activeIndex || latest.boardedAt !== requestTrip.boardedAt) return;
        setLiveResult(next);
        const updated = applyRideUpdate(latest, next);
        persistLiveTrip(updated);
        if (updated.phase === "transfer") optionsRef.current.notify("하차했습니다. 환승을 이어갑니다.");
        if (updated.phase === "done") {
          void optionsRef.current.onClearAlert(true).catch(() => undefined);
          optionsRef.current.notify("목적지 도착이 확인되었습니다.");
        }
        const alert = optionsRef.current.alert;
        if (alert && !alert.pending_cancel && updated.phase === "ride" && alertNeedsTripReplacement(alert.trip_snapshot, updated)) void optionsRef.current.onSyncAlert(updated, true);
      } catch (caught: unknown) {
        if (!cancelled) optionsRef.current.notify(caught instanceof Error ? caught.message : "추적 갱신 실패");
      } finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 20_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [applyRideUpdate, autoBoardWaiting, finishTransfer, liveTrip?.activeIndex, liveTrip?.boardedTrainNo, liveTrip?.phase, liveTrip?.transferEndsAt, options.alert?.alert_id, options.alert?.trip_snapshot, options.alert?.pending_cancel, persistLiveTrip, recalculateRemainingRoute]);

  useEffect(() => {
    if (!liveTrip || liveTrip.phase !== "transfer" || !liveTrip.transferEndsAt) return undefined;
    const timer = window.setInterval(() => {
      const end = new Date(liveTrip.transferEndsAt || "").getTime();
      if (Number.isFinite(end) && end <= Date.now()) { window.clearInterval(timer); void finishTransfer(); }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [liveTrip?.phase, liveTrip?.transferEndsAt, finishTransfer]);

  return {
    liveTrip,
    liveResult,
    restoredResult: liveTrip?.displaySegments.length ? restoredRouteResult(liveTrip) : null,
    clearLiveResult,
    startTracking,
    finishTransfer,
    handleAlight,
    stopTracking,
    refreshLiveJourney,
  };
}
