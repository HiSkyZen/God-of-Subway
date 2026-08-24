import { repository } from "./data-repository";
import { GTX_LINES, GTX_LINE_NAMES, isGtxLine } from "./gtx-topology";
import { canonStation, nowKst, routePair, routeTrains, STATIONS_BY_LINE } from "./timetable-service";
import { RAPID_SERVICE_LINES, supportsRapidLocalChange } from "./rapid-service";
import { DISJOINT_HOMONYM_STATIONS, isDisjointHomonymTransfer } from "./station-identity";
import {
  adjustedTransferSeconds,
  directionalTransferOverride,
  modeledMissingTransferSeconds,
  physicalTransferEntries,
  transferOverride,
  type TransferMode,
} from "./transfer-policy";
import type { Path, PathEdge, SegmentInput, TransferInfo } from "../types/domain";

const graph = () => repository.data.graph;
const transfers = () => repository.data.transfers;
export const STATION_SELECTOR_SEPARATOR = "\u001f";

const routingStationSets = new Map<string, Set<string>>(
  Object.entries(STATIONS_BY_LINE).map(([line, names]) => [line, new Set(names.map(canonStation))]),
);
for (const [line, config] of Object.entries(GTX_LINES)) {
  const stations = routingStationSets.get(line) ?? new Set<string>();
  for (const station of config.stations) stations.add(canonStation(station));
  routingStationSets.set(line, stations);
}
for (const entry of DISJOINT_HOMONYM_STATIONS) {
  for (const line of entry.lines) {
    const stations = routingStationSets.get(line) ?? new Set<string>();
    stations.add(canonStation(entry.station));
    routingStationSets.set(line, stations);
  }
}
const ROUTING_STATIONS_BY_LINE: Record<string, readonly string[]> = Object.fromEntries(
  [...routingStationSets.entries()].map(([line, stations]) => [line, [...stations]]),
);

type Node = [string, string];
interface AdjEdge { to: Node; weight: number; kind: PathEdge["kind"]; }
interface QueueEntry { d: number; order: number; node: Node; }
export interface RouteSearchOptions { excludeLines?: readonly string[]; }
interface StationSelector { station: string; line: string; }
const adjacencyCache = new Map<string, Map<string, AdjEdge[]>>();
const serviceCache = new Map<string, boolean>();
const nodeKey = (n: Node): string => `${n[0]}\u0000${n[1]}`;
const excludedSet = (options?: RouteSearchOptions): Set<string> => new Set(options?.excludeLines ?? []);
const queueLess = (a: QueueEntry, b: QueueEntry): boolean => a.d < b.d || (a.d === b.d && a.order < b.order);

class MinQueue {
  private readonly items: QueueEntry[] = [];
  get length(): number { return this.items.length; }
  push(value: QueueEntry): void {
    const items = this.items;
    items.push(value);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!queueLess(items[index], items[parent])) break;
      [items[index], items[parent]] = [items[parent], items[index]];
      index = parent;
    }
  }
  shift(): QueueEntry | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const first = items[0];
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && queueLess(items[left], items[smallest])) smallest = left;
        if (right < items.length && queueLess(items[right], items[smallest])) smallest = right;
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest], items[index]];
        index = smallest;
      }
    }
    return first;
  }
}

export function stationSelector(value: string): StationSelector {
  const raw = String(value ?? "").trim();
  const index = raw.lastIndexOf(STATION_SELECTOR_SEPARATOR);
  if (index >= 0) return { station: canonStation(raw.slice(0, index)), line: raw.slice(index + STATION_SELECTOR_SEPARATOR.length).trim() };
  const visible = raw.match(/^[^\s]+\s+(.+?)\s+·\s+(.+)$/u);
  if (visible) return { station: canonStation(visible[2]), line: visible[1].trim() };
  return { station: canonStation(raw), line: "" };
}

export function transferPairInfo(station: string, fromLine: string, toLine: string): Record<string, unknown> | null {
  if (isDisjointHomonymTransfer(station, fromLine, toLine)) return null;
  const pairs = transfers().pairs ?? {};
  const direct = pairs[`${station}|${fromLine}|${toLine}`];
  if (direct) return direct as Record<string, unknown>;
  const c = canonStation(station);
  for (const p of Object.values(pairs)) if (canonStation(p.station) === c && p.from_line === fromLine && p.to_line === toLine) return p as Record<string, unknown>;
  return null;
}

function pairBaseSeconds(station: string, fromLine: string, toLine: string, p?: Record<string, unknown> | null): number {
  const override = transferOverride(station, fromLine, toLine);
  if (override) return override.seconds;
  const direct = p?.default_seconds ?? p?.distance_seconds;
  if (typeof direct === "number" && Number.isFinite(direct)) return Math.max(0, Math.round(direct));
  const distanceM = typeof p?.distance_m === "number" ? p.distance_m : null;
  return modeledMissingTransferSeconds(distanceM, station, fromLine, toLine, stationLines(station).length);
}

export function transferSeconds(station: string, fromLine: string, toLine: string): number {
  return pairBaseSeconds(station, fromLine, toLine, transferPairInfo(station, fromLine, toLine));
}

function addEdge(adj: Map<string, AdjEdge[]>, from: Node, to: Node, weight: number, kind: PathEdge["kind"]): void {
  const key = nodeKey(from);
  const list = adj.get(key) ?? [];
  list.push({ to, weight: Math.max(0, Math.trunc(weight)), kind });
  adj.set(key, list);
}

/** Cross-line edges come from explicit transfer data or audited physical-layout policy. */
export function routeAdjacency(mode: string): Map<string, AdjEdge[]> {
  const cached = adjacencyCache.get(mode);
  if (cached) return cached;
  const adj = new Map<string, AdjEdge[]>();
  for (const raw of graph().modes?.[mode] ?? []) {
    if (!Array.isArray(raw) || raw.length < 4) continue;
    addEdge(adj, [String(raw[0]), canonStation(raw[1])], [String(raw[0]), canonStation(raw[2])], Number(raw[3]), "ride");
  }
  for (const [line, config] of Object.entries(GTX_LINES)) {
    for (let i = 0; i < config.stations.length - 1; i += 1) {
      const from = canonStation(config.stations[i]);
      const to = canonStation(config.stations[i + 1]);
      const seconds = Number(config.segmentSeconds[i] || 0);
      addEdge(adj, [line, from], [line, to], seconds, "ride");
      addEdge(adj, [line, to], [line, from], seconds, "ride");
    }
  }
  for (const p of Object.values(transfers().pairs ?? {})) {
    const station = canonStation(p.station ?? "");
    const fromLine = String(p.from_line ?? "");
    const toLine = String(p.to_line ?? "");
    if (!station || !fromLine || !toLine || fromLine === toLine) continue;
    if (isDisjointHomonymTransfer(station, fromLine, toLine)) continue;
    if (!ROUTING_STATIONS_BY_LINE[fromLine] || !ROUTING_STATIONS_BY_LINE[toLine]) continue;
    const fromExists = ROUTING_STATIONS_BY_LINE[fromLine].some((name) => canonStation(name) === station);
    const toExists = ROUTING_STATIONS_BY_LINE[toLine].some((name) => canonStation(name) === station);
    if (!fromExists || !toExists) continue;
    addEdge(adj, [fromLine, station], [toLine, station], pairBaseSeconds(station, fromLine, toLine, p as Record<string, unknown>), "transfer");
  }
  for (const { station, fromLine, toLine, policy } of physicalTransferEntries()) {
    if (isDisjointHomonymTransfer(station, fromLine, toLine)) continue;
    if (transferPairInfo(station, fromLine, toLine)) continue;
    if (!ROUTING_STATIONS_BY_LINE[fromLine] || !ROUTING_STATIONS_BY_LINE[toLine]) continue;
    const fromExists = ROUTING_STATIONS_BY_LINE[fromLine].some((name) => canonStation(name) === station);
    const toExists = ROUTING_STATIONS_BY_LINE[toLine].some((name) => canonStation(name) === station);
    if (!fromExists || !toExists) continue;
    addEdge(adj, [fromLine, station], [toLine, station], policy.seconds, "transfer");
  }
  adjacencyCache.set(mode, adj);
  return adj;
}

export function stationLines(station: string): string[] {
  const c = stationSelector(station).station;
  return Object.entries(ROUTING_STATIONS_BY_LINE)
    .filter(([, names]) => names.some((x) => canonStation(x) === c))
    .map(([line]) => line);
}

export function stationRequiresLineSelection(station: string): boolean {
  const c = canonStation(station);
  const lines = stationLines(c);
  if (DISJOINT_HOMONYM_STATIONS.some((entry) => canonStation(entry.station) === c && entry.lines.every((line) => lines.includes(line)))) return true;
  if (lines.length < 2) return false;
  const connected = new Map(lines.map((line) => [line, new Set<string>()]));
  for (const p of Object.values(transfers().pairs ?? {})) {
    if (canonStation(p.station ?? "") !== c) continue;
    const a = String(p.from_line ?? ""); const b = String(p.to_line ?? "");
    if (isDisjointHomonymTransfer(c, a, b)) continue;
    if (!connected.has(a) || !connected.has(b) || a === b) continue;
    connected.get(a)?.add(b); connected.get(b)?.add(a);
  }
  for (const entry of physicalTransferEntries()) {
    if (canonStation(entry.station) !== c) continue;
    const { fromLine: a, toLine: b } = entry;
    if (isDisjointHomonymTransfer(c, a, b)) continue;
    if (!connected.has(a) || !connected.has(b) || a === b) continue;
    connected.get(a)?.add(b); connected.get(b)?.add(a);
  }
  const visited = new Set<string>();
  const queue = [lines[0]];
  while (queue.length) {
    const line = queue.shift()!;
    if (visited.has(line)) continue;
    visited.add(line);
    for (const next of connected.get(line) ?? []) if (!visited.has(next)) queue.push(next);
  }
  return visited.size !== lines.length;
}

export function segmentHasTrain(line: string, mode: string, start: string, end: string): boolean {
  if (isGtxLine(line)) return true;
  const key = `${line}|${mode}|${canonStation(start)}|${canonStation(end)}`;
  const cached = serviceCache.get(key);
  if (cached !== undefined) return cached;
  const value = routeTrains(line, mode, start, end).length > 0;
  serviceCache.set(key, value);
  return value;
}

function eligibleLines(value: string, excluded: Set<string>): string[] {
  const selected = stationSelector(value);
  const lines = stationLines(selected.station).filter((line) => !excluded.has(line));
  if (!selected.line) return lines;
  return lines.includes(selected.line) ? [selected.line] : [];
}

function dijkstra(
  start: string,
  end: string,
  mode: string,
  sourceNode?: Node,
  bannedEdges = new Set<string>(),
  bannedNodes = new Set<string>(),
  options?: RouteSearchOptions,
): { cost: number; nodes: Node[]; edges: PathEdge[] } | null {
  const excluded = excludedSet(options);
  const startSelector = stationSelector(start);
  const endSelector = stationSelector(end);
  const source: Node = ["__SOURCE__", startSelector.station];
  const target: Node = ["__TARGET__", endSelector.station];
  const starts = eligibleLines(start, excluded).map((line) => [line, startSelector.station] as Node);
  const targets = new Set(eligibleLines(end, excluded).map((line) => nodeKey([line, endSelector.station])));
  const adj = routeAdjacency(mode);
  const src = sourceNode ?? source;
  if (src[0] !== "__SOURCE__" && excluded.has(src[0])) return null;
  const dist = new Map<string, number>([[nodeKey(src), 0]]);
  const previous = new Map<string, { node: Node; kind: PathEdge["kind"]; weight: number }>();
  const queue = new MinQueue();
  queue.push({ d: 0, order: 0, node: src });
  let order = 1;
  while (queue.length) {
    const current = queue.shift()!;
    const uKey = nodeKey(current.node);
    if (current.d !== dist.get(uKey)) continue;
    if (uKey === nodeKey(target)) {
      const nodes: Node[] = [];
      const edges: PathEdge[] = [];
      let cursor = current.node;
      while (nodeKey(cursor) !== nodeKey(src)) {
        const p = previous.get(nodeKey(cursor));
        if (!p) return null;
        nodes.push(cursor);
        edges.push({ from: p.node, to: cursor, kind: p.kind, weight: p.weight });
        cursor = p.node;
      }
      nodes.push(src); nodes.reverse(); edges.reverse();
      return { cost: current.d, nodes, edges };
    }
    if (bannedNodes.has(uKey) && uKey !== nodeKey(src)) continue;
    const baseOptions: AdjEdge[] = current.node[0] === "__SOURCE__"
      ? starts.map((n) => ({ to: n, weight: 0, kind: "start" as const }))
      : targets.has(uKey)
        ? [...(adj.get(uKey) ?? []), { to: target, weight: 0, kind: "end" as const }]
        : (adj.get(uKey) ?? []);
    for (const edge of baseOptions) {
      if (edge.to[0] !== "__TARGET__" && excluded.has(edge.to[0])) continue;
      if (current.node[0] !== "__SOURCE__" && excluded.has(current.node[0])) continue;
      const vKey = nodeKey(edge.to);
      if (bannedEdges.has(`${uKey}|${vKey}`) || (bannedNodes.has(vKey) && vKey !== nodeKey(target))) continue;
      const nd = current.d + edge.weight;
      if (nd < (dist.get(vKey) ?? Number.MAX_SAFE_INTEGER)) {
        dist.set(vKey, nd);
        previous.set(vKey, { node: current.node, kind: edge.kind, weight: edge.weight });
        queue.push({ d: nd, order: order++, node: edge.to });
      }
    }
  }
  return null;
}

function validateSelectors(start: string, end: string): { from: StationSelector; to: StationSelector } {
  const from = stationSelector(start); const to = stationSelector(end);
  if (!from.station || !to.station) throw new Error("출발역과 도착역을 입력하세요.");
  if (!stationLines(from.station).length) throw new Error(`지원 노선에서 출발역 '${from.station}'을 찾지 못했습니다.`);
  if (!stationLines(to.station).length) throw new Error(`지원 노선에서 도착역 '${to.station}'을 찾지 못했습니다.`);
  if (from.line && !stationLines(from.station).includes(from.line)) throw new Error(`출발역 '${from.station}'에서 '${from.line}'을 찾지 못했습니다.`);
  if (to.line && !stationLines(to.station).includes(to.line)) throw new Error(`도착역 '${to.station}'에서 '${to.line}'을 찾지 못했습니다.`);
  if (!from.line && stationRequiresLineSelection(from.station)) throw new Error(`'${from.station}'은 동명이의역이므로 노선 아이콘이 있는 역 후보를 선택하세요.`);
  if (!to.line && stationRequiresLineSelection(to.station)) throw new Error(`'${to.station}'은 동명이의역이므로 노선 아이콘이 있는 역 후보를 선택하세요.`);
  if (from.station === to.station && (!from.line || !to.line || from.line === to.line)) throw new Error("출발역과 도착역이 같습니다.");
  return { from, to };
}

export function autoFindPath(start: string, end: string, mode: string, options?: RouteSearchOptions): Path {
  const { from, to } = validateSelectors(start, end);
  const result = dijkstra(start, end, mode, undefined, new Set(), new Set(), options);
  if (!result) throw new Error(`${from.station} → ${to.station} 경로를 찾지 못했습니다.`);
  return { start: from.station, end: to.station, seconds: result.cost, edges: result.edges };
}

function yenPaths(start: string, end: string, mode: string, maxRaw = 36, options?: RouteSearchOptions): Array<{ cost: number; nodes: Node[]; edges: PathEdge[] }> {
  validateSelectors(start, end);
  const first = dijkstra(start, end, mode, undefined, new Set(), new Set(), options);
  if (!first) return [];
  const accepted = [first];
  const candidates: Array<{ cost: number; order: number; path: { cost: number; nodes: Node[]; edges: PathEdge[] } }> = [];
  const seen = new Set<string>(); let sequence = 0;
  while (accepted.length < maxRaw) {
    const previous = accepted[accepted.length - 1];
    for (let i = 0; i < previous.nodes.length - 1; i += 1) {
      const rootNodes = previous.nodes.slice(0, i + 1);
      const rootEdges = previous.edges.slice(0, i);
      const rootCost = rootEdges.reduce((n, x) => n + x.weight, 0);
      const removedEdges = new Set<string>();
      for (const path of accepted) {
        if (path.nodes.length > i && path.nodes.slice(0, i + 1).every((x, j) => nodeKey(x) === nodeKey(rootNodes[j])) && i < path.nodes.length - 1) removedEdges.add(`${nodeKey(path.nodes[i])}|${nodeKey(path.nodes[i + 1])}`);
      }
      const bannedNodes = new Set(rootNodes.slice(0, -1).map(nodeKey));
      const spur = dijkstra(start, end, mode, rootNodes[rootNodes.length - 1], removedEdges, bannedNodes, options);
      if (!spur) continue;
      const totalNodes = [...rootNodes.slice(0, -1), ...spur.nodes];
      const signature = totalNodes.map(nodeKey).join("|");
      if (seen.has(signature) || accepted.some((x) => x.nodes.map(nodeKey).join("|") === signature)) continue;
      seen.add(signature);
      candidates.push({ cost: rootCost + spur.cost, order: sequence++, path: { cost: rootCost + spur.cost, nodes: totalNodes, edges: [...rootEdges, ...spur.edges] } });
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => a.cost - b.cost || a.order - b.order);
    accepted.push(candidates.shift()!.path);
  }
  return accepted;
}

function serviceChangeInfo(station: string, line: string): TransferInfo {
  return { station: canonStation(station), seconds: 0, base_seconds: 0, distance_m: 0, alight_position: "", board_position: "", from_direction: "", to_direction: "", matched: "same-platform-service-change", mode: "same-platform", source: "timetable", crowding_multiplier: 1, crowding_level: "평시", predicted_load: 0, note: `${line} 완행·급행 제자리 환승 후보` };
}

function rapidSplitCandidates(segments: SegmentInput[], mode: string): SegmentInput[][] {
  const variants: SegmentInput[][] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!RAPID_SERVICE_LINES.has(segment.line) || isGtxLine(segment.line)) continue;
    const names = STATIONS_BY_LINE[segment.line] ?? [];
    let added = 0;
    for (const middleRaw of names) {
      const middle = canonStation(middleRaw);
      if (!middle || middle === canonStation(segment.from) || middle === canonStation(segment.to)) continue;
      const before = routeTrains(segment.line, mode, segment.from, middle);
      const after = routeTrains(segment.line, mode, middle, segment.to);
      if (!before.length || !after.length || !supportsRapidLocalChange(segment.line, before, after)) continue;
      const first: SegmentInput = { ...segment, to: middle, transfer_walk: 0, transfer_seconds: 0, transfer_info: serviceChangeInfo(middle, segment.line) };
      const second: SegmentInput = { ...segment, from: middle };
      const variant = [...segments.slice(0, index), first, second, ...segments.slice(index + 1)];
      variants.push(enrichTransferSegments(variant, mode));
      added += 1;
      if (added >= 4) break;
    }
  }
  return variants;
}

export function autoCandidateRoutes(start: string, end: string, mode: string, maxUnique = 8, options?: RouteSearchOptions): Array<{ path: Path; segments: SegmentInput[]; signature: string }> {
  const result: Array<{ path: Path; segments: SegmentInput[]; signature: string }> = [];
  const seen = new Set<string>();
  const baseBudget = Math.max(1, Math.min(maxUnique, Math.ceil(maxUnique * 0.65)));
  const rawBudget = Math.max(12, Math.min(24, maxUnique * 2));
  for (const raw of yenPaths(start, end, mode, rawBudget, options)) {
    const path: Path = { start: stationSelector(start).station, end: stationSelector(end).station, seconds: raw.cost, edges: raw.edges.filter((e) => e.kind !== "start" && e.kind !== "end") };
    try {
      const segments = enrichTransferSegments(autoPathToSegments(path, mode), mode);
      const signature = segments.map((s) => `${s.line}:${canonStation(s.from)}:${canonStation(s.to)}`).join("|");
      if (seen.has(signature)) continue;
      seen.add(signature); result.push({ path, segments, signature });
      if (result.length >= baseBudget) break;
    } catch { /* topology cannot be covered by one or more timetable services */ }
  }
  if (!result.length) {
    const path = autoFindPath(start, end, mode, options);
    const segments = enrichTransferSegments(autoPathToSegments(path, mode), mode);
    const signature = segments.map((s) => `${s.line}:${s.from}:${s.to}`).join("|");
    result.push({ path, segments, signature }); seen.add(signature);
  }
  for (const base of [...result]) {
    for (const segments of rapidSplitCandidates(base.segments, mode)) {
      const signature = segments.map((s) => `${s.line}:${canonStation(s.from)}:${canonStation(s.to)}`).join("|");
      if (seen.has(signature)) continue;
      seen.add(signature); result.push({ path: base.path, segments, signature });
      if (result.length >= maxUnique) return result;
    }
  }
  return result.slice(0, maxUnique);
}

export function autoPathToSegments(path: Path, mode: string): SegmentInput[] {
  const segments: SegmentInput[] = [];
  let current: SegmentInput | null = null;
  const finish = (walk?: number): void => { if (!current) return; if (walk !== undefined) current.transfer_walk = walk; segments.push(current); current = null; };
  for (const edge of path.edges) {
    if (edge.kind === "transfer") { finish(edge.weight / 60); continue; }
    if (edge.kind !== "ride") continue;
    const line = edge.from[0]; const from = edge.from[1]; const to = edge.to[1];
    if (!current) { current = { line, from, to, transfer_walk: 0 }; continue; }
    if (current.line === line) {
      if (segmentHasTrain(line, mode, current.from, to)) current.to = to;
      else { finish(0); current = { line, from, to, transfer_walk: 0 }; }
    } else {
      finish(transferSeconds(from, current.line, line) / 60); current = { line, from, to, transfer_walk: 0 };
    }
  }
  finish(0);
  if (!segments.length) throw new Error("자동 경로를 구간으로 변환하지 못했습니다.");
  if (segments.length > 8) throw new Error(`자동 경로가 ${segments.length}개 구간이라 현재 최대 8구간 제한을 초과합니다.`);
  return segments;
}

function directionStation(line: string, mode: string, start: string, end: string): string {
  if (isGtxLine(line)) return "";
  const from = canonStation(start); const to = canonStation(end);
  for (const train of routeTrains(line, mode, from, to)) {
    const pair = routePair(train.stops, from, to); if (!pair) continue;
    for (let i = pair[1] + 1; i < train.stops.length; i += 1) { const station = canonStation(train.stops[i].station); if (station && station !== to) return station; }
  }
  return "";
}

function outgoingDirectionStation(line: string, mode: string, start: string, end: string): string {
  if (isGtxLine(line)) return "";
  const from = canonStation(start); const to = canonStation(end);
  for (const train of routeTrains(line, mode, from, to)) {
    const pair = routePair(train.stops, from, to); if (!pair) continue;
    for (let i = pair[0] + 1; i < train.stops.length; i += 1) { const station = canonStation(train.stops[i].station); if (station && station !== from) return station; }
  }
  return "";
}

export function bestTransferDetail(station: string, from: SegmentInput, to: SegmentInput, mode: string, at = nowKst()): TransferInfo {
  if (from.line === to.line && !transferPairInfo(station, from.line, to.line)) return serviceChangeInfo(station, from.line);
  const p = transferPairInfo(station, from.line, to.line);
  const incoming = directionStation(from.line, mode, from.from, from.to);
  const outgoing = outgoingDirectionStation(to.line, mode, to.from, to.to);
  const override = directionalTransferOverride(station, from.line, to.line, incoming, outgoing);
  const records = Array.isArray(p?.records) ? p.records.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null) : [];
  const canonDirection = (value: unknown): string => canonStation(String(value ?? "").replace(" 방면", "").trim());
  const both = records.filter((record) => canonDirection(record.from_direction) === canonStation(incoming) && canonDirection(record.to_direction) === canonStation(outgoing));
  const oneOutgoing = records.filter((record) => canonDirection(record.to_direction) === canonStation(outgoing));
  const oneIncoming = records.filter((record) => canonDirection(record.from_direction) === canonStation(incoming));
  const chosen = (both.length ? both : oneOutgoing.length ? oneOutgoing : oneIncoming.length ? oneIncoming : records)[0] ?? {};
  const matched = override ? "physical-layout-override" : both.length ? "direction" : oneOutgoing.length ? "outgoing" : oneIncoming.length ? "incoming" : p ? "pair" : "modeled";
  const rawChosen = chosen.seconds;
  const baseSeconds = override?.seconds ?? (typeof rawChosen === "number" && Number.isFinite(rawChosen) ? rawChosen : pairBaseSeconds(station, from.line, to.line, p));
  const transferMode: TransferMode = override?.mode ?? (baseSeconds === 0 ? "same-platform" : p ? "passage" : "estimated");
  const adjusted = adjustedTransferSeconds(baseSeconds, station, at, stationLines(station).length, transferMode);
  const pos = (car: unknown, door: unknown): string => { const c = String(car ?? "").trim(); const d = String(door ?? "").trim(); return c && d ? `${c}-${d}` : c || d; };
  return {
    station: canonStation(station), seconds: adjusted.seconds, base_seconds: Math.round(baseSeconds),
    distance_m: typeof p?.distance_m === "number" ? p.distance_m : null,
    alight_position: pos(chosen.alight_car, chosen.alight_door), board_position: pos(chosen.board_car, chosen.board_door),
    from_direction: String(chosen.from_direction || incoming), to_direction: String(chosen.to_direction || outgoing), matched,
    mode: transferMode, source: override?.source ?? (p ? "upstream" : "model"), note: override?.note ?? "",
    crowding_multiplier: adjusted.load.multiplier, crowding_level: adjusted.load.label, predicted_load: adjusted.load.predictedLoad,
  };
}

export function enrichTransferSegments(segments: SegmentInput[], mode: string): SegmentInput[] {
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (canonStation(segments[i].to) !== canonStation(segments[i + 1].from)) continue;
    const existing = segments[i].transfer_info;
    const info = existing?.matched === "same-platform-service-change" ? existing : bestTransferDetail(segments[i].to, segments[i], segments[i + 1], mode);
    segments[i].transfer_info = info; segments[i].transfer_seconds = info.seconds; segments[i].transfer_walk = Math.round(info.seconds / 60 * 1000) / 1000;
  }
  if (segments.length) {
    const last = segments[segments.length - 1]; last.transfer_seconds = 0; last.transfer_walk = 0; last.transfer_info = null;
  }
  return segments;
}

export function candidateInterchanges(segments: SegmentInput[]): string[] {
  return segments.slice(0, -1).filter((x, i) => canonStation(x.to) === canonStation(segments[i + 1].from)).map((x) => x.to);
}

export function routeConfidence(result: { segments?: Array<{ confidence?: string }> } | null): string {
  const rank: Record<string, number> = { 높음: 3, 중간: 2, 낮음: 1 };
  if (!result?.segments?.length) return "낮음";
  return result.segments.reduce((best, s) => (rank[s.confidence ?? "낮음"] ?? 0) < (rank[best] ?? 0) ? (s.confidence ?? "낮음") : best, "높음");
}

export { GTX_LINE_NAMES };
