import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  DATASETS,
  buildSource,
  cleanName,
  parseTsv,
  tsvFiles,
  type SourceRow,
  type StationRow,
} from "./common";

interface TransferRow {
  station: string;
  from_line: string;
  to_line: string;
  distance_m: string;
  seconds: string;
  source: string;
  time_source?: string;
  note?: string;
}
interface CoordinateRow { logical_line: string; station: string; latitude: string; longitude: string; source?: string; }
interface TransferDetailRow {
  station: string;
  from_line: string;
  to_line: string;
  from_direction: string;
  to_direction: string;
  alight_car: string;
  alight_door: string;
  board_car: string;
  board_door: string;
  seconds: string;
  source: string;
  position_source?: string;
}

function parseDatasetTsv(relativePath: string): Record<string, string>[] {
  const path = resolve(DATASETS, relativePath);
  if (!path.endsWith(".gz")) return parseTsv(path);
  const text = gunzipSync(readFileSync(path)).toString("utf8").replace(/^\uFEFF/, "").trimEnd();
  if (!text) return [];
  const [header, ...lines] = text.split(/\r?\n/);
  const keys = header.split("\t");
  return lines.filter(Boolean).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ""]));
  });
}

const DISJOINT_PHYSICAL_LINES: Record<string, ReadonlySet<string>> = {
  신촌: new Set(["2호선", "경의중앙선"]),
  양평: new Set(["5호선", "경의중앙선"]),
};

function physicalStationId(db: Database, name: string, logicalLine: string): number {
  const canonical = cleanName(name);
  const disjoint = DISJOINT_PHYSICAL_LINES[canonical]?.has(logicalLine) ?? false;
  const key = disjoint ? `KR:${canonical}:${logicalLine}` : `KR:${canonical}`;
  db.query(`
    INSERT OR IGNORE INTO station(station_key,canonical_name,display_name)
    VALUES (?,?,?)
  `).run(key, canonical, canonical);
  return Number((
    db.query(`SELECT station_id FROM station WHERE station_key=?`).get(key) as { station_id: number }
  ).station_id);
}

export function transferStationId(
  db: Database,
  stationName: string,
  fromLine: string,
  toLine: string,
): number | null {
  const canonical = cleanName(stationName);
  if (fromLine === toLine) {
    const sameLine = db.query(`
      SELECT s.station_id
      FROM station s
      JOIN station_source ss ON ss.station_id=s.station_id
      JOIN source_registry sr ON sr.source_id=ss.source_id
      WHERE s.canonical_name=? AND sr.logical_line=?
      GROUP BY s.station_id
      ORDER BY s.station_id
      LIMIT 1
    `).get(canonical, fromLine) as { station_id: number } | null;
    return sameLine ? Number(sameLine.station_id) : null;
  }

  const row = db.query(`
    SELECT s.station_id
    FROM station s
    JOIN station_source ss ON ss.station_id=s.station_id
    JOIN source_registry sr ON sr.source_id=ss.source_id
    WHERE s.canonical_name=? AND sr.logical_line IN (?,?)
    GROUP BY s.station_id
    HAVING COUNT(DISTINCT CASE WHEN sr.logical_line IN (?,?) THEN sr.logical_line END)=2
    ORDER BY s.station_id
    LIMIT 1
  `).get(canonical, fromLine, toLine, fromLine, toLine) as { station_id: number } | null;
  return row ? Number(row.station_id) : null;
}

export function loadStaticRegistry(db: Database): {
  sources: SourceRow[];
  stations: StationRow[];
} {
  const sources = parseTsv(resolve(DATASETS, "kric/line-sources.tsv")) as unknown as SourceRow[];
  const stations = tsvFiles(resolve(DATASETS, "kric/stations"))
    .flatMap((path) => parseTsv(path)) as unknown as StationRow[];
  const sourceMap = new Map(sources.map((source) => [source.source_id, source]));
  const insertSource = db.prepare(`
    INSERT INTO source_registry(
      source_id,logical_line,operator_code,operator_name,line_code,source_line_name,
      realtime,timetable,section,priority
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const insertStationSource = db.prepare(`
    INSERT OR REPLACE INTO station_source(
      source_id,station_code,station_id,source_station_name,sequence_hint
    ) VALUES (?,?,?,?,?)
  `);

  db.transaction(() => {
    for (const source of sources) {
      insertSource.run(
        source.source_id,
        source.logical_line,
        source.operator_code,
        source.operator_name,
        source.line_code,
        source.source_line_name,
        Number(source.realtime || 0),
        Number(source.timetable || 1),
        source.section || "",
        Number(source.priority || 0),
      );
    }
    for (const row of stations) {
      const source = sourceMap.get(row.source_id);
      if (!source) throw new Error(`unknown station source_id: ${row.source_id}`);
      insertStationSource.run(
        row.source_id,
        row.station_code,
        physicalStationId(
          db,
          row.canonical_name || row.source_station_name,
          source.logical_line,
        ),
        row.source_station_name,
        Number(row.sequence_hint || 0),
      );
    }
  })();

  buildSource(db, "line-source-registry", "datasets/kric/line-sources.tsv", sources.length, "2026-02-28 operator/line code snapshot");
  buildSource(db, "station-code-registry", "datasets/kric/stations/*.tsv", stations.length, "2026-02-28 operator/station code snapshot; disjoint homonyms have separate physical station_id");
  return { sources, stations };
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}

export function loadStationCoordinates(db: Database): number {
  const path = resolve(DATASETS, "stations/station-coordinates.tsv.gz");
  if (!existsSync(path)) return 0;
  const rows = parseDatasetTsv("stations/station-coordinates.tsv.gz") as unknown as CoordinateRow[];
  const update = db.prepare(`UPDATE station SET latitude=?, longitude=? WHERE station_id=?`);
  let updated = 0;
  db.transaction(() => {
    for (const row of rows) {
      const stationId = transferStationId(db, row.station, row.logical_line, row.logical_line);
      const latitude = Number(row.latitude); const longitude = Number(row.longitude);
      if (!stationId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      updated += Number(update.run(latitude, longitude, stationId).changes || 0);
    }
  })();
  buildSource(db, "molit-station-coordinates", "datasets/stations/station-coordinates.tsv.gz", updated,
    "MOLIT 2026-06-30 station coordinates; fare-distance estimate only; never used for transfer time");
  return updated;
}

export function loadSeoulTransfers(db: Database): number {
  const rows = parseTsv(resolve(DATASETS, "transfers/seoul-metro-transfer-times.tsv")) as unknown as TransferRow[];
  const insert = db.prepare(`
    INSERT OR REPLACE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source)
    VALUES (?,?,?,?,?,?)
  `);
  let loaded = 0;
  db.transaction(() => {
    for (const row of rows) {
      const stationId = transferStationId(db, row.station, row.from_line, row.to_line);
      if (!stationId) continue;
      insert.run(stationId, row.from_line, row.to_line, numberOrNull(row.distance_m), numberOrNull(row.seconds), row.source);
      loaded += 1;
    }
  })();
  buildSource(db, "seoul-metro-transfer-distance-time", "datasets/transfers/seoul-metro-transfer-times.tsv", loaded, "Provided 2025-12-31 source; authoritative transfer time/distance where present");
  return loaded;
}

export function loadUpstreamTransferFallback(db: Database): number {
  const path = resolve(DATASETS, "transfers/upstream-fallback-pairs.tsv.gz");
  if (!existsSync(path)) return 0;
  const rows = parseDatasetTsv("transfers/upstream-fallback-pairs.tsv.gz") as unknown as TransferRow[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source)
    VALUES (?,?,?,?,?,?)
  `);
  let loaded = 0;
  db.transaction(() => {
    for (const row of rows) {
      const stationId = transferStationId(db, row.station, row.from_line, row.to_line);
      if (!stationId) continue;
      loaded += Number(insert.run(
        stationId,
        row.from_line,
        row.to_line,
        numberOrNull(row.distance_m),
        numberOrNull(row.seconds),
        row.source || "upstream-fallback",
      ).changes || 0);
    }
  })();
  buildSource(db, "upstream-transfer-fallback", "datasets/transfers/upstream-fallback-pairs.tsv.gz", loaded, "Imported only for pairs absent from authoritative Seoul Metro transfer-time data; includes audited same-line branch/platform changes");
  return loaded;
}

function loadDetailFile(db: Database, relativePath: string, sourceName: string, sourcePrefix = ""): number {
  const path = resolve(DATASETS, relativePath);
  if (!existsSync(path)) return 0;
  const rows = parseDatasetTsv(relativePath) as unknown as TransferDetailRow[];
  const insert = db.prepare(`
    INSERT INTO transfer_detail(
      station_id,from_line,to_line,from_direction,to_direction,
      alight_car,alight_door,board_car,board_door,seconds,source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  let loaded = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (sourcePrefix && !String(row.source || "").startsWith(sourcePrefix)) continue;
      const stationId = transferStationId(db, row.station, row.from_line, row.to_line);
      if (!stationId) continue;
      insert.run(
        stationId,
        row.from_line,
        row.to_line,
        cleanName(row.from_direction || ""),
        cleanName(row.to_direction || ""),
        row.alight_car || "",
        row.alight_door || "",
        row.board_car || "",
        row.board_door || "",
        numberOrNull(row.seconds),
        row.source || sourceName,
      );
      loaded += 1;
    }
  })();
  buildSource(db, sourceName, `datasets/${relativePath}`, loaded);
  return loaded;
}

/**
 * Positional precedence is encoded by insertion order because runtime keeps the
 * lowest detail_id among equally direction-matched records. KRIC/KR static
 * location records are intentionally below upstream: their position text is
 * useful as a last-resort hint, but neither coordinates nor chtnDst are reliable
 * enough to infer walking duration.
 *
 * Seoul Metro detail > MOLIT fast-transfer > upstream verified > KRIC/KR static.
 * Live KRIC stLocCont/clsLocCont hints are loaded separately after these rows.
 */
export function loadTransferDetails(db: Database): Record<string, number> {
  const seoul = loadDetailFile(db, "transfers/seoul-metro-transfer-details.tsv.gz", "seoul-metro-transfer-detail-2026-03-03");
  const molit = loadDetailFile(db, "transfers/public-transfer-details.tsv.gz", "molit-fast-transfer-position", "molit-fast-transfer");
  const upstream = loadDetailFile(db, "transfers/upstream-transfer-details.tsv.gz", "upstream-transfer-detail-fallback");
  const kricStatic = loadDetailFile(db, "transfers/public-transfer-details.tsv.gz", "kric-static-position-fallback", "kric-static-position");
  return { seoul, molit, upstream, kric_static: kricStatic };
}

export function loadHolidays(db: Database): number {
  const path = resolve(DATASETS, "calendar/kr-holidays.tsv");
  if (!existsSync(path)) return 0;
  const rows = parseTsv(path);
  const insert = db.prepare(`INSERT OR REPLACE INTO holiday(date,name,substitute,source) VALUES (?,?,?,?)`);
  db.transaction(() => {
    for (const row of rows) insert.run(row.date, row.name, Number(row.substitute || 0), row.source || "calendar");
  })();
  buildSource(db, "kr-holidays", "datasets/calendar/kr-holidays.tsv", rows.length);
  return rows.length;
}
