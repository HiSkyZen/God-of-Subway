import { stationMatches } from "./pure";

const LINE_ICONS: Record<string, string> = {
  "1호선": "🔵", "2호선": "🟢", "3호선": "🟠", "4호선": "🔷", "5호선": "🟣", "6호선": "🟤",
  "7호선": "🟩", "8호선": "🩷", "9호선": "🟡", "경의중앙선": "🩵", "수인분당선": "🟨",
  "경춘선": "🟦", "경강선": "🔷", "서해선": "🟩", "공항철도": "🟦", "신분당선": "🟥",
  "인천1호선": "🩵", "인천2호선": "🟠", "용인에버라인": "🟢", "김포골드라인": "🟡", "의정부경전철": "🟧",
  "GTX-A(북부)": "🟪", "GTX-A(남부)": "🟪",
};

export interface StationSuggestion {
  station: string;
  line: string;
  icon: string;
  label: string;
}

export function lineIcon(line: string): string {
  return LINE_ICONS[line] ?? "⚪";
}

export function formatStationSuggestion(station: string, line: string): string {
  return `${lineIcon(line)} ${line} · ${station}`;
}

export function stationSuggestionOptions(stations: Record<string, string[]>, query: string, limit = 10): StationSuggestion[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const matches: StationSuggestion[] = [];
  const seen = new Set<string>();
  for (const [line, names] of Object.entries(stations)) {
    for (const station of names) {
      if (!stationMatches(station, normalized)) continue;
      const key = `${line}\u0000${station}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ station, line, icon: lineIcon(line), label: formatStationSuggestion(station, line) });
    }
  }
  return matches
    .sort((a, b) => a.station.length - b.station.length || a.station.localeCompare(b.station, "ko") || a.line.localeCompare(b.line, "ko"))
    .slice(0, limit);
}
