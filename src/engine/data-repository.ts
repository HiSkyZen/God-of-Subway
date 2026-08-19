import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EngineData, RawTrain } from "../types/domain";
import { DATASET_METADATA } from "./data-metadata";
import { isDisjointHomonymTransfer } from "./station-identity";

type JsonObject = { [key: string]: unknown };
type DatasetKey = "s1-weekday" | "s1-holiday" | "s1-stations" | "official" | "extra" | "sinbundang" | "urban" | "holidays" | "graph" | "transfers" | "transfer-overlay";
const root = resolve(dirname(import.meta.path), "../..");
const resolvedPaths = new Map<string, string>();
function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function dataPath(name: string): string {
  const cached = resolvedPaths.get(name); if (cached) return cached;
  const candidates = [
    join(root, "data", name),
    join(process.cwd(), "data", name),
    resolve(dirname(import.meta.path), "../../data", name),
    resolve(dirname(import.meta.path), "../../../data", name),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) { resolvedPaths.set(name, candidate); return candidate; }
  throw new Error(`데이터 파일을 찾지 못했습니다: data/${name}`);
}
function readJson<T>(name: string): T { return JSON.parse(readFileSync(dataPath(name), "utf8")) as T; }
function asRecord(value: unknown): JsonObject { return isObject(value) ? value : {}; }
function asStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []; }
function asRawTrains(value: unknown): Record<string, RawTrain> { const result: Record<string, RawTrain> = {}; for (const [key, raw] of Object.entries(asRecord(value))) if (isObject(raw)) result[key] = raw as RawTrain; return result; }

/** Preserve the imported upstream file verbatim while removing impossible runtime edges. */
function sanitizedTransfers(value: unknown): EngineData["transfers"] {
  const raw = asRecord(value);
  const pairs = Object.fromEntries(Object.entries(asRecord(raw.pairs)).filter(([, entry]) => {
    if (!isObject(entry)) return true;
    return !isDisjointHomonymTransfer(entry.station, entry.from_line, entry.to_line);
  }));
  return { ...raw, pairs } as EngineData["transfers"];
}

interface UrbanWindow { 0: number; 1: number; 2: number }
interface UrbanLineDefinition {
  stations?: string[];
  segment_seconds?: number[];
  weekday?: { forward?: UrbanWindow[]; reverse?: UrbanWindow[] };
  holiday?: { forward?: UrbanWindow[]; reverse?: UrbanWindow[] };
}
function generatedUrbanLines(value: unknown): EngineData["extra"] {
  const result: EngineData["extra"] = {};
  const lines = asRecord(asRecord(value).lines);
  const makeMode = (line: string, cfg: UrbanLineDefinition, mode: "weekday" | "holiday"): Record<string, RawTrain> => {
    const output: Record<string, RawTrain> = {};
    const stations = asStringArray(cfg.stations);
    const segmentSeconds = Array.isArray(cfg.segment_seconds) ? cfg.segment_seconds.map(Number) : [];
    const modeCfg = cfg[mode] ?? {};
    const directions: Array<["forward" | "reverse", string[], number[]]> = [
      ["forward", stations, segmentSeconds],
      ["reverse", [...stations].reverse(), [...segmentSeconds].reverse()],
    ];
    let sequence = 0;
    for (const [directionKey, orderedStations, orderedSeconds] of directions) {
      const windows = Array.isArray(modeCfg[directionKey]) ? modeCfg[directionKey] as UrbanWindow[] : [];
      const departures = new Set<number>();
      for (const rawWindow of windows) {
        const start = Math.trunc(Number(rawWindow?.[0]));
        const end = Math.trunc(Number(rawWindow?.[1]));
        const headway = Math.max(60, Math.trunc(Number(rawWindow?.[2])));
        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(headway) || end < start) continue;
        for (let second = start; second <= end; second += headway) departures.add(second);
      }
      for (const departure of [...departures].sort((a, b) => a - b)) {
        const stops: NonNullable<RawTrain["stops"]> = [];
        let cursor = departure;
        for (let index = 0; index < orderedStations.length; index += 1) {
          const terminal = index === 0 || index === orderedStations.length - 1;
          stops.push({ station: orderedStations[index], arr: index === 0 ? null : cursor, dep: index === orderedStations.length - 1 ? null : cursor + (terminal ? 0 : 25), call: true });
          if (index < orderedSeconds.length) cursor += Number(orderedSeconds[index]) + (index === 0 ? 0 : 25);
        }
        sequence += 1;
        const code = line.replace(/[^0-9A-Za-z가-힣]/g, "").slice(0, 4);
        const id = `URB-${code}-${mode === "weekday" ? "W" : "H"}-${directionKey === "forward" ? "D" : "U"}-${String(sequence).padStart(4, "0")}`;
        output[id] = {
          direction: directionKey === "forward" ? "DOWN" : "UP",
          service: "local",
          start: orderedStations[0] ?? "",
          dest: orderedStations[orderedStations.length - 1] ?? "",
          stops,
        };
      }
    }
    return output;
  };
  for (const [line, raw] of Object.entries(lines)) {
    if (!isObject(raw)) continue;
    const cfg = raw as UrbanLineDefinition;
    result[line] = {
      stations: asStringArray(cfg.stations),
      trains: { weekday: makeMode(line, cfg, "weekday"), holiday: makeMode(line, cfg, "holiday") },
    };
  }
  return result;
}
function mergedTransfers(baseValue: unknown, overlayValue: unknown): EngineData["transfers"] {
  const base = sanitizedTransfers(baseValue);
  const overlay = asRecord(overlayValue);
  const overlayPairs = asRecord(overlay.pairs);
  const pairs = { ...(base.pairs ?? {}) };
  for (const [key, raw] of Object.entries(overlayPairs)) {
    if (!isObject(raw) || isDisjointHomonymTransfer(raw.station, raw.from_line, raw.to_line)) continue;
    pairs[key] = raw as never;
  }
  return { ...base, pairs };
}

function firstServiceSecond(train: RawTrain): number {
  for (const stop of train.stops ?? []) {
    const value = typeof stop.dep === "number" ? stop.dep : typeof stop.arr === "number" ? stop.arr : null;
    if (value !== null && Number.isFinite(value)) return value;
  }
  return Number.MAX_SAFE_INTEGER;
}
function sinbundangModeCode(mode: string): string {
  if (mode === "weekday") return "W";
  if (mode === "holiday") return "H";
  return mode.replace(/[^0-9A-Za-z]/g, "").slice(0, 3).toUpperCase() || "X";
}
/**
 * The imported Shinbundang workbook used DX-prefixed labels only as source-row
 * identifiers. They are not public train numbers. Convert the source rows to a
 * timetable-derived internal index before the rest of the engine can see them.
 */
function indexedSinbundangTrains(value: unknown): Record<string, Record<string, RawTrain>> {
  const result: Record<string, Record<string, RawTrain>> = {};
  for (const [mode, rawValue] of Object.entries(asRecord(value))) {
    const trains = Object.values(asRecord(rawValue))
      .filter(isObject)
      .map((raw) => {
        const clean = { ...(raw as RawTrain) };
        if (/^DX/i.test(String(clean.linked_train_no ?? ""))) delete clean.linked_train_no;
        return clean;
      });
    trains.sort((a, b) => firstServiceSecond(a) - firstServiceSecond(b)
      || String(a.direction ?? "").localeCompare(String(b.direction ?? ""))
      || String(a.start ?? "").localeCompare(String(b.start ?? ""))
      || String(a.dest ?? "").localeCompare(String(b.dest ?? "")));
    const code = sinbundangModeCode(mode);
    result[mode] = Object.fromEntries(trains.map((train, index) => [`SB-${code}-${String(index + 1).padStart(4, "0")}`, train]));
  }
  return result;
}

export interface DataRepository { readonly data: EngineData; reload(): void; loadedDatasets(): DatasetKey[]; validate(): { files: string[]; stationLines: number; graphModes: string[] }; }
class JsonDataRepository implements DataRepository {
  readonly data: EngineData;
  private readonly cache = new Map<DatasetKey, unknown>();
  constructor() {
    const s1 = {} as EngineData["s1"];
    Object.defineProperties(s1, {
      weekday: { enumerable: true, get: () => this.cached("s1-weekday", () => asRawTrains(asRecord(readJson<JsonObject>("schedule_weekday.json")).trains)) },
      holiday: { enumerable: true, get: () => this.cached("s1-holiday", () => asRawTrains(asRecord(readJson<JsonObject>("schedule_holiday.json")).trains)) },
    });
    const view = {} as EngineData;
    Object.defineProperties(view, {
      s1: { enumerable: true, value: s1 },
      s1Stations: { enumerable: true, get: () => this.cached("s1-stations", () => asStringArray(readJson<unknown>("stations.json"))) },
      official: { enumerable: true, get: () => this.cached("official", () => asRecord(readJson<unknown>("official_2to9_schedule.json")) as EngineData["official"]) },
      extra: { enumerable: true, get: () => this.cached("extra", () => {
        const extra = { ...(asRecord(readJson<unknown>("korail_extra_lines_schedule.json")) as EngineData["extra"]) };
        const sb = this.cached("sinbundang", () => asRecord(readJson<unknown>("sinbundang_schedule.json")));
        extra["신분당선"] = { stations: asStringArray(sb.stations), trains: indexedSinbundangTrains(sb.trains) };
        const urban = this.cached("urban", () => readJson<unknown>("urban_schedule.json"));
        Object.assign(extra, generatedUrbanLines(urban));
        return extra;
      }) },
      holidays: { enumerable: true, get: () => this.cached("holidays", () => asRecord(readJson<unknown>("kr_holidays_2026_2035.json")) as EngineData["holidays"]) },
      graph: { enumerable: true, get: () => this.cached("graph", () => asRecord(readJson<unknown>("route_graph.json")) as EngineData["graph"]) },
      transfers: { enumerable: true, get: () => this.cached("transfers", () => mergedTransfers(readJson<unknown>("transfer_data.json"), this.cached("transfer-overlay", () => readJson<unknown>("transfer_overlay.json")))) },
    });
    this.data = view;
  }
  private cached<T>(key: DatasetKey, load: () => T): T { if (!this.cache.has(key)) this.cache.set(key, load()); return this.cache.get(key) as T; }
  reload(): void { this.cache.clear(); }
  loadedDatasets(): DatasetKey[] { return [...this.cache.keys()].sort(); }
  validate(): { files: string[]; stationLines: number; graphModes: string[] } {
    const files = Object.keys(DATASET_METADATA.files) as Array<keyof typeof DATASET_METADATA.files>;
    for (const name of files) { const actual = statSync(dataPath(name)).size; const expected = DATASET_METADATA.files[name]; if (actual !== expected) throw new Error(`데이터 메타데이터가 오래되었습니다: ${name} (${actual} != ${expected})`); }
    const graphModes = Object.keys(this.data.graph.modes ?? {}); const lines = new Set<string>();
    for (const rows of Object.values(this.data.graph.modes ?? {})) for (const edge of rows) if (Array.isArray(edge) && typeof edge[0] === "string") lines.add(edge[0]);
    return { files, stationLines: lines.size, graphModes };
  }
}
export const repository: DataRepository = new JsonDataRepository();
export { JsonDataRepository, dataPath, readJson };
