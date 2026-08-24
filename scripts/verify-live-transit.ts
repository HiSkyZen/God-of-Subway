import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(import.meta.dir, "..", Bun.env.TRANSIT_DB_PATH?.trim() || "data/transit.sqlite");
if (!existsSync(path)) throw new Error(`live transit SQLite is missing: ${path}`);

const db = new Database(path, { readonly: true, strict: true });
try {
  const metadataRows = db.query(`SELECT key,value FROM metadata`).all() as Array<{ key: string; value: string }>;
  const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
  if (metadata.get("build_mode") !== "live") {
    throw new Error(`expected live transit SQLite, got build_mode=${metadata.get("build_mode") ?? "missing"}`);
  }

  const failures = Number(metadata.get("kric_timetable_station_failures") ?? "0");
  if (!Number.isFinite(failures) || failures !== 0) {
    throw new Error(`KRIC timetable station failures remain after retries: ${metadata.get("kric_timetable_station_failures") ?? "missing"}`);
  }

  const requests = Number(metadata.get("kric_timetable_requests") ?? "0");
  if (!Number.isFinite(requests) || requests <= 0) {
    throw new Error("KRIC timetable request metadata is missing or empty");
  }

  console.log(`[verify-live-transit] PASS requests=${requests}, station_failures=0`);
} finally {
  db.close();
}
