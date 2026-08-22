import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const path = resolve(Bun.env.TRANSIT_DB_PATH?.trim() || "data/transit.sqlite");
if (!(await Bun.file(path).exists())) throw new Error(`missing ${path}; run bun run build:data first`);
const db = new Database(path, { readonly: true, strict: true });
try {
  const one = (sql: string) => Number((db.query(sql).get() as { n:number } | null)?.n ?? 0);
  const bySource = db.query(`SELECT source,COUNT(*) AS n FROM transfer_pair GROUP BY source ORDER BY source`).all() as Array<{ source:string; n:number }>;
  const rawMissing = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE seconds IS NULL OR seconds < 0`);
  const zero = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE seconds=0`);
  const kricMismatch = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE source='kric-distance-1.2mps' AND (distance_m IS NULL OR seconds != CAST(ROUND(distance_m / 1.2) AS INTEGER))`);
  const details = one(`SELECT COUNT(*) AS n FROM transfer_detail`);
  const result = {
    storage: "sqlite",
    runtime_pair_count: one(`SELECT COUNT(*) AS n FROM transfer_pair`),
    by_source: Object.fromEntries(bySource.map((row) => [row.source, Number(row.n)])),
    zero_second_pairs: zero,
    invalid_duration_pairs: rawMissing,
    kric_1_2mps_formula_mismatches: kricMismatch,
    direction_detail_count: details,
    policy: "Seoul Metro transfer distances/times are authoritative; missing pairs are filled from KRIC distance with seconds=round(distance_m/1.2).",
  };
  console.log(JSON.stringify(result, null, 2));
  if (rawMissing || kricMismatch) process.exitCode = 1;
} finally { db.close(); }

export {};
