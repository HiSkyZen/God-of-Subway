import { useEffect, useState } from "react";
import type { Dispatch, FormEvent, KeyboardEvent, SetStateAction } from "react";
import { apiClient, ApiError } from "./api";
import type { AutoRouteResponse, ClientServiceDay, FavoriteRoute, LiveTripState, RouteObjective, RouteSegmentInput } from "./contract";
import { useStationSuggestions } from "./hooks";
import { stationLineSelector, type StationSuggestion } from "./station-suggestions";
import { localDateTimeString } from "./pure";
import { isRecord, readStorage, STORAGE_KEYS, writeStorage } from "./storage";

export type SuggestionSide = "from" | "to";
export interface JourneySearchOptions { useGtx?: boolean; }

export interface JourneySearchController {
  from: string;
  setFrom: Dispatch<SetStateAction<string>>;
  to: string;
  setTo: Dispatch<SetStateAction<string>>;
  healthState: "checking" | "ok" | "error";
  searchMinutes: number;
  exactTime: string;
  setExactTime(value: string): void;
  day: ClientServiceDay;
  setDay: Dispatch<SetStateAction<ClientServiceDay>>;
  objective: RouteObjective;
  setObjective: Dispatch<SetStateAction<RouteObjective>>;
  useGtx: boolean;
  setUseGtx: Dispatch<SetStateAction<boolean>>;
  showSettings: boolean;
  toggleSettings(): void;
  result: AutoRouteResponse | null;
  error: string;
  loading: boolean;
  favorites: FavoriteRoute[];
  activeSuggestion: SuggestionSide | null;
  setActiveSuggestion: Dispatch<SetStateAction<SuggestionSide | null>>;
  suggestionIndex: number;
  setSuggestionIndex: Dispatch<SetStateAction<number>>;
  suggestions: StationSuggestion[];
  search(event?: FormEvent, offsetOverride?: number, options?: JourneySearchOptions): Promise<boolean>;
  swap(): void;
  adjustTime(minutes: number): void;
  selectSuggestion(suggestion: StationSuggestion): void;
  onStationKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  saveFavorite(): void;
  deleteFavorite(id: string): void;
  loadFavorite(favorite: FavoriteRoute): void;
  restoreTrip(trip: LiveTripState, restored: AutoRouteResponse): void;
  refreshRoute(): Promise<void>;
}

function isFavoriteArray(value: unknown): value is FavoriteRoute[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.segments));
}

function defaultClientDay(): ClientServiceDay {
  const day = new Date().getDay();
  return day === 0 || day === 6 ? "END" : "DAY";
}

function normalizeClientDay(value: unknown): ClientServiceDay {
  return value === "DAY" ? "DAY" : "END";
}

function normalizeObjective(value: unknown): RouteObjective {
  return value === "fewest_transfers" || value === "lowest_cost" ? value : "fastest";
}

export function useJourneySearch(notify: (message: string) => void): JourneySearchController {
  const [from, setFromState] = useState("");
  const [to, setToState] = useState("");
  const [fromSelector, setFromSelector] = useState("");
  const [toSelector, setToSelector] = useState("");
  const setFrom: Dispatch<SetStateAction<string>> = (value) => { setFromSelector(""); setFromState(value); };
  const setTo: Dispatch<SetStateAction<string>> = (value) => { setToSelector(""); setToState(value); };
  const [stations, setStations] = useState<Record<string, string[]>>({});
  const [healthState, setHealthState] = useState<"checking" | "ok" | "error">("checking");
  const [searchMinutes, setSearchMinutes] = useState(0);
  const [exactTimeValue, setExactTimeValue] = useState("");
  const [day, setDay] = useState<ClientServiceDay>(() => normalizeClientDay(localStorage.getItem("jigeumta_service_day") || defaultClientDay()));
  const [objective, setObjective] = useState<RouteObjective>(() => normalizeObjective(localStorage.getItem("jigeumta_route_objective")));
  const [useGtx, setUseGtx] = useState(() => localStorage.getItem("jigeumta_use_gtx") !== "0");
  const [showSettings, setShowSettings] = useState(false);
  const [result, setResult] = useState<AutoRouteResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteRoute[]>(() => readStorage(localStorage, STORAGE_KEYS.favorites, [], isFavoriteArray));
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

  useEffect(() => { localStorage.setItem("jigeumta_service_day", day); }, [day]);
  useEffect(() => { localStorage.setItem("jigeumta_route_objective", objective); }, [objective]);
  useEffect(() => { localStorage.setItem("jigeumta_use_gtx", useGtx ? "1" : "0"); }, [useGtx]);

  const search = async (event?: FormEvent, offsetOverride?: number, options?: JourneySearchOptions): Promise<boolean> => {
    event?.preventDefault();
    if (!from.trim() || !to.trim()) { notify("출발역과 도착역을 입력하세요."); return false; }
    const requestFrom = fromSelector || from.trim();
    const requestTo = toSelector || to.trim();
    const requestUseGtx = options?.useGtx ?? useGtx;
    setLoading(true);
    setError("");
    const start = exactTimeValue ? new Date(`${localDateTimeString(new Date()).slice(0, 10)}T${exactTimeValue}:00`) : new Date(Date.now() + (offsetOverride ?? searchMinutes) * 60_000);
    try {
      const next = await apiClient.autoRoute({
        from: requestFrom,
        to: requestTo,
        start_time: localDateTimeString(start),
        day,
        objective,
        use_gtx: requestUseGtx,
      });
      setResult(next);
      return true;
    } catch (caught: unknown) {
      const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : "조회에 실패했습니다.";
      setError(message);
      return false;
    } finally { setLoading(false); }
  };

  const swap = (): void => {
    const previousFrom = from;
    const previousSelector = fromSelector;
    setFromState(to);
    setFromSelector(toSelector);
    setToState(previousFrom);
    setToSelector(previousSelector);
  };
  const adjustTime = (minutes: number): void => { setExactTimeValue(""); setSearchMinutes(minutes); };
  const setExactTime = (value: string): void => { setExactTimeValue(value); setSearchMinutes(0); };
  const toggleSettings = (): void => setShowSettings((value) => !value);

  const selectSuggestion = (suggestion: StationSuggestion): void => {
    if (activeSuggestion === "from") {
      setFromState(suggestion.station);
      setFromSelector(suggestion.selector);
    } else {
      setToState(suggestion.station);
      setToSelector(suggestion.selector);
    }
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
    const first = favorite.segments[0];
    const last = favorite.segments.at(-1);
    setFromState(first?.from || "");
    setToState(last?.to || "");
    setFromSelector(first ? stationLineSelector(first.from, first.line) : "");
    setToSelector(last ? stationLineSelector(last.to, last.line) : "");
    setDay(normalizeClientDay(favorite.day));
    setResult(null);
    notify("즐겨찾기 경로를 불러왔습니다. 조회를 눌러 계산하세요.");
  };

  const restoreTrip = (trip: LiveTripState, restored: AutoRouteResponse): void => {
    const first = trip.segments[0];
    const last = trip.segments.at(-1);
    setFromState(first?.from || "");
    setToState(last?.to || "");
    setFromSelector(first ? stationLineSelector(first.from, first.line) : "");
    setToSelector(last ? stationLineSelector(last.to, last.line) : "");
    setDay(normalizeClientDay(trip.day));
    setResult(restored);
  };

  const refreshRoute = async (): Promise<void> => {
    if (!result?.segments?.length) return;
    try {
      const segments: RouteSegmentInput[] = result.segments.map((segment) => ({ line: segment.line, from: segment.from, to: segment.to, transfer_walk: segment.transfer_walk, transfer_seconds: segment.transfer_seconds, transfer_info: segment.transfer_info }));
      const next = await apiClient.route({ start_time: result.start_time || localDateTimeString(new Date()), day, segments, refresh_only: true });
      setResult({ ...result, ...next, segments: next.segments, arrival_time: next.arrival_time });
      notify("현재 여정 기준으로 갱신했습니다.");
    } catch (caught: unknown) { notify(caught instanceof Error ? `갱신 실패: ${caught.message}` : "갱신에 실패했습니다."); }
  };

  return {
    from, setFrom, to, setTo, healthState, searchMinutes, exactTime: exactTimeValue, setExactTime, day, setDay,
    objective, setObjective, useGtx, setUseGtx, showSettings, toggleSettings, result, error, loading, favorites,
    activeSuggestion, setActiveSuggestion, suggestionIndex, setSuggestionIndex, suggestions, search, swap, adjustTime,
    selectSuggestion, onStationKeyDown, saveFavorite, deleteFavorite, loadFavorite, restoreTrip, refreshRoute,
  };
}
