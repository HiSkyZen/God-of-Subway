import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stationSuggestionOptions, type StationSuggestion } from "./station-suggestions";

export function useClock(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useToast(durationMs = 2_600): readonly [string, (message: string) => void] {
  const [message, setMessage] = useState("");
  const timer = useRef<number | null>(null);
  const notify = useCallback((next: string): void => {
    setMessage(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(""), durationMs);
  }, [durationMs]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return [message, notify] as const;
}

/** Group real interchange stations while preserving physical same-name disambiguation. */
export function useStationSuggestions(stations: Record<string, string[]>, from: string, to: string, active: "from" | "to" | null): StationSuggestion[] {
  return useMemo(() => {
    const query = active === "from" ? from : active === "to" ? to : "";
    return stationSuggestionOptions(stations, query);
  }, [active, from, stations, to]);
}
