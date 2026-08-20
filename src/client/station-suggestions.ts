import { stationMatches } from "./pure";

const SELECTOR_SEPARATOR = "\u001f";
const DISJOINT_UI_LINES: Record<string, readonly string[]> = {
  "신촌": ["2호선", "경의중앙선"],
  "양평": ["5호선", "경의중앙선"],
};

export interface LineBadgeSpec {
  line: string;
  text: string;
  color: string;
  shape: "circle" | "pill";
  width: number;
}

const LINE_BADGES: Record<string, Omit<LineBadgeSpec, "line">> = {
  "1호선": { text: "1", color: "#0052A4", shape: "circle", width: 24 },
  "2호선": { text: "2", color: "#00A84D", shape: "circle", width: 24 },
  "3호선": { text: "3", color: "#EF7C1C", shape: "circle", width: 24 },
  "4호선": { text: "4", color: "#00A5DE", shape: "circle", width: 24 },
  "5호선": { text: "5", color: "#996CAC", shape: "circle", width: 24 },
  "6호선": { text: "6", color: "#CD7C2F", shape: "circle", width: 24 },
  "7호선": { text: "7", color: "#747F00", shape: "circle", width: 24 },
  "8호선": { text: "8", color: "#E6186C", shape: "circle", width: 24 },
  "9호선": { text: "9", color: "#BDB092", shape: "circle", width: 24 },
  "공항철도": { text: "공항", color: "#0090D2", shape: "pill", width: 42 },
  "경의중앙선": { text: "경의중앙", color: "#56A98A", shape: "pill", width: 62 },
  "경춘선": { text: "경춘", color: "#178C72", shape: "pill", width: 42 },
  "수인분당선": { text: "수인분당", color: "#E8A000", shape: "pill", width: 62 },
  "경강선": { text: "경강", color: "#0054A6", shape: "pill", width: 42 },
  "서해선": { text: "서해", color: "#8FC31F", shape: "pill", width: 42 },
  "신분당선": { text: "신분당", color: "#D4003B", shape: "pill", width: 52 },
  "인천1호선": { text: "인천1", color: "#7CA8D5", shape: "pill", width: 48 },
  "인천2호선": { text: "인천2", color: "#ED8B00", shape: "pill", width: 48 },
  "용인에버라인": { text: "에버", color: "#4EA346", shape: "pill", width: 42 },
  "김포골드라인": { text: "김포", color: "#B99A31", shape: "pill", width: 42 },
  "의정부경전철": { text: "의정부", color: "#F28C28", shape: "pill", width: 52 },
  "우이신설선": { text: "우이신설", color: "#B0CE18", shape: "pill", width: 62 },
  "신림선": { text: "신림", color: "#6789CA", shape: "pill", width: 42 },
  "GTX-A(북부)": { text: "GTX-A", color: "#9A6292", shape: "pill", width: 54 },
  "GTX-A(남부)": { text: "GTX-A", color: "#9A6292", shape: "pill", width: 54 },
};

export interface StationSuggestion {
  station: string;
  lines: string[];
  selector: string;
  disambiguated: boolean;
}

export function lineBadgeSpec(line: string): LineBadgeSpec {
  const spec = LINE_BADGES[line] ?? { text: line.slice(0, 4) || "?", color: "#65717E", shape: "pill" as const, width: 48 };
  return { line, ...spec };
}

export function stationLineSelector(station: string, line: string): string {
  const disjoint = DISJOINT_UI_LINES[station];
  return disjoint?.includes(line) ? `${station}${SELECTOR_SEPARATOR}${line}` : station;
}

function lineOrder(a: string, b: string): number {
  const ai = Object.keys(LINE_BADGES).indexOf(a);
  const bi = Object.keys(LINE_BADGES).indexOf(b);
  if (ai >= 0 || bi >= 0) return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  return a.localeCompare(b, "ko");
}

export function stationSuggestionOptions(stations: Record<string, string[]>, query: string, limit = 10): StationSuggestion[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const linesByStation = new Map<string, Set<string>>();
  for (const [line, names] of Object.entries(stations)) {
    for (const station of names) {
      if (!stationMatches(station, normalized)) continue;
      const lines = linesByStation.get(station) ?? new Set<string>();
      lines.add(line);
      linesByStation.set(station, lines);
    }
  }

  const matches: StationSuggestion[] = [];
  for (const [station, lineSet] of linesByStation) {
    const lines = [...lineSet].sort(lineOrder);
    const disjoint = DISJOINT_UI_LINES[station]?.filter((line) => lineSet.has(line)) ?? [];
    if (disjoint.length >= 2) {
      for (const line of disjoint.sort(lineOrder)) matches.push({ station, lines: [line], selector: `${station}${SELECTOR_SEPARATOR}${line}`, disambiguated: true });
      const remaining = lines.filter((line) => !disjoint.includes(line));
      if (remaining.length) matches.push({ station, lines: remaining, selector: station, disambiguated: false });
    } else {
      matches.push({ station, lines, selector: station, disambiguated: false });
    }
  }

  return matches
    .sort((a, b) => a.station.length - b.station.length || a.station.localeCompare(b.station, "ko") || a.lines.join("|").localeCompare(b.lines.join("|"), "ko"))
    .slice(0, limit);
}
