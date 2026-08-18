import type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionRow, SegmentInput, Serialized } from "../types/domain";
import { fetchPosition, positionRows, type FetchLike } from "./realtime-service";
import { canonStation, formatKst, nowKst, parseDt, resolveServiceMode } from "./timetable-service";

export const GTX_LINES = {
  "GTX-A(북부)": { stations: ["운정중앙", "킨텍스", "대곡", "연신내", "서울역"], segmentSeconds: [300, 300, 540, 360] },
  "GTX-A(남부)": { stations: ["수서", "성남", "구성", "동탄"], segmentSeconds: [420, 360, 420] },
} as const;
export type GtxLine = keyof typeof GTX_LINES;
export const GTX_TRANSFER_STATIONS: Record<GtxLine, readonly string[]> = {
  "GTX-A(북부)": ["대곡", "연신내", "서울역"],
  "GTX-A(남부)": ["수서", "성남", "구성"],
};
const DEFAULT_GTX_TRANSFER_SECONDS = 240;
export const isGtxLine = (line: string): line is GtxLine => line in GTX_LINES;
export function gtxLineForStation(station: string): GtxLine | null {
  const name = canonStation(station);
  for (const [line, config] of Object.entries(GTX_LINES) as Array<[GtxLine, (typeof GTX_LINES)[GtxLine]]>) if (config.stations.includes(name as never)) return line;
  return null;
}
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
function asSegments(result: Serialized): Array<Record<string, unknown>> { return Array.isArray(result.segments) ? result.segments.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null).map((segment) => ({ ...segment })) : []; }
function resultArrival(result: Serialized): string { return String(result.arrival_time ?? result.estimated_arrival_time ?? ""); }
function resultWarnings(result: Serialized): string[] { return Array.isArray(result.warnings) ? result.warnings.filter((value): value is string => typeof value === "string") : []; }
function transferSeconds(segment: SegmentInput, hasNext: boolean): number { if (!hasNext) return 0; const value = Number(segment.transfer_seconds ?? Math.round(Number(segment.transfer_walk ?? 0) * 60)); return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_GTX_TRANSFER_SECONDS; }
function addSeconds(date: Date, seconds: number): Date { return new Date(date.getTime() + seconds * 1000); }
function markTransfer(segments: Array<Record<string, unknown>>, station: string, seconds = DEFAULT_GTX_TRANSFER_SECONDS): void {
  const last = segments.at(-1); if (!last) return;
  last.transfer_seconds = seconds; last.transfer_walk = seconds / 60;
  if (!last.transfer_info) last.transfer_info = { station: canonStation(station), seconds, distance_m: null, alight_position: "", board_position: "", from_direction: "", to_direction: "", matched: "fallback" };
}
function confidenceOf(segments: Array<Record<string, unknown>>): string {
  if (segments.some((segment) => segment.confidence === "낮음")) return "낮음";
  if (segments.some((segment) => segment.confidence === "중간")) return "중간";
  return "높음";
}

async function direct(line: GtxLine, from: string, to: string, start: Date, mode: string, fetchImpl: FetchLike): Promise<Serialized> {
  const cfg = GTX_LINES[line]; const fromName = canonStation(from); const toName = canonStation(to); const fi = cfg.stations.indexOf(fromName as never); const ti = cfg.stations.indexOf(toName as never); if (fi < 0 || ti < 0 || fi === ti) throw new Error(`${line} 구간을 찾지 못했습니다.`);
  const wanted: 1 | -1 = fi < ti ? 1 : -1; const realtime = await fetchPosition(line, 5, fetchImpl); const now = nowKst(); const candidates: Array<{ board: Date; alight: Date; row: PositionRow; current: string }> = [];
  for (const row of positionRows(realtime.data)) {
    const current = canonStation(row.statnNm); const ci = cfg.stations.indexOf(current as never); if (ci < 0 || direction(line, row) !== wanted) continue; if ((wanted === 1 && ci > fi) || (wanted === -1 && ci < fi)) continue;
    const observed = parseDt(row.recptnDt ?? row.lastRecptnDt); const age = Math.max(0, (now.getTime() - observed.getTime()) / 1000); const toBoard = secondsBetween(line, ci, fi); const board = new Date(now.getTime() + Math.max(0, toBoard - age) * 1000); if (board.getTime() < start.getTime() - 5000) continue; const alight = new Date(board.getTime() + duration(line, fromName, toName) * 1000); candidates.push({ board, alight, row, current });
  }
  candidates.sort((a, b) => a.alight.getTime() - b.alight.getTime());
  let selected = candidates[0]; let confidence = "높음"; let method = "GTX-A 실시간 위치 + 구간 주행시간"; const cacheState = String(realtime.data?._jigeumta_cache_state || "");
  if (!selected) {
    const headway = Math.max(300, Number(Bun.env.GTX_A_FALLBACK_HEADWAY_SECONDS || 600)); const sec = start.getUTCHours() * 3600 + start.getUTCMinutes() * 60 + start.getUTCSeconds(); const wait = (headway - sec % headway) % headway; const board = new Date(start.getTime() + wait * 1000); selected = { board, alight: new Date(board.getTime() + duration(line, fromName, toName) * 1000), row: {}, current: "" }; confidence = realtime.ok ? "중간" : "낮음"; method = "GTX-A 실시간 열차 미포착 · 보수적 운행간격 추정";
  }
  const trainNo = String(selected.row.trainNo ?? selected.row.btrainNo ?? "GTX-A"); const [resolvedMode, reason] = resolveServiceMode(mode, start); const ride = Math.round((selected.alight.getTime() - selected.board.getTime()) / 1000); const total = Math.round((selected.alight.getTime() - start.getTime()) / 1000);
  const segment = { index: 0, line, from: fromName, to: toName, train_no: trainNo, origin: wanted === 1 ? cfg.stations[0] : cfg.stations.at(-1), destination: wanted === 1 ? cfg.stations.at(-1) : cfg.stations[0], service: "express", direction: wanted === 1 ? "DOWN" : "UP", board_dt: formatKst(selected.board), alight_dt: formatKst(selected.alight), wait_seconds: Math.max(0, Math.round((selected.board.getTime() - start.getTime()) / 1000)), ride_seconds: ride, delay_seconds: 0, current_station: selected.current, current_station_name: selected.current, location: selected.current || "실시간 미포착", confidence, method, projected: !selected.current, realtime_query: realtime.data?._jigeumta_query, cache_state: cacheState };
  return { ok: true, from: fromName, to: toName, start_time: formatKst(start), arrival_time: formatKst(selected.alight), estimated_arrival_time: formatKst(selected.alight), total_seconds: total, estimated_total_seconds: total, route_seconds: ride, transfer_count: 0, service_mode: resolvedMode, service_mode_reason: reason, segments: [segment], positions: positionRows(realtime.data).length, matched: selected.current ? 1 : 0, warnings: selected.current ? [] : ["GTX-A 실시간 열차가 현재 구간에서 포착되지 않아 운행간격 추정을 사용했습니다."] };
}

export async function calculateGtxAuto(payload: AutoRoutePayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> { const line = gtxLineForPair(payload.from, payload.to); if (!line) return null; return direct(line, payload.from, payload.to, parseDt(payload.start_time), String(payload.day || "AUTO"), fetchImpl); }
export async function calculateGtxRoute(payload: CalculateRoutePayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> { if (payload.segments.length !== 1 || !isGtxLine(String(payload.segments[0].line))) return null; const s = payload.segments[0]; return direct(s.line as GtxLine, String(s.from), String(s.to), parseDt(payload.start_time), String(payload.day || "AUTO"), fetchImpl); }
export async function calculateGtxTrip(payload: LiveTripPayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> { if (payload.segments.length !== 1 || !isGtxLine(String(payload.segments[0].line))) return null; const s = payload.segments[0]; const result = await direct(s.line as GtxLine, String(s.from), String(s.to), nowKst(), String(payload.day || "AUTO"), fetchImpl); return { ...result, active_index: 0, boarded_train_no: payload.boarded_train_no || (result.segments as Array<Record<string, unknown>>)?.[0]?.train_no || "", current_segment_remaining_seconds: Number(result.total_seconds || 0), remaining_seconds: Number(result.total_seconds || 0) }; }

export async function calculateGtxHybridAuto(payload: AutoRoutePayload, baseAuto: (payload: AutoRoutePayload) => Promise<Serialized>, fetchImpl: FetchLike = fetch): Promise<Serialized | null> {
  const directResult = await calculateGtxAuto(payload, fetchImpl); if (directResult) return directResult;
  const fromLine = gtxLineForStation(payload.from); const toLine = gtxLineForStation(payload.to);
  const fromName = canonStation(payload.from); const toName = canonStation(payload.to);
  const fromExclusive = fromLine && !GTX_TRANSFER_STATIONS[fromLine].includes(fromName);
  const toExclusive = toLine && !GTX_TRANSFER_STATIONS[toLine].includes(toName);
  if (!fromExclusive && !toExclusive) return null;
  const start = parseDt(payload.start_time); const mode = String(payload.day || "AUTO");
  const fromGateways = fromExclusive && fromLine ? GTX_TRANSFER_STATIONS[fromLine] : [fromName];
  const toGateways = toExclusive && toLine ? GTX_TRANSFER_STATIONS[toLine] : [toName];
  const candidates: Serialized[] = [];
  for (const fromGateway of fromGateways) for (const toGateway of toGateways) {
    try {
      let cursor = start; const segments: Array<Record<string, unknown>> = []; const warnings: string[] = [];
      if (fromExclusive && fromLine) {
        const first = await direct(fromLine, fromName, fromGateway, cursor, mode, fetchImpl); const firstSegments = asSegments(first); if (!firstSegments.length) continue; segments.push(...firstSegments); warnings.push(...resultWarnings(first)); cursor = parseDt(resultArrival(first)); markTransfer(segments, fromGateway); cursor = addSeconds(cursor, DEFAULT_GTX_TRANSFER_SECONDS);
      }
      if (canonStation(fromGateway) !== canonStation(toGateway)) {
        const middle = await baseAuto({ ...payload, from: fromGateway, to: toGateway, start_time: formatKst(cursor) }); if (middle.ok === false) continue; const middleSegments = asSegments(middle); const middleArrival = resultArrival(middle); if (!middleSegments.length || !middleArrival) continue; segments.push(...middleSegments); warnings.push(...resultWarnings(middle)); cursor = parseDt(middleArrival);
      }
      if (toExclusive && toLine) {
        if (segments.length) { markTransfer(segments, toGateway); cursor = addSeconds(cursor, DEFAULT_GTX_TRANSFER_SECONDS); }
        const last = await direct(toLine, toGateway, toName, cursor, mode, fetchImpl); const lastSegments = asSegments(last); if (!lastSegments.length) continue; segments.push(...lastSegments); warnings.push(...resultWarnings(last)); cursor = parseDt(resultArrival(last));
      }
      if (!segments.length) continue;
      const total = Math.max(0, Math.round((cursor.getTime() - start.getTime()) / 1000));
      candidates.push({ ok: true, from: fromName, to: toName, start_time: formatKst(start), arrival_time: formatKst(cursor), estimated_arrival_time: formatKst(cursor), total_seconds: total, estimated_total_seconds: total, route_seconds: segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.ride_seconds) || 0), 0), transfer_count: Math.max(0, segments.length - 1), interchanges: segments.slice(0, -1).map((segment) => segment.to), segments, estimated_confidence: confidenceOf(segments), selection_method: "GTX-A 환승 포함 자동 경로", warnings });
    } catch { /* Try the next transfer gateway. */ }
  }
  candidates.sort((a, b) => String(a.arrival_time).localeCompare(String(b.arrival_time)) || Number(a.transfer_count) - Number(b.transfer_count));
  const selected = candidates[0]; return selected ? { ...selected, candidate_count: candidates.length, alternatives: candidates.slice(1, 4) } : null;
}

export async function calculateGtxHybridRoute(payload: CalculateRoutePayload, baseRoute: (payload: CalculateRoutePayload) => Promise<Serialized>, fetchImpl: FetchLike = fetch): Promise<Serialized | null> {
  if (!payload.segments.some((segment) => isGtxLine(String(segment.line)))) return null;
  const start = parseDt(payload.start_time); const mode = String(payload.day || "AUTO"); let cursor = start; const results: Array<Record<string, unknown>> = []; const warnings: string[] = [];
  for (let index = 0; index < payload.segments.length; index += 1) {
    const input = payload.segments[index]; const singlePayload: CalculateRoutePayload = { ...payload, start_time: formatKst(cursor), segments: [input] };
    const result = isGtxLine(String(input.line)) ? await calculateGtxRoute(singlePayload, fetchImpl) : await baseRoute(singlePayload);
    if (!result || result.ok === false) return { ...(result ?? { ok: false, error: "GTX-A 구간 계산 실패" }), failed_segment: index + 1, partial_segments: results };
    const segments = asSegments(result); const arrival = resultArrival(result); if (!segments.length || !arrival) return { ok: false, failed_segment: index + 1, error: "구간 도착시각을 계산하지 못했습니다.", partial_segments: results };
    const segment = segments[0]; const walkSeconds = transferSeconds(input, index < payload.segments.length - 1); if (walkSeconds) { segment.transfer_seconds = walkSeconds; segment.transfer_walk = walkSeconds / 60; if (input.transfer_info) segment.transfer_info = input.transfer_info; }
    results.push(segment); warnings.push(...resultWarnings(result)); cursor = parseDt(arrival); if (walkSeconds) cursor = addSeconds(cursor, walkSeconds);
  }
  const arrival = results.at(-1)?.alight_dt; const end = arrival ? parseDt(arrival) : cursor; const total = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return { ok: true, start_time: formatKst(start), arrival_time: formatKst(end), total_seconds: total, estimated_total_seconds: total, transfer_count: Math.max(0, results.length - 1), segments: results, warnings };
}

export async function calculateGtxHybridTrip(payload: LiveTripPayload, baseTrip: (payload: LiveTripPayload) => Promise<Serialized>, baseRoute: (payload: CalculateRoutePayload) => Promise<Serialized>, fetchImpl: FetchLike = fetch): Promise<Serialized | null> {
  if (!payload.segments.some((segment) => isGtxLine(String(segment.line)))) return null;
  const activeIndex = Number(payload.active_index ?? 0); if (activeIndex < 0 || activeIndex >= payload.segments.length) throw new Error("추적 중인 구간 번호가 올바르지 않습니다.");
  const active = payload.segments[activeIndex]; const activePayload: LiveTripPayload = { ...payload, active_index: 0, segments: [active] };
  const activeResult = isGtxLine(String(active.line)) ? await calculateGtxTrip(activePayload, fetchImpl) : await baseTrip(activePayload);
  if (!activeResult || activeResult.ok === false) return activeResult ?? { ok: false, error: "탑승 열차 추적 실패" };
  const results = asSegments(activeResult); if (!results.length) return { ok: false, error: "추적 구간 결과가 없습니다." };
  let cursor = parseDt(String(results[0].alight_dt ?? activeResult.arrival_time)); const warnings = resultWarnings(activeResult);
  const firstTransfer = transferSeconds(active, activeIndex < payload.segments.length - 1); if (firstTransfer) { results[0].transfer_seconds = firstTransfer; results[0].transfer_walk = firstTransfer / 60; if (active.transfer_info) results[0].transfer_info = active.transfer_info; cursor = addSeconds(cursor, firstTransfer); }
  for (let index = activeIndex + 1; index < payload.segments.length; index += 1) {
    const input = payload.segments[index]; const routePayload: CalculateRoutePayload = { day: payload.day, start_time: formatKst(cursor), segments: [input] };
    const next = isGtxLine(String(input.line)) ? await calculateGtxRoute(routePayload, fetchImpl) : await baseRoute(routePayload); if (!next || next.ok === false) return { ...(next ?? { ok: false, error: "후속 구간 계산 실패" }), failed_segment: index + 1, segments: results };
    const nextSegments = asSegments(next); const arrival = resultArrival(next); if (!nextSegments.length || !arrival) return { ok: false, failed_segment: index + 1, error: "후속 구간 도착시각을 계산하지 못했습니다.", segments: results };
    const segment = nextSegments[0]; const walk = transferSeconds(input, index < payload.segments.length - 1); if (walk) { segment.transfer_seconds = walk; segment.transfer_walk = walk / 60; if (input.transfer_info) segment.transfer_info = input.transfer_info; }
    results.push(segment); warnings.push(...resultWarnings(next)); cursor = parseDt(arrival); if (walk) cursor = addSeconds(cursor, walk);
  }
  const final = parseDt(String(results.at(-1)?.alight_dt ?? activeResult.arrival_time)); const now = nowKst();
  return { ok: true, live_tracking: true, active_index: activeIndex, boarded_train_no: activeResult.boarded_train_no ?? payload.boarded_train_no ?? "", updated_at: formatKst(now), arrival_time: formatKst(final), remaining_seconds: Math.max(0, Math.round((final.getTime() - now.getTime()) / 1000)), current_segment_remaining_seconds: Number(activeResult.current_segment_remaining_seconds ?? activeResult.remaining_seconds ?? 0), current_station: activeResult.current_station ?? results[0].current_station ?? "", current_status: activeResult.current_status ?? results[0].status ?? "", segments: results, warnings };
}
