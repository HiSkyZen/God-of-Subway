import type {
  AutoRoutePayload,
  CalculateRoutePayload,
  RouteObjective,
  SegmentInput,
  Serialized,
} from "../types/domain";
import type { FetchLike } from "./realtime-service";
import { expandedAutoCandidates, type RouteCandidate } from "./route-candidate-service";
import { calculateGtxHybridRoute, isGtxLine } from "./gtx-service";
import { candidateInterchanges, routeConfidence, stationLines } from "./routing-service";
import { canonStation, formatKst, parseDt, resolveServiceMode } from "./timetable-service";
import { estimateRouteFare, type FareEstimate } from "./fare-service";
import { GTX_LINE_NAMES, type GtxLine } from "./gtx-topology";

type BaseRoute = (payload: CalculateRoutePayload) => Promise<Serialized>;

function usableRoute(result: Serialized | null | undefined): result is Serialized {
  return Boolean(result && result.ok !== false && result.arrival_time && Array.isArray(result.segments));
}
function segmentsOf(result: Serialized): Array<Record<string, unknown>> {
  return Array.isArray(result.segments)
    ? result.segments.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
}
function usesGtx(segments: readonly SegmentInput[]): boolean {
  return segments.some((segment) => isGtxLine(String(segment.line)));
}
function transferCount(segments: readonly SegmentInput[]): number {
  return Math.max(0, segments.length - 1);
}

function routeObjective(value: unknown): RouteObjective {
  return value === "fewest_transfers" || value === "lowest_cost" ? value : "fastest";
}

function requiredGtxLinesForEndpoint(station: string): GtxLine[] {
  const lines = stationLines(canonStation(station));
  if (lines.some((line) => !isGtxLine(line))) return [];
  return lines.filter(isGtxLine);
}

export function gtxExclusionsForPreference(from: string, to: string, useGtx: boolean): GtxLine[] {
  if (useGtx) return [];
  const required = new Set<GtxLine>([
    ...requiredGtxLinesForEndpoint(from),
    ...requiredGtxLinesForEndpoint(to),
  ]);
  return GTX_LINE_NAMES.filter((line) => !required.has(line));
}

function lineCanBeExcluded(line: string, from: string, to: string): boolean {
  for (const station of [from, to]) {
    const lines = stationLines(canonStation(station));
    if (lines.includes(line) && !lines.some((candidate) => candidate !== line)) return false;
  }
  return true;
}

export interface AutoRouteScore {
  candidate: RouteCandidate;
  result: Serialized;
  fare: FareEstimate;
}

export function compareAutoRouteScores(a: AutoRouteScore, b: AutoRouteScore, objective: RouteObjective): number {
  const arrival = String(a.result.arrival_time).localeCompare(String(b.result.arrival_time));
  const transfers = transferCount(a.candidate.segments) - transferCount(b.candidate.segments);
  const gtx = Number(usesGtx(a.candidate.segments)) - Number(usesGtx(b.candidate.segments));
  if (objective === "fewest_transfers") {
    return transfers || arrival || gtx || a.fare.adult_card_won - b.fare.adult_card_won
      || a.candidate.path.seconds - b.candidate.path.seconds;
  }
  if (objective === "lowest_cost") {
    return a.fare.adult_card_won - b.fare.adult_card_won || arrival || transfers || gtx
      || a.candidate.path.seconds - b.candidate.path.seconds;
  }
  return arrival || gtx || transfers || a.fare.adult_card_won - b.fare.adult_card_won
    || a.candidate.path.seconds - b.candidate.path.seconds;
}

function candidateKey(candidate: RouteCandidate): string { return candidate.signature; }

export async function calculateExpandedAutoRoute(
  payload: AutoRoutePayload,
  baseRoute: BaseRoute,
  fetchImpl: FetchLike = fetch,
): Promise<Serialized> {
  const start = parseDt(payload.start_time);
  const [mode, reason] = resolveServiceMode(String(payload.day || "AUTO"), start);
  const objective = routeObjective(payload.objective);
  const useGtx = payload.use_gtx !== false && payload.exclude_gtx !== true;
  const requestedGtxExclusions = gtxExclusionsForPreference(payload.from, payload.to, useGtx);
  const candidateMap = new Map<string, RouteCandidate>();
  const addPool = (excludeLines: readonly string[] | undefined, limit = 24): void => {
    try {
      for (const candidate of expandedAutoCandidates(
        payload.from,
        payload.to,
        mode,
        limit,
        excludeLines?.length ? { excludeLines } : undefined,
      )) candidateMap.set(candidateKey(candidate), candidate);
    } catch {
      // A diversity pool may be impossible (e.g. GTX-exclusive endpoint).
    }
  };

  // Primary pool honors the user's GTX preference.
  addPool(requestedGtxExclusions);
  // With GTX enabled, also guarantee an ordinary/no-unnecessary-GTX pool so an
  // exact ETA tie can deterministically choose the non-GTX route.
  if (useGtx) addPool(gtxExclusionsForPreference(payload.from, payload.to, false), 16);
  // Lowest-cost must consider a topology that avoids Shinbundang when endpoints
  // are still reachable without it. This is candidate diversity, not a penalty.
  if (objective === "lowest_cost" && lineCanBeExcluded("신분당선", payload.from, payload.to)) {
    addPool([...new Set([...requestedGtxExclusions, "신분당선"])], 16);
  }

  const candidates = [...candidateMap.values()];
  if (!candidates.length) return { ok: false, error: "경로를 찾지 못했습니다." };

  const scored: AutoRouteScore[] = [];
  for (const candidate of candidates) {
    const result = usesGtx(candidate.segments)
      ? await calculateGtxHybridRoute(
          { start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false },
          baseRoute,
          fetchImpl,
        )
      : await baseRoute({ start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false });
    if (usableRoute(result)) {
      scored.push({ candidate, result, fare: estimateRouteFare(candidate.segments, mode) });
    }
  }
  if (!scored.length) {
    return {
      ok: false,
      from: canonStation(payload.from),
      to: canonStation(payload.to),
      error: "현재 시각 이후 이용 가능한 열차 경로를 찾지 못했습니다.",
      service_mode: mode,
      service_mode_reason: reason,
    };
  }

  scored.sort((a, b) => compareAutoRouteScores(a, b, objective));
  const selected = scored[0];
  const selectedSegments = segmentsOf(selected.result);
  const alternatives = scored.slice(1, 4).map(({ candidate, result, fare }) => ({
    segments: segmentsOf(result),
    interchanges: candidateInterchanges(candidate.segments),
    transfer_count: transferCount(candidate.segments),
    route_seconds: candidate.path.seconds,
    total_seconds: Number(result.total_seconds ?? 0),
    arrival_time: result.arrival_time,
    estimated_fare: fare.adult_card_won,
    fare_distance_km: fare.distance_km,
    uses_gtx: usesGtx(candidate.segments),
    seed: candidate.seed,
    confidence: routeConfidence(result as { segments?: Array<{ confidence?: string }> }),
  }));
  return {
    ok: true,
    service_mode: mode,
    service_mode_reason: reason,
    from: canonStation(payload.from),
    to: canonStation(payload.to),
    start_time: formatKst(start),
    route_objective: objective,
    route_seconds: selected.candidate.path.seconds,
    estimated_total_seconds: Number(selected.result.total_seconds ?? 0),
    total_seconds: Number(selected.result.total_seconds ?? 0),
    estimated_arrival_time: selected.result.arrival_time,
    arrival_time: selected.result.arrival_time,
    estimated_confidence: routeConfidence(selected.result as { segments?: Array<{ confidence?: string }> }),
    estimated_fare: selected.fare.adult_card_won,
    fare_distance_km: selected.fare.distance_km,
    fare_basis: selected.fare.basis,
    shinbundang_surcharge: selected.fare.shinbundang_surcharge_won,
    transfer_count: transferCount(selected.candidate.segments),
    interchanges: candidateInterchanges(selected.candidate.segments),
    segments: selectedSegments,
    selection_method: objective === "fewest_transfers"
      ? "최소 환승회 수 → 실제 ETA"
      : objective === "lowest_cost"
        ? "최소 예상 운임 → 실제 ETA"
        : "최단 실제 ETA → 동윭 시 비GTX → 최소환승",
    candidate_count: candidates.length,
    live_scored_count: scored.length,
    candidate_seed: selected.candidate.seed,
    gtx_enabled: useGtx,
    gtx_excluded: !useGtx,
    gtx_excluded_lines: requestedGtxExclusions,
    alternatives,
  };
}
