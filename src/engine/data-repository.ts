import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EngineData, RawMetroTrain, RawTrain, RawTransfer } from "../types/domain";

export type DatasetKey = "s1-weekday" | "s1-saturday" | "s1-holiday" | "official" | "extra" | "holidays" | "graph" | "transfers";
type ServiceDay = "DAY" | "SAT" | "END";
type LegacyDay = "weekday" | "saturday" | "holiday";

const ROOT = resolve(dirname(import.meta.path), "../..");
const EXTRA_LINES = ["경의중앙선", "수인분당선", "경춘선", "경강선", "서해선", "공항철도", "신분당선", "인천1호선", "인천2호선", "용인에버라인", "김포골드라인", "의정부경전철", "우이신설선", "신림선", "GTX-A(북부)", "GTX-A(남부)"] as const;

function transitDbCandidates(): string[] {
  const configured = Bun.env.TRANSIT_DB_PATH?.trim();
  return [configured ? resolve(configured) : "", resolve(ROOT, "data/transit.sqlite"), resolve(process.cwd(), "data/transit.sqlite"), resolve(dirname(import.meta.path), "../../data/transit.sqlite"), resolve(dirname(import.meta.path), "../../../data/transit.sqlite")].filter(Boolean);
}
export function transitDbPath(): string {
  for (const candidate of transitDbCandidates()) if (existsSync(candidate)) return candidate;
  throw new Error("SQLite 철도 데이터베이스를 찾지 못했습니다. 먼저 bun run build:data를 실행하세요.");
}

interface TripRow { trip_id: number; train_no: string; direction: string; service_kind: string; origin: string; destination: string; }
interface StopRow { trip_id: number; station: string; arrival_sec: number | null; departure_sec: number | null; callable: number; }
interface GraphRow { service_day: ServiceDay; logical_line: string; from_station: string; to_station: string; seconds: number; }
interface PairRow { station_id: number; station: string; from_line: string; to_line: string; distance_m: number | null; seconds: number | null; source: string; }
interface DetailRow { station_id: number; from_line: string; to_line: string; from_direction: string; to_direction: string; alight_car: string; alight_door: string; board_car: string; board_door: string; seconds: number | null; source: string; }

export interface DataRepository {
  readonly data: EngineData;
  reload(): void;
  loadedDatasets(): DatasetKey[];
  validate(): { files: string[]; stationLines: number; graphModes: string[]; stations: number; trips: number; stopTimes: number; transfers: number; schemaVersion: number; buildMode: string };
}

export class SqliteDataRepository implements DataRepository {
  readonly data: EngineData;
  private dbHandle: Database | null = null;
  private readonly cache = new Map<DatasetKey, unknown>();
  constructor(private readonly explicitPath?: string) {
    const s1 = {} as EngineData["s1"];
    Object.defineProperties(s1, {
      weekday: { enumerable: true, get: () => this.cached("s1-weekday", () => this.rawTrainMap("1호선", "DAY")) },
      saturday: { enumerable: true, get: () => this.cached("s1-saturday", () => this.rawTrainMap("1호선", "SAT")) },
      holiday: { enumerable: true, get: () => this.cached("s1-holiday", () => this.rawTrainMap("1호선", "END")) },
    });
    const view = {} as EngineData;
    Object.defineProperties(view, {
      s1: { enumerable: true, value: s1 },
      s1Stations: { enumerable: true, get: () => this.lineStations("1호선") },
      official: { enumerable: true, get: () => this.cached("official", () => this.officialData()) },
      extra: { enumerable: true, get: () => this.cached("extra", () => this.extraData()) },
      holidays: { enumerable: true, get: () => this.cached("holidays", () => this.holidayData()) },
      graph: { enumerable: true, get: () => this.cached("graph", () => this.graphData()) },
      transfers: { enumerable: true, get: () => this.cached("transfers", () => this.transferData()) },
    });
    this.data = view;
  }
  private db(): Database { if (!this.dbHandle) this.dbHandle = new Database(this.explicitPath ?? transitDbPath(), { readonly: true, strict: true }); return this.dbHandle; }
  private cached<T>(key: DatasetKey, load: () => T): T { if (!this.cache.has(key)) this.cache.set(key, load()); return this.cache.get(key) as T; }
  private lineStations(line: string): string[] { return (this.db().query(`SELECT DISTINCT s.canonical_name AS station FROM station s JOIN station_source ss ON ss.station_id=s.station_id JOIN source_registry sr ON sr.source_id=ss.source_id WHERE sr.logical_line=? ORDER BY s.canonical_name COLLATE NOCASE`).all(line) as Array<{ station: string }>).map((row) => row.station); }
  private rawTrainMap(line: string, day: ServiceDay): Record<string, RawTrain> {
    const trips = this.db().query(`SELECT t.trip_id, t.train_no, t.direction, t.service_kind, COALESCE(o.canonical_name,'') AS origin, COALESCE(d.canonical_name,'') AS destination FROM trip t LEFT JOIN station o ON o.station_id=t.origin_station_id LEFT JOIN station d ON d.station_id=t.destination_station_id WHERE t.logical_line=? AND t.service_day=? ORDER BY t.train_no`).all(line, day) as TripRow[];
    if (!trips.length) return {};
    const result: Record<string, RawTrain> = {}; const stopQuery = this.db().prepare(`SELECT st.trip_id, s.canonical_name AS station, st.arrival_sec, st.departure_sec, st.callable FROM stop_time st JOIN station s ON s.station_id=st.station_id WHERE st.trip_id=? ORDER BY st.stop_sequence`);
    for (const trip of trips) { const stops = stopQuery.all(trip.trip_id) as StopRow[]; result[trip.train_no] = { direction: trip.direction, service: trip.service_kind, start: trip.origin, dest: trip.destination, stops: stops.map((stop) => ({ station: stop.station, arr: stop.arrival_sec, dep: stop.departure_sec, call: stop.callable !== 0 })) }; }
    return result;
  }
  private officialData(): EngineData["official"] {
    const days: NonNullable<EngineData["official"]["days"]> = {}; const stations: Record<string, string[]> = {};
    for (const day of ["DAY", "SAT", "END"] as ServiceDay[]) {
      const perLine: Record<string, Record<string, RawMetroTrain>> = {};
      for (let number = 2; number <= 9; number += 1) {
        const line = `${number}호선`; const raw = this.rawTrainMap(line, day);
        perLine[String(number)] = Object.fromEntries(Object.entries(raw).map(([trainNo, train]) => [trainNo, [String(train.direction ?? ""), String(train.service ?? "local") === "local" ? "0" : "1", String(train.start ?? ""), String(train.dest ?? ""), (train.stops ?? []).map((stop) => [String(stop.station ?? ""), stop.arr ?? null, stop.dep ?? null])] as RawMetroTrain]));
        stations[String(number)] = this.lineStations(line);
      }
      days[day] = perLine;
    }
    return { meta: { source: "SQLite normalized transit database", version: String(this.metadata().built_at ?? "") }, days, stations };
  }
  private extraData(): EngineData["extra"] {
    const result: EngineData["extra"] = {};
    for (const line of EXTRA_LINES) result[line] = { stations: this.lineStations(line), trains: { weekday: this.rawTrainMap(line, "DAY"), saturday: this.rawTrainMap(line, "SAT"), holiday: this.rawTrainMap(line, "END") } };
    return result;
  }
  private holidayData(): EngineData["holidays"] { const dates: Record<string, { name?: string }> = {}; for (const row of this.db().query(`SELECT date, name FROM holiday ORDER BY date`).all() as Array<{ date: string; name: string }>) dates[row.date] = { name: row.name }; return { dates }; }
  private graphData(): EngineData["graph"] {
    const rows = this.db().query(`SELECT r.service_day, r.logical_line, f.canonical_name AS from_station, t.canonical_name AS to_station, MIN(r.seconds) AS seconds FROM ride_edge r JOIN station f ON f.station_id=r.from_station_id JOIN station t ON t.station_id=r.to_station_id GROUP BY r.service_day,r.logical_line,r.from_station_id,r.to_station_id ORDER BY r.service_day,r.logical_line,f.canonical_name,t.canonical_name`).all() as GraphRow[];
    const modes: Record<string, unknown[]> = { DAY: [], SAT: [], END: [] }; for (const row of rows) modes[row.service_day].push([row.logical_line, row.from_station, row.to_station, row.seconds]); return { meta: { source: "SQLite ride_edge", weight: "median scheduled running time" }, modes };
  }
  private transferData(): EngineData["transfers"] {
    const pairRows = this.db().query(`SELECT p.station_id,s.canonical_name AS station,p.from_line,p.to_line,p.distance_m,p.seconds,p.source FROM transfer_pair p JOIN station s ON s.station_id=p.station_id ORDER BY s.canonical_name,p.from_line,p.to_line`).all() as PairRow[];
    const details = this.db().query(`SELECT station_id,from_line,to_line,from_direction,to_direction,alight_car,alight_door,board_car,board_door,seconds,source FROM transfer_detail ORDER BY detail_id`).all() as DetailRow[];
    const detailMap = new Map<string, DetailRow[]>(); for (const row of details) { const key = `${row.station_id}|${row.from_line}|${row.to_line}`; detailMap.set(key, [...(detailMap.get(key) ?? []), row]); }
    const pairs: Record<string, RawTransfer> = {};
    for (const row of pairRows) { const records = (detailMap.get(`${row.station_id}|${row.from_line}|${row.to_line}`) ?? []).map((detail) => ({ from_direction: detail.from_direction, to_direction: detail.to_direction, alight_car: detail.alight_car, alight_door: detail.alight_door, board_car: detail.board_car, board_door: detail.board_door, seconds: detail.seconds, source: detail.source })); pairs[`${row.station}|${row.from_line}|${row.to_line}`] = { station: row.station, from_line: row.from_line, to_line: row.to_line, distance_m: row.distance_m, distance_seconds: row.seconds, default_seconds: row.seconds, source: row.source, records } as RawTransfer; }
    return { pairs };
  }
  private metadata(): Record<string, string> { return Object.fromEntries((this.db().query(`SELECT key,value FROM metadata`).all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value])); }
  reload(): void { this.cache.clear(); if (this.dbHandle) { this.dbHandle.close(); this.dbHandle = null; } }
  loadedDatasets(): DatasetKey[] { return [...this.cache.keys()].sort(); }
  validate(): { files: string[]; stationLines: number; graphModes: string[]; stations: number; trips: number; stopTimes: number; transfers: number; schemaVersion: number; buildMode: string } {
    const db = this.db(); const integrity = String((db.query(`PRAGMA integrity_check`).get() as Record<string, unknown>)?.integrity_check ?? ""); if (integrity !== "ok") throw new Error(`SQLite integrity_check 실패: ${integrity}`);
    const meta = this.metadata(); const count = (table: string): number => Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n); const stationLines = Number((db.query(`SELECT COUNT(DISTINCT logical_line) AS n FROM source_registry`).get() as { n: number }).n); const graphModes = (db.query(`SELECT DISTINCT service_day FROM ride_edge ORDER BY CASE service_day WHEN 'DAY' THEN 1 WHEN 'SAT' THEN 2 ELSE 3 END`).all() as Array<{ service_day: string }>).map((row) => row.service_day);
    return { files: [this.explicitPath ?? transitDbPath()], stationLines, graphModes, stations: count("station"), trips: count("trip"), stopTimes: count("stop_time"), transfers: count("transfer_pair"), schemaVersion: Number(meta.schema_version || 0), buildMode: String(meta.build_mode || "unknown") };
  }
}

export const repository: DataRepository = new SqliteDataRepository();
