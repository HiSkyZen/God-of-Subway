import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATASETS, buildSource, parseTsv, stationId, tsvFiles, type SourceRow, type StationRow } from "./common";

interface TransferRow { station: string; from_line: string; to_line: string; distance_m: string; seconds: string; source: string; }

export function loadStaticRegistry(db: Database): { sources: SourceRow[]; stations: StationRow[] } {
  const sources = parseTsv(resolve(DATASETS, "kric/line-sources.tsv")) as unknown as SourceRow[];
  const stations = tsvFiles(resolve(DATASETS, "kric/stations")).flatMap((path) => parseTsv(path)) as unknown as StationRow[];
  const insertSource = db.prepare(`INSERT INTO source_registry(source_id,logical_line,operator_code,operator_name,line_code,source_line_name,realtime,timetable,section,priority) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertStationSource = db.prepare(`INSERT OR REPLACE INTO station_source(source_id,station_code,station_id,source_station_name,sequence_hint) VALUES (?,?,?,?,?)`);
  db.transaction(() => {
    for (const source of sources) insertSource.run(source.source_id, source.logical_line, source.operator_code, source.operator_name, source.line_code, source.source_line_name, Number(source.realtime || 0), Number(source.timetable || 1), source.section || "", Number(source.priority || 0));
    for (const row of stations) insertStationSource.run(row.source_id, row.station_code, stationId(db, row.canonical_name || row.source_station_name), row.source_station_name, Number(row.sequence_hint || 0));
  })();
  buildSource(db, "line-source-registry", "datasets/kric/line-sources.tsv", sources.length, "2026-02-28 operator/line code snapshot");
  buildSource(db, "station-code-registry", "datasets/kric/stations/*.tsv", stations.length, "2026-02-28 operator/station code snapshot");
  return { sources, stations };
}

export function loadSeoulTransfers(db: Database): number {
  const rows = parseTsv(resolve(DATASETS, "transfers/seoul-metro-transfer-times.tsv")) as unknown as TransferRow[];
  const insert = db.prepare(`INSERT OR REPLACE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source) VALUES (?,?,?,?,?,?)`);
  db.transaction(() => { for (const row of rows) insert.run(stationId(db, row.station), row.from_line, row.to_line, Number(row.distance_m), Number(row.seconds), row.source); })();
  buildSource(db, "seoul-metro-transfer-distance-time", "datasets/transfers/seoul-metro-transfer-times.tsv", rows.length, "Provided 2025-12-31 source; authoritative over KRIC fallback");
  return rows.length;
}

export function loadHolidays(db: Database): number {
  const path = resolve(DATASETS, "calendar/kr-holidays.tsv"); if (!existsSync(path)) return 0;
  const rows = parseTsv(path); const insert = db.prepare(`INSERT OR REPLACE INTO holiday(date,name,substitute,source) VALUES (?,?,?,?)`);
  db.transaction(() => { for (const row of rows) insert.run(row.date, row.name, Number(row.substitute || 0), row.source || "calendar"); })();
  buildSource(db, "kr-holidays", "datasets/calendar/kr-holidays.tsv", rows.length); return rows.length;
}
