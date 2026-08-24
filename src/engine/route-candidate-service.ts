import { repository } from "./data-repository";
import {
  autoCandidateRoutes,
  autoFindPath,
  autoPathToSegments,
  enrichTransferSegments,
  stationLines,
  stationSelector,
  STATION_SELECTOR_SEPARATOR,
  transferSeconds,
  type RouteSearchOptions,
} from "./routing-service";
import { SHARED_TRACK_INTERCHANGES } from "./transfer-policy";
import { canonStation } from "./timetable-service";
import type { Path, PathEdge, SegmentInput } from "../types/domain";

export interface RouteCandidate {
  path: Path;
  segments: SegmentInput[];
  signature: string;
  seed: "time" | "fewest-transfers" | "shared-interchange";
}

type Node = [string, string];
interface AdjEdge { to: Node; seconds: number; transfer: number; kind: PathEdge["kind"]; }
interface QueueEntry { node: Node; transfers: number; seconds: number; order: number; }

const nodeKey = (node: Node): string => `${node[0]}\u0000${canonStation(node[1])}`;
const selector = (station: string, line: string): string => `${canonStation(station)}${STATION_SELECTOR_SEPARATOR}${line}`;
const signatureOf = (segments: readonly SegmentInput[]): string => segments
  .map((segment) => `${segment.line}:${canonStation(segment.from)}:${canonStation(segment.to)}`)
  .join("|");

function hasPingPong(segments: readonly SegmentInput[]): boolean {
  const lines = segments.map((segment) => String(segment.line));
  for (let index = 0; index + 2 < lines.length; index += 1) {
    if (lines[index] === lines[index + 2] && lines[index] !== lines[index + 1]) return true;
  }
  return false;
}

function adjacency(mode: string, excluded: ReadonlySet<string>): Map<string, AdjEdge[]> {
  const result = new Map<string, AdjEdge[]>();
  const add = (from: Node, edge: AdjEdge): void => {
    if (excluded.has(from[0]) || excluded.has(edge.to[0])) return;
    const key = nodeKey(from);
    result.set(key, [...(result.get(key) ?? []), edge]);
  };
  const edges = (repository.data.graph.modes?.[mode] ?? []) as unknown[];
  for (const raw of edges) {
    if (!Array.isArray(raw) || raw.length < 4) continue;
    const line = String(raw[0]); const from = canonStation(raw[1]); const to = canonStation(raw[2]);
    const seconds = Number(raw[3]);
    if (!line || !from || !to || !Number.isFinite(seconds) || seconds < 0) continue;
    add([line, from], { to: [line, to], seconds, transfer: 0, kind: "ride" });
  }
  for (const pair of Object.values(repository.data.transfers.pairs ?? {})) {
    const station = canonStation(pair.station); const fromLine = String(pair.from_line ?? ""); const toLine = String(pair.to_line ?? "");
    if (!station || !fromLine || !toLine || fromLine === toLine) continue;
    add([fromLine, station], {
      to: [toLine, station],
      seconds: transferSeconds(station, fromLine, toLine),
      transfer: 1,
      kind: "transfer",
    });
  }
  return result;
}

function less(a: QueueEntry, b: QueueEntry): boolean {
  return a.transfers < b.transfers
    || (a.transfers === b.transfers && (a.seconds < b.seconds || (a.seconds === b.seconds && a.order < b.order)));
}

function fewestTransferPath(start: string, end: string, mode: string, options?: RouteSearchOptions): Path | null {
  const from = stationSelector(start); const to = stationSelector(end);
  const excluded = new Set(options?.excludeLines ?? []);
  const starts = (from.line ? [from.line] : stationLines(from.station)).filter((line) => !excluded.has(line));
  const targets = new Set((to.line ? [to.line] : stationLines(to.station)).filter((line) => !excluded.has(line)).map((line) => nodeKey([line, to.station])));
  if (!starts.length || !targets.size) return null;
  const adj = adjacency(mode, excluded);
  const queue: QueueEntry[] = [];
  const best = new Map<string, [number, number]>();
  const previous = new Map<string, { node: Node; edge: AdjEdge }>();
  let order = 0;
  for (const line of starts) {
    const node: Node = [line, from.station]; const key = nodeKey(node);
    best.set(key, [0, 0]); queue.push({ node, transfers: 0, seconds: 0, order: order++ });
  }
  while (queue.length) {
    queue.sort((a, b) => less(a, b) ? -1 : less(b, a) ? 1 : 0);
    const current = queue.shift()!; const key = nodeKey(current.node); const known = best.get(key);
    if (!known || known[0] !== current.transfers || known[1] !== current.seconds) continue;
    if (targets.has(key)) {
      const edges: PathEdge[] = []; let cursor = current.node;
      while (previous.has(nodeKey(cursor))) {
        const item = previous.get(nodeKey(cursor))!;
        edges.push({ from: item.node, to: cursor, kind: item.edge.kind, weight: item.edge.seconds }); cursor = item.node;
      }
      edges.reverse();
      return { start: from.station, end: to.station, seconds: current.seconds, edges };
    }
    for (const edge of adj.get(key) ?? []) {
      const transfers = current.transfers + edge.transfer; const seconds = current.seconds + edge.seconds;
      const nextKey = nodeKey(edge.to); const old = best.get(nextKey);
      if (old && (old[0] < transfers || (old[0] === transfers && old[1] <= seconds))) continue;
      best.set(nextKey, [transfers, seconds]); previous.set(nextKey, { node: current.node, edge });
      queue.push({ node: edge.to, transfers, seconds, order: order++ });
    }
  }
  return null;
}

function sharedInterchangeCandidates(start: string, end: string, mode: string, options?: RouteSearchOptions): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  for (const exchange of SHARED_TRACK_INTERCHANGES) {
    for (const [fromLine, toLine] of [[exchange.fromLine, exchange.toLine], [exchange.toLine, exchange.fromLine]] as const) {
      if (options?.excludeLines?.includes(fromLine) || options?.excludeLines?.includes(toLine)) continue;
      try {
        const left = autoFindPath(start, selector(exchange.station, fromLine), mode, options);
        const right = autoFindPath(selector(exchange.station, toLine), end, mode, options);
        const leftSegments = enrichTransferSegments(autoPathToSegments(left, mode), mode);
        const rightSegments = enrichTransferSegments(autoPathToSegments(right, mode), mode);
        const segments = enrichTransferSegments([...leftSegments, ...rightSegments], mode);
        if (!segments.length || hasPingPong(segments)) continue;
        const transfer = transferSeconds(exchange.station, fromLine, toLine);
        const path: Path = {
          start: stationSelector(start).station,
          end: stationSelector(end).station,
          seconds: left.seconds + transfer + right.seconds,
          edges: [...left.edges, { from: [fromLine, canonStation(exchange.station)], to: [toLine, canonStation(exchange.station)], kind: "transfer", weight: transfer }, ...right.edges],
        };
        candidates.push({ path, segments, signature: signatureOf(segments), seed: "shared-interchange" });
      } catch {
        // This interchange is not reachable for this endpoint/direction pair.
      }
    }
  }
  return candidates;
}

export function expandedAutoCandidates(start: string, end: string, mode: string, maxUnique = 24, options?: RouteSearchOptions): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: RouteCandidate): void => {
    if (!candidate.segments.length || candidate.segments.length > 8 || hasPingPong(candidate.segments) || seen.has(candidate.signature)) return;
    seen.add(candidate.signature); candidates.push(candidate);
  };
  for (const candidate of autoCandidateRoutes(start, end, mode, 12, options)) add({ ...candidate, seed: "time" });
  const fewest = fewestTransferPath(start, end, mode, options);
  if (fewest) {
    try {
      const segments = enrichTransferSegments(autoPathToSegments(fewest, mode), mode);
      add({ path: fewest, segments, signature: signatureOf(segments), seed: "fewest-transfers" });
    } catch { }
  }
  for (const candidate of sharedInterchangeCandidates(start, end, mode, options)) add(candidate);
  return candidates.slice(0, maxUnique);
}
