import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const path = resolve(Bun.env.TRANSIT_DB_PATH?.trim() || "data/transit.sqlite");
if (!(await Bun.file(path).exists())) throw new Error(`missing ${path}; run bun run build:data first`);
const db = new Database(path, { readonly: true, strict: true });

try {
  const one = (sql: string) => Number((db.query(sql).get() as { n: number } | null)?.n ?? 0);
  const bySource = db.query(`
    SELECT source,COUNT(*) AS n FROM transfer_pair GROUP BY source ORDER BY source
  `).all() as Array<{ source: string; n: number }>;
  const rawMissing = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE seconds IS NULL OR seconds < 0`);
  const zero = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE seconds=0`);
  const forbiddenKricDistance = one(`
    SELECT COUNT(*) AS n FROM transfer_pair
    WHERE lower(source) LIKE '%kric%distance%'
       OR source='runtime-kric-pending'
       OR source='kric-distance-1.2mps'
  `);
  const unverified = one(`SELECT COUNT(*) AS n FROM transfer_pair WHERE source='unverified-transfer-fallback'`);
  const details = one(`SELECT COUNT(*) AS n FROM transfer_detail`);
  const locationHints = one(`SELECT COUNT(*) AS n FROM transfer_location_hint`);
  const nC2Mismatches = one(`
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
             CASE WHEN from_line < to_line
                  THEN from_line || char(31) || to_line
                  ELSE to_line || char(31) || from_line END AS pair_key
      FROM transfer_pair
      WHERE from_line <> to_line
      GROUP BY station_id,pair_key
    ),
    pair_counts AS (
      SELECT station_id,COUNT(*) AS pairs FROM unordered_pairs GROUP BY station_id
    )
    SELECT COUNT(*) AS n
    FROM station_lines sl
    LEFT JOIN pair_counts pc ON pc.station_id=sl.station_id
    WHERE COALESCE(pc.pairs,0) <> sl.n * (sl.n - 1) / 2
  `);

  const result = {
    storage: "sqlite",
    runtime_pair_count: one(`SELECT COUNT(*) AS n FROM transfer_pair`),
    by_source: Object.fromEntries(bySource.map((row) => [row.source, Number(row.n)])),
    zero_second_pairs: zero,
    invalid_duration_pairs: rawMissing,
    forbidden_kric_distance_or_runtime_rows: forbiddenKricDistance,
    unverified_topology_fallback_directed_rows: unverified,
    physical_station_nC2_mismatches: nC2Mismatches,
    direction_detail_count: details,
    kric_location_hint_count: locationHints,
    policy:
      "Seoul Metro transfer time/distance is authoritative; upstream fills missing verified pairs; "
      + "remaining nC2 gaps are non-fatal topology fallbacks. KRIC stationTransferInfo contributes location text only; chtnDst is ignored.",
  };
  console.log(JSON.stringify(result, null, 2));
  if (rawMissing || forbiddenKricDistance || nC2Mismatches) process.exitCode = 1;
} finally {
  db.close();
}

export {};
