import { Database } from "bun:sqlite";
import type { TransitServiceDay } from "../../src/infra/transit-schema";
import { ALLOW_PARTIAL, BUILD_CONCURRENCY, DAYS, KRIC_BASE, buildSource, cleanName, collectApiRows, kricJson, mapConcurrent, parseClock, rowValue, serviceKind, servicePriority, type ApiRow, type Event, type SourceRow, type StationRow } from "./common";

export function insertTrip(db: Database, line: string, day: TransitServiceDay, trainNo: string, direction: string, kind: string, sourceIds: string[], events: Event[]): void {
  if (events.length < 2) return;
  const ordered = [...events].sort((a, b) => (a.departure ?? a.arrival ?? Number.MAX_SAFE_INTEGER) - (b.departure ?? b.arrival ?? Number.MAX_SAFE_INTEGER) || a.sequenceHint - b.sequenceHint);
  const deduped: Event[] = [];
  for (const event of ordered) { const last = deduped.at(-1); if (last && last.stationId === event.stationId && (last.departure ?? last.arrival) === (event.departure ?? event.arrival)) continue; deduped.push(event); }
  if (deduped.length < 2) return;
  const isAirportDirect = line === "공항철도" && (kind === "direct" || (deduped.length <= 4 && deduped.some((event) => event.station === "서울역") && deduped.some((event) => event.station.startsWith("인천공항"))));
  if (isAirportDirect) return;
  const actualKind = kind === "direct" ? "local" : kind;
  db.query(`INSERT OR IGNORE INTO trip(logical_line,service_day,train_no,direction,service_kind,service_priority,origin_station_id,destination_station_id) VALUES (?,?,?,?,?,?,?,?)`).run(line, day, trainNo, direction, actualKind, servicePriority(actualKind), deduped[0].stationId, deduped.at(-1)!.stationId);
  const tripId = Number((db.query(`SELECT trip_id FROM trip WHERE logical_line=? AND service_day=? AND train_no=?`).get(line, day, trainNo) as { trip_id: number }).trip_id);
  for (const sourceId of new Set(sourceIds)) db.query(`INSERT OR IGNORE INTO trip_source(trip_id,source_id) VALUES (?,?)`).run(tripId, sourceId);
  const insertStop = db.prepare(`INSERT OR REPLACE INTO stop_time(trip_id,stop_sequence,station_id,arrival_sec,departure_sec,callable,source_station_code) VALUES (?,?,?,?,?,?,?)`);
  deduped.forEach((event, index) => insertStop.run(tripId, index, event.stationId, event.arrival, event.departure, 1, event.stationCode));
}

export function deriveRideEdges(db: Database): void {
  db.exec(`DELETE FROM ride_edge`);
  const rows = db.query(`SELECT t.trip_id,t.logical_line,t.service_day,t.service_kind,st.stop_sequence,st.station_id,st.arrival_sec,st.departure_sec FROM trip t JOIN stop_time st ON st.trip_id=t.trip_id WHERE st.callable=1 ORDER BY t.trip_id,st.stop_sequence`).all() as Array<{ trip_id:number; logical_line:string; service_day:TransitServiceDay; service_kind:string; stop_sequence:number; station_id:number; arrival_sec:number|null; departure_sec:number|null }>;
  const samples = new Map<string, number[]>(); let previous: typeof rows[number] | null = null;
  for (const row of rows) {
    if (!previous || previous.trip_id !== row.trip_id) { previous = row; continue; }
    const start = previous.departure_sec ?? previous.arrival_sec; let end = row.arrival_sec ?? row.departure_sec;
    if (start !== null && end !== null) { while (end < start) end += 86400; const seconds = end - start; if (seconds >= 20 && seconds <= 7200) { const key = `${row.service_day}\u0001${row.logical_line}\u0001${previous.station_id}\u0001${row.station_id}\u0001${row.service_kind}`; samples.set(key, [...(samples.get(key) ?? []), seconds]); } }
    previous = row;
  }
  const insert = db.prepare(`INSERT INTO ride_edge(service_day,logical_line,from_station_id,to_station_id,seconds,service_kind,sample_count) VALUES (?,?,?,?,?,?,?)`);
  db.transaction(() => { for (const [key, values] of samples) { values.sort((a,b)=>a-b); const [day,line,from,to,kind] = key.split("\u0001"); insert.run(day,line,Number(from),Number(to),values[Math.floor(values.length/2)],kind,values.length); } })();
}

function inferDirection(events: Event[]): string { if (events.length < 2) return ""; const ordered=[...events].sort((a,b)=>(a.departure??a.arrival??0)-(b.departure??b.arrival??0)); const a=ordered[0].sequenceHint, b=ordered.at(-1)!.sequenceHint; return a === b ? "" : a < b ? "DOWN" : "UP"; }
function timetableRows(payload: unknown): ApiRow[] { return collectApiRows(payload, (row) => rowValue(row, "trnNo", "trainNo") !== undefined && rowValue(row, "arvTm", "dptTm", "arrTm", "depTm") !== undefined); }

type TimetableJob = { source: SourceRow; station: StationRow; stationId: number; day: TransitServiceDay; dayCd: string };
type TimetableResult = { job: TimetableJob; rows: ApiRow[]; source: "exp" | "station" | "empty" };

async function fetchTimetable(job: TimetableJob): Promise<TimetableResult> {
  const params = { railOprIsttCd: job.source.operator_code, lnCd: job.source.line_code, stinCd: job.station.station_code, dayCd: job.dayCd };
  let expError = "";
  try {
    const rows = timetableRows(await kricJson("trainUseInfo/subwayTimetableExp", params));
    if (rows.length) return { job, rows, source: "exp" };
  } catch (error) { expError = error instanceof Error ? error.message : String(error); }
  try {
    const rows = timetableRows(await kricJson("convenientInfo/stationTimetable", params));
    return { job, rows, source: rows.length ? "station" : "empty" };
  } catch (error) {
    const fallbackError = error instanceof Error ? error.message : String(error);
    const message = `${job.source.source_id}/${job.station.station_code}/${job.day}: exp=${expError || "empty"}; station=${fallbackError}`;
    if (!ALLOW_PARTIAL) throw new Error(`KRIC 시간표 요청 실패: ${message}`);
    console.warn(`[build:data] partial timetable: ${message}`);
    return { job, rows: [], source: "empty" };
  }
}

export async function loadLiveTimetables(db: Database, sources: SourceRow[], stations: StationRow[]): Promise<number> {
  const sourceMap = new Map(sources.map((row) => [row.source_id, row])); const jobs: TimetableJob[] = [];
  for (const station of stations) {
    const source = sourceMap.get(station.source_id); if (!source || source.timetable === "0") continue;
    const row = db.query(`SELECT station_id FROM station_source WHERE source_id=? AND station_code=?`).get(source.source_id, station.station_code) as { station_id:number } | null;
    if (!row) continue;
    for (const [day, dayCd] of DAYS) jobs.push({ source, station, stationId: Number(row.station_id), day, dayCd });
  }

  const results = await mapConcurrent(jobs, BUILD_CONCURRENCY, fetchTimetable);
  const events = new Map<string, Event[]>(); let apiRows = 0; let expRows = 0; let fallbackRows = 0; let emptyRequests = 0;
  for (const result of results) {
    apiRows += result.rows.length; if (result.source === "exp") expRows += result.rows.length; else if (result.source === "station") fallbackRows += result.rows.length; else emptyRequests += 1;
    const { source, station, stationId, day } = result.job;
    for (const raw of result.rows) {
      const trainNo = String(rowValue(raw, "trnNo", "trainNo") ?? "").trim(); if (!trainNo) continue;
      const key = `${source.logical_line}\u0001${day}\u0001${trainNo}`;
      const event: Event = { sourceId: source.source_id, line: source.logical_line, day, trainNo, stationId, stationCode: station.station_code, station: cleanName(station.canonical_name), arrival: parseClock(rowValue(raw,"arvTm","arrTm")), departure: parseClock(rowValue(raw,"dptTm","depTm")), sequenceHint: Number(station.sequence_hint || 0), rawKind: String(rowValue(raw,"exptCd","expressCd","trainType") ?? "") };
      events.set(key, [...(events.get(key) ?? []), event]);
    }
  }

  db.transaction(() => {
    for (const [key, group] of events) {
      const [line, day, trainNo] = key.split("\u0001") as [string, TransitServiceDay, string];
      const kind = group.map((event) => serviceKind(event.rawKind)).sort((a,b)=>servicePriority(b)-servicePriority(a))[0] ?? "local";
      insertTrip(db, line, day, trainNo, inferDirection(group), kind, group.map((event)=>event.sourceId), group);
    }
  })();
  buildSource(db, "kric-timetable-exp", `${KRIC_BASE}/trainUseInfo/subwayTimetableExp`, expRows, `${jobs.length} station/day jobs; bounded concurrency=${BUILD_CONCURRENCY}; credentials omitted`);
  buildSource(db, "kric-station-timetable-fallback", `${KRIC_BASE}/convenientInfo/stationTimetable`, fallbackRows, `${emptyRequests} jobs remained empty after fallback; credentials omitted`);
  return apiRows;
}
