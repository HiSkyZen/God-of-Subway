import { Database } from "bun:sqlite";
import type { TransitServiceDay } from "../../src/infra/transit-schema";
import {
  BUILD_CONCURRENCY,
  API_DAYS,
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
  failed: boolean;
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
      if (rows.length) return { job, rows, endpoint, requests, failed: false };
    } catch (error) {
      errors.push(`${endpoint}=${error instanceof Error ? error.name : "Error"}`);
    }
  }
  const failed = errors.length === ordered.length;
  if (failed) {
    console.warn(`[build:data][kric-station-failure] ${JSON.stringify({
      type: "kric_timetable_station_failure",
      source_id: job.source.source_id,
      station_code: job.ref.station.station_code,
      day: job.day,
      endpoints: errors,
    })}`);
  }
  return { job, rows: [], endpoint: null, requests, failed };
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
  const copied: string[] = [];
  for (const line of lines) {
    const holidayGroups = [...events.entries()].filter(([key]) => {
      const [eventLine, day] = key.split("\u0001");
      return eventLine === line && day === "END";
    });
    if (!holidayGroups.length) continue;
    for (const [key, group] of holidayGroups) {
      const [, , trainNo] = key.split("\u0001");
      events.set(`${line}\u0001SAT\u0001${trainNo}`, group.map((event) => ({ ...event, day: "SAT" as const })));
    }
    copied.push(line);
  }
  return copied;
}

function trustedTrainNumberExpress(line: string, trainNo: string): boolean {
  return line === "1호선" && /^K19\d{2}$/i.test(trainNo.trim());
}

function inferServiceKinds(
  events: Map<string, Event[]>,
  unavailableSequences: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): Map<string, "local" | "express" | "direct"> {
  const kinds = new Map<string, "local" | "express" | "direct">();
  for (const [key, group] of events) {
    const [line, day, trainNo] = key.split("\u0001");
    if (line === "공항철도" && group.some((event) => serviceKind(event.rawKind) === "direct")) { kinds.set(key, "direct"); continue; }
    let express = trustedTrainNumberExpress(line, trainNo);
    const bySource = new Map<string, Event[]>();
    for (const event of group) bySource.set(event.sourceId, [...(bySource.get(event.sourceId) ?? []), event]);
    for (const [sourceId, sourceEvents] of bySource) {
      const seq = [...new Set(sourceEvents.map((event) => event.sequenceHint).filter(Number.isFinite))].sort((a, b) => a - b);
      const unavailable = unavailableSequences.get(`${sourceId}\u0001${day}`);
      const reliableGap = seq.some((value, index) => {
        if (index === 0) return false;
        const previous = seq[index - 1];
        if (value - previous <= 1) return false;
        for (let missing = previous + 1; missing < value; missing += 1) {
          if (unavailable?.has(missing)) return false;
        }
        return true;
      });
      if (reliableGap) { express = true; break; }
    }
    kinds.set(key, express ? "express" : "local");
  }
  const pairRuns = new Map<string, Array<{ key: string; dep: number; arr: number }>>();
  for (const [key, group] of events) {
    if (kinds.get(key) === "direct") continue;
    const [line, day] = key.split("\u0001");
    const ordered = [...group].sort((a, b) => (a.departure ?? a.arrival ?? 0) - (b.departure ?? b.arrival ?? 0));
    const direction = inferDirection(ordered);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const dep = ordered[i].departure ?? ordered[i].arrival; if (dep === null) continue;
      for (let j = i + 1; j < Math.min(ordered.length, i + 9); j += 1) {
        let arr = ordered[j].arrival ?? ordered[j].departure; if (arr === null) continue;
        while (arr < dep) arr += 86400;
        const pairKey = `${line}\u0001${day}\u0001${direction}\u0001${ordered[i].stationId}\u0001${ordered[j].stationId}`;
        pairRuns.set(pairKey, [...(pairRuns.get(pairKey) ?? []), { key, dep, arr }]);
      }
    }
  }
  for (const runs of pairRuns.values()) {
    runs.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
    let slowestPriorArrival = Number.NEGATIVE_INFINITY;
    for (const run of runs) {
      if (run.arr + 30 < slowestPriorArrival) kinds.set(run.key, "express");
      slowestPriorArrival = Math.max(slowestPriorArrival, run.arr);
    }
  }
  return kinds;
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
    for (const [day, dayCd] of API_DAYS) sourceDayJobs.push({ source, stations: refs, day, dayCd });
  }

  const plans = await mapConcurrent(
    sourceDayJobs,
    Math.min(TIMETABLE_CONCURRENCY, 16),
    discoverEndpoint,
  );
  const discoveryRequests = plans.reduce((sum, plan) => sum + plan.requests, 0);

  const events = new Map<string, Event[]>();
  const endpointRows: Record<EndpointId, number> = { exp: 0, base: 0, station: 0 };
  let apiRows = 0;

  for (const plan of plans) {
    if (!plan.endpoint) continue;
    for (const probe of plan.probeRows) {
      const added = appendRows(events, plan.job.source, probe.ref, plan.job.day, probe.rows);
      apiRows += added;
      endpointRows[plan.endpoint] += added;
    }
  }

  const stationJobs: StationJob[] = [];
  for (const plan of plans) {
    if (!plan.endpoint) {
      console.warn(`[build:data][kric-endpoint-discovery-failure] ${JSON.stringify({
        type: "kric_timetable_endpoint_discovery_failure",
        source_id: plan.job.source.source_id,
        day: plan.job.day,
      })}`);
    }
    const probedCodes = new Set(plan.probeRows.map((probe) => probe.ref.station.station_code));
    for (const ref of plan.job.stations) {
      if (probedCodes.has(ref.station.station_code)) continue;
      stationJobs.push({
        source: plan.job.source,
        ref,
        day: plan.job.day,
        dayCd: plan.job.dayCd,
        endpoint: plan.endpoint ?? "station",
      });
    }
  }

  const stationResults = await mapConcurrent(
    stationJobs,
    TIMETABLE_CONCURRENCY,
    fetchStation,
  );
  const stationRequests = stationResults.reduce((sum, result) => sum + result.requests, 0);
  const unavailableSequences = new Map<string, Set<number>>();
  for (const result of stationResults) {
    if (result.failed) {
      for (const day of result.job.day === "END" ? (["END", "SAT"] as const) : ([result.job.day] as const)) {
        const failureKey = `${result.job.source.source_id}\u0001${day}`;
        const unavailable = unavailableSequences.get(failureKey) ?? new Set<number>();
        unavailable.add(Number(result.job.ref.station.sequence_hint || 0));
        unavailableSequences.set(failureKey, unavailable);
      }
    }
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
  metadata(db, "sat_schedule_source", `END(dayCd=9):${fallbackLines.join(",")}`);
  console.log(`[build:data] Saturday uses END(dayCd=9) for ${fallbackLines.length} supported lines; KRIC dayCd=7 requests=0`);

  const inferredKinds = inferServiceKinds(events, unavailableSequences);
  db.transaction(() => {
    for (const [key, group] of events) {
      const [line, day, trainNo] = key.split("\u0001") as [
        string,
        TransitServiceDay,
        string,
      ];
      const kind = inferredKinds.get(key) ?? "local";
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
    + `day_rows=${JSON.stringify(dayRows)}, SAT_from_END_lines=${fallbackLines.length}, dayCd7_requests=0`,
  );

  buildSource(
    db,
    "kric-timetable-exp",
    `${KRIC_BASE}/trainUseInfo/subwayTimetableExp`,
    endpointRows.exp,
    "KRIC-first per-source/day endpoint discovery for dayCd 8/9 only; credentials omitted",
  );
  buildSource(
    db,
    "kric-timetable-base-fallback",
    `${KRIC_BASE}/trainUseInfo/subwayTimetable`,
    endpointRows.base,
    "fallback endpoint for dayCd 8/9 only; credentials omitted",
  );
  buildSource(
    db,
    "kric-station-timetable-fallback",
    `${KRIC_BASE}/convenientInfo/stationTimetable`,
    endpointRows.station,
    "last endpoint for dayCd 8/9 only; credentials omitted",
  );
  metadata(db, "kric_timetable_requests", discoveryRequests + stationRequests);
  metadata(db, "kric_timetable_concurrency", TIMETABLE_CONCURRENCY);
  metadata(db, "kric_timetable_station_failures", stationResults.filter((result) => result.failed).length);
  return apiRows;
}
