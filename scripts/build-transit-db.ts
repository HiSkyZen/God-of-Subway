import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TRANSIT_SCHEMA_SQL, TRANSIT_SCHEMA_VERSION } from "../src/infra/transit-schema";
import {
  ALLOW_PARTIAL,
  DAYS,
  ROOT,
  SUPPORTED_LINES,
  TRANSFER_SPEED_MPS,
  metadata,
} from "./transit-build/common";
import { loadFixtureTimetables } from "./transit-build/fixture";
import { loadHolidays, loadSeoulTransfers, loadStaticRegistry } from "./transit-build/static";
import { deriveRideEdges, loadLiveTimetables } from "./transit-build/timetable";
import { seedRuntimeTransferPlaceholders } from "./transit-build/transfer";

const OUTPUT = resolve(ROOT, Bun.env.TRANSIT_DB_PATH?.trim() || "data/transit.sqlite");
const TEMP = `${OUTPUT}.tmp`;
const requestedMode = Bun.env.TRANSIT_DATA_MODE?.trim().toLowerCase() || "";
const hasKricKey = Boolean(Bun.env.KRIC_API_KEY?.trim());
const vercelEnvironment = Bun.env.VERCEL_ENV?.trim().toLowerCase() || "";
const MODE = requestedMode === "fixture"
  ? "fixture"
  : requestedMode === "live"
    ? "live"
    : vercelEnvironment === "preview" && !hasKricKey
      ? "fixture"
      : "live";

if (!requestedMode && vercelEnvironment === "preview" && !hasKricKey) {
  console.log(
    "[build:data] Vercel Preview has no KRIC_API_KEY; using deterministic fixture SQLite. "
    + "Production remains live-by-default.",
  );
}

function verify(db: Database, seoulTransferCount: number): void {
  const integrity = String((
    db.query(`PRAGMA integrity_check`).get() as Record<string, unknown>
  ).integrity_check ?? "");
  if (integrity !== "ok") throw new Error(`SQLite integrity_check failed: ${integrity}`);

  const foreignKeys = db.query(`PRAGMA foreign_key_check`).all();
  if (foreignKeys.length) {
    throw new Error(`SQLite foreign_key_check failed: ${foreignKeys.length} rows`);
  }

  const directArex = Number((
    db.query(`
      SELECT COUNT(*) AS n
      FROM trip
      WHERE logical_line='공항철도'
        AND (service_kind='direct' OR service_priority>20)
    `).get() as { n: number }
  ).n);
  if (directArex) throw new Error(`공항철도 직통 ${directArex}건이 포함되었습니다.`);

  const retainedSeoul = Number((
    db.query(`
      SELECT COUNT(*) AS n
      FROM transfer_pair
      WHERE source='seoul-metro-2025-12-31'
    `).get() as { n: number }
  ).n);
  if (retainedSeoul !== seoulTransferCount) {
    throw new Error(
      `서울교통공사 환승 원천이 보존되지 않았습니다: ${retainedSeoul}/${seoulTransferCount}`,
    );
  }

  const staticKricTransfers = Number((
    db.query(`
      SELECT COUNT(*) AS n
      FROM transfer_pair
      WHERE source='kric-distance-1.2mps'
    `).get() as { n: number }
  ).n);
  if (staticKricTransfers) {
    throw new Error(
      `KRIC 환승거리는 deploy-time DB에 저장하지 않습니다: ${staticKricTransfers}`,
    );
  }

  const invalidTransfers = Number((
    db.query(`
      SELECT COUNT(*) AS n
      FROM transfer_pair
      WHERE seconds IS NULL OR seconds < 0
    `).get() as { n: number }
  ).n);
  if (invalidTransfers) throw new Error(`환승시간 누락/오류: ${invalidTransfers}`);

  const pairCoverage = db.query(`
    WITH station_lines AS (
      SELECT s.station_id, COUNT(DISTINCT sr.logical_line) AS n
      FROM station s
      JOIN station_source ss ON ss.station_id=s.station_id
      JOIN source_registry sr ON sr.source_id=ss.source_id
      GROUP BY s.station_id
      HAVING n > 1
    ),
    unordered_pairs AS (
      SELECT station_id,
             CASE
               WHEN from_line < to_line THEN from_line || char(31) || to_line
               ELSE to_line || char(31) || from_line
             END AS pair_key
      FROM transfer_pair
      WHERE from_line <> to_line
      GROUP BY station_id, pair_key
    ),
    pair_counts AS (
      SELECT station_id, COUNT(*) AS pairs
      FROM unordered_pairs
      GROUP BY station_id
    )
    SELECT sl.station_id, sl.n,
           sl.n * (sl.n - 1) / 2 AS expected,
           COALESCE(pc.pairs, 0) AS actual
    FROM station_lines sl
    LEFT JOIN pair_counts pc ON pc.station_id=sl.station_id
    WHERE COALESCE(pc.pairs, 0) <> sl.n * (sl.n - 1) / 2
  `).all() as Array<{ station_id: number; n: number; expected: number; actual: number }>;
  if (pairCoverage.length) {
    const sample = pairCoverage.slice(0, 5)
      .map((row) => `${row.station_id}:${row.actual}/${row.expected}`)
      .join(", ");
    throw new Error(`환승역 nC2 pair coverage 실패: ${sample}`);
  }

  const missing: string[] = [];
  for (const line of SUPPORTED_LINES) {
    for (const [day] of DAYS) {
      const count = Number((
        db.query(`
          SELECT COUNT(*) AS n
          FROM trip
          WHERE logical_line=? AND service_day=?
        `).get(line, day) as { n: number }
      ).n);
      if (!count) missing.push(`${line}/${day}`);
    }
  }
  if (missing.length && !ALLOW_PARTIAL) {
    throw new Error(`시간표 누락: ${missing.join(", ")}`);
  }
  if (missing.length) {
    console.warn(`[build:data] partial mode timetable omissions: ${missing.join(", ")}`);
  }

  for (const day of ["DAY", "SAT", "END"]) {
    const count = Number((
      db.query(`SELECT COUNT(*) AS n FROM ride_edge WHERE service_day=?`)
        .get(day) as { n: number }
    ).n);
    if (!count) throw new Error(`${day} ride_edge가 비어 있습니다.`);
  }
}

mkdirSync(dirname(OUTPUT), { recursive: true });
if (existsSync(TEMP)) rmSync(TEMP, { force: true });
const db = new Database(TEMP, { create: true, strict: true });

try {
  db.exec(TRANSIT_SCHEMA_SQL);
  metadata(db, "schema_version", TRANSIT_SCHEMA_VERSION);
  metadata(db, "build_mode", MODE);
  metadata(db, "built_at", new Date().toISOString());
  metadata(db, "airport_direct_excluded", true);
  metadata(db, "transfer_fallback_speed_mps", TRANSFER_SPEED_MPS);
  metadata(
    db,
    "transfer_distance_source",
    "Seoul Metro build-time + KRIC stationTransferInfo runtime on-demand",
  );
  metadata(
    db,
    "timetable_source",
    MODE === "live"
      ? "KRIC subwayTimetableExp + subwayTimetable + stationTimetable fallback"
      : "deterministic CI fixture",
  );

  const { sources, stations } = loadStaticRegistry(db);
  const seoulTransferCount = loadSeoulTransfers(db);
  const placeholderStats = seedRuntimeTransferPlaceholders(db);
  metadata(db, "runtime_kric_transfer_physical_pairs", placeholderStats.physicalPairs);
  metadata(db, "runtime_kric_transfer_build_requests", 0);
  loadHolidays(db);

  if (MODE === "fixture") {
    loadFixtureTimetables(db, sources, stations);
  } else {
    await loadLiveTimetables(db, sources, stations);
  }

  deriveRideEdges(db);
  verify(db, seoulTransferCount);
  db.exec(`PRAGMA optimize; VACUUM;`);
  db.close();

  if (existsSync(OUTPUT)) rmSync(OUTPUT, { force: true });
  renameSync(TEMP, OUTPUT);

  const check = new Database(OUTPUT, { readonly: true, strict: true });
  const counts = Object.fromEntries(
    ["station", "trip", "stop_time", "ride_edge", "transfer_pair", "holiday"].map(
      (table) => [
        table,
        Number((check.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n),
      ],
    ),
  );
  check.close();
  console.log(
    `[build:data] ${MODE} SQLite generated: ${JSON.stringify(counts)}; `
    + `KRIC transfer build requests=0`,
  );
} catch (error) {
  try {
    db.close();
  } catch {
  }
  if (existsSync(TEMP)) rmSync(TEMP, { force: true });
  throw error;
}
