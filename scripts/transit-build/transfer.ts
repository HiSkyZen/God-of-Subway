import { Database } from "bun:sqlite";
import { DISJOINT, KRIC_BASE, SUPPORTED_LINES, TRANSFER_SPEED_MPS, buildSource, collectApiRows, kricJson, normalizeLine, rowValue, stationId, type SourceRow, type StationRow } from "./common";

export function seedFixtureMissingTransfers(db: Database): number {
  const rows = db.query(`SELECT s.station_id,s.canonical_name,GROUP_CONCAT(DISTINCT sr.logical_line) AS lines FROM station s JOIN station_source ss ON ss.station_id=s.station_id JOIN source_registry sr ON sr.source_id=ss.source_id GROUP BY s.station_id HAVING COUNT(DISTINCT sr.logical_line)>1`).all() as Array<{ station_id:number; canonical_name:string; lines:string }>;
  let inserted = 0; const insert = db.prepare(`INSERT OR IGNORE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source) VALUES (?,?,?,?,?,?)`);
  db.transaction(() => {
    for (const row of rows) for (const fromLine of row.lines.split(",")) for (const toLine of row.lines.split(",")) {
      if (fromLine === toLine || DISJOINT.has(`${row.canonical_name}|${fromLine}|${toLine}`)) continue;
      const result = insert.run(row.station_id, fromLine, toLine, 120, Math.round(120 / TRANSFER_SPEED_MPS), "fixture-kric-distance-1.2mps"); inserted += Number(result.changes || 0);
    }
  })();
  return inserted;
}

export async function loadKricTransferFallback(db: Database, sources: SourceRow[], stations: StationRow[]): Promise<number> {
  const sourceMap = new Map(sources.map((source) => [source.source_id, source])); let inserted = 0; let apiRows = 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source) VALUES (?,?,?,?,?,?)`);
  for (const station of stations) {
    const source = sourceMap.get(station.source_id); if (!source) continue;
    let payload: unknown;
    try { payload = await kricJson("convenientInfo/stationTransferInfo", { railOprIsttCd: source.operator_code, lnCd: source.line_code, stinCd: station.station_code }, 1); }
    catch { continue; }
    const rows = collectApiRows(payload, (row) => rowValue(row, "chtnDst") !== undefined && rowValue(row, "chtnLn") !== undefined); apiRows += rows.length;
    const sid = stationId(db, station.canonical_name);
    for (const row of rows) {
      const distance = Number(String(rowValue(row, "chtnDst") ?? "").replace(/[^0-9.]/g, "")); if (!Number.isFinite(distance) || distance <= 0) continue;
      const toLine = normalizeLine(rowValue(row, "chtnLn"), station.canonical_name); if (!SUPPORTED_LINES.includes(toLine as never) || toLine === source.logical_line) continue;
      const result = insert.run(sid, source.logical_line, toLine, distance, Math.round(distance / TRANSFER_SPEED_MPS), "kric-distance-1.2mps"); inserted += Number(result.changes || 0);
    }
  }
  buildSource(db, "kric-transfer-distance", `${KRIC_BASE}/convenientInfo/stationTransferInfo`, apiRows, `Only fills Seoul Metro omissions; seconds=round(distance_m/${TRANSFER_SPEED_MPS}); credentials omitted`);
  return inserted;
}
