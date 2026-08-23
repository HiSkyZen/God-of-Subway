import type { AutoRoutePayload, CalculateRoutePayload, SegmentInput, Serialized } from "../types/domain";
import type { FetchLike } from "./realtime-service";
import { expandedAutoCandidates } from "./route-candidate-service";
import { calculateGtxHybridRoute, isGtxLine } from "./gtx-service";
import { candidateInterchanges, routeConfidence } from "./routing-service";
import { canonStation, formatKst, parseDt, resolveServiceMode } from "./timetable-service";

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

export async function calculateExpandedAutoRoute(
  payload: AutoRoutePayload,
  baseRoute: BaseRoute,
  fetchImpl: FetchLike = fetch,
): Promise<Serialized> {
  const start = parseDt(payload.start_time);
  const [mode, reason] = resolveServiceMode(String(payload.day || "AUTO"), start);
  const excludeGtx = Boolean((payload as unknown as Record<string, unknown>).exclude_gtx);
  const options = excludeGtx ? { excludeLines: ["GTX-A(북부)", "GTX-A(남부)"] } : undefined;
  let candidates;
  try {
    candidates = expandedAutoCandidates(payload.from, payload.to, mode, 24, options);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "경로를 찾지 못했습니다." };
  }
  const scored: Array<{ candidate: (typeof candidates)[number]; result: Serialized }> = [];
  for (const candidate of candidates) {
    const result = usesGtx(candidate.segments)
      ? await calculateGtxHybridRoute(
          { start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false },
          baseRoute,
          fetchImpl,
        )
      : await baseRoute({ start_time: formatKst(start), day: mode, segments: candidate.segments, refresh_only: false });
    if (usableRoute(result)) scored.push({ candidate, result });
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
  scored.sort((a, b) => String(a.result.arrival_time).localeCompare(String(b.result.arrival_time))
    || Number(usesGtx(a.candidate.segments)) - Number(usesGtx(b.candidate.segments))
    || a.candidate.segments.length - b.candidate.segments.length
    || a.candidate.path.seconds - b.candidate.path.seconds);
  const selected = scored[0];
  const selectedSegments = segmentsOf(selected.result);
  const alternatives = scored.slice(1, 4).map(({ candidate, result }) => ({
    segments: segmentsOf(result),
    interchanges: candidateInterchanges(candidate.segments),
    transfer_count: Math.max(0, candidate.segments.length - 1),
    route_seconds: candidate.path.seconds,
    total_seconds: Number(result.total_seconds ?? 0),
    arrival_time: result.arrival_time,
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
    route_seconds: selected.candidate.path.seconds,
    estimated_total_seconds: Number(selected.result.total_seconds ?? 0),
    total_seconds: Number(selected.result.total_seconds ?? 0),
    estimated_arrival_time: selected.result.arrival_time,
    arrival_time: selected.result.arrival_time,
    estimated_confidence: routeConfidence(selected.result as { segments?: Array<{ confidence?: string }> }),
    transfer_count: Math.max(0, selected.candidate.segments.length - 1),
    interchanges: candidateInterchanges(selected.candidate.segments),
    segments: selectedSegments,
    selection_method: "실제 ETA → 동률 시 비GTX → 최소환승",
    candidate_count: candidates.length,
    live_scored_count: scored.length,
    candidate_seed: selected.candidate.seed,
    gtx_excluded: excludeGtx,
    alternatives,
  };
}
