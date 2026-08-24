import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { TransitServiceDay } from "../src/infra/transit-schema";
import {
  cleanName,
  collectApiRows,
  kricJson,
  mapConcurrent,
  metadata,
  parseClock,
  rowValue,
  serviceKind,
  servicePriority,
  type ApiRow,
  type Event,
} from "./transit-build/common";
import { deriveRideEdges } from "./transit-build/timetable";

const ROOT = resolve(import.meta.dir, "..");
const DB_PATH = resolve(ROOT, Bun.env.TRANSIT_DB_PATH?.trim() || "data/transit.pending.sqlite");
const MARKER_PATH = resolve(ROOT, Bun.env.TRANSIT_FAILURE_MARKER?.trim() || "data/transit-refresh-failure.json");
const REPAIR_CONCURRENCY = Math.max(1, Math.min(16, Number(Bun.env.TRANSIT_DEPLOY_REPAIR_CONCURRENCY ?? 8) || 8));

const ENDPOINTS = [
  { id: "exp", path: "trainUseInfo/subwayTimetableExp" },
  { id: "base", path: "trainUseInfo/subwayTimetable" },
  { id: "station", path: "convenientInfo/stationTimetable" },
] as const;

type FailureUnit = {
  source_id: string;
  station_code: string;
  day: "DAY" | "END";
};
type FailureMarker = {
  failed_timetable_units?: FailureUnit[];
  [key: string]: unknown;
};
type SourceRef = {
  source_id: string;
  logical_line: string;
  operator_code: string;
  line_code: string;
};
type StationRef = {
  station_id: number;
  source_station_name: string;
  canonical_name: string;
  sequence_hint: number;
};
type FetchResult = {
  unit: FailureUnit;
  source: SourceRef | null;
  station: StationRef | null;
  rows: ApiRow[];
  resolved: boolean;
  errors: string[];
};

function timetableRows(payload: unknown, expectedDayCd: string): ApiRow[] {
  const rows = collectApiRows(
    payload,
    (row) =>
      rowValue(row, "trnNo", "trainNo") !== undefined
      && rowValue(row, "arvTm", "dptTm", "arrTm", "depTm") !== undefined,
  );
  return rows.filter((row) => {
    const actual = String(rowValue(row, "dayCd") ?? "").trim();
    return !/^[789]$/.test(actual) || actual === expectedDayCd;
  });
}

function uniqueUnits(units: FailureUnit[]): FailureUnit[] {
  const seen = new Set<string>();
  return units.filter((unit) => {
    if (!unit?.source_id || !unit?.station_code || !["DAY", "END"].includes(unit.day)) return false;
    const key = `${unit.source_id}\u0001${unit.station_code}\u0001${unit.day}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

if (!(await Bun.file(DB_PATH).exists())) throw new Error(`pending transit SQLite is missing: ${DB_PATH}`);
if (!(await Bun.file(MARKER_PATH).exists())) throw new Error(`transit failure marker is missing: ${MARKER_PATH}`);

const marker = await Bun.file(MARKER_PATH).json() as FailureMarker;
const units = uniqueUnits(Array.isArray(marker.failed_timetable_units) ? marker.failed_timetable_units : []);
if (!units.length) throw new Error("failure marker has no retryable KRIC timetable units");

const db = new Database(DB_PATH, { strict: true });

async function fetchUnit(unit: FailureUnit): Promise<FetchResult> {
  const source = db.query(`
    SELECT source_id,logical_line,operator_code,line_code
    FROM source_registry WHERE source_id=?
  `).get(unit.source_id) as SourceRef | null;
  const station = db.query(`
    SELECT ss.station_id,ss.source_station_name,s.canonical_name,ss.sequence_hint
    FROM station_source ss
    JOIN station s ON s.station_id=ss.station_id
    WHERE ss.source_id=? AND ss.station_code=?
  `).get(unit.source_id, unit.station_code) as StationRef | null;
  if (!source || !station) {
    return {
      unit,
      source,
      station,
      rows: [],
      resolved: false,
      errors: [!source ? "source_registry_missing" : "station_source_missing"],
    };
  }

  const dayCd = unit.day === "DAY" ? "8" : "9";
  const errors: string[] = [];
  let hadSuccessfulResponse = false;
  for (const endpoint of ENDPOINTS) {
    try {
      const payload = await kricJson(endpoint.path, {
        railOprIsttCd: source.operator_code,
        dayCd,
        lnCd: source.line_code,
        stinCd: unit.station_code,
      });
      hadSuccessfulResponse = true;
      const rows = timetableRows(payload, dayCd);
      if (rows.length) return { unit, source, station, rows, resolved: true, errors };
    } catch (error) {
      errors.push(`${endpoint.id}=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { unit, source, station, rows: [], resolved: hadSuccessfulResponse, errors };
}

function eventFromRow(result: FetchResult, raw: ApiRow, day: TransitServiceDay): Event | null {
  if (!result.source || !result.station) return null;
  const trainNo = String(rowValue(raw, "trnNo", "trainNo") ?? "").trim();
  if (!trainNo) return null;
  return {
    sourceId: result.source.source_id,
    line: result.source.logical_line,
    day,
    trainNo,
    stationId: Number(result.station.station_id),
    stationCode: result.unit.station_code,
    station: cleanName(result.station.canonical_name),
    arrival: parseClock(rowValue(raw, "arvTm", "arrTm")),
    departure: parseClock(rowValue(raw, "dptTm", "depTm")),
    sequenceHint: Number(result.station.sequence_hint || 0),
    rawKind: String(rowValue(raw, "exptCd", "expressCd", "trainType") ?? ""),
  };
}

function inferDirection(events: Event[]): string {
  if (events.length < 2) return "";
  const ordered = [...events].sort(
    (a, b) =>
      (a.departure ?? a.arrival ?? Number.MAX_SAFE_INTEGER)
      - (b.departure ?? b.arrival ?? Number.MAX_SAFE_INTEGER)
      || a.sequenceHint - b.sequenceHint,
  );
  const first = ordered[0].sequenceHint;
  const last = ordered.at(-1)!.sequenceHint;
  return first === last ? "" : first < last ? "DOWN" : "UP";
}

function existingEvents(tripId: number, sourceId: string, day: TransitServiceDay, line: string, trainNo: string): Event[] {
  const rows = db.query(`
    SELECT st.stop_sequence,st.station_id,st.arrival_sec,st.departure_sec,st.source_station_code,
           s.canonical_name,COALESCE(ss.sequence_hint,st.stop_sequence) AS sequence_hint
    FROM stop_time st
    JOIN station s ON s.station_id=st.station_id
    LEFT JOIN station_source ss
      ON ss.source_id=? AND ss.station_code=st.source_station_code
    WHERE st.trip_id=?
    ORDER BY st.stop_sequence
  `).all(sourceId, tripId) as Array<{
    stop_sequence: number;
    station_id: number;
    arrival_sec: number | null;
    departure_sec: number | null;
    source_station_code: string;
    canonical_name: string;
    sequence_hint: number;
  }>;
  return rows.map((row) => ({
    sourceId,
    line,
    day,
    trainNo,
    stationId: Number(row.station_id),
    stationCode: row.source_station_code,
    station: cleanName(row.canonical_name),
    arrival: row.arrival_sec,
    departure: row.departure_sec,
    sequenceHint: Number(row.sequence_hint),
    rawKind: "",
  }));
}

function orderedDeduped(events: Event[]): Event[] {
  const ordered = [...events].sort(
    (a, b) =>
      (a.departure ?? a.arrival ?? Number.MAX_SAFE_INTEGER)
      - (b.departure ?? b.arrival ?? Number.MAX_SAFE_INTEGER)
      || a.sequenceHint - b.sequenceHint,
  );
  const out: Event[] = [];
  for (const event of ordered) {
    const previous = out.at(-1);
    if (
      previous
      && previous.stationId === event.stationId
      && previous.arrival === event.arrival
      && previous.departure === event.departure
    ) continue;
    out.push(event);
  }
  return out;
}

function applyGroup(group: Event[]): void {
  if (!group.length) return;
  const { line, day, trainNo } = group[0];
  const trip = db.query(`
    SELECT trip_id,direction,service_kind FROM trip
    WHERE logical_line=? AND service_day=? AND train_no=?
  `).get(line, day, trainNo) as { trip_id: number; direction: string; service_kind: string } | null;

  const repairedStationIds = new Set(group.map((event) => event.stationId));
  const before = trip
    ? existingEvents(Number(trip.trip_id), group[0].sourceId, day, line, trainNo)
      .filter((event) => !repairedStationIds.has(event.stationId))
    : [];
  const combined = orderedDeduped([...before, ...group]);
  if (combined.length < 2) return;

  const kind = trip?.service_kind || serviceKind(group.find((event) => event.rawKind)?.rawKind ?? "");
  if (line === "공항철도" && kind === "direct") return;
  const direction = trip?.direction || inferDirection(combined);
  const actualKind = kind === "direct" ? "local" : kind;
  let tripId = Number(trip?.trip_id ?? 0);

  if (!tripId) {
    db.query(`
      INSERT INTO trip(
        logical_line,service_day,train_no,direction,service_kind,service_priority,
        origin_station_id,destination_station_id
      ) VALUES (?,?,?,?,?,?,?,?)
    `).run(
      line,
      day,
      trainNo,
      direction,
      actualKind,
      servicePriority(actualKind),
      combined[0].stationId,
      combined.at(-1)!.stationId,
    );
    tripId = Number((db.query(`
      SELECT trip_id FROM trip WHERE logical_line=? AND service_day=? AND train_no=?
    `).get(line, day, trainNo) as { trip_id: number }).trip_id);
  } else {
    db.query(`
      UPDATE trip SET origin_station_id=?,destination_station_id=?,direction=? WHERE trip_id=?
    `).run(combined[0].stationId, combined.at(-1)!.stationId, direction, tripId);
    db.query(`DELETE FROM stop_time WHERE trip_id=?`).run(tripId);
  }

  for (const sourceId of new Set(group.map((event) => event.sourceId))) {
    db.query(`INSERT OR IGNORE INTO trip_source(trip_id,source_id) VALUES (?,?)`).run(tripId, sourceId);
  }
  const insertStop = db.prepare(`
    INSERT INTO stop_time(
      trip_id,stop_sequence,station_id,arrival_sec,departure_sec,callable,source_station_code
    ) VALUES (?,?,?,?,?,?,?)
  `);
  combined.forEach((event, index) => insertStop.run(
    tripId,
    index,
    event.stationId,
    event.arrival,
    event.departure,
    1,
    event.stationCode,
  ));
}

try {
  console.log(`[deploy:data] retrying ${units.length} failed KRIC timetable units only`);
  const results = await mapConcurrent(units, REPAIR_CONCURRENCY, fetchUnit);
  const remaining = results.filter((result) => !result.resolved);
  const groups = new Map<string, Event[]>();

  for (const result of results) {
    if (!result.resolved) continue;
    for (const raw of result.rows) {
      const event = eventFromRow(result, raw, result.unit.day);
      if (!event) continue;
      const key = `${event.line}\u0001${event.day}\u0001${event.trainNo}`;
      groups.set(key, [...(groups.get(key) ?? []), event]);
      if (result.unit.day === "END") {
        const sat = { ...event, day: "SAT" as const };
        const satKey = `${sat.line}\u0001SAT\u0001${sat.trainNo}`;
        groups.set(satKey, [...(groups.get(satKey) ?? []), sat]);
      }
    }
  }

  db.transaction(() => {
    for (const group of groups.values()) applyGroup(group);
    metadata(db, "kric_timetable_station_failures", remaining.length);
    metadata(db, "kric_timetable_repaired_units", units.length - remaining.length);
    metadata(db, "kric_timetable_repaired_at", new Date().toISOString());
    metadata(db, "kric_timetable_failures_json", JSON.stringify(remaining.map((result) => result.unit)));
    deriveRideEdges(db);
  })();
  db.exec(`PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);`);

  if (remaining.length) {
    const nextMarker = {
      ...marker,
      failed_timetable_units: remaining.map((result) => result.unit),
      deploy_retry_errors: remaining.map((result) => ({
        ...result.unit,
        errors: result.errors.map((error) => error.slice(0, 500)),
      })),
    };
    await Bun.write(MARKER_PATH, `${JSON.stringify(nextMarker, null, 2)}\n`);
    console.warn(`[deploy:data] ${remaining.length} KRIC timetable units remain unavailable after deploy retry`);
    process.exitCode = 2;
  } else {
    console.log(`[deploy:data] repaired all ${units.length} failed KRIC timetable units`);
  }
} finally {
  db.close();
}
