import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EngineData, RawTrain } from "../types/domain";
import { DATASET_METADATA } from "./data-metadata";

type JsonObject = { [key: string]: unknown };
type DatasetKey = "s1-weekday" | "s1-holiday" | "s1-stations" | "official" | "extra" | "sinbundang" | "holidays" | "graph" | "transfers";
const root = resolve(dirname(import.meta.path), "../..");
const resolvedPaths = new Map<string, string>();
function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function dataPath(name: string): string {
  const cached = resolvedPaths.get(name); if (cached) return cached;
  const candidates = [join(root, name), resolve(dirname(import.meta.path), "../../", name), resolve(dirname(import.meta.path), "../../../", name), join(process.cwd(), name)];
  for (const candidate of candidates) if (existsSync(candidate)) { resolvedPaths.set(name, candidate); return candidate; }
  throw new Error(`데이터 파일을 찾지 못했습니다: ${name}`);
}
function readJson<T>(name: string): T { return JSON.parse(readFileSync(dataPath(name), "utf8")) as T; }
function asRecord(value: unknown): JsonObject { return isObject(value) ? value : {}; }
function asStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []; }
function asRawTrains(value: unknown): Record<string, RawTrain> { const result: Record<string, RawTrain> = {}; for (const [key, raw] of Object.entries(asRecord(value))) if (isObject(raw)) result[key] = raw as RawTrain; return result; }

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
        extra["신분당선"] = { stations: asStringArray(sb.stations), trains: asRecord(sb.trains) as Record<string, Record<string, RawTrain>> };
        return extra;
      }) },
      holidays: { enumerable: true, get: () => this.cached("holidays", () => asRecord(readJson<unknown>("kr_holidays_2026_2035.json")) as EngineData["holidays"]) },
      graph: { enumerable: true, get: () => this.cached("graph", () => asRecord(readJson<unknown>("route_graph.json")) as EngineData["graph"]) },
      transfers: { enumerable: true, get: () => this.cached("transfers", () => asRecord(readJson<unknown>("transfer_data.json")) as EngineData["transfers"]) },
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
