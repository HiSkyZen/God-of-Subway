import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { SUPPORTED_LINES } from "./transit-build/common";

const failures: string[] = [];
const path = resolve(Bun.env.TRANSIT_DB_PATH?.trim() || "data/transit.sqlite");
console.log(`[doctor] Bun ${Bun.version}`);
if (typeof Bun.version !== "string") failures.push("Bun runtime unavailable");
if (!(await Bun.file(path).exists())) failures.push(`missing ${path}; run bun run build:data first`);

if (!failures.length) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const one = (sql: string, ...params: Array<string | number>) => Number((db.query(sql).get(...params) as { n:number } | null)?.n ?? 0);
    const integrity = String((db.query(`PRAGMA integrity_check`).get() as Record<string, unknown>)?.integrity_check ?? "");
    if (integrity !== "ok") failures.push(`integrity_check=${integrity}`);
    const fk = db.query(`PRAGMA foreign_key_check`).all().length; if (fk) failures.push(`foreign_key_check=${fk}`);
    const meta = Object.fromEntries((db.query(`SELECT key,value FROM metadata`).all() as Array<{ key:string; value:string }>).map((row) => [row.key, row.value]));
    const lineCount = one(`SELECT COUNT(DISTINCT logical_line) AS n FROM source_registry`);
    const stations = one(`SELECT COUNT(*) AS n FROM station`); const trips = one(`SELECT COUNT(*) AS n FROM trip`); const stops = one(`SELECT COUNT(*) AS n FROM stop_time`); const transfers = one(`SELECT COUNT(*) AS n FROM transfer_pair`);
    const directArex = one(`SELECT COUNT(*) AS n FROM trip WHERE logical_line='공항철도' AND (service_kind='direct' OR service_priority>20)`);
    const invalidTransfer = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE seconds IS NULL OR seconds < 0`);
    const kricMismatch = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE source='kric-distance-1.2mps' AND (distance_m IS NULL OR seconds != CAST(ROUND(distance_m / 1.2) AS INTEGER))`);
    const seoul = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE source='seoul-metro-2025-12-31'`); const kric = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE source='kric-distance-1.2mps'`);
    const missing: string[] = [];
    for (const line of SUPPORTED_LINES) for (const day of ["DAY", "SAT", "END"]) if (!one(`SELECT COUNT(*) AS n FROM trip WHERE logical_line=? AND service_day=?`, line, day)) missing.push(`${line}/${day}`);
    console.log(`[doctor] sqlite=${path}`);
    console.log(`[doctor] schema=${meta.schema_version ?? "?"}, mode=${meta.build_mode ?? "?"}, lines=${lineCount}, stations=${stations}, trips=${trips}, stops=${stops}, transfers=${transfers}`);
    console.log(`[doctor] transfers seoul=${seoul}, kric=${kric}, invalid=${invalidTransfer}, kric_formula_mismatch=${kricMismatch}`);
    if (lineCount !== SUPPORTED_LINES.length) failures.push(`logical lines: ${lineCount} != ${SUPPORTED_LINES.length}`);
    if (!stations || !trips || !stops) failures.push("core SQLite tables must be non-empty");
    if (!transfers) failures.push("transfer_pair is empty");
    if (directArex) failures.push(`AREX direct trips present: ${directArex}`);
    if (invalidTransfer) failures.push(`invalid transfer durations: ${invalidTransfer}`);
    if (kricMismatch) failures.push(`KRIC 1.2m/s formula mismatches: ${kricMismatch}`);
    if (missing.length) failures.push(`missing timetable coverage: ${missing.join(", ")}`);
  } finally { db.close(); }
}

if (failures.length) {
  console.error("\n[doctor] FAIL");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("[doctor] PASS");
