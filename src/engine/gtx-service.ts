import type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionRow, Serialized } from "../types/domain";
import { fetchPosition, positionRows, type FetchLike } from "./realtime-service";
import { canonStation, formatKst, nowKst, parseDt, resolveServiceMode } from "./timetable-service";

export const GTX_LINES = {
  "GTX-A(북부)": { stations: ["운정중앙", "킨텍스", "대곡", "연신내", "서울역"], segmentSeconds: [300, 300, 540, 360] },
  "GTX-A(남부)": { stations: ["수서", "성남", "구성", "동탄"], segmentSeconds: [420, 360, 420] },
} as const;
export type GtxLine = keyof typeof GTX_LINES;
export const isGtxLine = (line: string): line is GtxLine => line in GTX_LINES;
export function gtxLineForPair(from: string, to: string): GtxLine | null {
  const a = canonStation(from); const b = canonStation(to);
  for (const [line, config] of Object.entries(GTX_LINES) as Array<[GtxLine, (typeof GTX_LINES)[GtxLine]]>) if (config.stations.includes(a as never) && config.stations.includes(b as never) && a !== b) return line;
  return null;
}
function duration(line: GtxLine, from: string, to: string): number {
  const cfg = GTX_LINES[line]; const a = cfg.stations.indexOf(canonStation(from) as never); const b = cfg.stations.indexOf(canonStation(to) as never); if (a < 0 || b < 0 || a === b) throw new Error(`${line} 구간을 찾지 못했습니다.`);
  let sum = 0; for (let i = Math.min(a, b); i < Math.max(a, b); i += 1) sum += cfg.segmentSeconds[i] || 0; return sum;
}
function direction(line: GtxLine, row: PositionRow): 1 | -1 | null {
  const stations = GTX_LINES[line].stations; const target = canonStation(row.statnTnm); const targetIndex = stations.indexOf(target as never); if (targetIndex === stations.length - 1) return 1; if (targetIndex === 0) return -1;
  const updn = String(row.updnLine || ""); if (/하행/.test(updn)) return 1; if (/상행/.test(updn)) return -1; return null;
}
function secondsBetween(line: GtxLine, a: number, b: number): number { const cfg = GTX_LINES[line]; let sum = 0; for (let i = Math.min(a, b); i < Math.max(a, b); i += 1) sum += cfg.segmentSeconds[i] || 0; return sum; }

async function direct(line: GtxLine, from: string, to: string, start: Date, mode: string, fetchImpl: FetchLike): Promise<Serialized> {
  const cfg = GTX_LINES[line]; const fromName = canonStation(from); const toName = canonStation(to); const fi = cfg.stations.indexOf(fromName as never); const ti = cfg.stations.indexOf(toName as never); if (fi < 0 || ti < 0 || fi === ti) throw new Error(`${line} 구간을 찾지 못했습니다.`);
  const wanted: 1 | -1 = fi < ti ? 1 : -1; const realtime = await fetchPosition(line, 5, fetchImpl); const now = nowKst(); const candidates: Array<{ board: Date; alight: Date; row: PositionRow; current: string }> = [];
  for (const row of positionRows(realtime.data)) {
    const current = canonStation(row.statnNm); const ci = cfg.stations.indexOf(current as never); if (ci < 0 || direction(line, row) !== wanted) continue; if ((wanted === 1 && ci > fi) || (wanted === -1 && ci < fi)) continue;
    const observed = parseDt(row.recptnDt ?? row.lastRecptnDt); const age = Math.max(0, (now.getTime() - observed.getTime()) / 1000); const toBoard = secondsBetween(line, ci, fi); const board = new Date(now.getTime() + Math.max(0, toBoard - age) * 1000); if (board.getTime() < start.getTime() - 5000) continue; const alight = new Date(board.getTime() + duration(line, fromName, toName) * 1000); candidates.push({ board, alight, row, current });
  }
  candidates.sort((a, b) => a.alight.getTime() - b.alight.getTime());
  let selected = candidates[0]; let confidence = "높음"; let method = "GTX-A 실시간 위치 + 구간 주행시간"; let cacheState = String(realtime.data?._jigeumta_cache_state || "");
  if (!selected) {
    const headway = Math.max(300, Number(Bun.env.GTX_A_FALLBACK_HEADWAY_SECONDS || 600)); const sec = start.getUTCHours() * 3600 + start.getUTCMinutes() * 60 + start.getUTCSeconds(); const wait = (headway - sec % headway) % headway; const board = new Date(start.getTime() + wait * 1000); selected = { board, alight: new Date(board.getTime() + duration(line, fromName, toName) * 1000), row: {}, current: "" }; confidence = realtime.ok ? "중간" : "낮음"; method = "GTX-A 실시간 열차 미포착 · 보수적 운행간격 추정";
  }
  const trainNo = String(selected.row.trainNo ?? selected.row.btrainNo ?? "GTX-A"); const [resolvedMode, reason] = resolveServiceMode(mode, start); const ride = Math.round((selected.alight.getTime() - selected.board.getTime()) / 1000); const total = Math.round((selected.alight.getTime() - start.getTime()) / 1000);
  const segment = { index: 0, line, from: fromName, to: toName, train_no: trainNo, origin: wanted === 1 ? cfg.stations[0] : cfg.stations.at(-1), destination: wanted === 1 ? cfg.stations.at(-1) : cfg.stations[0], service: "express", direction: wanted === 1 ? "DOWN" : "UP", board_dt: formatKst(selected.board), alight_dt: formatKst(selected.alight), wait_seconds: Math.max(0, Math.round((selected.board.getTime() - start.getTime()) / 1000)), ride_seconds: ride, delay_seconds: 0, current_station: selected.current, current_station_name: selected.current, location: selected.current || "실시간 미포착", confidence, method, projected: !selected.current, realtime_query: realtime.data?._jigeumta_query, cache_state: cacheState };
  return { ok: true, from: fromName, to: toName, start_time: formatKst(start), arrival_time: formatKst(selected.alight), estimated_arrival_time: formatKst(selected.alight), total_seconds: total, estimated_total_seconds: total, route_seconds: ride, transfer_count: 0, service_mode: resolvedMode, service_mode_reason: reason, segments: [segment], positions: positionRows(realtime.data).length, matched: selected.current ? 1 : 0, warnings: selected.current ? [] : ["GTX-A 실시간 열차가 현재 구간에서 포착되지 않아 운행간격 추정을 사용했습니다."] };
}
export async function calculateGtxAuto(payload: AutoRoutePayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> { const line = gtxLineForPair(payload.from, payload.to); if (!line) return null; return direct(line, payload.from, payload.to, parseDt(payload.start_time), String(payload.day || "AUTO"), fetchImpl); }
export async function calculateGtxRoute(payload: CalculateRoutePayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> { if (payload.segments.length !== 1 || !isGtxLine(String(payload.segments[0].line))) return null; const s = payload.segments[0]; return direct(s.line as GtxLine, String(s.from), String(s.to), parseDt(payload.start_time), String(payload.day || "AUTO"), fetchImpl); }
export async function calculateGtxTrip(payload: LiveTripPayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> { if (payload.segments.length !== 1 || !isGtxLine(String(payload.segments[0].line))) return null; const s = payload.segments[0]; const result = await direct(s.line as GtxLine, String(s.from), String(s.to), nowKst(), String(payload.day || "AUTO"), fetchImpl); return { ...result, active_index: 0, boarded_train_no: payload.boarded_train_no || (result.segments as Array<Record<string,unknown>>)?.[0]?.train_no || "", current_segment_remaining_seconds: Number(result.total_seconds || 0), remaining_seconds: Number(result.total_seconds || 0) };
}
