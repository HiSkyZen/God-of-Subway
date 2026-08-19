import { useEffect, useState } from "react";
import type { Dispatch, FormEvent, KeyboardEvent, SetStateAction } from "react";
import { apiClient, ApiError } from "./api";
import { track, trackOnce } from "./analytics";
import type { AutoRouteResponse, Confidence, ExperimentRecord, FavoriteRoute, LiveTripState, RouteResponse, RouteSegmentInput, ServiceMode } from "./contract";
import { useStationSuggestions } from "./hooks";
import { addMinutesToDateTime, experimentsToCsv, experimentsToJson, localDateTimeString } from "./pure";
import { isRecord, readStorage, STORAGE_KEYS, writeStorage } from "./storage";

export type SuggestionSide = "from" | "to";
export interface JourneySearchOptions { excludeGtx?: boolean; }

export interface JourneySearchController {
  from: string;
  setFrom: Dispatch<SetStateAction<string>>;
  to: string;
  setTo: Dispatch<SetStateAction<string>>;
  healthState: "checking" | "ok" | "error";
  searchMinutes: number;
  exactTime: string;
  setExactTime(value: string): void;
  day: ServiceMode;
  setDay: Dispatch<SetStateAction<ServiceMode>>;
  baseline: string;
  setBaseline: Dispatch<SetStateAction<string>>;
  showSettings: boolean;
  toggleSettings(): void;
  result: AutoRouteResponse | null;
  error: string;
  loading: boolean;
  favorites: FavoriteRoute[];
  experiments: ExperimentRecord[];
  experimentEnabled: boolean;
  setExperimentEnabled: Dispatch<SetStateAction<boolean>>;
  activeSuggestion: SuggestionSide | null;
  setActiveSuggestion: Dispatch<SetStateAction<SuggestionSide | null>>;
  suggestionIndex: number;
  setSuggestionIndex: Dispatch<SetStateAction<number>>;
  suggestions: string[];
  search(event?: FormEvent, offsetOverride?: number, options?: JourneySearchOptions): Promise<boolean>;
  swap(): void;
  adjustTime(minutes: number): void;
  selectSuggestion(name: string): void;
  onStationKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  saveFavorite(): void;
  deleteFavorite(id: string): void;
  loadFavorite(favorite: FavoriteRoute): void;
  restoreTrip(trip: LiveTripState, restored: AutoRouteResponse): void;
  recordBoardEvent(trip: LiveTripState, index: number, trainNo: string): void;
  recordEtaUpdate(result: RouteResponse, kind: string): void;
  arriveExperiment(): void;
  updateExperiment(id: string, update: Partial<ExperimentRecord>): void;
  deleteExperiment(id: string): void;
  exportExperiments(format: "csv" | "json"): void;
  refreshRoute(): Promise<void>;
}

function isExperimentArray(value: unknown): value is ExperimentRecord[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.created_at === "string" && typeof item.from === "string" && typeof item.to === "string" && Array.isArray(item.route_segments));
}

function isFavoriteArray(value: unknown): value is FavoriteRoute[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.segments));
}

function confidenceLabel(value?: Confidence): string { return value || "낮음"; }

function createExperiment(result: AutoRouteResponse, segments: RouteSegmentInput[], baseline: number | null, day: ServiceMode): ExperimentRecord {
  const now = localDateTimeString(new Date());
  const initialEta = result.arrival_time || result.estimated_arrival_time || null;
  return {
    id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    fingerprint: JSON.stringify({ date: now.slice(0, 10), from: segments[0]?.from, to: segments.at(-1)?.to, segments }),
    created_at: now, completed_at: null, excluded: false,
    from: segments[0]?.from || "", to: segments.at(-1)?.to || "", planned_platform_arrival: result.start_time || now,
    day_requested: day, service_mode: result.service_mode || day, service_mode_reason: result.service_mode_reason || "",
    route_segments: segments, route_text: segments.map((segment) => `${segment.line} ${segment.from}→${segment.to}`).join(" / "),
    transfer_count: Math.max(0, segments.length - 1), baseline_minutes: baseline,
    baseline_arrival: baseline == null ? null : addMinutesToDateTime(result.start_time || now, baseline),
    initial_eta: initialEta, initial_total_seconds: result.total_seconds || result.estimated_total_seconds || null, initial_quality: confidenceLabel(result.segments?.[0]?.confidence),
    initial_predictions: result.segments || [], last_eta: initialEta, last_quality: confidenceLabel(result.segments?.[0]?.confidence),
    board_events: [], eta_events: initialEta ? [{ at: now, kind: "route_search", eta: initialEta, remaining_seconds: Number(result.total_seconds ?? result.estimated_total_seconds) || 0, quality: confidenceLabel(result.segments?.[0]?.confidence), segments: result.segments || [] }] : [], actual_arrival: null, note: "",
  };
}

function exportFile(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function useJourneySearch(notify: (message: string) => void): JourneySearchController {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [stations, setStations] = useState<Record<string, string[]>>({});
  const [healthState, setHealthState] = useState<"checking" | "ok" | "error">("checking");
  const [searchMinutes, setSearchMinutes] = useState(0);
  const [exactTimeValue, setExactTimeValue] = useState("");
  const [day, setDay] = useState<ServiceMode>("AUTO");
  const [baseline, setBaseline] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [result, setResult] = useState<AutoRouteResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteRoute[]>(() => readStorage(localStorage, STORAGE_KEYS.favorites, [], isFavoriteArray));
  const [experiments, setExperiments] = useState<ExperimentRecord[]>(() => readStorage(localStorage, STORAGE_KEYS.experiments, [], isExperimentArray));
  const [experimentEnabled, setExperimentEnabled] = useState(true);
  const [activeSuggestion, setActiveSuggestion] = useState<SuggestionSide | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const suggestions = useStationSuggestions(stations, from, to, activeSuggestion);

  useEffect(() => {
    let mounted = true;
    void Promise.all([apiClient.health(), apiClient.stations()]).then(([, stationResponse]) => {
      if (!mounted) return;
      setHealthState("ok");
      setStations(stationResponse.stations || {});
    }).catch(() => {
      if (!mounted) return;
      setHealthState("error");
      setError("실시간 연결을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (from.trim() && to.trim()) trackOnce("station_set", "session", { from: from.trim(), to: to.trim() });
  }, [from, to]);

  const search = async (event?: FormEvent, offsetOverride?: number, options?: JourneySearchOptions): Promise<boolean> => {
    event?.preventDefault();
    if (!from.trim() || !to.trim()) { notify("출발역과 도착역을 입력하세요."); track("route_search_invalid"); return false; }
    const excludeGtx = Boolean(options?.excludeGtx);
    setLoading(true);
    setError("");
    track("route_search", { from, to, exclude_gtx: excludeGtx });
    trackOnce("station_set", "session", { from: from.trim(), to: to.trim() });
    const start = exactTimeValue ? new Date(`${localDateTimeString(new Date()).slice(0, 10)}T${exactTimeValue}:00`) : new Date(Date.now() + (offsetOverride ?? searchMinutes) * 60_000);
    const inputSegments: RouteSegmentInput[] = [{ line: "", from: from.trim(), to: to.trim(), transfer_walk: 0, transfer_seconds: 0 }];
    try {
      const next = await apiClient.autoRoute({ from: from.trim(), to: to.trim(), start_time: localDateTimeString(start), baseline_minutes: baseline || null, day, exclude_gtx: excludeGtx });
      setResult(next);
      track("route_search_success", { transfer_count: next.transfer_count ?? -1, exclude_gtx: excludeGtx });
      if (experimentEnabled) {
        const all = readStorage(localStorage, STORAGE_KEYS.experiments, [], isExperimentArray);
        const activeId = localStorage.getItem(STORAGE_KEYS.activeExperiment);
        const current = activeId ? all.find((item) => item.id === activeId && !item.completed_at) : null;
        const experiment = current || createExperiment(next, next.segments?.map((segment) => ({ line: segment.line, from: segment.from, to: segment.to, transfer_walk: segment.transfer_walk, transfer_seconds: segment.transfer_seconds })) || inputSegments, baseline ? Number(baseline) : null, day);
        const updated = current ? all : [...all, experiment];
        writeStorage(localStorage, STORAGE_KEYS.experiments, updated);
        localStorage.setItem(STORAGE_KEYS.activeExperiment, experiment.id);
        setExperiments(updated);
      }
      return true;
    } catch (caught: unknown) {
      const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : "조회에 실패했습니다.";
      setError(message);
      track("route_search_error", { reason: message.slice(0, 100), exclude_gtx: excludeGtx });
      return false;
    } finally { setLoading(false); }
  };

  const swap = (): void => { setFrom(to); setTo(from); };
  const adjustTime = (minutes: number): void => { setExactTimeValue(""); setSearchMinutes(minutes); trackOnce("time_adjust", "session", { offset_minutes: minutes }); };
  const setExactTime = (value: string): void => { setExactTimeValue(value); setSearchMinutes(0); trackOnce("time_adjust", "session", { exact_time: value }); };
  const toggleSettings = (): void => setShowSettings((value) => !value);

  const selectSuggestion = (name: string): void => {
    if (activeSuggestion === "from") setFrom(name); else setTo(name);
    setActiveSuggestion(null);
    setSuggestionIndex(-1);
  };

  const onStationKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionIndex((index) => (index + 1) % suggestions.length); }
    if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length); }
    if (event.key === "Enter" && suggestionIndex >= 0) { event.preventDefault(); selectSuggestion(suggestions[suggestionIndex]); }
    if (event.key === "Escape") setActiveSuggestion(null);
  };

  const saveFavorite = (): void => {
    if (!result?.segments?.length) { notify("먼저 경로를 조회하세요."); return; }
    const favorite: FavoriteRoute = { id: String(Date.now()), name: `${from} → ${to}`, day, segments: result.segments.map((segment) => ({ line: segment.line, from: segment.from, to: segment.to, transfer_walk: segment.transfer_walk, transfer_seconds: segment.transfer_seconds, transfer_info: segment.transfer_info })) };
    const signature = JSON.stringify({ day: favorite.day, segments: favorite.segments });
    if (favorites.some((item) => JSON.stringify({ day: item.day, segments: item.segments }) === signature)) { notify("이미 저장된 경로입니다."); return; }
    const next = [...favorites, favorite];
    setFavorites(next);
    writeStorage(localStorage, STORAGE_KEYS.favorites, next);
    notify("즐겨찾기에 저장했습니다.");
  };

  const deleteFavorite = (id: string): void => {
    if (!id) { notify("삭제할 즐겨찾기를 선택하세요."); return; }
    const next = favorites.filter((favorite) => favorite.id !== id);
    setFavorites(next);
    writeStorage(localStorage, STORAGE_KEYS.favorites, next);
    notify("즐겨찾기를 삭제했습니다.");
  };

  const loadFavorite = (favorite: FavoriteRoute): void => {
    setFrom(favorite.segments[0]?.from || "");
    setTo(favorite.segments.at(-1)?.to || "");
    setDay(favorite.day);
    setResult(null);
    notify("즐겨찾기 경로를 불러왔습니다. 조회를 눌러 계산하세요.");
  };

  const restoreTrip = (trip: LiveTripState, restored: AutoRouteResponse): void => {
    setFrom(trip.segments[0]?.from || "");
    setTo(trip.segments.at(-1)?.to || "");
    setDay(trip.day);
    setBaseline(trip.baseline == null ? "" : String(trip.baseline));
    setResult(restored);
  };

  const recordBoardEvent = (trip: LiveTripState, index: number, trainNo: string): void => {
    const activeExperimentId = localStorage.getItem(STORAGE_KEYS.activeExperiment);
    if (!activeExperimentId) return;
    const all = readStorage(localStorage, STORAGE_KEYS.experiments, [], isExperimentArray);
    const experiment = all.find((item) => item.id === activeExperimentId);
    const recommendation = trip.displaySegments[index];
    if (!experiment || !recommendation || experiment.board_events.some((boardEvent) => boardEvent.segment_index === index && boardEvent.boarded_train_no === String(trainNo))) return;
    experiment.board_events.push({ at: trip.boardedAt || localDateTimeString(new Date()), segment_index: index, line: recommendation.line, from: recommendation.from, to: recommendation.to, boarded_train_no: String(trainNo), recommended_train_no: String(recommendation.train_no || ""), matches_recommendation: Boolean(recommendation.train_no && String(recommendation.train_no) === String(trainNo)), recommendation_confidence: confidenceLabel(recommendation.confidence), recommendation_delay_seconds: Number(recommendation.delay_seconds) || 0, recommendation_eta: recommendation.alight_dt || "" });
    writeStorage(localStorage, STORAGE_KEYS.experiments, all);
    setExperiments(all);
  };

  const recordEtaUpdate = (next: RouteResponse, kind: string): void => {
    const activeExperimentId = localStorage.getItem(STORAGE_KEYS.activeExperiment);
    if (!activeExperimentId) return;
    const all = readStorage(localStorage, STORAGE_KEYS.experiments, [], isExperimentArray);
    const experiment = all.find((item) => item.id === activeExperimentId);
    if (!experiment) return;
    experiment.last_eta = next.arrival_time || next.estimated_arrival_time || experiment.last_eta;
    experiment.final_eta = experiment.last_eta;
    experiment.last_quality = confidenceLabel(next.segments?.[0]?.confidence || experiment.last_quality);
    experiment.eta_events.push({ at: localDateTimeString(new Date()), kind, eta: experiment.last_eta || "", remaining_seconds: Number(next.remaining_seconds ?? next.total_seconds ?? next.estimated_total_seconds) || 0, quality: experiment.last_quality, segments: next.segments });
    writeStorage(localStorage, STORAGE_KEYS.experiments, all);
    setExperiments(all);
  };

  const arriveExperiment = (): void => {
    const activeId = localStorage.getItem(STORAGE_KEYS.activeExperiment);
    if (!activeId) return;
    const now = localDateTimeString(new Date());
    const next = experiments.map((item) => item.id === activeId ? { ...item, completed_at: now, actual_arrival: now } : item);
    setExperiments(next);
    writeStorage(localStorage, STORAGE_KEYS.experiments, next);
    localStorage.removeItem(STORAGE_KEYS.activeExperiment);
    notify("실제 도착을 기록했습니다.");
  };

  const updateExperiment = (id: string, update: Partial<ExperimentRecord>): void => {
    const next = experiments.map((item) => item.id === id ? { ...item, ...update } : item);
    setExperiments(next);
    writeStorage(localStorage, STORAGE_KEYS.experiments, next);
  };

  const deleteExperiment = (id: string): void => {
    const next = experiments.filter((item) => item.id !== id);
    setExperiments(next);
    writeStorage(localStorage, STORAGE_KEYS.experiments, next);
    if (localStorage.getItem(STORAGE_KEYS.activeExperiment) === id) localStorage.removeItem(STORAGE_KEYS.activeExperiment);
    notify("실험 기록을 삭제했습니다.");
  };

  const exportExperiments = (format: "csv" | "json"): void => {
    if (format === "csv") exportFile("jigeumta-experiments.csv", experimentsToCsv(experiments), "text/csv;charset=utf-8");
    else exportFile("jigeumta-experiments.json", experimentsToJson(experiments), "application/json");
  };

  const refreshRoute = async (): Promise<void> => {
    if (!result?.segments?.length) return;
    try {
      const segments: RouteSegmentInput[] = result.segments.map((segment) => ({ line: segment.line, from: segment.from, to: segment.to, transfer_walk: segment.transfer_walk, transfer_seconds: segment.transfer_seconds, transfer_info: segment.transfer_info }));
      const next = await apiClient.route({ start_time: result.start_time || localDateTimeString(new Date()), baseline_minutes: baseline || null, day, segments, refresh_only: true });
      setResult({ ...result, ...next, segments: next.segments, arrival_time: next.arrival_time });
      notify("현재 여정 기준으로 갱신했습니다.");
    } catch (caught: unknown) { notify(caught instanceof Error ? `갱신 실패: ${caught.message}` : "갱신에 실패했습니다."); }
  };

  return {
    from, setFrom, to, setTo, healthState, searchMinutes, exactTime: exactTimeValue, setExactTime, day, setDay, baseline, setBaseline,
    showSettings, toggleSettings, result, error, loading, favorites, experiments, experimentEnabled, setExperimentEnabled,
    activeSuggestion, setActiveSuggestion, suggestionIndex, setSuggestionIndex, suggestions, search, swap, adjustTime, selectSuggestion,
    onStationKeyDown, saveFavorite, deleteFavorite, loadFavorite, restoreTrip, recordBoardEvent, recordEtaUpdate,
    arriveExperiment, updateExperiment, deleteExperiment, exportExperiments, refreshRoute,
  };
}
