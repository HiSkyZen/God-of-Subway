import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TRANSIT_SCHEMA_SQL, TRANSIT_SCHEMA_VERSION } from "../src/infra/transit-schema";
import { ALLOW_PARTIAL, DAYS, ROOT, SUPPORTED_LINES, metadata } from "./transit-build/common";
import { loadFixtureTimetables } from "./transit-build/fixture";
import {
  loadHolidays,
  loadSeoulTransfers,
  loadStaticRegistry,
  loadStationCoordinates,
  loadTransferDetails,
  loadUpstreamTransferFallback,
} from "./transit-build/static";
import { deriveRideEdges, loadLiveTimetables } from "./transit-build/timetable";
import { loadKricTransferLocationHints, seedMissingTransferFallbacks } from "./transit-build/transfer";

const OUTPUT = resolve(ROOT, Bun.env.TRANSIT_DB_PATH?.trim() || "data/transit.sqlite");
const TEMP = `${OUTPUT}.tmp`;
const requestedMode = Bun.env.TRANSIT_DATA_MODE?.trim().toLowerCase() || "live";
const MODE: "fixture" | "live" = requestedMode === "fixture" ? "fixture" : "live";

function verify(db: Database, seoulTransferCount: number): void {
  const integrity = String((db.query(`PRAGMA integrity_check`).get() as Record<string, unknown>).integrity_check ?? "");
  if (integrity !== "ok") throw new Error(`SQLite integrity_check failed: ${integrity}`);
  const foreignKeys = db.query(`PRAGMA foreign_key_check`).all();
  if (foreignKeys.length) throw new Error(`SQLite foreign_key_check failed: ${foreignKeys.length} rows`);

  const directArex = Number((db.query(`
    SELECT COUNT(*) AS n FROM trip
    WHERE logical_line='공항철도' AND (service_kind='direct' OR service_priority>20)
  `).get() as { n: number }).n);
  if (directArex) throw new Error(`공항철도 직통 ${directArex}건이 포함되었습니다.`);

  const retainedSeoul = Number((db.query(`
    SELECT COUNT(*) AS n FROM transfer_pair WHERE source='seoul-metro-2025-12-31'
  `).get() as { n: number }).n);
  if (retainedSeoul !== seoulTransferCount) throw new Error(`서울교통공사 환승 원천이 보존되지 않았습니다: ${retainedSeoul}/${seoulTransferCount}`);

  const forbiddenKricDistance = Number((db.query(`
    SELECT COUNT(*) AS n FROM transfer_pair WHERE lower(source) LIKE '%kric%distance%'
  `).get() as { n: number }).n);
  if (forbiddenKricDistance) throw new Error(`KRIC 환승거리 기반 시간 레코드 금지 위반: ${forbiddenKricDistance}`);

  const invalidTransfers = Number((db.query(`
    SELECT COUNT(*) AS n FROM transfer_pair WHERE seconds IS NULL OR seconds < 0
  `).get() as { n: number }).n);
  if (invalidTransfers) throw new Error(`환승시간 누락/오류: ${invalidTransfers}`);

  const missing: string[] = [];
  for (const line of SUPPORTED_LINES) for (const [day] of DAYS) {
    const count = Number((db.query(`SELECT COUNT(*) AS n FROM trip WHERE logical_line=? AND service_day=?`).get(line, day) as { n: number }).n);
    if (!count) missing.push(`${line}/${day}`);
  }
  if (missing.length && !ALLOW_PARTIAL) throw new Error(`시간표 누락: ${missing.join(", ")}`);
  if (missing.length) console.warn(`[build:data] partial mode timetable omissions: ${missing.join(", ")}`);

  for (const day of ["DAY", "SAT", "END"]) {
    const count = Number((db.query(`SELECT COUNT(*) AS n FROM ride_edge WHERE service_day=?`).get(day) as { n: number }).n);
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
  metadata(db, "transfer_time_policy", "Seoul authoritative -> upstream fallback -> unverified topology fallback; KRIC distance disabled");
  metadata(db, "transfer_position_policy", "Seoul detail -> MOLIT fast-transfer -> upstream verified -> KRIC/KR static location -> KRIC live raw location hint");
  metadata(db, "timetable_source", MODE === "live" ? "KRIC dayCd=8 weekday + dayCd=9 weekend/holiday; SAT copies END" : "deterministic CI fixture");

  const { sources, stations } = loadStaticRegistry(db);
  const coordinateCount = loadStationCoordinates(db);
  metadata(db, "fare_coordinate_rows", coordinateCount);
  const seoulTransferCount = loadSeoulTransfers(db);
  const upstreamTransferCount = loadUpstreamTransferFallback(db);
  const detailCounts = loadTransferDetails(db);
  const fallbackStats = seedMissingTransferFallbacks(db);
  metadata(db, "upstream_transfer_fallback_rows", upstreamTransferCount);
  metadata(db, "missing_verified_transfer_pairs", fallbackStats.missingVerifiedPairs.length);
  metadata(db, "transfer_detail_counts", JSON.stringify(detailCounts));
  loadHolidays(db);

  if (MODE === "fixture") {
    loadFixtureTimetables(db, sources, stations);
    metadata(db, "kric_transfer_location_hint_rows", 0);
  } else {
    await loadLiveTimetables(db, sources, stations);
    const hints = await loadKricTransferLocationHints(db, sources, stations);
    metadata(db, "kric_transfer_location_hint_rows", hints);
  }

  deriveRideEdges(db);
  verify(db, seoulTransferCount);
  db.exec(`PRAGMA optimize; VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;`);
  db.close();
  rmSync(`${TEMP}-wal`, { force: true });
  rmSync(`${TEMP}-shm`, { force: true });

  if (existsSync(OUTPUT)) rmSync(OUTPUT, { force: true });
  renameSync(TEMP, OUTPUT);

  const check = new Database(OUTPUT, { readonly: true, strict: true });
  const counts = Object.fromEntries(
    ["station", "trip", "stop_time", "ride_edge", "transfer_pair", "transfer_detail", "transfer_location_hint", "holiday"].map(
      (table) => [table, Number((check.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)],
    ),
  );
  check.close();
  console.log(`[build:data] ${MODE} SQLite generated: ${JSON.stringify(counts)}; KRIC transfer-distance usage=0`);
} catch (error) {
  try { db.close(); } catch { }
  if (existsSync(TEMP)) rmSync(TEMP, { force: true });
  throw error;
}
