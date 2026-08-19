import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { stationSuggestionOptions } from "./station-suggestions";

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

/** Keep line identity in the visible value so names such as 신촌/양평 are never collapsed. */
export function useStationSuggestions(stations: Record<string, string[]>, from: string, to: string, active: "from" | "to" | null): string[] {
  return useMemo(() => {
    const query = active === "from" ? from : active === "to" ? to : "";
    return stationSuggestionOptions(stations, query).map((candidate) => candidate.label);
  }, [active, from, stations, to]);
}
