import type { Train } from "../types/domain";

/** Active 수도권 전철 lines with scheduled rapid/express/direct service. */
export const RAPID_SERVICE_LINES = new Set(["1호선", "4호선", "9호선", "경의중앙선", "수인분당선", "경춘선", "공항철도"]);
export type RailServiceKind = "rapid" | "local" | "unknown";
const RAPID_TEXT = /(급행|특급|express|rapid|직통|direct)/i;
const LOCAL_TEXT = /(완행|일반|local|각역)/i;
export function railServiceKind(line: string, train: Pick<Train, "service" | "stops">): RailServiceKind {
  if (!RAPID_SERVICE_LINES.has(line)) return "local";
  const service = String(train.service || "").trim();
  if (RAPID_TEXT.test(service)) return "rapid";
  if (LOCAL_TEXT.test(service)) return "local";
  if (train.stops.some((stop) => stop.call === false)) return "rapid";
  return service ? "local" : "unknown";
}
export function serviceKinds(line: string, trains: readonly Train[]): Set<RailServiceKind> { return new Set(trains.map((train) => railServiceKind(line, train)).filter((kind) => kind !== "unknown")); }
export function supportsRapidLocalChange(line: string, before: readonly Train[], after: readonly Train[]): boolean { if (!RAPID_SERVICE_LINES.has(line)) return false; const a = serviceKinds(line, before), b = serviceKinds(line, after); return (a.has("rapid") && b.has("local")) || (a.has("local") && b.has("rapid")); }
export function servicePriority(service: unknown): number { const value = String(service ?? ""); if (/직통|direct/i.test(value)) return 30; if (/급행|특급|express|rapid/i.test(value)) return 20; return 10; }
