import type { PositionRow } from "../types/domain";
import { canonStation } from "./timetable-service";

export const GTX_LINES = {
  "GTX-A(북부)": { stations: ["운정중앙", "킨텍스", "대곡", "연신내", "서울역"], segmentSeconds: [300, 300, 540, 360] },
  "GTX-A(남부)": { stations: ["수서", "성남", "구성", "동탄"], segmentSeconds: [420, 360, 420] },
} as const;

export type GtxLine = keyof typeof GTX_LINES;
export const GTX_LINE_NAMES = Object.keys(GTX_LINES) as GtxLine[];
export const isGtxLine = (line: string): line is GtxLine => line in GTX_LINES;

export function gtxLineForStation(station: string): GtxLine | null {
  const name = canonStation(station);
  for (const [line, config] of Object.entries(GTX_LINES) as Array<[GtxLine, (typeof GTX_LINES)[GtxLine]]>) {
    if (config.stations.includes(name as never)) return line;
  }
  return null;
}

export function gtxLineForPair(from: string, to: string): GtxLine | null {
  const a = canonStation(from);
  const b = canonStation(to);
  for (const [line, config] of Object.entries(GTX_LINES) as Array<[GtxLine, (typeof GTX_LINES)[GtxLine]]>) {
    if (config.stations.includes(a as never) && config.stations.includes(b as never) && a !== b) return line;
  }
  return null;
}

export function gtxDuration(line: GtxLine, from: string, to: string): number {
  const cfg = GTX_LINES[line];
  const a = cfg.stations.indexOf(canonStation(from) as never);
  const b = cfg.stations.indexOf(canonStation(to) as never);
  if (a < 0 || b < 0 || a === b) throw new Error(`${line} 구간을 찾지 못했습니다.`);
  return gtxSecondsBetween(line, a, b);
}

export function gtxSecondsBetween(line: GtxLine, a: number, b: number): number {
  const cfg = GTX_LINES[line];
  let sum = 0;
  for (let i = Math.min(a, b); i < Math.max(a, b); i += 1) sum += cfg.segmentSeconds[i] || 0;
  return sum;
}

export function gtxDirection(line: GtxLine, row: PositionRow): 1 | -1 | null {
  const stations = GTX_LINES[line].stations;
  const target = canonStation(row.statnTnm);
  const targetIndex = stations.indexOf(target as never);
  if (targetIndex === stations.length - 1) return 1;
  if (targetIndex === 0) return -1;
  const updn = String(row.updnLine || "");
  if (/하행/.test(updn)) return 1;
  if (/상행/.test(updn)) return -1;
  return null;
}
