import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

function transferStationId(
  db: Database,
  stationName: string,
  fromLine: string,
  toLine: string,
): number {
  const canonical = cleanName(stationName);
  const row = db.query(`
    SELECT s.station_id
    FROM station s
    JOIN station_source ss ON ss.station_id=s.station_id
    JOIN source_registry sr ON sr.source_id=ss.source_id
    WHERE s.canonical_name=?
      AND sr.logical_line IN (?,?)
    GROUP BY s.station_id
    HAVING COUNT(DISTINCT CASE
      WHEN sr.logical_line IN (?,?) THEN sr.logical_line
    END)=2
    ORDER BY s.station_id
    LIMIT 1
  `).get(canonical, fromLine, toLine, fromLine, toLine) as { station_id: number } | null;
  if (!row) {
    throw new Error(
      `서울교통공사 환승쌍의 단일 물리역을 찾지 못했습니다: ${canonical} ${fromLine}↔${toLine}`,
    );
  }
  return Number(row.station_id);
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

  buildSource(
    db,
    "line-source-registry",
    "datasets/kric/line-sources.tsv",
    sources.length,
    "2026-02-28 operator/line code snapshot",
  );
  buildSource(
    db,
    "station-code-registry",
    "datasets/kric/stations/*.tsv",
    stations.length,
    "2026-02-28 operator/station code snapshot; disjoint homonyms have separate physical station_id",
  );
  return { sources, stations };
}

export function loadSeoulTransfers(db: Database): number {
  const rows = parseTsv(
    resolve(DATASETS, "transfers/seoul-metro-transfer-times.tsv"),
  ) as unknown as TransferRow[];
  const insert = db.prepare(`
    INSERT OR REPLACE INTO transfer_pair(
      station_id,from_line,to_line,distance_m,seconds,source
    ) VALUES (?,?,?,?,?,?)
  `);
  db.transaction(() => {
    for (const row of rows) {
      insert.run(
        transferStationId(db, row.station, row.from_line, row.to_line),
        row.from_line,
        row.to_line,
        Number(row.distance_m),
        Number(row.seconds),
        row.source,
      );
    }
  })();
  buildSource(
    db,
    "seoul-metro-transfer-distance-time",
    "datasets/transfers/seoul-metro-transfer-times.tsv",
    rows.length,
    "Provided 2025-12-31 source; authoritative over runtime KRIC fallback",
  );
  return rows.length;
}

export function loadHolidays(db: Database): number {
  const path = resolve(DATASETS, "calendar/kr-holidays.tsv");
  if (!existsSync(path)) return 0;
  const rows = parseTsv(path);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO holiday(date,name,substitute,source)
    VALUES (?,?,?,?)
  `);
  db.transaction(() => {
    for (const row of rows) {
      insert.run(row.date, row.name, Number(row.substitute || 0), row.source || "calendar");
    }
  })();
  buildSource(db, "kr-holidays", "datasets/calendar/kr-holidays.tsv", rows.length);
  return rows.length;
}
