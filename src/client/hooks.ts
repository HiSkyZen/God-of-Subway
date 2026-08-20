import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stationMatches } from "./pure";

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

export function useStationSuggestions(stations: Record<string, string[]>, from: string, to: string, active: "from" | "to" | null): string[] {
  const allStations = useMemo(() => [...new Set(Object.values(stations).flat())].sort((a, b) => a.length - b.length || a.localeCompare(b, "ko")), [stations]);
  return useMemo(() => {
    const query = active === "from" ? from : to;
    return query.trim() ? allStations.filter((name) => stationMatches(name, query)).slice(0, 8) : [];
  }, [active, allStations, from, to]);
}

