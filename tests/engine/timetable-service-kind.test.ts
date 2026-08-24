import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { TRANSIT_SCHEMA_SQL } from "../../src/infra/transit-schema";
import { loadLiveTimetables } from "../../scripts/transit-build/timetable";
import type { SourceRow, StationRow } from "../../scripts/transit-build/common";

const previousKey = Bun.env.KRIC_API_KEY;
const previousFetch = globalThis.fetch;

const sources: SourceRow[] = [
  { source_id: "main", logical_line: "4호선", operator_code: "OP", operator_name: "operator", line_code: "L", source_line_name: "main", section: "", realtime: "0", timetable: "1", priority: "1" },
  { source_id: "branch", logical_line: "4호선", operator_code: "OP", operator_name: "operator", line_code: "LB", source_line_name: "branch", section: "", realtime: "0", timetable: "1", priority: "1" },
];
const stations: StationRow[] = [
  { source_id: "main", station_code: "A", source_station_name: "A", canonical_name: "A", sequence_hint: "1" },
  { source_id: "main", station_code: "B", source_station_name: "B", canonical_name: "B", sequence_hint: "2" },
  { source_id: "main", station_code: "C", source_station_name: "C", canonical_name: "C", sequence_hint: "3" },
  { source_id: "branch", station_code: "D", source_station_name: "D", canonical_name: "D", sequence_hint: "100" },
  { source_id: "branch", station_code: "E", source_station_name: "E", canonical_name: "E", sequence_hint: "101" },
];

type Row = { trnNo: string; arvTm?: string; dptTm?: string; dayCd: string };
function rowsFor(station: string, dayCd: string): Row[] {
  const at = (trnNo: string, arvTm?: string, dptTm?: string): Row => ({ trnNo, arvTm, dptTm, dayCd });
  switch (station) {
    case "A": return [
      at("SLOW", undefined, "10:00:00"),
      at("FAST", undefined, "10:02:00"),
      at("SKIP", undefined, "11:00:00"),
      at("TERM", undefined, "12:00:00"),
      at("BRANCH", undefined, "13:00:00"),
    ];
    case "B": return [
      at("SLOW", "10:05:00", "10:05:30"),
      at("FAST", "10:04:00", "10:04:30"),
      at("TERM", "12:05:00", undefined),
      at("BRANCH", "13:05:00", undefined),
    ];
    case "C": return [
      at("SLOW", "10:10:00", undefined),
      at("FAST", "10:08:00", undefined),
      at("SKIP", "11:06:00", undefined),
    ];
    case "D": return [at("BRANCH", undefined, "13:06:00")];
    case "E": return [at("BRANCH", "13:10:00", undefined)];
    default: return [];
  }
}

beforeEach(() => {
  Bun.env.KRIC_API_KEY = "test-key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const station = url.searchParams.get("stinCd") ?? "";
    const dayCd = url.searchParams.get("dayCd") ?? "8";
    return new Response(JSON.stringify(rowsFor(station, dayCd)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  if (previousKey == null) delete Bun.env.KRIC_API_KEY;
  else Bun.env.KRIC_API_KEY = previousKey;
});

function buildDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(TRANSIT_SCHEMA_SQL);
  for (const source of sources) {
    db.query(`INSERT INTO source_registry(source_id,logical_line,operator_code,operator_name,line_code,source_line_name,realtime,timetable,section,priority) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      source.source_id, source.logical_line, source.operator_code, source.operator_name, source.line_code, source.source_line_name, 0, 1, "", 1,
    );
  }
  stations.forEach((station, index) => {
    const stationId = index + 1;
    db.query(`INSERT INTO station(station_id,station_key,canonical_name,display_name) VALUES (?,?,?,?)`).run(stationId, `T:${station.source_id}:${station.station_code}`, station.canonical_name, station.canonical_name);
    db.query(`INSERT INTO station_source(source_id,station_code,station_id,source_station_name,sequence_hint) VALUES (?,?,?,?,?)`).run(station.source_id, station.station_code, stationId, station.source_station_name, Number(station.sequence_hint));
  });
  return db;
}

describe("timetable service-kind inference", () => {
  test("overtaking and internal skips are express while termination and branch continuation stay local", async () => {
    const db = buildDb();
    try {
      await loadLiveTimetables(db, sources, stations);
      const rows = db.query(`SELECT train_no,service_kind FROM trip WHERE service_day='DAY' ORDER BY train_no`).all() as Array<{ train_no: string; service_kind: string }>;
      const kinds = Object.fromEntries(rows.map((row) => [row.train_no, row.service_kind]));
      expect(kinds.SLOW).toBe("local");
      expect(kinds.FAST).toBe("express");
      expect(kinds.SKIP).toBe("express");
      expect(kinds.TERM).toBe("local");
      expect(kinds.BRANCH).toBe("local");
    } finally {
      db.close();
    }
  });
});
