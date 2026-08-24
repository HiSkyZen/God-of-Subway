import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TransitServiceDay } from "../../src/infra/transit-schema";

export const ROOT = resolve(import.meta.dir, "../..");
export const DATASETS = resolve(ROOT, "datasets");
export const KRIC_BASE = (Bun.env.KRIC_API_BASE_URL?.trim() || "https://openapi.kric.go.kr/openapi").replace(/\/$/, "");
export const API_DAYS: ReadonlyArray<[Exclude<TransitServiceDay, "SAT">, string]> = [["DAY", "8"], ["END", "9"]];
export const DAYS: ReadonlyArray<[TransitServiceDay, string]> = [["DAY", "8"], ["SAT", "9"], ["END", "9"]];
export const SUPPORTED_LINES = [
  "1호선", "2호선", "3호선", "4호선", "5호선", "6호선", "7호선", "8호선", "9호선",
  "경의중앙선", "공항철도", "경춘선", "수인분당선", "신분당선", "경강선", "서해선",
  "인천1호선", "인천2호선", "용인에버라인", "의정부경전철", "우이신설선", "신림선", "김포골드라인",
  "GTX-A(북부)", "GTX-A(남부)",
] as const;
export const DISJOINT = new Set(["신촌|2호선|경의중앙선", "신촌|경의중앙선|2호선", "양평|5호선|경의중앙선", "양평|경의중앙선|5호선"]);

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(Bun.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}
export const BUILD_CONCURRENCY = intEnv("TRANSIT_BUILD_CONCURRENCY", 32, 1, 128);
export const BUILD_HTTP_TIMEOUT_MS = intEnv("TRANSIT_BUILD_HTTP_TIMEOUT_MS", 30000, 3000, 60000);
export const KRIC_HTTP_CONCURRENCY = intEnv("TRANSIT_BUILD_KRIC_HTTP_CONCURRENCY", 24, 1, 64);
export const ALLOW_PARTIAL = /^(1|true|yes)$/i.test(Bun.env.TRANSIT_BUILD_ALLOW_PARTIAL?.trim() || "");

export interface SourceRow {
  source_id: string; logical_line: string; operator_code: string; operator_name: string; line_code: string;
  source_line_name: string; section: string; realtime: string; timetable: string; priority: string;
}
export interface StationRow { source_id: string; station_code: string; source_station_name: string; canonical_name: string; sequence_hint: string; }
export interface ApiRow { [key: string]: unknown; }
export interface Event {
  sourceId: string; line: string; day: TransitServiceDay; trainNo: string; stationId: number; stationCode: string;
  station: string; arrival: number | null; departure: number | null; sequenceHint: number; rawKind: string;
}

export function parseTsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trimEnd();
  if (!text) return [];
  const [header, ...lines] = text.split(/\r?\n/); const keys = header.split("\t");
  return lines.filter(Boolean).map((line) => { const values = line.split("\t"); return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ""])); });
}
export function tsvFiles(dir: string): string[] { return readdirSync(dir).filter((name) => name.endsWith(".tsv")).sort().map((name) => resolve(dir, name)); }

export function cleanName(value: unknown): string {
  let station = String(value ?? "").trim().replaceAll(" ", "");
  if (station.endsWith("역") && station !== "서울역") station = station.slice(0, -1);
  const keep = new Set(["총신대입구(이수)", "쌍용(나사렛대)", "관악산(서울대)"]);
  if (!keep.has(station)) station = station.replace(/\([^()]*\)$/u, "");
  const aliases: Record<string, string> = {
    성균관: "성균관대", 가산디: "가산디지털단지", 금천구: "금천구청", 동두중: "동두천중앙", 쌍용나: "쌍용(나사렛대)", 온양온: "온양온천", 평지제: "평택지제",
    이수: "총신대입구(이수)", 디엠시: "디지털미디어시티", 홍대입: "홍대입구", 효창공: "효창공원앞", 항공대: "한국항공대", 강남구: "강남구청", 로데오: "압구정로데오",
    남동인: "남동인더스파크", 소래포: "소래포구", 수원시: "수원시청", 매탄권: "매탄권선", 신길온천: "능길", 인천논: "인천논현", 세종릉: "세종대왕릉",
    도예촌: "신둔도예촌", 경광주: "경기광주", 시흥능: "시흥능곡", 시흥청: "시흥시청", 시흥대: "시흥대야", 부천종: "부천종합운동장", 신김포: "김포공항", 평내호: "평내호평",
  };
  return aliases[station] ?? station;
}
export function normalizeLine(value: unknown, station = ""): string {
  const raw = String(value ?? "").trim().replaceAll(" ", ""); if (!raw) return "";
  const m = raw.match(/^([1-9])(?:호선)?$/); if (m) return `${m[1]}호선`;
  const table: Record<string, string> = {
    경의중앙: "경의중앙선", 경의중앙선: "경의중앙선", 수인분당: "수인분당선", 수인분당선: "수인분당선", 경춘: "경춘선", 경춘선: "경춘선", 경강: "경강선", 경강선: "경강선",
    서해: "서해선", 서해선: "서해선", 공항: "공항철도", 공항철도: "공항철도", 신분당: "신분당선", 신분당선: "신분당선", 인천1: "인천1호선", 인천1호선: "인천1호선",
    인천2: "인천2호선", 인천2호선: "인천2호선", 에버라인: "용인에버라인", 용인에버라인: "용인에버라인", 의정부: "의정부경전철", 의정부경전철: "의정부경전철",
    우이신설: "우이신설선", 우이신설선: "우이신설선", 신림: "신림선", 신림선: "신림선", 김포골드: "김포골드라인", 김포골드라인: "김포골드라인", 경원선: "1호선",
    국철: cleanName(station) === "수서" ? "수인분당선" : "1호선",
  };
  if (table[raw]) return table[raw];
  if (/GTX-?A|수도권광역급행철도.*에이/u.test(raw)) return ["수서", "성남", "구성", "동탄"].includes(cleanName(station)) ? "GTX-A(남부)" : "GTX-A(북부)";
  return raw;
}
export function parseClock(value: unknown): number | null {
  const raw = String(value ?? "").trim(); if (!raw) return null;
  const m = raw.match(/^(\d{1,2}):?(\d{2})(?::?(\d{2}))?$/); if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]); const sec = Number(m[3] ?? 0); if (h > 47 || min > 59 || sec > 59) return null;
  let out = h * 3600 + min * 60 + sec; if (h < 2) out += 86400; return out;
}
export function rowValue(row: ApiRow, ...keys: string[]): unknown { for (const key of keys) if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") return row[key]; return undefined; }
export function collectApiRows(value: unknown, predicate: (row: ApiRow) => boolean, out: ApiRow[] = []): ApiRow[] {
  if (Array.isArray(value)) { for (const item of value) collectApiRows(item, predicate, out); return out; }
  if (!value || typeof value !== "object") return out; const row = value as ApiRow; if (predicate(row)) out.push(row);
  for (const child of Object.values(row)) if (child && typeof child === "object") collectApiRows(child, predicate, out); return out;
}
export function serviceKind(raw: unknown): "local" | "express" | "direct" { const text = String(raw ?? "").trim().toLowerCase(); if (/직통|direct/.test(text)) return "direct"; if (/급행|특급|express|rapid/.test(text)) return "express"; return "local"; }
export function servicePriority(kind: string): number { return kind === "express" ? 20 : 10; }

export async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length); let cursor = 0;
  const run = async () => { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => run()));
  return results;
}

export function normalizeKricServiceKey(value: string): string {
  const key = value.trim();
  if (!/%[0-9a-f]{2}/i.test(key)) return key;
  try { return decodeURIComponent(key); } catch { return key; }
}

function secureKey(): string {
  const key = Bun.env.KRIC_API_KEY?.trim() ?? "";
  if (!key) throw new Error("live 데이터 빌드에는 KRIC_API_KEY 환경변수가 필요합니다.");
  return normalizeKricServiceKey(key);
}

export function buildKricUrl(endpoint: string, params: Record<string, string>, serviceKey = secureKey()): URL {
  const url = new URL(`${KRIC_BASE}/${endpoint.replace(/^\/+/, "")}`);
  url.searchParams.set("serviceKey", normalizeKricServiceKey(serviceKey));
  url.searchParams.set("format", "json");
  const ordered = ["railOprIsttCd", "dayCd", "lnCd", "stinCd"] as const;
  const seen = new Set<string>();
  for (const name of ordered) {
    const value = params[name];
    if (value === undefined) continue;
    url.searchParams.set(name, value);
    seen.add(name);
  }
  for (const [name, value] of Object.entries(params)) {
    if (!seen.has(name)) url.searchParams.set(name, value);
  }
  return url;
}

export function parseKricJsonText(text: string): unknown {
  const normalized = text.replace(/^\uFEFF/u, "").trim();
  if (!normalized) throw new SyntaxError("KRIC returned an empty response body");
  return JSON.parse(normalized);
}

const KRIC_TIMETABLE_RETRIES = intEnv("TRANSIT_BUILD_KRIC_RETRIES", 10, 0, 10);
function effectiveKricRetries(endpoint: string, requested: number): number {
  return /(?:subwayTimetableExp|subwayTimetable|stationTimetable)$/u.test(endpoint)
    ? Math.max(requested, KRIC_TIMETABLE_RETRIES)
    : requested;
}

let activeKricRequests = 0;
const kricWaiters: Array<() => void> = [];
async function acquireKricSlot(): Promise<void> {
  if (activeKricRequests < KRIC_HTTP_CONCURRENCY) {
    activeKricRequests += 1;
    return;
  }
  await new Promise<void>((resolveWaiter) => kricWaiters.push(resolveWaiter));
}
function releaseKricSlot(): void {
  const next = kricWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeKricRequests = Math.max(0, activeKricRequests - 1);
}

function safeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240).replace(/serviceKey=[^&\s]+/gi, "serviceKey=REDACTED");
}
function requestDescriptor(endpoint: string, params: Record<string, string>): string {
  return `${endpoint} ${JSON.stringify(params)}`;
}

export async function kricJson(endpoint: string, params: Record<string, string>, retries = 2): Promise<unknown> {
  const url = buildKricUrl(endpoint, params);
  const attempts = effectiveKricRetries(endpoint, retries);
  let error = "";
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    await acquireKricSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BUILD_HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${safeSnippet(text)}`);
      return parseKricJsonText(text);
    } catch (cause) {
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    } finally {
      clearTimeout(timer);
      releaseKricSlot();
    }
  }
  throw new Error(`${requestDescriptor(endpoint, params)} 호출 실패: ${error}`);
}
export function metadata(db: Database, key: string, value: string | number | boolean): void { db.query(`INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)`).run(key, String(value)); }
export function buildSource(db: Database, name: string, uri: string, rows: number, note = ""): void { db.query(`INSERT OR REPLACE INTO build_source(source_name,source_uri,fetched_at,row_count,note) VALUES (?,?,?,?,?)`).run(name, uri, new Date().toISOString(), rows, note); }
export function stationId(db: Database, name: string): number {
  const canonical = cleanName(name); const key = `KR:${canonical}`; db.query(`INSERT OR IGNORE INTO station(station_key,canonical_name,display_name) VALUES (?,?,?)`).run(key, canonical, canonical);
  return Number((db.query(`SELECT station_id FROM station WHERE station_key=?`).get(key) as { station_id: number }).station_id);
}
