import { Database } from "bun:sqlite";
import { KRIC_BASE, buildSource, cleanName } from "./common";
import { unorderedLinePairs, unorderedTransferPairCount } from "../../src/infra/transfer-pairs";

/**
 * Seed routing topology for every physical transfer pair without calling KRIC.
 *
 * A physical station with n logical lines has nC2 distinct unordered line-pairs.
 * SQLite stores directed routing edges, so each unordered pair can produce two
 * rows. Existing Seoul Metro rows are authoritative and INSERT OR IGNORE keeps
 * them unchanged. The 180-second value is a routing placeholder only: runtime
 * KRIC enrichment replaces pending pairs with round(chtnDst / 1.2) before final
 * ETA scoring.
 */
export function seedRuntimeTransferPlaceholders(db: Database): {
  physicalPairs: number;
  directedRows: number;
} {
  const stations = db.query(`
    SELECT s.station_id, s.canonical_name,
           GROUP_CONCAT(DISTINCT sr.logical_line) AS lines
    FROM station s
    JOIN station_source ss ON ss.station_id=s.station_id
    JOIN source_registry sr ON sr.source_id=ss.source_id
    GROUP BY s.station_id
    HAVING COUNT(DISTINCT sr.logical_line) > 1
    ORDER BY s.station_id
  `).all() as Array<{ station_id: number; canonical_name: string; lines: string }>;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO transfer_pair(
      station_id,from_line,to_line,distance_m,seconds,source
    ) VALUES (?,?,?,NULL,180,'runtime-kric-pending')
  `);
  let physicalPairs = 0;
  let directedRows = 0;

  db.transaction(() => {
    for (const row of stations) {
      const station = cleanName(row.canonical_name);
      const lines = [...new Set(
        row.lines.split(",").map((line) => line.trim()).filter(Boolean),
      )].sort();
      const pairs = unorderedLinePairs(lines);
      const expected = unorderedTransferPairCount(lines.length);
      if (pairs.length !== expected) {
        throw new Error(
          `환승쌍 nC2 생성 실패: ${station} lines=${lines.length} pairs=${pairs.length}/${expected}`,
        );
      }

      for (const [a, b] of pairs) {
        physicalPairs += 1;
        directedRows += Number(insert.run(row.station_id, a, b).changes || 0);
        directedRows += Number(insert.run(row.station_id, b, a).changes || 0);
      }
    }
  })();

  buildSource(
    db,
    "runtime-kric-transfer-placeholders",
    `${KRIC_BASE}/convenientInfo/stationTransferInfo`,
    physicalPairs,
    `build-time API requests=0; physical pair topology=nC2; directed placeholder rows inserted=${directedRows}; Seoul Metro rows preserved`,
  );
  return { physicalPairs, directedRows };
}

/** Backward-compatible fixture alias used by older tests/scripts. */
export function seedFixtureMissingTransfers(db: Database): number {
  return seedRuntimeTransferPlaceholders(db).directedRows;
}
