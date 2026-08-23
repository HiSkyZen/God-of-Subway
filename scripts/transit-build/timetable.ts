import { Database } from "bun:sqlite";
import type { TransitServiceDay } from "../../src/infra/transit-schema";
import {
  ALLOW_PARTIAL,
  BUILD_CONCURRENCY,
  DAYS,
  KRIC_BASE,
  SUPPORTED_LINES,
  buildSource,
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
  type SourceRow,
  type StationRow,
} from "./common";

const TIMETABLE_CONCURRENCY = Bun.env.TRANSIT_BUILD_CONCURRENCY?.trim()
  ? BUILD_CONCURRENCY
  : 16;

const ENDPOINTS = [
  { id: "exp", path: "trainUseInfo/subwayTimetableExp" },
  { id: "base", path: "trainUseInfo/subwayTimetable" },
  { id: "station", path: "convenientInfo/stationTimetable" },
] as const;
type EndpointId = typeof ENDPOINTS[number]["id"];

export function insertTrip(
  db: Database,
  line: string,
  day: TransitServiceDay,
  trainNo: string,
  direction: string,
  kind: string,
  sourceIds: string[],
  events: Event[],
): void {
  if (events.length < 2) return;
  const ordered = [...events].sort(
    (a, b) =>
      (a.departure ?? a.arrival ?? Number.MAX_SAFE_INTEGER)
      - (b.departure ?? b.arrival ?? Number.MAX_SAFE_INTEGER)
      || a.sequenceHint - b.sequenceHint,
  );
  const deduped: Event[] = [];
  for (const event of ordered) {
    const last = deduped.at(-1);
    if (
      last
      && last.stationId === event.stationId
      && (last.departure ?? last.arrival) === (event.departure ?? event.arrival)
    ) continue;
    deduped.push(event);
  }
  if (deduped.length < 2) return;

  const isAirportDirect = line === "공항철도"
    && (
      kind === "direct"
      || (
        deduped.length <= 4
        && deduped.some((event) => event.station === "서울역")
        && deduped.some((event) => event.station.startsWith("인천공항"))
      )
    );
  if (isAirportDirect) return;

  const actualKind = kind === "direct" ? "local" : kind;
  db.query(`
    INSERT OR IGNORE INTO trip(
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
    deduped[0].stationId,
    deduped.at(-1)!.stationId,
  );
  const tripId = Number((
    db.query(`SELECT trip_id FROM trip WHERE logical_line=? AND service_day=? AND train_no=?`)
      .get(line, day, trainNo) as { trip_id: number }
  ).trip_id);
  for (const sourceId of new Set(sourceIds)) {
    db.query(`INSERT OR IGNORE INTO trip_source(trip_id,source_id) VALUES (?,?)`).run(tripId, sourceId);
  }
  const insertStop = db.prepare(`
    INSERT OR REPLACE INTO stop_time(
      trip_id,stop_sequence,station_id,arrival_sec,departure_sec,callable,source_station_code
    ) VALUES (?,?,?,?,?,?,?)
  `);
  deduped.forEach((event, index) => {
    insertStop.run(
      tripId,
      index,
      event.stationId,
      event.arrival,
      event.departure,
      1,
      event.stationCode,
    );
  });
}

export function deriveRideEdges(db: Database): void {
  db.exec(`DELETE FROM ride_edge`);
  const rows = db.query(`
    SELECT t.trip_id,t.logical_line,t.service_day,t.service_kind,
           st.stop_sequence,st.station_id,st.arrival_sec,st.departure_sec
    FROM trip t
    JOIN stop_time st ON st.trip_id=t.trip_id
    WHERE st.callable=1
    ORDER BY t.trip_id,st.stop_sequence
  `).all() as Array<{
    trip_id: number;
    logical_line: string;
    service_day: TransitServiceDay;
    service_kind: string;
    stop_sequence: number;
    station_id: number;
    arrival_sec: number | null;
    departure_sec: number | null;
  }>;

  const samples = new Map<string, number[]>();
  let previous: typeof rows[number] | null = null;
  for (const row of rows) {
    if (!previous || previous.trip_id !== row.trip_id) {
      previous = row;
      continue;
    }
    const start = previous.departure_sec ?? previous.arrival_sec;
    let end = row.arrival_sec ?? row.departure_sec;
    if (start !== null && end !== null) {
      while (end < start) end += 86400;
      const seconds = end - start;
      if (seconds >= 20 && seconds <= 7200) {
        const key = [
          row.service_day,
          row.logical_line,
          previous.station_id,
          row.station_id,
          row.service_kind,
        ].join("\u0001");
        samples.set(key, [...(samples.get(key) ?? []), seconds]);
      }
    }
    previous = row;
  }

  const insert = db.prepare(`
    INSERT INTO ride_edge(
      service_day,logical_line,from_station_id,to_station_id,seconds,service_kind,sample_count
    ) VALUES (?,?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (const [key, values] of samples) {
      values.sort((a, b) => a - b);
      const [day, line, from, to, kind] = key.split("\u0001");
      insert.run(
        day,
        line,
        Number(from),
        Number(to),
        values[Math.floor(values.length / 2)],
        kind,
        values.length,
      );
    }
  })();
}

function inferDirection(events: Event[]): string {
  if (events.length < 2) return "";
  const ordered = [...events].sort(
    (a, b) => (a.departure ?? a.arrival ?? 0) - (b.departure ?? b.arrival ?? 0),
  );
  const a = ordered[0].sequenceHint;
  const b = ordered.at(-1)!.sequenceHint;
  return a === b ? "" : a < b ? "DOWN" : "UP";
}

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

type StationRef = { station: StationRow; stationId: number };
type SourceDayJob = {
  source: SourceRow;
  stations: StationRef[];
  day: TransitServiceDay;
  dayCd: string;
};
type SourceDayPlan = {
  job: SourceDayJob;
  endpoint: EndpointId | null;
  probeRows: Array<{ ref: StationRef; rows: ApiRow[] }>;
  requests: number;
};
type StationJob = {
  source: SourceRow;
  ref: StationRef;
  day: TransitServiceDay;
  dayCd: string;
  endpoint: EndpointId;
};
type StationResult = {
  job: StationJob;
  rows: ApiRow[];
  endpoint: EndpointId | null;
  requests: number;
};

function endpointPath(id: EndpointId): string {
  return ENDPOINTS.find((endpoint) => endpoint.id === id)!.path;
}

async function requestRows(
  endpoint: EndpointId,
  job: SourceDayJob,
  ref: StationRef,
  retries = 1,
): Promise<ApiRow[]> {
  return timetableRows(
    await kricJson(endpointPath(endpoint), {
      railOprIsttCd: job.source.operator_code,
      lnCd: job.source.line_code,
      stinCd: ref.station.station_code,
      dayCd: job.dayCd,
    }, retries),
    job.dayCd,
  );
}

async function discoverEndpoint(job: SourceDayJob): Promise<SourceDayPlan> {
  const probes = job.stations.slice(0, Math.min(2, job.stations.length));
  let requests = 0;
  for (const endpoint of ENDPOINTS) {
    for (const ref of probes) {
      requests += 1;
      try {
        const rows = await requestRows(endpoint.id, job, ref, 0);
        if (rows.length) {
          return { job, endpoint: endpoint.id, probeRows: [{ ref, rows }], requests };
        }
      } catch {
      }
    }
  }
  return { job, endpoint: null, probeRows: [], requests };
}

async function fetchStation(job: StationJob): Promise<StationResult> {
  const ordered: EndpointId[] = [
    job.endpoint,
    ...ENDPOINTS.map((endpoint) => endpoint.id).filter((id) => id !== job.endpoint),
  ];
  const errors: string[] = [];
  let requests = 0;
  for (const endpoint of ordered) {
    requests += 1;
    try {
      const rows = await requestRows(endpoint, {
        source: job.source,
        stations: [job.ref],
        day: job.day,
        dayCd: job.dayCd,
      }, job.ref);
      if (rows.length) return { job, rows, endpoint, requests };
    } catch (error) {
      errors.push(`${endpoint}=${error instanceof Error ? error.name : "Error"}`);
    }
  }
  if (errors.length === ordered.length && !ALLOW_PARTIAL) {
    throw new Error(
      `KRIC 시간표 요청 실패: ${job.source.source_id}/${job.ref.station.station_code}/${job.day}: ${errors.join("; ")}`,
    );
  }
  return { job, rows: [], endpoint: null, requests };
}

function eventFromRow(
  source: SourceRow,
  ref: StationRef,
  day: TransitServiceDay,
  raw: ApiRow,
): Event | null {
  const trainNo = String(rowValue(raw, "trnNo", "trainNo") ?? "").trim();
  if (!trainNo) return null;
  return {
    sourceId: source.source_id,
    line: source.logical_line,
    day,
    trainNo,
    stationId: ref.stationId,
    stationCode: ref.station.station_code,
    station: cleanName(ref.station.canonical_name),
    arrival: parseClock(rowValue(raw, "arvTm", "arrTm")),
    departure: parseClock(rowValue(raw, "dptTm", "depTm")),
    sequenceHint: Number(ref.station.sequence_hint || 0),
    rawKind: String(rowValue(raw, "exptCd", "expressCd", "trainType") ?? ""),
  };
}

function appendRows(
  events: Map<string, Event[]>,
  source: SourceRow,
  ref: StationRef,
  day: TransitServiceDay,
  rows: ApiRow[],
): number {
  let added = 0;
  for (const raw of rows) {
    const event = eventFromRow(source, ref, day, raw);
    if (!event) continue;
    const key = `${event.line}\u0001${event.day}\u0001${event.trainNo}`;
    events.set(key, [...(events.get(key) ?? []), event]);
    added += 1;
  }
  return added;
}

function duplicateHolidayAsSaturday(
  events: Map<string, Event[]>,
  lines: readonly string[],
): string[] {
  const fallbackLines: string[] = [];
  for (const line of lines) {
    const hasSaturday = [...events.keys()].some((key) => {
      const [eventLine, day] = key.split("\u0001");
      return eventLine === line && day === "SAT";
    });
    if (hasSaturday) continue;
    const holidayGroups = [...events.entries()].filter(([key]) => {
      const [eventLine, day] = key.split("\u0001");
      return eventLine === line && day === "END";
    });
    if (!holidayGroups.length) continue;
    for (const [key, group] of holidayGroups) {
      const [, , trainNo] = key.split("\u0001");
      events.set(
        `${line}\u0001SAT\u0001${trainNo}`,
        group.map((event) => ({ ...event, day: "SAT" as const })),
      );
    }
    fallbackLines.push(line);
  }
  return fallbackLines;
}

export async function loadLiveTimetables(
  db: Database,
  sources: SourceRow[],
  stations: StationRow[],
): Promise<number> {
  const sourceMap = new Map(sources.map((row) => [row.source_id, row]));
  const stationRefsBySource = new Map<string, StationRef[]>();
  for (const station of stations) {
    const source = sourceMap.get(station.source_id);
    if (!source || source.timetable === "0") continue;
    const row = db.query(
      `SELECT station_id FROM station_source WHERE source_id=? AND station_code=?`,
    ).get(source.source_id, station.station_code) as { station_id: number } | null;
    if (!row) continue;
    const refs = stationRefsBySource.get(source.source_id) ?? [];
    refs.push({ station, stationId: Number(row.station_id) });
    stationRefsBySource.set(source.source_id, refs);
  }

  const sourceDayJobs: SourceDayJob[] = [];
  for (const source of sources) {
    if (source.timetable === "0") continue;
    const refs = stationRefsBySource.get(source.source_id) ?? [];
    if (!refs.length) continue;
    for (const [day, dayCd] of DAYS) sourceDayJobs.push({ source, stations: refs, day, dayCd });
  }

  const plans = await mapConcurrent(
    sourceDayJobs,
    Math.min(TIMETABLE_CONCURRENCY, 16),
    discoverEndpoint,
  );
  const discoveryRequests = plans.reduce((sum, plan) => sum + plan.requests, 0);
  const satPlans = plans.filter((plan) => plan.job.day === "SAT");
  const globalSaturdayUnavailable = satPlans.length > 0 && satPlans.every((plan) => !plan.endpoint);
  if (globalSaturdayUnavailable) {
    console.warn(
      "[build:data] KRIC dayCd=7 returned no timetable rows from representative "
      + "operator/line probes. Saturday station fanout is skipped; END is used "
      + "only as an explicit, metadata-recorded SAT fallback.",
    );
  }

  const events = new Map<string, Event[]>();
  const endpointRows: Record<EndpointId, number> = { exp: 0, base: 0, station: 0 };
  let apiRows = 0;

  for (const plan of plans) {
    if (plan.job.day === "SAT" && globalSaturdayUnavailable) continue;
    if (!plan.endpoint) continue;
    for (const probe of plan.probeRows) {
      const added = appendRows(events, plan.job.source, probe.ref, plan.job.day, probe.rows);
      apiRows += added;
      endpointRows[plan.endpoint] += added;
    }
  }

  const stationJobs: StationJob[] = [];
  for (const plan of plans) {
    if (plan.job.day === "SAT" && globalSaturdayUnavailable) continue;
    if (!plan.endpoint) continue;
    const probedCodes = new Set(plan.probeRows.map((probe) => probe.ref.station.station_code));
    for (const ref of plan.job.stations) {
      if (probedCodes.has(ref.station.station_code)) continue;
      stationJobs.push({
        source: plan.job.source,
        ref,
        day: plan.job.day,
        dayCd: plan.job.dayCd,
        endpoint: plan.endpoint,
      });
    }
  }

  const stationResults = await mapConcurrent(
    stationJobs,
    TIMETABLE_CONCURRENCY,
    fetchStation,
  );
  const stationRequests = stationResults.reduce((sum, result) => sum + result.requests, 0);
  for (const result of stationResults) {
    const added = appendRows(
      events,
      result.job.source,
      result.job.ref,
      result.job.day,
      result.rows,
    );
    apiRows += added;
    if (result.endpoint) endpointRows[result.endpoint] += added;
  }

  const fallbackLines = duplicateHolidayAsSaturday(events, SUPPORTED_LINES);
  metadata(db, "sat_schedule_fallback", fallbackLines.length
    ? `END:${fallbackLines.join(",")}`
    : "none");
  if (fallbackLines.length) {
    console.warn(
      `[build:data] explicit END→SAT fallback applied to ${fallbackLines.length} lines: ${fallbackLines.join(", ")}`,
    );
  }

  db.transaction(() => {
    for (const [key, group] of events) {
      const [line, day, trainNo] = key.split("\u0001") as [
        string,
        TransitServiceDay,
        string,
      ];
      const kind = group
        .map((event) => serviceKind(event.rawKind))
        .sort((a, b) => servicePriority(b) - servicePriority(a))[0] ?? "local";
      insertTrip(
        db,
        line,
        day,
        trainNo,
        inferDirection(group),
        kind,
        group.map((event) => event.sourceId),
        group,
      );
    }
  })();

  const dayRows = Object.fromEntries(
    (["DAY", "SAT", "END"] as const).map((day) => [
      day,
      [...events.entries()]
        .filter(([key]) => key.split("\u0001")[1] === day)
        .reduce((sum, [, group]) => sum + group.length, 0),
    ]),
  );
  console.log(
    `[build:data] KRIC timetable: discovery_requests=${discoveryRequests}, `
    + `station_requests=${stationRequests}, concurrency=${TIMETABLE_CONCURRENCY}, `
    + `rows=${apiRows}, endpoint_rows=${JSON.stringify(endpointRows)}, `
    + `day_rows=${JSON.stringify(dayRows)}, SAT_fallback_lines=${fallbackLines.length}`,
  );

  buildSource(
    db,
    "kric-timetable-exp",
    `${KRIC_BASE}/trainUseInfo/subwayTimetableExp`,
    endpointRows.exp,
    "per-source/day endpoint discovery then station fanout; credentials omitted",
  );
  buildSource(
    db,
    "kric-timetable-base-fallback",
    `${KRIC_BASE}/trainUseInfo/subwayTimetable`,
    endpointRows.base,
    "fallback endpoint selected once per source/day; credentials omitted",
  );
  buildSource(
    db,
    "kric-station-timetable-fallback",
    `${KRIC_BASE}/convenientInfo/stationTimetable`,
    endpointRows.station,
    "last endpoint selected once per source/day; credentials omitted",
  );
  metadata(db, "kric_timetable_requests", discoveryRequests + stationRequests);
  metadata(db, "kric_timetable_concurrency", TIMETABLE_CONCURRENCY);
  return apiRows;
}
