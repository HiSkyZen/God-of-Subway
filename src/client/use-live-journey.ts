import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "./api";
import { track } from "./analytics";
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
  baseline: string;
  alert: LiveAlertSnapshot | null;
  notify(message: string): void;
  onBoardEvent(trip: StoredTrip, index: number, trainNo: string): void;
  onEtaEvent(result: RouteResponse, kind: string): void;
  onSyncAlert(trip: StoredTrip, quiet: boolean): Promise<unknown | null>;
  onClearAlert(quiet: boolean): Promise<void>;
}

export interface LiveJourneyController {
  liveTrip: StoredTrip | null;
  liveResult: RouteResponse | null;
  restoredResult: AutoRouteResponse | null;
  clearLiveResult(): void;
  startTracking(index: number, trainNo: string | number): void;
  finishTransfer(): Promise<void>;
  handleAlight(): void;
  stopTracking(): void;
  refreshLiveJourney(): Promise<boolean>;
}

function isStoredTrip(value: unknown): value is StoredTrip {
  return isRecord(value) && typeof value.activeIndex === "number" && ["ride", "transfer", "waiting", "done"].includes(String(value.phase))
    && typeof value.boardedTrainNo === "string" && Array.isArray(value.segments) && Array.isArray(value.displaySegments)
    && typeof value.journeyStartedAt === "string";
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

  const startTracking = useCallback((index: number, trainNo: string | number): void => {
    const normalizedTrainNo = String(trainNo).trim();
    if (!normalizedTrainNo || normalizedTrainNo === "-") return;
    const currentOptions = optionsRef.current;
    const currentTrip = liveTripRef.current;
    const nowValue = new Date();
    let trip: StoredTrip;
    if (currentTrip?.phase === "waiting") {
      const next = boardWaitingTrain(currentTrip, index, normalizedTrainNo, nowValue);
      if (next === currentTrip) return;
      trip = next;
    } else {
      const currentResult = currentOptions.result;
      if (!currentResult?.segments?.length) return;
      const nowText = localDateTimeString(nowValue);
      trip = {
        activeIndex: index, phase: "ride", boardedTrainNo: normalizedTrainNo, boardedAt: nowText, trackingStartedAt: nowText,
        platformStart: currentResult.start_time || null,
        segments: currentResult.segments.map((segment) => ({ line: segment.line, from: segment.from, to: segment.to, transfer_walk: segment.transfer_walk, transfer_seconds: segment.transfer_seconds, transfer_info: segment.transfer_info })),
        day: currentOptions.day, baseline: currentOptions.baseline || null, previousNextTrain: null, displaySegments: currentResult.segments,
        transferEndsAt: null, journeyStartedAt: nowText,
      };
    }
    currentOptions.onBoardEvent(trip, index, normalizedTrainNo);
    persistLiveTrip(trip);
    setLiveResult(null);
    track("train_tracking_start", { line: trip.segments[index]?.line, train_no: normalizedTrainNo, segment_index: index + 1 });
    currentOptions.notify(`${normalizedTrainNo}열차 추적을 시작했습니다.`);
    const alert = currentOptions.alert;
    if (alert && !alert.pending_cancel && alertNeedsTripReplacement(alert.trip_snapshot, trip)) {
      void currentOptions.onSyncAlert(trip, true).then((saved) => { if (!saved) optionsRef.current.notify("다음 구간 도착 알림을 동기화하지 못했습니다."); });
    }
  }, [persistLiveTrip]);

  const recalculateRemainingRoute = useCallback(async (trip: StoredTrip): Promise<RouteResponse | null> => {
    const startIndex = remainingRouteStartIndex(trip);
    if (!trip.segments.slice(startIndex).length) return null;
    const next = await apiClient.route(remainingRouteRequest(trip, new Date()));
    const latest = liveTripRef.current;
    if (!latest || latest.journeyStartedAt !== trip.journeyStartedAt || latest.phase === "ride" || latest.phase === "done" || remainingRouteStartIndex(latest) !== startIndex) return null;
    setLiveResult(next);
    optionsRef.current.onEtaEvent(next, "route_recalculation");
    setLiveTrip((current) => {
      if (!current || current.journeyStartedAt !== trip.journeyStartedAt) return current;
      const updated = { ...current, displaySegments: mergeCalculatedSegments(current.displaySegments, startIndex, next.segments) };
      liveTripRef.current = updated;
      writeStorage(sessionStorage, STORAGE_KEYS.liveTrip, updated);
      return updated;
    });
    return next;
  }, []);

  const finishTransfer = useCallback(async (): Promise<void> => {
    const current = liveTripRef.current;
    if (!current || current.phase !== "transfer") return;
    const next = completeTransfer(current);
    if (next === current) return;
    persistLiveTrip(next);
    setLiveResult(null);
    optionsRef.current.notify("환승을 마쳤습니다. 다음 실제 열차를 선택해 주세요.");
    try { await recalculateRemainingRoute(next); }
    catch (caught: unknown) { optionsRef.current.notify(caught instanceof Error ? `다음 열차 계산 실패: ${caught.message}` : "다음 열차를 계산하지 못했습니다."); }
  }, [persistLiveTrip, recalculateRemainingRoute]);

  const handleAlight = useCallback((): void => {
    const current = liveTripRef.current;
    if (!current || current.phase !== "ride") return;
    const next = alightTrip(current, new Date());
    if (next === current) return;
    persistLiveTrip(next);
    if (next.phase === "done") {
      void optionsRef.current.onClearAlert(true).catch(() => undefined);
      optionsRef.current.notify("목적지에 도착했습니다. 여정을 종료할 수 있습니다.");
    } else optionsRef.current.notify("환승 구간입니다. 환승을 마친 뒤 다음 열차를 선택하세요.");
  }, [persistLiveTrip]);

  const stopTracking = useCallback((): void => {
    void optionsRef.current.onClearAlert(true).catch(() => undefined);
    liveTripRef.current = null;
    setLiveTrip(null);
    setLiveResult(null);
    sessionStorage.removeItem(STORAGE_KEYS.liveTrip);
    optionsRef.current.notify("여정을 마쳤습니다.");
  }, []);

  const refreshLiveJourney = useCallback(async (): Promise<boolean> => {
    const current = liveTripRef.current;
    if (!current) return false;
    if (current.phase === "ride") {
      const next = await apiClient.tripUpdate(tripUpdatePayload(current));
      const latest = liveTripRef.current;
      if (!latest || latest.journeyStartedAt !== current.journeyStartedAt || latest.phase !== "ride") return true;
      const updated = { ...latest, displaySegments: mergeCalculatedSegments(latest.displaySegments, latest.activeIndex, next.segments), boardedTrainNo: next.boarded_train_no || latest.boardedTrainNo };
      setLiveResult(next);
      persistLiveTrip(updated);
      return true;
    }
    if (current.phase === "transfer" || current.phase === "waiting") await recalculateRemainingRoute(current);
    return true;
  }, [persistLiveTrip, recalculateRemainingRoute]);

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
        if (requestTrip.phase !== "ride") { await recalculateRemainingRoute(requestTrip); return; }
        const next = await apiClient.tripUpdate(tripUpdatePayload(requestTrip));
        if (cancelled) return;
        const latest = liveTripRef.current;
        if (!latest || latest.journeyStartedAt !== requestTrip.journeyStartedAt || latest.phase !== "ride" || latest.activeIndex !== requestTrip.activeIndex || latest.boardedAt !== requestTrip.boardedAt) return;
        setLiveResult(next);
        const merged = mergeCalculatedSegments(latest.displaySegments, latest.activeIndex, next.segments);
        const tracked = { ...latest, displaySegments: merged, boardedTrainNo: next.boarded_train_no || latest.boardedTrainNo };
        const updated = Boolean(next.segments?.[0]?.arrived) ? alightTrip(tracked, new Date()) : tracked;
        persistLiveTrip(updated);
        if (updated.phase === "transfer") optionsRef.current.notify("환승 구간입니다. 환승을 마친 뒤 다음 열차를 선택하세요.");
        if (updated.phase === "done") { void optionsRef.current.onClearAlert(true).catch(() => undefined); optionsRef.current.notify("목적지 도착이 확인되었습니다."); }
        const alert = optionsRef.current.alert;
        if (alert && !alert.pending_cancel && updated.phase === "ride" && alertNeedsTripReplacement(alert.trip_snapshot, updated)) void optionsRef.current.onSyncAlert(updated, true);
        optionsRef.current.onEtaEvent(next, "tracking_update");
      } catch (caught: unknown) { if (!cancelled) optionsRef.current.notify(caught instanceof Error ? caught.message : "추적 갱신에 실패했습니다."); }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 20_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [liveTrip?.activeIndex, liveTrip?.boardedTrainNo, liveTrip?.phase, liveTrip?.transferEndsAt, options.alert?.alert_id, options.alert?.trip_snapshot, options.alert?.pending_cancel, persistLiveTrip, recalculateRemainingRoute]);

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
