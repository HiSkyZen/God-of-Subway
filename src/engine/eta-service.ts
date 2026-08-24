import type { Candidate, CalculateRoutePayload, Diagnostics, LiveTripPayload, PositionCache, PositionRow, PublicCandidate, SegmentInput, Serialized, Train } from "../types/domain";
import { cachedPositionRows, prefetchPositionCache, type FetchLike } from "./realtime-service";
import {
  activeTrainNoForVirtual,
  canonStation,
  firstCurrentIndex,
  formatKst,
  getTrain,
  mergedContinuationTrain,
  nearestScheduleDt,
  nowKst,
  parseDt,
  routePair,
  routeTrains,
  resolveServiceMode,
  scheduleDtAfter,
  scheduleDtBefore,
  serviceOccurrenceMidnight,
  statusName,
  stopAlightSec,
  stopBoardSec,
  stopTimeSec,
  STATIONS_BY_LINE,
} from "./timetable-service";
import { autoCandidateRoutes, autoFindPath, autoPathToSegments, candidateInterchanges, enrichTransferSegments, routeConfidence } from "./routing-service";

const DAY_SECONDS = 86400;
const MAX_DELAY_SECONDS = 2700;
const EARLY_TOLERANCE_SECONDS = 30;
const ORIGIN_WAIT_WINDOW_SECONDS = 90 * 60;
const round = (n: number): number => Math.round(n);
const serializeDate = (value: unknown): unknown => value instanceof Date ? formatKst(value) : value;

interface Observation {
  train_no: string;
  direction: string;
  service: string;
  delay: number;
  raw_delay: number;
  delay_valid: boolean;
  delay_failsafe: boolean;
  waiting: boolean;
  current_station: string;
  status: string;
  location_label: string;
  observed: Date;
  ref: number;
  index: number;
  schedule_anchor: number | null;
  train: Train;
  raw: PositionRow;
}

export function serializeSegment(value: Record<string, unknown>): Serialized {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeDate(item)]));
}

export function stopReference(stops: Train["stops"], index: number, status: unknown): number | null {
  if (index < 0 || index >= stops.length) return null;
  const rawStatus = String(status ?? "").trim();
  if (rawStatus === "3") {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const ref = stops[cursor].dep ?? stops[cursor].arr;
      if (ref !== null) return ref;
    }
    const arr = stops[index].arr;
    return arr === null ? null : arr - 60;
  }
  const stop = stops[index];
  if (rawStatus === "2" && stop.dep !== null) return stop.dep;
  if (rawStatus === "1" && stop.arr !== null) return stop.arr;
  if (rawStatus === "0" && stop.arr !== null) return stop.arr - 30;
  return stop.dep ?? stop.arr;
}

function firstTimedSec(train: Train): number | null {
  for (const stop of train.stops) {
    const value = stop.dep ?? stop.arr;
    if (value !== null) return value;
  }
  return null;
}

function normalizedClock(value: number): number {
  return ((value % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
}

function signedClockDelta(candidate: number, target: number): number {
  let delta = normalizedClock(candidate) - normalizedClock(target);
  if (delta > DAY_SECONDS / 2) delta -= DAY_SECONDS;
  if (delta < -DAY_SECONDS / 2) delta += DAY_SECONDS;
  return delta;
}

function observedClockSeconds(value: Date): number {
  return value.getUTCHours() * 3600 + value.getUTCMinutes() * 60 + value.getUTCSeconds();
}

function alignedDelaySeconds(observed: Date, ref: number): number {
  const actual = observedClockSeconds(observed);
  const candidates = [actual - DAY_SECONDS, actual, actual + DAY_SECONDS, actual + 2 * DAY_SECONDS];
  const aligned = candidates.reduce((best, next) => Math.abs(next - ref) < Math.abs(best - ref) ? next : best);
  return aligned - ref;
}

function isOriginWaiting(train: Train, index: number, observed: Date): boolean {
  if (index !== 0) return false;
  const departure = stopBoardSec(train.stops[0]) ?? stopTimeSec(train.stops[0]);
  if (departure === null) return false;
  const scheduled = nearestScheduleDt(departure, observed, 0);
  const untilDeparture = (scheduled.getTime() - observed.getTime()) / 1000;
  return untilDeparture > EARLY_TOLERANCE_SECONDS && untilDeparture <= ORIGIN_WAIT_WINDOW_SECONDS;
}

function liveLocationLabel(train: Train, index: number, current: string, rawStatus: unknown, waiting: boolean): string {
  if (!current) return "위치 확인 중";
  if (waiting) return `${current} 운행 대기`;
  const status = statusName(rawStatus);
  if (status === "도착") return `${current} 도착`;
  if (status === "출발") return `${current} 출발`;
  if (status === "진입" || status === "전역출발") {
    const previous = index > 0 ? canonStation(train.stops[index - 1].station) : "";
    return previous && previous !== current ? `${previous}-${current}` : `${current} 진입`;
  }
  return status ? `${current} ${status}` : current;
}

export function estimatedTrainLocation(train: Train, ref = nowKst(), delay = 0): { kind: "expected"; label: string; station: string; status: string } {
  const timed = train.stops
    .map((stop, index) => [index, stopTimeSec(stop)] as const)
    .filter((item): item is readonly [number, number] => item[1] !== null);
  if (!timed.length) return { kind: "expected", label: "예상 소재 계산 불가", station: "", status: "" };
  const midnight = serviceOccurrenceMidnight(train, ref, delay);
  const timeline = timed.map(([index, seconds]) => [index, new Date(midnight.getTime() + (seconds + delay) * 1000)] as const);
  const [firstIndex, first] = timeline[0];
  const [lastIndex, last] = timeline[timeline.length - 1];
  if (ref < first) {
    const station = canonStation(train.stops[firstIndex].station);
    return first.getTime() - ref.getTime() <= 3 * 3600000
      ? { kind: "expected", label: `${station} 운행 대기`, station, status: "운행 대기" }
      : { kind: "expected", label: "운행 전", station: "", status: "운행 전" };
  }
  if (ref > last) {
    const station = canonStation(train.stops[lastIndex].station);
    return ref.getTime() - last.getTime() <= 30 * 60000
      ? { kind: "expected", label: `${station} 도착 추정`, station, status: "도착 추정" }
      : { kind: "expected", label: "운행 종료 추정", station, status: "운행 종료 추정" };
  }
  const nearest = timeline.reduce((a, b) => Math.abs(a[1].getTime() - ref.getTime()) < Math.abs(b[1].getTime() - ref.getTime()) ? a : b);
  if (Math.abs(nearest[1].getTime() - ref.getTime()) <= 45000) {
    const stop = train.stops[nearest[0]];
    const station = canonStation(stop.station);
    const passLike = nearest[0] !== 0 && nearest[0] !== train.stops.length - 1 && stop.arr === null;
    const status = passLike ? "통과 예상" : "부근 예상";
    return { kind: "expected", label: `${station} ${status}`, station, status };
  }
  for (let index = 0; index < timeline.length - 1; index += 1) {
    if (timeline[index][1] <= ref && ref <= timeline[index + 1][1]) {
      const previous = canonStation(train.stops[timeline[index][0]].station);
      const next = canonStation(train.stops[timeline[index + 1][0]].station);
      return { kind: "expected", label: `${previous}-${next}`, station: "", status: "구간 운행 예상" };
    }
  }
  return { kind: "expected", label: "예상 소재 계산 중", station: "", status: "" };
}

function nearestNeighborDelay(observations: Observation[], targetTrain: Train, targetDirection?: string, excludeTrainNo?: string): number | null {
  const targetAnchor = firstTimedSec(targetTrain);
  if (targetAnchor === null) return null;
  let pool = observations.filter((item) => item.delay_valid && !item.waiting && Number.isFinite(item.delay) && item.delay >= 0 && item.delay <= MAX_DELAY_SECONDS && item.train_no !== excludeTrainNo);
  if (targetDirection) {
    const directional = pool.filter((item) => item.direction === targetDirection);
    if (directional.length) pool = directional;
  }
  const exact = pool.filter((item) => item.train_no === targetTrain.train_no).sort((a, b) => b.observed.getTime() - a.observed.getTime())[0];
  if (exact) return exact.delay;
  let ahead: { distance: number; delay: number } | null = null;
  let behind: { distance: number; delay: number } | null = null;
  for (const item of pool) {
    if (item.schedule_anchor === null) continue;
    const delta = signedClockDelta(item.schedule_anchor, targetAnchor);
    if (delta < 0 && (!ahead || Math.abs(delta) < ahead.distance)) ahead = { distance: Math.abs(delta), delay: item.delay };
    if (delta > 0 && (!behind || delta < behind.distance)) behind = { distance: delta, delay: item.delay };
  }
  if (ahead && behind) return (ahead.delay + behind.delay) / 2;
  return ahead?.delay ?? behind?.delay ?? null;
}

export function medianDelay(observations: Array<{ direction: string; service: string; delay: number }>, direction?: string, service?: string): number {
  let values = observations
    .filter((item) => (!direction || item.direction === direction) && (!service || item.service === service))
    .map((item) => item.delay)
    .filter((delay) => Number.isFinite(delay) && delay >= 0 && delay <= MAX_DELAY_SECONDS);
  if (!values.length && (direction || service)) return medianDelay(observations);
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function delayForTrain(train: Train, observations: Observation[]): number {
  const neighbor = nearestNeighborDelay(observations, train, train.direction);
  if (neighbor !== null) return Math.max(0, neighbor);
  return Math.max(0, medianDelay(observations, train.direction, train.service));
}

export function observeDelays(line: string, mode: string, positions: PositionRow[]): [Observation[], Diagnostics] {
  const observations: Observation[] = [];
  const unmatchedTrain: string[] = [];
  const unmatchedStation: string[] = [];
  for (const raw of positions) {
    const rawTrain = raw.trainNo ?? raw.btrainNo;
    const train = getTrain(line, mode, rawTrain);
    if (!train) {
      if (rawTrain && unmatchedTrain.length < 10) unmatchedTrain.push(String(rawTrain));
      continue;
    }
    const current = canonStation(raw.statnNm);
    const index = firstCurrentIndex(train.stops, current);
    if (index === null) {
      if (current && unmatchedStation.length < 10) unmatchedStation.push(current);
      continue;
    }
    const ref = stopReference(train.stops, index, raw.trainSttus);
    if (ref === null) continue;
    const observed = parseDt(raw.recptnDt ?? raw.lastRecptnDt);
    const waiting = isOriginWaiting(train, index, observed);
    const rawDelay = waiting ? 0 : alignedDelaySeconds(observed, ref);
    const delayValid = waiting || (rawDelay >= -EARLY_TOLERANCE_SECONDS && rawDelay <= MAX_DELAY_SECONDS);
    const delay = waiting ? 0 : delayValid ? Math.max(0, rawDelay) : Number.NaN;
    const status = waiting ? "운행 대기" : statusName(raw.trainSttus);
    observations.push({
      train_no: train.train_no,
      direction: train.direction,
      service: train.service,
      delay,
      raw_delay: rawDelay,
      delay_valid: delayValid,
      delay_failsafe: false,
      waiting,
      current_station: current,
      status,
      location_label: liveLocationLabel(train, index, current, raw.trainSttus, waiting),
      observed,
      ref,
      index,
      schedule_anchor: firstTimedSec(train),
      train,
      raw,
    });
  }

  let failsafeCount = 0;
  for (const item of observations) {
    if (item.delay_valid) continue;
    const neighbor = nearestNeighborDelay(observations, item.train, item.direction, item.train_no);
    const fallback = neighbor ?? medianDelay(observations.filter((candidate) => candidate.delay_valid), item.direction, item.service);
    item.delay = Math.max(0, Number.isFinite(fallback) ? fallback : 0);
    item.delay_valid = true;
    item.delay_failsafe = true;
    failsafeCount += 1;
  }

  return [observations, {
    positions: positions.length,
    matched: observations.length,
    unmatched_train: unmatchedTrain,
    unmatched_station: unmatchedStation,
    waiting_trains: observations.filter((item) => item.waiting).length,
    delay_failsafe: failsafeCount,
  }];
}

function liveCandidates(line: string, mode: string, start: string, end: string, ready: Date, observations: Observation[]): Candidate[] {
  const out: Candidate[] = [];
  for (const observation of observations) {
    let train = observation.train;
    let stops = train.stops;
    let currentIndex = firstCurrentIndex(stops, observation.current_station);
    let pair = currentIndex === null ? null : routePair(stops, start, end, currentIndex);
    if (!pair && (line === "2호선" || line === "6호선")) {
      const virtual = mergedContinuationTrain(line, mode, train.train_no);
      if (virtual) {
        train = virtual;
        stops = train.stops;
        currentIndex = firstCurrentIndex(stops, observation.current_station);
        pair = currentIndex === null ? null : routePair(stops, start, end, currentIndex);
      }
    }
    if (currentIndex === null || !pair || currentIndex > pair[0]) continue;
    const boardSec = stopBoardSec(stops[pair[0]]);
    let alightSec = stopAlightSec(stops[pair[1]]);
    if (boardSec === null || alightSec === null) continue;
    while (alightSec < boardSec) alightSec += DAY_SECONDS;
    const board = scheduleDtAfter(boardSec, ready, observation.waiting ? 0 : observation.delay);
    if (!board) continue;
    const waitSeconds = (board.getTime() - ready.getTime()) / 1000;
    if (waitSeconds < -5 || waitSeconds > 14400) continue;
    const alight = new Date(board.getTime() + (alightSec - boardSec) * 1000);
    out.push({
      line,
      from: canonStation(start),
      to: canonStation(end),
      train_no: train.train_no,
      continuation_train_no: train.continuation_train_no ?? "",
      physical_continuation: Boolean(train.physical_continuation),
      service: train.service,
      direction: train.direction,
      origin: train.start,
      destination: train.dest,
      board_dt: board,
      alight_dt: alight,
      wait_seconds: round(waitSeconds),
      ride_seconds: round((alight.getTime() - board.getTime()) / 1000),
      delay_seconds: round(observation.delay),
      current_station: observation.current_station,
      status: observation.status,
      location_kind: "live",
      location_label: observation.location_label,
      confidence: observation.delay_failsafe ? "중간" : "높음",
      method: observation.waiting
        ? "실시간 운행 대기 + 공식 출발시각"
        : observation.delay_failsafe
          ? "실시간 위치 + 인접 앞·뒤 열차 지연 평균 Fail-Safe"
          : "실시간 열차 위치 + 열차별 공식 시간표",
      projected: false,
    });
  }
  return out.sort((a, b) => a.alight_dt.getTime() - b.alight_dt.getTime() || a.board_dt.getTime() - b.board_dt.getTime());
}

function projectedCandidates(line: string, mode: string, start: string, end: string, ready: Date, observations: Observation[]): Candidate[] {
  const raw: Array<[Date, Date, Train, number]> = [];
  const now = nowKst();
  for (const train of routeTrains(line, mode, start, end)) {
    const pair = routePair(train.stops, start, end);
    if (!pair) continue;
    const boardSec = stopBoardSec(train.stops[pair[0]]);
    let alightSec = stopAlightSec(train.stops[pair[1]]);
    if (boardSec === null || alightSec === null) continue;
    while (alightSec < boardSec) alightSec += DAY_SECONDS;
    const delay = delayForTrain(train, observations);
    const board = scheduleDtAfter(boardSec, ready, delay);
    if (!board || (board.getTime() - ready.getTime()) / 1000 > 14400) continue;
    raw.push([new Date(board.getTime() + (alightSec - boardSec) * 1000), board, train, delay]);
  }
  raw.sort((a, b) => a[0].getTime() - b[0].getTime() || a[1].getTime() - b[1].getTime());
  return raw.slice(0, 30).map(([alight, board, train, delay]) => {
    const location = estimatedTrainLocation(train, now, delay);
    return {
      line,
      from: canonStation(start),
      to: canonStation(end),
      train_no: train.train_no,
      continuation_train_no: train.continuation_train_no ?? "",
      physical_continuation: Boolean(train.physical_continuation),
      service: train.service,
      direction: train.direction,
      origin: train.start,
      destination: train.dest,
      board_dt: board,
      alight_dt: alight,
      wait_seconds: round((board.getTime() - ready.getTime()) / 1000),
      ride_seconds: round((alight.getTime() - board.getTime()) / 1000),
      delay_seconds: round(delay),
      current_station: location.station,
      status: location.status,
      location_kind: "expected" as const,
      location_label: location.label,
      confidence: observations.length ? "중간" as const : "낮음" as const,
      method: observations.length ? "공식 시간표 + 인접 앞·뒤 열차 지연 평균" : "공식 시간표만 사용",
      projected: true,
    };
  });
}

function previousCandidate(line: string, mode: string, start: string, end: string, ready: Date, observations: Observation[]): Candidate | null {
  let best: Candidate | null = null;
  for (const train of routeTrains(line, mode, start, end)) {
    const pair = routePair(train.stops, start, end);
    if (!pair) continue;
    const boardSec = stopBoardSec(train.stops[pair[0]]);
    let alightSec = stopAlightSec(train.stops[pair[1]]);
    if (boardSec === null || alightSec === null) continue;
    while (alightSec < boardSec) alightSec += DAY_SECONDS;
    const delay = delayForTrain(train, observations);
    const board = scheduleDtBefore(boardSec, ready, delay);
    if (!board) continue;
    const alight = new Date(board.getTime() + (alightSec - boardSec) * 1000);
    if (alight.getTime() < nowKst().getTime() - 120000) continue;
    const location = estimatedTrainLocation(train, nowKst(), delay);
    const candidate: Candidate = {
      line,
      from: canonStation(start),
      to: canonStation(end),
      train_no: train.train_no,
      continuation_train_no: train.continuation_train_no ?? "",
      physical_continuation: Boolean(train.physical_continuation),
      service: train.service,
      direction: train.direction,
      origin: train.start,
      destination: train.dest,
      board_dt: board,
      alight_dt: alight,
      wait_seconds: round((board.getTime() - ready.getTime()) / 1000),
      ride_seconds: round((alight.getTime() - board.getTime()) / 1000),
      delay_seconds: round(delay),
      current_station: location.station,
      status: location.status,
      location_kind: "expected",
      location_label: location.label,
      confidence: observations.length ? "중간" : "낮음",
      method: observations.length ? "직전 열차 추정 · 인접 앞·뒤 열차 지연 평균" : "직전 열차 추정 · 공식 시간표",
      projected: true,
    };
    if (!best || candidate.board_dt.getTime() > best.board_dt.getTime()) best = candidate;
  }
  return best;
}

export function publicCandidate(candidate: Candidate | null, selected = false): PublicCandidate | null {
  if (!candidate) return null;
  return {
    train_no: candidate.train_no,
    continuation_train_no: candidate.continuation_train_no,
    physical_continuation: candidate.physical_continuation,
    service: candidate.service,
    direction: candidate.direction,
    origin: candidate.origin,
    destination: candidate.destination,
    board_dt: formatKst(candidate.board_dt),
    alight_dt: formatKst(candidate.alight_dt),
    wait_seconds: candidate.wait_seconds,
    ride_seconds: candidate.ride_seconds,
    delay_seconds: candidate.delay_seconds,
    current_station: candidate.current_station,
    status: candidate.status,
    location_kind: candidate.location_kind,
    location_label: candidate.location_label,
    confidence: candidate.confidence,
    method: candidate.method,
    projected: candidate.projected,
    live_detected: !candidate.projected,
    selected,
  };
}

export async function calculateSegment(line: string, mode: string, start: string, end: string, ready: Date, cache: PositionCache, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; chosen?: Candidate; candidates?: Candidate[]; public_candidates?: PublicCandidate[]; previous_candidate?: PublicCandidate | null; diagnostics?: Diagnostics; error?: string }> {
  if (!STATIONS_BY_LINE[line]) return { ok: false, error: `지원하지 않는 노선: ${line}` };
  const lineStations = new Set(STATIONS_BY_LINE[line].map(canonStation));
  if (!lineStations.has(canonStation(start))) return { ok: false, error: `${line} 시간표에서 승차역 '${start}'을 찾지 못했습니다.` };
  if (!lineStations.has(canonStation(end))) return { ok: false, error: `${line} 시간표에서 하차역 '${end}'을 찾지 못했습니다.` };
  const realtime = await cachedPositionRows(line, cache, 5, fetchImpl);
  const [observations, diagnostics] = observeDelays(line, mode, realtime.rows);
  diagnostics.realtime_available = realtime.available;
  if (realtime.error) diagnostics.realtime_error = realtime.error;
  const direct = liveCandidates(line, mode, start, end, ready, observations);
  const projected = projectedCandidates(line, mode, start, end, ready, observations);
  const merged = new Map<string, Candidate>();
  for (const candidate of projected) merged.set(candidate.train_no, candidate);
  for (const candidate of direct) merged.set(candidate.train_no, candidate);
  let candidates = [...merged.values()];
  let near = candidates.filter((candidate) => {
    const seconds = (candidate.board_dt.getTime() - ready.getTime()) / 1000;
    return seconds >= -5 && seconds <= 3600;
  });
  if (!near.length) near = candidates;
  near.sort((a, b) => a.alight_dt.getTime() - b.alight_dt.getTime() || a.board_dt.getTime() - b.board_dt.getTime());
  if (!near.length) return { ok: false, error: `${line} ${start}→${end} 운행 열차를 현재 시간표에서 찾지 못했습니다.`, diagnostics };
  const chosen = near[0];
  return {
    ok: true,
    chosen,
    candidates: near.slice(0, 10),
    public_candidates: near.slice(0, 6).map((candidate) => publicCandidate(candidate, candidate.train_no === chosen.train_no) as PublicCandidate),
    previous_candidate: publicCandidate(previousCandidate(line, mode, start, end, ready, observations)),
    diagnostics,
  };
}

function trackedCandidate(line: string, start: string, end: string, train: Train, live: Observation, board: Date, alight: Date, remaining: number, arrived: boolean): Candidate & Record<string, unknown> {
  return {
    line,
    from: canonStation(start),
    to: canonStation(end),
    train_no: live.train_no,
    continuation_train_no: train.continuation_train_no ?? "",
    physical_continuation: Boolean(train.physical_continuation),
    service: train.service,
    direction: live.direction || train.direction,
    origin: train.start,
    destination: train.dest,
    board_dt: board,
    alight_dt: alight,
    wait_seconds: 0,
    ride_seconds: arrived ? 0 : Math.max(0, round((alight.getTime() - board.getTime()) / 1000)),
    remaining_seconds: arrived ? 0 : remaining,
    delay_seconds: round(live.delay),
    current_station: live.current_station,
    status: live.status,
    location_kind: "live",
    location_label: live.location_label,
    confidence: live.delay_failsafe ? "중간" : "높음",
    method: live.waiting
      ? "탑승 열차 운행 대기 · 공식 출발시각"
      : live.delay_failsafe
        ? "탑승 열차 실시간 위치 + 인접 앞·뒤 열차 지연 평균 Fail-Safe"
        : train.physical_continuation ? "탑승 열차 연속운행 추적" : "탑승 열차 실시간 고정 추적",
    projected: false,
    tracking: true,
    arrived,
  };
}

export async function trackedTrainSegment(line: string, mode: string, start: string, end: string, trainNo: string, cache: PositionCache, boardedAt?: string, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; arrived?: boolean; chosen?: Candidate & Record<string, unknown>; diagnostics?: Diagnostics; error?: string }> {
  const now = nowKst();
  const base = getTrain(line, mode, trainNo);
  if (!base) return { ok: false, error: `${line} 공식 시간표에서 탑승 열차 ${trainNo}을 찾지 못했습니다.` };
  let train = base;
  let pair = routePair(train.stops, start, end);
  if (!pair && (line === "2호선" || line === "6호선")) {
    const virtual = mergedContinuationTrain(line, mode, base.train_no);
    if (virtual && routePair(virtual.stops, start, end)) {
      train = virtual;
      pair = routePair(train.stops, start, end);
    }
  }
  if (!pair) return { ok: false, error: `${trainNo}열차 시간표에서 ${start}→${end} 운행 구간을 찾지 못했습니다.` };
  const targetSec = stopAlightSec(train.stops[pair[1]]);
  if (targetSec === null) return { ok: false, error: `${end} 도착시각이 시간표에 없습니다.` };
  const realtime = await cachedPositionRows(line, cache, 5, fetchImpl);
  const [observations, diagnostics] = observeDelays(line, mode, realtime.rows);
  diagnostics.realtime_available = realtime.available;
  if (realtime.error) diagnostics.realtime_error = realtime.error;
  const wanted = new Set([train.train_no, train.continuation_train_no ?? ""].map((value) => value.toUpperCase()));
  const live = observations.filter((item) => wanted.has(item.train_no.toUpperCase())).sort((a, b) => b.observed.getTime() - a.observed.getTime())[0];
  let boarded = boardedAt ? parseDt(boardedAt) : null;

  if (live) {
    let currentIndex = firstCurrentIndex(train.stops, live.current_station, pair[1]);
    currentIndex ??= firstCurrentIndex(train.stops, live.current_station);
    const arrived = currentIndex !== null && (currentIndex > pair[1] || (currentIndex === pair[1] && ["도착", "출발"].includes(live.status)));
    if (arrived) return { ok: true, arrived: true, chosen: trackedCandidate(line, start, end, train, live, boarded ?? now, now, 0, true), diagnostics };
    if (live.waiting) {
      const target = scheduleDtAfter(targetSec, now, 0) ?? nearestScheduleDt(targetSec, now, 0);
      const remaining = Math.max(0, round((target.getTime() - now.getTime()) / 1000));
      return { ok: true, arrived: false, chosen: trackedCandidate(line, start, end, train, live, boarded ?? now, target, remaining, false), diagnostics };
    }
    if (currentIndex !== null) {
      const ref = stopReference(train.stops, currentIndex, live.raw.trainSttus);
      if (ref !== null) {
        let target = targetSec;
        while (target < ref) target += DAY_SECONDS;
        const age = Math.max(0, (now.getTime() - live.observed.getTime()) / 1000);
        const remainingByPosition = Math.max(0, target - ref - age);
        let alight = scheduleDtAfter(targetSec, now, live.delay) ?? new Date(now.getTime() + remainingByPosition * 1000);
        if ((alight.getTime() - now.getTime()) / 1000 > 21600) alight = new Date(now.getTime() + remainingByPosition * 1000);
        if (boarded && boarded > alight) boarded = alight;
        return {
          ok: true,
          arrived: false,
          chosen: trackedCandidate(line, start, end, train, live, boarded ?? now, alight, Math.max(0, round((alight.getTime() - now.getTime()) / 1000)), false),
          diagnostics,
        };
      }
    }
  }

  const direction = train.physical_continuation && activeTrainNoForVirtual(train, now) === train.continuation_train_no
    ? (train.continuation_direction ?? train.direction)
    : train.direction;
  const delay = delayForTrain({ ...train, direction }, observations);
  const location = estimatedTrainLocation(train, now, delay);
  let target = nearestScheduleDt(targetSec, now, delay);
  if (target.getTime() < now.getTime() - 300000 || target.getTime() > now.getTime() + 21600000) target = now;
  return {
    ok: true,
    arrived: false,
    chosen: {
      line,
      from: canonStation(start),
      to: canonStation(end),
      train_no: activeTrainNoForVirtual(train, now, delay),
      continuation_train_no: train.continuation_train_no ?? "",
      physical_continuation: Boolean(train.physical_continuation),
      service: train.service,
      direction,
      origin: train.start,
      destination: train.dest,
      board_dt: boarded ?? now,
      alight_dt: target,
      wait_seconds: 0,
      ride_seconds: Math.max(0, round((target.getTime() - (boarded ?? now).getTime()) / 1000)),
      remaining_seconds: Math.max(0, round((target.getTime() - now.getTime()) / 1000)),
      delay_seconds: round(delay),
      current_station: location.station,
      status: location.status || "위치 재포착 대기",
      location_kind: "expected",
      location_label: location.label,
      confidence: observations.length ? "중간" : "낮음",
      method: realtime.available
        ? train.physical_continuation ? "연속운행 열차 잠금 · 실시간 위치 재포착 대기" : "탑승 열차 잠금 · 실시간 위치 재포착 대기"
        : "공식 시간표 기반 임시 추적 · 실시간 위치 조회 실패",
      projected: true,
      tracking: true,
      arrived: false,
    },
    diagnostics,
  };
}

export async function calculateRoute(payload: CalculateRoutePayload, positionCache?: PositionCache, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  const segments = payload.segments ?? [];
  if (segments.length < 1 || segments.length > 8) throw new Error("구간은 1~8개로 입력하세요.");
  const now = nowKst();
  let start = payload.start_time ? clockDtNearForPayload(payload.start_time, now) : now;
  if (start.getTime() < now.getTime() - 8 * 3600000) start = new Date(start.getTime() + 86400000);
  const [mode, reason] = resolveServiceMode(String(payload.day ?? "AUTO"), start);
  const refresh = Boolean(payload.refresh_only);
  const readyBase = refresh ? new Date(Math.max(start.getTime(), now.getTime())) : start;
  const cache = positionCache ?? await prefetchPositionCache(segments.map((segment) => String(segment.line)), 5, fetchImpl);
  const results: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  let ready = readyBase;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const line = String(segment.line ?? "").trim();
    const from = canonStation(segment.from);
    const to = canonStation(segment.to);
    if (!from || !to) throw new Error(`${index + 1}번 구간의 승차역/하차역을 입력하세요.`);
    if (from === to) throw new Error(`${index + 1}번 구간의 승차역과 하차역이 같습니다.`);
    const result = await calculateSegment(line, mode, from, to, ready, cache, fetchImpl);
    if (!result.ok || !result.chosen) return { ok: false, failed_segment: index + 1, error: result.error ?? "구간 계산 실패", diagnostics: result.diagnostics ?? {}, partial_segments: results.map(serializeSegment) };
    const chosen: Record<string, unknown> = {
      ...result.chosen,
      segment_index: index + 1,
      ready_dt: ready,
      diagnostics: result.diagnostics ?? {},
      nearby_candidates: result.public_candidates ?? [],
      previous_candidate: result.previous_candidate ?? null,
      transfer_info: segment.transfer_info ?? null,
      transfer_seconds: Number(segment.transfer_seconds ?? Math.round(Number(segment.transfer_walk ?? 0) * 60)),
    };
    results.push(chosen);
    if (result.chosen.confidence !== "높음") warnings.push(`${index + 1}구간 ${line} ${from}→${to}: ${result.chosen.method} (${result.chosen.confidence} 신뢰도)`);
    const transfer = Math.max(0, Number(segment.transfer_seconds ?? Math.round(Number(segment.transfer_walk ?? 0) * 60)));
    ready = new Date(result.chosen.alight_dt.getTime() + (index < segments.length - 1 ? transfer * 1000 : 0));
  }
  const end = results[results.length - 1].alight_dt as Date;
  return {
    ok: true,
    service_mode: mode,
    service_mode_reason: reason,
    start_time: formatKst(start),
    calculated_at: formatKst(now),
    refresh_only: refresh,
    arrival_time: formatKst(end),
    total_seconds: round((end.getTime() - start.getTime()) / 1000),
    segments: results.map(serializeSegment),
    warnings,
  };
}

function clockDtNearForPayload(text: string, ref: Date): Date {
  return /^\d{4}-\d{2}-\d{2}[ T]/.test(text) ? parseDt(text) : awaitlessClock(text, ref);
}

function awaitlessClock(text: string, ref: Date): Date {
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return parseDt(text);
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
  const base = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  return [-1, 0, 1]
    .map((days) => new Date(base.getTime() + days * 86400000 + seconds * 1000))
    .reduce((a, b) => Math.abs(a.getTime() - ref.getTime()) < Math.abs(b.getTime() - ref.getTime()) ? a : b);
}

export async function calculateLiveTrip(payload: LiveTripPayload, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  const segments = payload.segments ?? [];
  if (segments.length < 1 || segments.length > 8) throw new Error("구간은 1~8개로 입력하세요.");
  const activeIndex = Number(payload.active_index ?? 0);
  if (activeIndex < 0 || activeIndex >= segments.length) throw new Error("추적 중인 구간 번호가 올바르지 않습니다.");
  const boardedNo = String(payload.boarded_train_no ?? "").trim();
  if (!boardedNo) throw new Error("탑승한 열차번호가 없습니다.");
  const ref = payload.boarded_at ? parseDt(payload.boarded_at) : nowKst();
  const [mode, reason] = resolveServiceMode(String(payload.day ?? "AUTO"), ref);
  const cache = await prefetchPositionCache(segments.map((segment) => String(segment.line)), 5, fetchImpl);
  const results: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const active = segments[activeIndex];
  const tracked = await trackedTrainSegment(String(active.line ?? ""), mode, canonStation(active.from), canonStation(active.to), boardedNo, cache, typeof payload.boarded_at === "string" ? payload.boarded_at : undefined, fetchImpl);
  if (!tracked.ok || !tracked.chosen) return { ok: false, failed_segment: activeIndex + 1, error: tracked.error ?? "탑승 열차 추적 실패", diagnostics: tracked.diagnostics ?? {} };
  const activeCurrent: Record<string, unknown> = {
    ...tracked.chosen,
    segment_index: activeIndex + 1,
    diagnostics: tracked.diagnostics ?? {},
    nearby_candidates: [publicCandidate(tracked.chosen as Candidate, true)],
    transfer_info: active.transfer_info ?? null,
    transfer_seconds: Number(active.transfer_seconds ?? Math.round(Number(active.transfer_walk ?? 0) * 60)),
  };
  results.push(activeCurrent);
  let ready = new Date((activeCurrent.alight_dt as Date).getTime() + (activeIndex < segments.length - 1 ? Number(activeCurrent.transfer_seconds ?? 0) * 1000 : 0));
  for (let index = activeIndex + 1; index < segments.length; index += 1) {
    const segment = segments[index];
    const result = await calculateSegment(String(segment.line ?? ""), mode, canonStation(segment.from), canonStation(segment.to), ready, cache, fetchImpl);
    if (!result.ok || !result.chosen) return { ok: false, failed_segment: index + 1, error: result.error ?? "후속 구간 계산 실패", diagnostics: result.diagnostics ?? {}, segments: results.map(serializeSegment) };
    const nextChosen: Record<string, unknown> = {
      ...result.chosen,
      segment_index: index + 1,
      ready_dt: ready,
      diagnostics: result.diagnostics ?? {},
      nearby_candidates: result.public_candidates ?? [],
      previous_candidate: result.previous_candidate ?? null,
      transfer_info: segment.transfer_info ?? null,
      transfer_seconds: Number(segment.transfer_seconds ?? Math.round(Number(segment.transfer_walk ?? 0) * 60)),
    };
    results.push(nextChosen);
    if (result.chosen.confidence !== "높음") warnings.push(`${index + 1}구간 ${segment.line} ${segment.from}→${segment.to}: ${result.chosen.method} (${result.chosen.confidence} 신뢰도)`);
    ready = new Date(result.chosen.alight_dt.getTime() + (index < segments.length - 1 ? Number(nextChosen.transfer_seconds ?? 0) * 1000 : 0));
  }
  const now = nowKst();
  const final = results[results.length - 1].alight_dt as Date;
  return {
    ok: true,
    live_tracking: true,
    service_mode: mode,
    service_mode_reason: reason,
    active_index: activeIndex,
    boarded_train_no: activeCurrent.train_no ?? boardedNo,
    updated_at: formatKst(now),
    arrival_time: formatKst(final),
    remaining_seconds: Math.max(0, round((final.getTime() - now.getTime()) / 1000)),
    current_segment_remaining_seconds: Number(activeCurrent.remaining_seconds ?? 0),
    current_station: String(activeCurrent.current_station ?? ""),
    current_status: String(activeCurrent.status ?? ""),
    segments: results.map(serializeSegment),
    warnings,
  };
}

export interface AutoRouteLiveScore {
  path: { seconds: number };
  segments: SegmentInput[];
  result: Serialized;
  scheduleResult: Serialized;
}

export function compareAutoRouteLiveScores(a: AutoRouteLiveScore, b: AutoRouteLiveScore): number {
  return String(a.result.arrival_time).localeCompare(String(b.result.arrival_time))
    || a.segments.length - b.segments.length
    || String(a.scheduleResult.arrival_time).localeCompare(String(b.scheduleResult.arrival_time))
    || a.path.seconds - b.path.seconds;
}

export async function calculateAutoRoute(payload: { from: string; to: string; start_time?: string; day?: string; [key: string]: unknown }, fetchImpl: FetchLike = fetch): Promise<Serialized> {
  const now = nowKst();
  let start = payload.start_time ? clockDtNearForPayload(payload.start_time, now) : now;
  if (start.getTime() < now.getTime() - 8 * 3600000) start = new Date(start.getTime() + 86400000);
  const [mode, reason] = resolveServiceMode(String(payload.day ?? "AUTO"), start);
  const startStation = canonStation(payload.from);
  const endStation = canonStation(payload.to);
  const candidates = autoCandidateRoutes(startStation, endStation, mode);
  const scheduleCache: PositionCache = new Map();
  for (const line of Object.keys(STATIONS_BY_LINE)) {
    if (scheduleCache instanceof Map) scheduleCache.set(line, { rows: [], error: "자동경로 시간표 사전채점", available: false });
  }
  const scoredSchedule: Array<{ path: (typeof candidates)[number]["path"]; segments: SegmentInput[]; result: Serialized }> = [];
  for (const candidate of candidates) {
    const result = await calculateRoute({ start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false }, scheduleCache, fetchImpl);
    if (result.ok) scoredSchedule.push({ path: candidate.path, segments: candidate.segments, result });
  }
  if (!scoredSchedule.length) {
    const path = autoFindPath(startStation, endStation, mode);
    const segments = enrichTransferSegments(autoPathToSegments(path, mode), mode);
    return {
      ok: true,
      service_mode: mode,
      service_mode_reason: reason,
      from: startStation,
      to: endStation,
      route_seconds: path.seconds,
      transfer_count: Math.max(0, segments.length - 1),
      interchanges: candidateInterchanges(segments),
      segments,
      selection_method: "정적 그래프 fallback",
      candidate_count: 1,
      live_scored_count: 0,
      alternatives: [],
    };
  }
  scoredSchedule.sort((a, b) => String(a.result.arrival_time).localeCompare(String(b.result.arrival_time)) || a.segments.length - b.segments.length || a.path.seconds - b.path.seconds);
  const lines = [...new Set(scoredSchedule.flatMap((item) => item.segments.map((segment) => String(segment.line))))];
  const liveCache = await prefetchPositionCache(lines, 5, fetchImpl);
  const liveScored: AutoRouteLiveScore[] = [];
  for (const candidate of scoredSchedule) {
    const result = await calculateRoute({ start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false }, liveCache, fetchImpl);
    liveScored.push({ path: candidate.path, segments: candidate.segments, result: result.ok ? result : candidate.result, scheduleResult: candidate.result });
  }
  liveScored.sort(compareAutoRouteLiveScores);
  const selected = liveScored[0];
  const selectedResult = selected.result;
  const alternatives = liveScored.slice(1, 4).map((item) => ({
    segments: item.segments,
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
    from: startStation,
    to: endStation,
    route_seconds: selected.path.seconds,
    estimated_total_seconds: Number(selectedResult.total_seconds ?? 0),
    estimated_arrival_time: selectedResult.arrival_time,
    estimated_confidence: routeConfidence(selectedResult as { segments?: Array<{ confidence?: string }> }),
    transfer_count: Math.max(0, selected.segments.length - 1),
    interchanges: candidateInterchanges(selected.segments),
    segments: selectedResult.segments ?? selected.segments,
    selection_method: "다중 후보 시간표 + 실시간 ETA 비교",
    candidate_count: candidates.length,
    live_scored_count: liveScored.length,
    alternatives,
  };
}

export { formatKst, nowKst };
