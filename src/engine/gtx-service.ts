import type { AutoRoutePayload, CalculateRoutePayload, LiveTripPayload, PositionRow, SegmentInput, Serialized } from "../types/domain";
import { fetchPosition, positionRows, type FetchLike } from "./realtime-service";
import { autoCandidateRoutes, candidateInterchanges, routeConfidence } from "./routing-service";
import { scheduledGtxCandidates } from "./gtx-schedule";
import { GTX_LINES, GTX_LINE_NAMES, gtxDirection, gtxDuration, gtxLineForPair, gtxLineForStation, gtxSecondsBetween, isGtxLine, type GtxLine } from "./gtx-topology";
import { canonStation, formatKst, nowKst, parseDt, resolveServiceMode } from "./timetable-service";

export { GTX_LINES, GTX_LINE_NAMES, gtxLineForPair, gtxLineForStation, isGtxLine } from "./gtx-topology";
export type { GtxLine } from "./gtx-topology";

const DEFAULT_TRANSFER_SECONDS = 240;
const MAX_BOARD_WAIT_SECONDS = 3600;

type BaseRoute = (payload: CalculateRoutePayload) => Promise<Serialized>;
type BaseTrip = (payload: LiveTripPayload) => Promise<Serialized>;

interface GtxCandidate {
  board: Date;
  alight: Date;
  current: string;
  trainNo: string;
  wanted: 1 | -1;
  live: boolean;
  row?: PositionRow;
}

function asSegments(result: Serialized): Array<Record<string, unknown>> {
  return Array.isArray(result.segments)
    ? result.segments.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null).map((segment) => ({ ...segment }))
    : [];
}
function resultArrival(result: Serialized): string { return String(result.arrival_time ?? result.estimated_arrival_time ?? ""); }
function resultWarnings(result: Serialized): string[] { return Array.isArray(result.warnings) ? result.warnings.filter((value): value is string => typeof value === "string") : []; }
function transferSeconds(segment: SegmentInput, hasNext: boolean): number {
  if (!hasNext) return 0;
  const value = Number(segment.transfer_seconds ?? Math.round(Number(segment.transfer_walk ?? 0) * 60));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_TRANSFER_SECONDS;
}
function addSeconds(date: Date, seconds: number): Date { return new Date(date.getTime() + seconds * 1000); }
function candidateLine(line: GtxLine, from: string, to: string): { fromName: string; toName: string; fi: number; ti: number; wanted: 1 | -1 } {
  const cfg = GTX_LINES[line];
  const fromName = canonStation(from);
  const toName = canonStation(to);
  const fi = cfg.stations.indexOf(fromName as never);
  const ti = cfg.stations.indexOf(toName as never);
  if (fi < 0 || ti < 0 || fi === ti) throw new Error(`${line} 구간을 찾지 못했습니다.`);
  return { fromName, toName, fi, ti, wanted: fi < ti ? 1 : -1 };
}

function publicGtxCandidate(line: GtxLine, candidate: GtxCandidate, from: string, to: string, ready: Date, selected = false): Record<string, unknown> {
  const cfg = GTX_LINES[line];
  return {
    line,
    from,
    to,
    train_no: candidate.trainNo,
    origin: candidate.wanted === 1 ? cfg.stations[0] : cfg.stations.at(-1),
    destination: candidate.wanted === 1 ? cfg.stations.at(-1) : cfg.stations[0],
    service: "express",
    direction: candidate.wanted === 1 ? "DOWN" : "UP",
    board_dt: formatKst(candidate.board),
    alight_dt: formatKst(candidate.alight),
    wait_seconds: Math.max(0, Math.round((candidate.board.getTime() - ready.getTime()) / 1000)),
    ride_seconds: Math.max(0, Math.round((candidate.alight.getTime() - candidate.board.getTime()) / 1000)),
    delay_seconds: 0,
    current_station: candidate.current,
    current_station_name: candidate.current,
    location_kind: candidate.live ? "live" : "expected",
    location_label: candidate.live && candidate.current ? `${candidate.current} 실시간` : "GTX-A 시간표",
    confidence: candidate.live ? "높음" : "중간",
    method: candidate.live ? "GTX-A 실시간 열차 위치 + 구간 주행시간" : "GTX-A 시간표 + 구간 주행시간",
    projected: !candidate.live,
    live_detected: candidate.live,
    selected,
  };
}

function realtimeGtxCandidates(line: GtxLine, from: string, to: string, start: Date, rows: PositionRow[]): GtxCandidate[] {
  const cfg = GTX_LINES[line];
  const { fromName, toName, fi, wanted } = candidateLine(line, from, to);
  const out: GtxCandidate[] = [];
  for (const row of rows) {
    const current = canonStation(row.statnNm);
    const ci = cfg.stations.indexOf(current as never);
    if (ci < 0 || gtxDirection(line, row) !== wanted) continue;
    if ((wanted === 1 && ci > fi) || (wanted === -1 && ci < fi)) continue;
    const observed = parseDt(row.recptnDt ?? row.lastRecptnDt);
    const toBoard = gtxSecondsBetween(line, ci, fi);
    const board = new Date(observed.getTime() + toBoard * 1000);
    const wait = (board.getTime() - start.getTime()) / 1000;
    if (wait < -5 || wait > MAX_BOARD_WAIT_SECONDS) continue;
    const alight = new Date(board.getTime() + gtxDuration(line, fromName, toName) * 1000);
    const trainNo = String(row.trainNo ?? row.btrainNo ?? "").trim();
    if (!trainNo) continue;
    out.push({ board, alight, row, current, trainNo, wanted, live: true });
  }
  return out.sort((a, b) => a.alight.getTime() - b.alight.getTime() || a.board.getTime() - b.board.getTime());
}

function timetableGtxCandidates(line: GtxLine, from: string, to: string, start: Date): GtxCandidate[] {
  return scheduledGtxCandidates(line, from, to, start, MAX_BOARD_WAIT_SECONDS).map((candidate) => ({
    board: candidate.board,
    alight: candidate.alight,
    current: "",
    trainNo: candidate.trainNo,
    wanted: candidate.wanted,
    live: false,
  }));
}

function mergeGtxCandidates(live: GtxCandidate[], timetable: GtxCandidate[]): GtxCandidate[] {
  const merged = [...live];
  for (const scheduled of timetable) {
    if (live.some((candidate) => Math.abs(candidate.board.getTime() - scheduled.board.getTime()) <= 120_000)) continue;
    merged.push(scheduled);
  }
  return merged.sort((a, b) => a.alight.getTime() - b.alight.getTime() || Number(b.live) - Number(a.live) || a.board.getTime() - b.board.getTime()).slice(0, 10);
}

async function direct(line: GtxLine, from: string, to: string, start: Date, mode: string, fetchImpl: FetchLike): Promise<Serialized> {
  const { fromName, toName } = candidateLine(line, from, to);
  const timetable = timetableGtxCandidates(line, fromName, toName, start);
  let rows: PositionRow[] = [];
  let realtimeAvailable = false;
  let realtimeQuery = "";
  let cacheState = "";
  try {
    const realtime = await fetchPosition(line, 5, fetchImpl);
    realtimeAvailable = realtime.ok;
    rows = positionRows(realtime.data);
    realtimeQuery = String(realtime.data?._jigeumta_query || "");
    cacheState = String(realtime.data?._jigeumta_cache_state || "");
  } catch {
    // GTX routing remains timetable-capable when the realtime API is unavailable.
  }
  const live = realtimeGtxCandidates(line, fromName, toName, start, rows);
  const candidates = mergeGtxCandidates(live, timetable);
  if (!candidates.length) {
    return {
      ok: false,
      error: `${line} ${fromName}→${toName} 현재 시각 이후 운행 열차가 없습니다.`,
      positions: rows.length,
      realtime_available: realtimeAvailable,
    };
  }
  const selected = candidates[0];
  const [resolvedMode, reason] = resolveServiceMode(mode, start);
  const ride = Math.round((selected.alight.getTime() - selected.board.getTime()) / 1000);
  const total = Math.round((selected.alight.getTime() - start.getTime()) / 1000);
  const segment = {
    ...publicGtxCandidate(line, selected, fromName, toName, start, true),
    index: 0,
    nearby_candidates: candidates.slice(0, 6).map((candidate) => publicGtxCandidate(line, candidate, fromName, toName, start, candidate.trainNo === selected.trainNo)),
    previous_candidate: null,
    realtime_query: realtimeQuery,
    cache_state: cacheState,
  };
  return {
    ok: true,
    from: fromName,
    to: toName,
    start_time: formatKst(start),
    arrival_time: formatKst(selected.alight),
    estimated_arrival_time: formatKst(selected.alight),
    total_seconds: total,
    estimated_total_seconds: total,
    route_seconds: ride,
    transfer_count: 0,
    service_mode: resolvedMode,
    service_mode_reason: reason,
    segments: [segment],
    positions: rows.length,
    matched: live.length,
    warnings: realtimeAvailable || live.length ? [] : ["GTX-A 실시간 위치를 사용하지 못해 시간표 기준으로 계산했습니다."],
  };
}

function usableRoute(result: Serialized): boolean {
  if (result.ok === false) return false;
  const segments = asSegments(result);
  if (!segments.length) return false;
  return segments.every((segment) => {
    const wait = Number(segment.wait_seconds ?? 0);
    return Boolean(String(segment.train_no ?? "").trim()) && Number.isFinite(wait) && wait >= -5 && wait <= MAX_BOARD_WAIT_SECONDS;
  });
}

export async function calculateGtxAuto(payload: AutoRoutePayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> {
  const line = gtxLineForPair(payload.from, payload.to);
  if (!line) return null;
  return direct(line, payload.from, payload.to, parseDt(payload.start_time), String(payload.day || "AUTO"), fetchImpl);
}

export async function calculateGtxRoute(payload: CalculateRoutePayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> {
  if (payload.segments.length !== 1 || !isGtxLine(String(payload.segments[0].line))) return null;
  const segment = payload.segments[0];
  return direct(segment.line as GtxLine, String(segment.from), String(segment.to), parseDt(payload.start_time), String(payload.day || "AUTO"), fetchImpl);
}

export async function calculateGtxTrip(payload: LiveTripPayload, fetchImpl: FetchLike = fetch): Promise<Serialized | null> {
  if (payload.segments.length !== 1 || !isGtxLine(String(payload.segments[0].line))) return null;
  const segment = payload.segments[0];
  const line = segment.line as GtxLine;
  const { fromName, toName, ti, wanted } = candidateLine(line, String(segment.from), String(segment.to));
  const trainNo = String(payload.boarded_train_no ?? "").trim();
  if (!trainNo) return { ok: false, error: "탑승한 GTX-A 열차번호가 없습니다." };
  let rows: PositionRow[] = [];
  try {
    const realtime = await fetchPosition(line, 5, fetchImpl);
    rows = positionRows(realtime.data);
  } catch {
    // Continue using elapsed time while realtime is temporarily unavailable.
  }
  const now = nowKst();
  const live = rows
    .filter((row) => String(row.trainNo ?? row.btrainNo ?? "").trim() === trainNo)
    .sort((a, b) => parseDt(b.recptnDt ?? b.lastRecptnDt).getTime() - parseDt(a.recptnDt ?? a.lastRecptnDt).getTime())[0];
  const totalRide = gtxDuration(line, fromName, toName);
  const boarded = payload.boarded_at ? parseDt(payload.boarded_at) : now;
  let remaining = Math.max(0, totalRide - Math.max(0, Math.round((now.getTime() - boarded.getTime()) / 1000)));
  let current = "";
  let arrived = remaining <= 0;
  let projected = true;
  let method = "GTX-A 시간표 · 탑승 후 경과시간 추적";
  if (live) {
    const cfg = GTX_LINES[line];
    current = canonStation(live.statnNm);
    const ci = cfg.stations.indexOf(current as never);
    const observed = parseDt(live.recptnDt ?? live.lastRecptnDt);
    const age = Math.max(0, (now.getTime() - observed.getTime()) / 1000);
    if (ci >= 0 && gtxDirection(line, live) === wanted) {
      const passedTarget = wanted === 1 ? ci > ti : ci < ti;
      const atTarget = ci === ti;
      remaining = passedTarget || atTarget ? 0 : Math.max(0, Math.round(gtxSecondsBetween(line, ci, ti) - age));
      arrived = passedTarget || (atTarget && remaining === 0);
      projected = false;
      method = "GTX-A 탑승 열차 실시간 추적";
    }
  }
  const alight = new Date(now.getTime() + remaining * 1000);
  const resultSegment = {
    index: 0,
    line,
    from: fromName,
    to: toName,
    train_no: trainNo,
    origin: wanted === 1 ? GTX_LINES[line].stations[0] : GTX_LINES[line].stations.at(-1),
    destination: wanted === 1 ? GTX_LINES[line].stations.at(-1) : GTX_LINES[line].stations[0],
    service: "express",
    direction: wanted === 1 ? "DOWN" : "UP",
    board_dt: formatKst(boarded),
    alight_dt: formatKst(alight),
    wait_seconds: 0,
    ride_seconds: Math.max(0, Math.round((alight.getTime() - boarded.getTime()) / 1000)),
    remaining_seconds: remaining,
    delay_seconds: 0,
    current_station: current,
    current_station_name: current,
    location: current || "시간표 진행 중",
    confidence: projected ? "중간" : "높음",
    method,
    projected,
    tracking: true,
    arrived,
    nearby_candidates: [],
  };
  return {
    ok: true,
    live_tracking: true,
    active_index: 0,
    boarded_train_no: trainNo,
    updated_at: formatKst(now),
    arrival_time: formatKst(alight),
    remaining_seconds: remaining,
    current_segment_remaining_seconds: remaining,
    current_station: current,
    current_status: arrived ? "도착" : current ? "운행 중" : "시간표 진행 중",
    segments: [resultSegment],
    warnings: [],
  };
}

export async function calculateGtxHybridRoute(payload: CalculateRoutePayload, baseRoute: BaseRoute, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  if (!payload.segments.some((segment) => isGtxLine(String(segment.line)))) return baseRoute(payload);
  const start = parseDt(payload.start_time);
  let cursor = start;
  const results: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  for (let index = 0; index < payload.segments.length; index += 1) {
    const input = payload.segments[index];
    const singlePayload: CalculateRoutePayload = { ...payload, start_time: formatKst(cursor), segments: [input] };
    const result = isGtxLine(String(input.line)) ? await calculateGtxRoute(singlePayload, fetchImpl) : await baseRoute(singlePayload);
    if (!result || result.ok === false || !usableRoute(result)) {
      return { ...(result ?? { ok: false, error: "구간 계산 실패" }), ok: false, failed_segment: index + 1, partial_segments: results };
    }
    const segments = asSegments(result);
    const arrival = resultArrival(result);
    if (!segments.length || !arrival) return { ok: false, failed_segment: index + 1, error: "구간 도착시각을 계산하지 못했습니다.", partial_segments: results };
    const segment = segments[0];
    const walk = transferSeconds(input, index < payload.segments.length - 1);
    segment.transfer_seconds = walk;
    segment.transfer_walk = walk / 60;
    segment.transfer_info = index < payload.segments.length - 1 ? (input.transfer_info ?? null) : null;
    results.push(segment);
    warnings.push(...resultWarnings(result));
    cursor = parseDt(arrival);
    if (walk) cursor = addSeconds(cursor, walk);
  }
  const end = results.length ? parseDt(String(results.at(-1)?.alight_dt)) : start;
  const total = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return { ok: true, start_time: formatKst(start), arrival_time: formatKst(end), total_seconds: total, estimated_total_seconds: total, transfer_count: Math.max(0, results.length - 1), segments: results, warnings };
}

export async function calculateGtxHybridAuto(payload: AutoRoutePayload, baseRoute: BaseRoute, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  const start = parseDt(payload.start_time);
  const [mode, reason] = resolveServiceMode(String(payload.day || "AUTO"), start);
  const excludeGtx = Boolean((payload as unknown as Record<string, unknown>).exclude_gtx);
  const options = excludeGtx ? { excludeLines: GTX_LINE_NAMES } : undefined;
  let candidates;
  try {
    candidates = autoCandidateRoutes(payload.from, payload.to, mode, 12, options);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "경로를 찾지 못했습니다." };
  }
  const scored: Array<{ path: (typeof candidates)[number]["path"]; segments: SegmentInput[]; result: Serialized }> = [];
  for (const candidate of candidates) {
    const result = candidate.segments.some((segment) => isGtxLine(String(segment.line)))
      ? await calculateGtxHybridRoute({ start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false }, baseRoute, fetchImpl)
      : await baseRoute({ start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false });
    if (usableRoute(result)) scored.push({ path: candidate.path, segments: candidate.segments, result });
  }
  if (!scored.length) {
    return { ok: false, from: canonStation(payload.from), to: canonStation(payload.to), error: "현재 시각 이후 이용 가능한 열차 경로를 찾지 못했습니다.", service_mode: mode, service_mode_reason: reason };
  }
  scored.sort((a, b) => String(a.result.arrival_time).localeCompare(String(b.result.arrival_time)) || a.segments.length - b.segments.length || a.path.seconds - b.path.seconds);
  const selected = scored[0];
  const selectedSegments = asSegments(selected.result);
  const alternatives = scored.slice(1, 4).map((item) => ({
    segments: asSegments(item.result),
    interchanges: candidateInterchanges(item.segments),
    transfer_count: Math.max(0, item.segments.length - 1),
    route_seconds: item.path.seconds,
    total_seconds: Number(item.result.total_seconds ?? 0),
    arrival_time: item.result.arrival_time,
    confidence: routeConfidence(item.result as { segments?: Array<{ confidence?: string }> }),
  }));
  return {
    ok: true,
    service_mode: mode,
    service_mode_reason: reason,
    from: canonStation(payload.from),
    to: canonStation(payload.to),
    start_time: formatKst(start),
    route_seconds: selected.path.seconds,
    estimated_total_seconds: Number(selected.result.total_seconds ?? 0),
    total_seconds: Number(selected.result.total_seconds ?? 0),
    estimated_arrival_time: selected.result.arrival_time,
    arrival_time: selected.result.arrival_time,
    estimated_confidence: routeConfidence(selected.result as { segments?: Array<{ confidence?: string }> }),
    transfer_count: Math.max(0, selected.segments.length - 1),
    interchanges: candidateInterchanges(selected.segments),
    segments: selectedSegments,
    selection_method: "통합 노선 그래프 + GTX-A 시간표 + 실시간 ETA",
    candidate_count: candidates.length,
    live_scored_count: scored.length,
    gtx_excluded: excludeGtx,
    alternatives,
  };
}

export async function calculateGtxHybridTrip(payload: LiveTripPayload, baseTrip: BaseTrip, baseRoute: BaseRoute, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  if (!payload.segments.some((segment) => isGtxLine(String(segment.line)))) return baseTrip(payload);
  const activeIndex = Number(payload.active_index ?? 0);
  if (activeIndex < 0 || activeIndex >= payload.segments.length) throw new Error("추적 중인 구간 번호가 올바르지 않습니다.");
  const active = payload.segments[activeIndex];
  const activePayload: LiveTripPayload = { ...payload, active_index: 0, segments: [active] };
  const activeResult = isGtxLine(String(active.line)) ? await calculateGtxTrip(activePayload, fetchImpl) : await baseTrip(activePayload);
  if (!activeResult || activeResult.ok === false) return activeResult ?? { ok: false, error: "탑승 열차 추적 실패" };
  const results = asSegments(activeResult);
  if (!results.length) return { ok: false, error: "추적 구간 결과가 없습니다." };
  let cursor = parseDt(String(results[0].alight_dt ?? activeResult.arrival_time));
  const warnings = resultWarnings(activeResult);
  const firstTransfer = transferSeconds(active, activeIndex < payload.segments.length - 1);
  results[0].transfer_seconds = firstTransfer;
  results[0].transfer_walk = firstTransfer / 60;
  results[0].transfer_info = activeIndex < payload.segments.length - 1 ? (active.transfer_info ?? null) : null;
  if (firstTransfer) cursor = addSeconds(cursor, firstTransfer);
  for (let index = activeIndex + 1; index < payload.segments.length; index += 1) {
    const input = payload.segments[index];
    const routePayload: CalculateRoutePayload = { day: payload.day, start_time: formatKst(cursor), segments: [input] };
    const next = isGtxLine(String(input.line)) ? await calculateGtxRoute(routePayload, fetchImpl) : await baseRoute(routePayload);
    if (!next || next.ok === false || !usableRoute(next)) return { ...(next ?? { ok: false, error: "후속 구간 계산 실패" }), ok: false, failed_segment: index + 1, segments: results };
    const nextSegments = asSegments(next);
    const arrival = resultArrival(next);
    if (!nextSegments.length || !arrival) return { ok: false, failed_segment: index + 1, error: "후속 구간 도착시각을 계산하지 못했습니다.", segments: results };
    const segment = nextSegments[0];
    const walk = transferSeconds(input, index < payload.segments.length - 1);
    segment.transfer_seconds = walk;
    segment.transfer_walk = walk / 60;
    segment.transfer_info = index < payload.segments.length - 1 ? (input.transfer_info ?? null) : null;
    results.push(segment);
    warnings.push(...resultWarnings(next));
    cursor = parseDt(arrival);
    if (walk) cursor = addSeconds(cursor, walk);
  }
  const final = parseDt(String(results.at(-1)?.alight_dt ?? activeResult.arrival_time));
  const now = nowKst();
  const currentRemaining = Number(activeResult.current_segment_remaining_seconds ?? activeResult.remaining_seconds ?? results[0].remaining_seconds ?? 0);
  if (currentRemaining <= 0) results[0].arrived = true;
  return {
    ok: true,
    live_tracking: true,
    active_index: activeIndex,
    boarded_train_no: activeResult.boarded_train_no ?? payload.boarded_train_no ?? "",
    updated_at: formatKst(now),
    arrival_time: formatKst(final),
    remaining_seconds: Math.max(0, Math.round((final.getTime() - now.getTime()) / 1000)),
    current_segment_remaining_seconds: Math.max(0, currentRemaining),
    current_station: activeResult.current_station ?? results[0].current_station ?? "",
    current_status: activeResult.current_status ?? results[0].status ?? "",
    segments: results,
    warnings,
  };
}
