import { Database } from "bun:sqlite";
import { repository, transitDbPath } from "./data-repository";
import { canonStation } from "./timetable-service";
import { isDisjointHomonymTransfer } from "./station-identity";
import { cacheGetJson, cacheSetJson } from "../infra/cache";
import type { FetchLike } from "./realtime-service";
import { unorderedTransferPairCount } from "../infra/transfer-pairs";

const KRIC_BASE = (Bun.env.KRIC_API_BASE_URL?.trim() || "https://openapi.kric.go.kr/openapi")
  .replace(/\/$/, "");
const TRANSFER_SPEED_MPS = 1.2;
const FRESH_SECONDS = 30 * 24 * 3600;
const STALE_SECONDS = 90 * 24 * 3600;
const NEGATIVE_CACHE_SECONDS = 3600;
const HTTP_TIMEOUT_MS = Math.max(
  1000,
  Math.min(8000, Number(Bun.env.KRIC_RUNTIME_TIMEOUT_MS ?? 3500) || 3500),
);
const RUNTIME_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number(Bun.env.KRIC_RUNTIME_TRANSFER_CONCURRENCY ?? 4) || 4),
);

type PairCandidate = {
  stationId: number;
  station: string;
  fromLine: string;
  toLine: string;
};

type SourceCandidate = {
  logical_line: string;
  operator_code: string;
  line_code: string;
  source_line_name: string;
  station_code: string;
  priority: number;
};

type KricPairValue = {
  distanceM: number | null;
  seconds: number | null;
  source: "kric-runtime-1.2mps" | "unavailable";
};

const inFlight = new Map<string, Promise<KricPairValue>>();
const stats = {
  requests: 0,
  cacheHit: 0,
  cacheMiss: 0,
  enrichedPairs: 0,
  unavailable: 0,
  errors: 0,
};

function canonicalPairKey(stationId: number, a: string, b: string): string {
  const [first, second] = [a, b].sort();
  return `kric-transfer:${stationId}:${first}:${second}`;
}

function collectRows(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) collectRows(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  const row = value as Record<string, unknown>;
  if (row.chtnDst !== undefined || row.chtnLn !== undefined) out.push(row);
  for (const child of Object.values(row)) {
    if (child && typeof child === "object") collectRows(child, out);
  }
  return out;
}

function compact(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, "").replace(/호선$/u, "");
}

function normalizeLine(value: unknown): string {
  const raw = compact(value);
  if (/^[1-9]$/.test(raw)) return `${raw}호선`;
  const aliases: Record<string, string> = {
    경의중앙: "경의중앙선",
    수인분당: "수인분당선",
    경춘: "경춘선",
    경강: "경강선",
    서해: "서해선",
    공항: "공항철도",
    공항철도: "공항철도",
    신분당: "신분당선",
    인천1: "인천1호선",
    인천2: "인천2호선",
    에버라인: "용인에버라인",
    용인에버라인: "용인에버라인",
    의정부: "의정부경전철",
    우이신설: "우이신설선",
    신림: "신림선",
    김포골드: "김포골드라인",
    김포골드라인: "김포골드라인",
    "GTX-A": "GTX-A",
    GTXΑ: "GTX-A",
  };
  return aliases[raw] ?? String(value ?? "").trim();
}

function distanceFromRow(
  row: Record<string, unknown>,
  targetLine: string,
  targetAliases: Set<string>,
): number | null {
  const rawLine = row.chtnLn ?? row.transferLine ?? row.toLine;
  const normalized = normalizeLine(rawLine);
  const rawCompact = compact(rawLine);
  const matches = normalized === targetLine
    || targetAliases.has(rawCompact)
    || targetAliases.has(compact(normalized));
  if (!matches) return null;
  const distance = Number(String(row.chtnDst ?? row.transferDistance ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(distance) && distance > 0 ? distance : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function db(): Database {
  return new Database(transitDbPath(), { readonly: true, strict: true });
}

function pendingPair(station: string, fromLine: string, toLine: string): PairCandidate | null {
  if (isDisjointHomonymTransfer(station, fromLine, toLine)) return null;
  const handle = db();
  try {
    const row = handle.query(`
      SELECT p.station_id, s.canonical_name AS station,
             p.from_line, p.to_line, p.source
      FROM transfer_pair p
      JOIN station s ON s.station_id=p.station_id
      WHERE s.canonical_name=?
        AND (
          (p.from_line=? AND p.to_line=?)
          OR (p.from_line=? AND p.to_line=?)
        )
      ORDER BY CASE WHEN p.source='runtime-kric-pending' THEN 0 ELSE 1 END
      LIMIT 1
    `).get(
      canonStation(station),
      fromLine,
      toLine,
      toLine,
      fromLine,
    ) as {
      station_id: number;
      station: string;
      from_line: string;
      to_line: string;
      source: string;
    } | null;
    if (!row) return null;

    const pending = handle.query(`
      SELECT COUNT(*) AS n
      FROM transfer_pair
      WHERE station_id=?
        AND source='runtime-kric-pending'
        AND (
          (from_line=? AND to_line=?)
          OR (from_line=? AND to_line=?)
        )
    `).get(
      row.station_id,
      fromLine,
      toLine,
      toLine,
      fromLine,
    ) as { n: number };
    if (!Number(pending.n)) return null;

    return {
      stationId: Number(row.station_id),
      station: canonStation(row.station),
      fromLine,
      toLine,
    };
  } finally {
    handle.close();
  }
}

function sourcesForPair(candidate: PairCandidate): SourceCandidate[] {
  const handle = db();
  try {
    return handle.query(`
      SELECT sr.logical_line, sr.operator_code, sr.line_code,
             sr.source_line_name, ss.station_code, sr.priority
      FROM station_source ss
      JOIN source_registry sr ON sr.source_id=ss.source_id
      WHERE ss.station_id=?
        AND sr.logical_line IN (?,?)
      ORDER BY
        CASE sr.logical_line WHEN ? THEN 0 ELSE 1 END,
        sr.priority DESC,
        sr.source_id
    `).all(
      candidate.stationId,
      candidate.fromLine,
      candidate.toLine,
      candidate.fromLine,
    ) as SourceCandidate[];
  } finally {
    handle.close();
  }
}

function aliasesForTarget(sources: SourceCandidate[], targetLine: string): Set<string> {
  const aliases = new Set<string>([compact(targetLine)]);
  for (const source of sources) {
    if (source.logical_line !== targetLine) continue;
    aliases.add(compact(source.logical_line));
    aliases.add(compact(source.source_line_name));
    aliases.add(compact(source.line_code));
  }
  return aliases;
}

async function fetchStationTransferRows(
  source: SourceCandidate,
  fetchImpl: FetchLike,
): Promise<Array<Record<string, unknown>>> {
  const key = Bun.env.KRIC_API_KEY?.trim() ?? "";
  if (!key) return [];

  const url = new URL(`${KRIC_BASE}/convenientInfo/stationTransferInfo`);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("railOprIsttCd", source.operator_code);
  url.searchParams.set("lnCd", source.line_code);
  url.searchParams.set("stinCd", source.station_code);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    stats.requests += 1;
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "JigeumTa-KRIC-Transfer/1.0",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return collectRows(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPairValue(
  candidate: PairCandidate,
  fetchImpl: FetchLike,
): Promise<KricPairValue> {
  const sources = sourcesForPair(candidate);
  const directions: Array<[string, string]> = [
    [candidate.fromLine, candidate.toLine],
    [candidate.toLine, candidate.fromLine],
  ];
  const distances: number[] = [];

  for (const [sourceLine, targetLine] of directions) {
    const candidates = sources.filter((source) => source.logical_line === sourceLine);
    const targetAliases = aliasesForTarget(sources, targetLine);
    for (const source of candidates) {
      try {
        const rows = await fetchStationTransferRows(source, fetchImpl);
        for (const row of rows) {
          const distance = distanceFromRow(row, targetLine, targetAliases);
          if (distance !== null) distances.push(distance);
        }
        if (distances.length) break;
      } catch {
        stats.errors += 1;
      }
    }
    if (distances.length) break;
  }

  const distanceM = median(distances);
  if (distanceM === null) {
    stats.unavailable += 1;
    return { distanceM: null, seconds: null, source: "unavailable" };
  }
  return {
    distanceM,
    seconds: Math.round(distanceM / TRANSFER_SPEED_MPS),
    source: "kric-runtime-1.2mps",
  };
}

function applyPairValue(candidate: PairCandidate, value: KricPairValue): boolean {
  if (value.distanceM === null || value.seconds === null) return false;
  const pairs = (repository.data.transfers.pairs ?? {}) as Record<string, any>;
  let changed = false;
  for (const [fromLine, toLine] of [
    [candidate.fromLine, candidate.toLine],
    [candidate.toLine, candidate.fromLine],
  ] as const) {
    const key = `${candidate.station}|${fromLine}|${toLine}`;
    const existing = pairs[key] as Record<string, unknown> | undefined;
    if (!existing || existing.source !== "runtime-kric-pending") continue;
    pairs[key] = {
      ...existing,
      distance_m: value.distanceM,
      distance_seconds: value.seconds,
      default_seconds: value.seconds,
      source: value.source,
    };
    changed = true;
  }
  if (changed) stats.enrichedPairs += 1;
  return changed;
}

async function resolvePair(
  candidate: PairCandidate,
  fetchImpl: FetchLike,
): Promise<boolean> {
  const key = canonicalPairKey(candidate.stationId, candidate.fromLine, candidate.toLine);
  const cached = await cacheGetJson<KricPairValue>(key, true);
  if (cached) {
    stats.cacheHit += 1;
    return applyPairValue(candidate, cached.value);
  }
  stats.cacheMiss += 1;

  let task = inFlight.get(key);
  if (!task) {
    task = fetchPairValue(candidate, fetchImpl)
      .then(async (value) => {
        await cacheSetJson(
          key,
          value,
          value.distanceM === null ? NEGATIVE_CACHE_SECONDS : FRESH_SECONDS,
          value.distanceM === null ? NEGATIVE_CACHE_SECONDS : STALE_SECONDS,
        );
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }
  return applyPairValue(candidate, await task);
}

function segmentPairs(segments: unknown): PairCandidate[] {
  if (!Array.isArray(segments)) return [];
  const found = new Map<string, PairCandidate>();
  for (let index = 0; index < segments.length - 1; index += 1) {
    const current = segments[index];
    const next = segments[index + 1];
    if (!current || typeof current !== "object" || !next || typeof next !== "object") continue;
    const a = current as Record<string, unknown>;
    const b = next as Record<string, unknown>;
    const station = canonStation(String(a.to ?? ""));
    if (!station || station !== canonStation(String(b.from ?? ""))) continue;
    const fromLine = String(a.line ?? "").trim();
    const toLine = String(b.line ?? "").trim();
    if (!fromLine || !toLine || fromLine === toLine) continue;
    const candidate = pendingPair(station, fromLine, toLine);
    if (!candidate) continue;
    found.set(
      canonicalPairKey(candidate.stationId, candidate.fromLine, candidate.toLine),
      candidate,
    );
  }
  return [...found.values()];
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => run()),
  );
  return results;
}

export async function prepareRuntimeTransfersForSegments(
  segments: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const candidates = segmentPairs(segments);
  if (!candidates.length || !Bun.env.KRIC_API_KEY?.trim()) return false;
  const changed = await mapLimited(
    candidates,
    RUNTIME_CONCURRENCY,
    (candidate) => resolvePair(candidate, fetchImpl),
  );
  return changed.some(Boolean);
}

export async function prepareRuntimeTransfersForResult(
  result: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const groups: unknown[] = [result.segments];
  if (Array.isArray(result.alternatives)) {
    for (const alternative of result.alternatives) {
      if (alternative && typeof alternative === "object") {
        groups.push((alternative as Record<string, unknown>).segments);
      }
    }
  }
  let changed = false;
  for (const segments of groups) {
    if (await prepareRuntimeTransfersForSegments(segments, fetchImpl)) changed = true;
  }
  return changed;
}

export function runtimeKricTransferSnapshot(): Record<string, unknown> {
  return {
    configured: Boolean(Bun.env.KRIC_API_KEY?.trim()),
    endpoint: "convenientInfo/stationTransferInfo",
    speed_mps: TRANSFER_SPEED_MPS,
    pair_model: `nC2 unordered physical line pairs (${unorderedTransferPairCount(4)} pairs for 4 lines)`,
    cache_fresh_days: FRESH_SECONDS / 86400,
    cache_stale_days: STALE_SECONDS / 86400,
    concurrency: RUNTIME_CONCURRENCY,
    counters: { ...stats },
  };
}
