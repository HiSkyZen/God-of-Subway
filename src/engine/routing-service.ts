import { repository } from "./data-repository";
import { canonStation, routePair, routeTrains, STATIONS_BY_LINE } from "./timetable-service";
import type { Path, PathEdge, SegmentInput, TransferInfo } from "../types/domain";

const graph = () => repository.data.graph;
const transfers = () => repository.data.transfers;
const transferExclude = (): Set<string> => new Set((graph().meta?.excluded_same_name_transfers as string[] | undefined) ?? []);
export const DEFAULT_TRANSFER_SECONDS = Number(graph().meta?.default_transfer_seconds ?? 240);

type Node = [string, string];
interface AdjEdge { to: Node; weight: number; kind: PathEdge["kind"]; }
const adjacencyCache = new Map<string, Map<string, AdjEdge[]>>();
const serviceCache = new Map<string, boolean>();
const nodeKey = (n: Node): string => `${n[0]}\u0000${n[1]}`;
const parseNode = (key: string): Node => { const i = key.indexOf("\u0000"); return [key.slice(0, i), key.slice(i + 1)]; };

export function transferPairInfo(station: string, fromLine: string, toLine: string): Record<string, unknown> | null {
  const pairs = transfers().pairs ?? {};
  const direct = pairs[`${station}|${fromLine}|${toLine}`]; if (direct) return direct as Record<string, unknown>;
  const c = canonStation(station); for (const p of Object.values(pairs)) if (canonStation(p.station) === c && p.from_line === fromLine && p.to_line === toLine) return p as Record<string, unknown>;
  return null;
}
export function transferSeconds(station: string, fromLine: string, toLine: string): number { const p = transferPairInfo(station, fromLine, toLine); return p ? Number(p.default_seconds ?? p.distance_seconds ?? DEFAULT_TRANSFER_SECONDS) : DEFAULT_TRANSFER_SECONDS; }

function addEdge(adj: Map<string, AdjEdge[]>, from: Node, to: Node, weight: number, kind: PathEdge["kind"]): void { const key = nodeKey(from); const list = adj.get(key) ?? []; list.push({ to, weight: Math.trunc(weight), kind }); adj.set(key, list); }
export function routeAdjacency(mode: string): Map<string, AdjEdge[]> {
  const cached = adjacencyCache.get(mode); if (cached) return cached; const adj = new Map<string, AdjEdge[]>();
  for (const raw of graph().modes?.[mode] ?? []) { if (!Array.isArray(raw) || raw.length < 4) continue; addEdge(adj, [String(raw[0]), canonStation(raw[1])], [String(raw[0]), canonStation(raw[2])], Number(raw[3]), "ride"); }
  const stationLines = new Map<string, string[]>(); for (const [line, names] of Object.entries(STATIONS_BY_LINE)) for (const st of names) { const c = canonStation(st); const lines = stationLines.get(c) ?? []; if (!lines.includes(line)) lines.push(line); stationLines.set(c, lines); }
  for (const [station, lines] of stationLines) { if (transferExclude().has(station) || lines.length < 2) continue; for (const a of lines) for (const b of lines) if (a !== b) addEdge(adj, [a, station], [b, station], transferSeconds(station, a, b), "transfer"); }
  adjacencyCache.set(mode, adj); return adj;
}

export function stationLines(station: string): string[] { const c = canonStation(station); return Object.entries(STATIONS_BY_LINE).filter(([, names]) => names.some((x) => canonStation(x) === c)).map(([line]) => line); }
export function segmentHasTrain(line: string, mode: string, start: string, end: string): boolean { const key = `${line}|${mode}|${canonStation(start)}|${canonStation(end)}`; const c = serviceCache.get(key); if (c !== undefined) return c; const value = routeTrains(line, mode, start, end).length > 0; serviceCache.set(key, value); return value; }

function dijkstra(start: string, end: string, mode: string, sourceNode?: Node, bannedEdges = new Set<string>(), bannedNodes = new Set<string>()): { cost: number; nodes: Node[]; edges: PathEdge[] } | null {
  const source: Node = ["__SOURCE__", canonStation(start)]; const target: Node = ["__TARGET__", canonStation(end)]; const starts = stationLines(start).map((line) => [line, canonStation(start)] as Node); const targets = new Set(stationLines(end).map((line) => nodeKey([line, canonStation(end)]))); const adj = routeAdjacency(mode); const src = sourceNode ?? source;
  const dist = new Map<string, number>([[nodeKey(src), 0]]); const previous = new Map<string, { node: Node; kind: PathEdge["kind"]; weight: number }>(); const queue: Array<{ d: number; order: number; node: Node }> = [{ d: 0, order: 0, node: src }]; let order = 1;
  const push = (entry: { d: number; order: number; node: Node }): void => { queue.push(entry); queue.sort((a, b) => a.d - b.d || a.order - b.order); };
  while (queue.length) { const current = queue.shift() as { d: number; order: number; node: Node }; const uKey = nodeKey(current.node); if (current.d !== dist.get(uKey)) continue; if (uKey === nodeKey(target)) { const nodes: Node[] = []; const edges: PathEdge[] = []; let cursor = current.node; while (nodeKey(cursor) !== nodeKey(src)) { const p = previous.get(nodeKey(cursor)); if (!p) return null; nodes.push(cursor); edges.push({ from: p.node, to: cursor, kind: p.kind, weight: p.weight }); cursor = p.node; } nodes.push(src); nodes.reverse(); edges.reverse(); return { cost: current.d, nodes, edges }; }
    if (bannedNodes.has(uKey) && uKey !== nodeKey(src)) continue;
    const options: AdjEdge[] = current.node[0] === "__SOURCE__" ? starts.map((n) => ({ to: n, weight: 0, kind: "start" as const })) : targets.has(uKey) ? [...(adj.get(uKey) ?? []), { to: target, weight: 0, kind: "end" as const }] : (adj.get(uKey) ?? []);
    for (const edge of options) { const vKey = nodeKey(edge.to); if (bannedEdges.has(`${uKey}|${vKey}`) || (bannedNodes.has(vKey) && vKey !== nodeKey(target))) continue; const nd = current.d + edge.weight; if (nd < (dist.get(vKey) ?? Number.MAX_SAFE_INTEGER)) { dist.set(vKey, nd); previous.set(vKey, { node: current.node, kind: edge.kind, weight: edge.weight }); push({ d: nd, order: order++, node: edge.to }); } }
  }
  return null;
}

export function autoFindPath(start: string, end: string, mode: string): Path {
  const from = canonStation(start); const to = canonStation(end); if (!from || !to) throw new Error("출발역과 도착역을 입력하세요."); if (from === to) throw new Error("출발역과 도착역이 같습니다."); if (!stationLines(from).length) throw new Error(`지원 노선에서 출발역 '${from}'을 찾지 못했습니다.`); if (!stationLines(to).length) throw new Error(`지원 노선에서 도착역 '${to}'을 찾지 못했습니다.`); const result = dijkstra(from, to, mode); if (!result) throw new Error(`${from} → ${to} 경로를 찾지 못했습니다.`); return { start: from, end: to, seconds: result.cost, edges: result.edges };
}

function yenPaths(start: string, end: string, mode: string, maxRaw = 36): Array<{ cost: number; nodes: Node[]; edges: PathEdge[] }> {
  const first = dijkstra(start, end, mode); if (!first) return []; const accepted = [first]; const candidates: Array<{ cost: number; order: number; path: { cost: number; nodes: Node[]; edges: PathEdge[] } }> = []; const seen = new Set<string>(); let sequence = 0;
  while (accepted.length < maxRaw) { const previous = accepted[accepted.length - 1]; for (let i = 0; i < previous.nodes.length - 1; i += 1) { const rootNodes = previous.nodes.slice(0, i + 1); const rootEdges = previous.edges.slice(0, i); const rootCost = rootEdges.reduce((n, x) => n + x.weight, 0); const removedEdges = new Set<string>(); for (const path of accepted) if (path.nodes.length > i && path.nodes.slice(0, i + 1).every((x, j) => nodeKey(x) === nodeKey(rootNodes[j]))) if (i < path.nodes.length - 1) removedEdges.add(`${nodeKey(path.nodes[i])}|${nodeKey(path.nodes[i + 1])}`); const bannedNodes = new Set(rootNodes.slice(0, -1).map(nodeKey)); const spur = dijkstra(start, end, mode, rootNodes[rootNodes.length - 1], removedEdges, bannedNodes); if (!spur) continue; const totalNodes = [...rootNodes.slice(0, -1), ...spur.nodes]; const signature = totalNodes.map(nodeKey).join("|"); if (seen.has(signature) || accepted.some((x) => x.nodes.map(nodeKey).join("|") === signature)) continue; seen.add(signature); candidates.push({ cost: rootCost + spur.cost, order: sequence++, path: { cost: rootCost + spur.cost, nodes: totalNodes, edges: [...rootEdges, ...spur.edges] } }); }
    if (!candidates.length) break; candidates.sort((a, b) => a.cost - b.cost || a.order - b.order); accepted.push(candidates.shift()!.path); }
  return accepted;
}

export function autoCandidateRoutes(start: string, end: string, mode: string, maxUnique = 8): Array<{ path: Path; segments: SegmentInput[]; signature: string }> {
  const result: Array<{ path: Path; segments: SegmentInput[]; signature: string }> = []; const seen = new Set<string>();
  for (const raw of yenPaths(start, end, mode)) { const path: Path = { start: canonStation(start), end: canonStation(end), seconds: raw.cost, edges: raw.edges.filter((e) => e.kind !== "start" && e.kind !== "end") }; try { const segments = enrichTransferSegments(autoPathToSegments(path, mode), mode); const signature = segments.map((s) => `${s.line}:${canonStation(s.from)}:${canonStation(s.to)}`).join("|"); if (seen.has(signature)) continue; seen.add(signature); result.push({ path, segments, signature }); if (result.length >= maxUnique) break; } catch { /* Skip topology that cannot be covered by a timetable. */ } }
  if (!result.length) { const path = autoFindPath(start, end, mode); const segments = enrichTransferSegments(autoPathToSegments(path, mode), mode); result.push({ path, segments, signature: segments.map((s) => `${s.line}:${s.from}:${s.to}`).join("|") }); }
  return result;
}

export function autoPathToSegments(path: Path, mode: string): SegmentInput[] {
  const segments: SegmentInput[] = []; let current: SegmentInput | null = null; const finish = (walk?: number): void => { if (!current) return; if (walk !== undefined) current.transfer_walk = walk; segments.push(current); current = null; };
  for (const edge of path.edges) { if (edge.kind === "transfer") { finish(edge.weight / 60); continue; } if (edge.kind !== "ride") continue; const line = edge.from[0]; const from = edge.from[1]; const to = edge.to[1]; if (!current) { current = { line, from, to, transfer_walk: 0 }; continue; } if (current.line === line) { if (segmentHasTrain(line, mode, current.from, to)) current.to = to; else { finish(1); current = { line, from, to, transfer_walk: 0 }; } } else { finish(DEFAULT_TRANSFER_SECONDS / 60); current = { line, from, to, transfer_walk: 0 }; } }
  finish(0); if (!segments.length) throw new Error("자동 경로를 구간으로 변환하지 못했습니다."); if (segments.length > 8) throw new Error(`자동 경로가 ${segments.length}개 구간이라 현재 최대 8구간 제한을 초과합니다.`); return segments;
}

function directionStation(line: string, mode: string, start: string, end: string): string {
  const from = canonStation(start); const to = canonStation(end);
  for (const train of routeTrains(line, mode, from, to)) {
    const pair = routePair(train.stops, from, to); if (!pair) continue;
    for (let i = pair[1] + 1; i < train.stops.length; i += 1) {
      const station = canonStation(train.stops[i].station); if (station && station !== to) return station;
    }
  }
  return "";
}

function outgoingDirectionStation(line: string, mode: string, start: string, end: string): string {
  const from = canonStation(start); const to = canonStation(end);
  for (const train of routeTrains(line, mode, from, to)) {
    const pair = routePair(train.stops, from, to); if (!pair) continue;
    for (let i = pair[0] + 1; i < train.stops.length; i += 1) {
      const station = canonStation(train.stops[i].station); if (station && station !== from) return station;
    }
  }
  return "";
}

export function bestTransferDetail(station: string, from: SegmentInput, to: SegmentInput, mode: string): TransferInfo {
  const p = transferPairInfo(station, from.line, to.line); if (!p) return { station: canonStation(station), seconds: DEFAULT_TRANSFER_SECONDS, distance_m: null, alight_position: "", board_position: "", from_direction: "", to_direction: "", matched: "fallback" };
  const incoming = directionStation(from.line, mode, from.from, from.to);
  const outgoing = outgoingDirectionStation(to.line, mode, to.from, to.to);
  const records = Array.isArray(p.records) ? p.records.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null) : [];
  const canonDirection = (value: unknown): string => canonStation(String(value ?? "").replace(" 방면", "").trim());
  const both = records.filter((record) => canonDirection(record.from_direction) === canonStation(incoming) && canonDirection(record.to_direction) === canonStation(outgoing));
  const oneOutgoing = records.filter((record) => canonDirection(record.to_direction) === canonStation(outgoing));
  const oneIncoming = records.filter((record) => canonDirection(record.from_direction) === canonStation(incoming));
  const chosen = (both.length ? both : oneOutgoing.length ? oneOutgoing : oneIncoming.length ? oneIncoming : records)[0] ?? {};
  const matched = both.length ? "direction" : oneOutgoing.length ? "outgoing" : oneIncoming.length ? "incoming" : "pair";
  const seconds = Number(chosen.seconds || p.default_seconds || DEFAULT_TRANSFER_SECONDS);
  const pos = (car: unknown, door: unknown): string => { const c = String(car ?? "").trim(); const d = String(door ?? "").trim(); return c && d ? `${c}-${d}` : c || d; };
  return {
    station: canonStation(station), seconds,
    distance_m: typeof p.distance_m === "number" ? p.distance_m : null,
    alight_position: pos(chosen.alight_car, chosen.alight_door), board_position: pos(chosen.board_car, chosen.board_door),
    from_direction: String(chosen.from_direction || incoming), to_direction: String(chosen.to_direction || outgoing), matched,
  };
}
export function enrichTransferSegments(segments: SegmentInput[], mode: string): SegmentInput[] { for (let i = 0; i < segments.length - 1; i += 1) { if (canonStation(segments[i].to) !== canonStation(segments[i + 1].from)) continue; const info = bestTransferDetail(segments[i].to, segments[i], segments[i + 1], mode); segments[i].transfer_info = info; segments[i].transfer_seconds = info.seconds; segments[i].transfer_walk = Math.round(info.seconds / 60 * 1000) / 1000; } if (segments.length) { const last = segments[segments.length - 1]; last.transfer_seconds = 0; last.transfer_walk = 0; last.transfer_info = null; } return segments; }

export function candidateInterchanges(segments: SegmentInput[]): string[] { return segments.slice(0, -1).filter((x, i) => canonStation(x.to) === canonStation(segments[i + 1].from)).map((x) => x.to); }
export function routeConfidence(result: { segments?: Array<{ confidence?: string }> } | null): string { const rank: Record<string, number> = { 높음: 3, 중간: 2, 낮음: 1 }; if (!result?.segments?.length) return "낮음"; return result.segments.reduce((best, s) => (rank[s.confidence ?? "낮음"] ?? 0) < (rank[best] ?? 0) ? (s.confidence ?? "낮음") : best, "높음"); }
