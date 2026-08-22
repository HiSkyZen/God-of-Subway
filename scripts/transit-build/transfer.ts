import { Database } from "bun:sqlite";
import { ALLOW_PARTIAL, BUILD_CONCURRENCY, DISJOINT, KRIC_BASE, SUPPORTED_LINES, TRANSFER_SPEED_MPS, buildSource, cleanName, collectApiRows, kricJson, mapConcurrent, normalizeLine, rowValue, stationId, type ApiRow, type SourceRow, type StationRow } from "./common";

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

type Candidate = { station: StationRow; source: SourceRow; canonical: string };
type KricTransferResult = { candidate: Candidate; rows: ApiRow[] };

function missingTransferCandidates(db: Database, sources: SourceRow[], stations: StationRow[]): Candidate[] {
  const sourceMap = new Map(sources.map((source) => [source.source_id, source]));
  const multi = db.query(`SELECT s.canonical_name,GROUP_CONCAT(DISTINCT sr.logical_line) AS lines FROM station s JOIN station_source ss ON ss.station_id=s.station_id JOIN source_registry sr ON sr.source_id=ss.source_id GROUP BY s.station_id HAVING COUNT(DISTINCT sr.logical_line)>1`).all() as Array<{ canonical_name:string; lines:string }>;
  const wanted = new Map(multi.map((row) => [cleanName(row.canonical_name), row.lines.split(",")]));
  const seen = new Set<string>(); const result: Candidate[] = [];
  for (const station of stations) {
    const canonical = cleanName(station.canonical_name || station.source_station_name); const lines = wanted.get(canonical); const source = sourceMap.get(station.source_id); if (!lines || !source) continue;
    const hasMissing = lines.some((toLine) => {
      if (toLine === source.logical_line || DISJOINT.has(`${canonical}|${source.logical_line}|${toLine}`)) return false;
      const row = db.query(`SELECT 1 AS ok FROM transfer_pair p JOIN station s ON s.station_id=p.station_id WHERE s.canonical_name=? AND p.from_line=? AND p.to_line=? LIMIT 1`).get(canonical, source.logical_line, toLine);
      return !row;
    });
    if (!hasMissing) continue;
    const key = `${station.source_id}|${station.station_code}`; if (seen.has(key)) continue; seen.add(key); result.push({ station, source, canonical });
  }
  return result;
}

async function fetchTransfer(candidate: Candidate): Promise<KricTransferResult> {
  try {
    const payload = await kricJson("convenientInfo/stationTransferInfo", { railOprIsttCd: candidate.source.operator_code, lnCd: candidate.source.line_code, stinCd: candidate.station.station_code }, 1);
    return { candidate, rows: collectApiRows(payload, (row) => rowValue(row, "chtnDst") !== undefined && rowValue(row, "chtnLn") !== undefined) };
  } catch (error) {
    const message = `${candidate.source.source_id}/${candidate.station.station_code}: ${error instanceof Error ? error.message : String(error)}`;
    if (!ALLOW_PARTIAL) throw new Error(`KRIC 환승거리 요청 실패: ${message}`);
    console.warn(`[build:data] partial transfer: ${message}`); return { candidate, rows: [] };
  }
}

export async function loadKricTransferFallback(db: Database, sources: SourceRow[], stations: StationRow[]): Promise<number> {
  const candidates = missingTransferCandidates(db, sources, stations); let inserted = 0; let apiRows = 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source) VALUES (?,?,?,?,?,?)`);
  const results = await mapConcurrent(candidates, Math.min(BUILD_CONCURRENCY, 6), fetchTransfer);
  db.transaction(() => {
    for (const { candidate, rows } of results) {
      apiRows += rows.length; const sid = stationId(db, candidate.canonical);
      for (const row of rows) {
        const distance = Number(String(rowValue(row, "chtnDst") ?? "").replace(/[^0-9.]/g, "")); if (!Number.isFinite(distance) || distance <= 0) continue;
        const toLine = normalizeLine(rowValue(row, "chtnLn"), candidate.canonical); const fromLine = candidate.source.logical_line;
        if (!SUPPORTED_LINES.includes(toLine as never) || toLine === fromLine || DISJOINT.has(`${candidate.canonical}|${fromLine}|${toLine}`)) continue;
        const seconds = Math.round(distance / TRANSFER_SPEED_MPS);
        const forward = insert.run(sid, fromLine, toLine, distance, seconds, "kric-distance-1.2mps"); inserted += Number(forward.changes || 0);
        if (!DISJOINT.has(`${candidate.canonical}|${toLine}|${fromLine}`)) { const reverse = insert.run(sid, toLine, fromLine, distance, seconds, "kric-distance-1.2mps"); inserted += Number(reverse.changes || 0); }
      }
    }
  })();
  buildSource(db, "kric-transfer-distance", `${KRIC_BASE}/convenientInfo/stationTransferInfo`, apiRows, `${candidates.length} missing-transfer station/source requests; INSERT OR IGNORE preserves Seoul Metro; seconds=round(distance_m/${TRANSFER_SPEED_MPS}); credentials omitted`);
  return inserted;
}
