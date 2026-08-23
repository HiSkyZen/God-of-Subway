import { Database } from "bun:sqlite";
import {
  BUILD_CONCURRENCY,
  KRIC_BASE,
  buildSource,
  cleanName,
  collectApiRows,
  kricJson,
  mapConcurrent,
  normalizeLine,
  rowValue,
  type SourceRow,
  type StationRow,
} from "./common";
import { unorderedLinePairs, unorderedTransferPairCount } from "../../src/infra/transfer-pairs";

const UNKNOWN_TRANSFER_SECONDS = 180;
const LIGHT_RAIL_LINES = new Set([
  "용인에버라인", "의정부경전철", "우이신설선", "신림선", "김포골드라인",
]);

interface PhysicalStation {
  station_id: number;
  canonical_name: string;
  lines: string;
}

function physicalTransferStations(db: Database): PhysicalStation[] {
  return db.query(`
    SELECT s.station_id, s.canonical_name,
           GROUP_CONCAT(DISTINCT sr.logical_line) AS lines
    FROM station s
    JOIN station_source ss ON ss.station_id=s.station_id
    JOIN source_registry sr ON sr.source_id=ss.source_id
    GROUP BY s.station_id
    HAVING COUNT(DISTINCT sr.logical_line) > 1
    ORDER BY s.station_id
  `).all() as PhysicalStation[];
}

export function seedMissingTransferFallbacks(db: Database): {
  physicalPairs: number;
  insertedDirectedRows: number;
  missingVerifiedPairs: Array<{ station: string; lines: [string, string] }>;
} {
  const stations = physicalTransferStations(db);
  const insertUnknown = db.prepare(`
    INSERT OR IGNORE INTO transfer_pair(
      station_id,from_line,to_line,distance_m,seconds,source
    ) VALUES (?,?,?,NULL,?,'unverified-transfer-fallback')
  `);
  const insertReverse = db.prepare(`
    INSERT OR IGNORE INTO transfer_pair(
      station_id,from_line,to_line,distance_m,seconds,source
    )
    SELECT station_id, ?, ?, distance_m, seconds, source || ':reverse-fallback'
    FROM transfer_pair
    WHERE station_id=? AND from_line=? AND to_line=?
    LIMIT 1
  `);
  const exists = db.prepare(`
    SELECT source,seconds,distance_m FROM transfer_pair
    WHERE station_id=? AND from_line=? AND to_line=?
  `);
  let physicalPairs = 0;
  let insertedDirectedRows = 0;
  const missingVerifiedPairs: Array<{ station: string; lines: [string, string] }> = [];

  db.transaction(() => {
    for (const row of stations) {
      const station = cleanName(row.canonical_name);
      const lines = [...new Set(row.lines.split(",").map((line) => line.trim()).filter(Boolean))].sort();
      const pairs = unorderedLinePairs(lines);
      const expected = unorderedTransferPairCount(lines.length);
      if (pairs.length !== expected) throw new Error(`환승쌍 nC2 생성 실패: ${station} ${pairs.length}/${expected}`);
      for (const [a, b] of pairs) {
        physicalPairs += 1;
        const ab = exists.get(row.station_id, a, b);
        const ba = exists.get(row.station_id, b, a);
        if (!ab && !ba) {
          missingVerifiedPairs.push({ station, lines: [a, b] });
          insertedDirectedRows += Number(insertUnknown.run(row.station_id, a, b, UNKNOWN_TRANSFER_SECONDS).changes || 0);
          insertedDirectedRows += Number(insertUnknown.run(row.station_id, b, a, UNKNOWN_TRANSFER_SECONDS).changes || 0);
          continue;
        }
        if (!ab && ba) insertedDirectedRows += Number(insertReverse.run(a, b, row.station_id, b, a).changes || 0);
        if (!ba && ab) insertedDirectedRows += Number(insertReverse.run(b, a, row.station_id, a, b).changes || 0);
      }
    }
  })();

  console.warn(`[build:data][transfer-diagnostic] ${JSON.stringify({
    type: "missing_transfer_pairs",
    count: missingVerifiedPairs.length,
    pairs: missingVerifiedPairs,
  })}`);
  buildSource(
    db,
    "unverified-transfer-fallbacks",
    "generated:nC2-after-seoul-and-upstream",
    missingVerifiedPairs.length,
    `non-fatal missing verified pairs; conservative topology=${UNKNOWN_TRANSFER_SECONDS}s; directed rows inserted=${insertedDirectedRows}`,
  );
  return { physicalPairs, insertedDirectedRows, missingVerifiedPairs };
}

function parsePositionHint(raw: unknown): { car: string; door: string } {
  const text = String(raw ?? "").trim();
  if (!text) return { car: "", door: "" };
  const explicit = text.match(/(?:^|\D)(\d{1,2})\s*호차\s*(\d{1,2})\s*(?:번\s*)?(?:문|출입문)(?:\D|$)/u);
  if (explicit) return { car: explicit[1], door: explicit[2] };
  const compact = text.match(/(?:^|\D)(\d{1,2})\s*[-/]\s*(\d{1,2})(?:\D|$)/u);
  return compact ? { car: compact[1], door: compact[2] } : { car: "", door: "" };
}

interface HintJob {
  source: SourceRow;
  station: StationRow;
  stationId: number;
  stationName: string;
  stationLines: string[];
}

export async function loadKricTransferLocationHints(
  db: Database,
  sources: SourceRow[],
  stations: StationRow[],
): Promise<number> {
  const sourceMap = new Map(sources.map((source) => [source.source_id, source]));
  const multi = new Map(physicalTransferStations(db).map((row) => [row.station_id, row]));
  const jobs: HintJob[] = [];
  const seen = new Set<string>();
  for (const station of stations) {
    const source = sourceMap.get(station.source_id);
    if (!source || LIGHT_RAIL_LINES.has(source.logical_line)) continue;
    const linked = db.query(`SELECT station_id FROM station_source WHERE source_id=? AND station_code=?`)
      .get(station.source_id, station.station_code) as { station_id: number } | null;
    if (!linked || !multi.has(Number(linked.station_id))) continue;
    const physical = multi.get(Number(linked.station_id))!;
    const key = `${station.source_id}|${station.station_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({
      source,
      station,
      stationId: Number(linked.station_id),
      stationName: cleanName(physical.canonical_name),
      stationLines: [...new Set(physical.lines.split(",").map((line) => line.trim()).filter(Boolean))],
    });
  }

  const results = await mapConcurrent(jobs, Math.min(8, BUILD_CONCURRENCY), async (job) => {
    try {
      const payload = await kricJson("convenientInfo/stationTransferInfo", {
        railOprIsttCd: job.source.operator_code,
        lnCd: job.source.line_code,
        stinCd: job.station.station_code,
      }, 1);
      const rows = collectApiRows(payload, (row) =>
        rowValue(row, "stLocCont", "clsLocCont", "chtnLn") !== undefined,
      );
      return { job, rows };
    } catch (error) {
      console.warn(`[build:data] KRIC transfer-location hint skipped: ${job.source.source_id}/${job.station.station_code}: ${error instanceof Error ? error.name : "Error"}`);
      return { job, rows: [] };
    }
  });

  const insert = db.prepare(`
    INSERT INTO transfer_location_hint(
      station_id,from_line,to_line,raw_start_location,raw_end_location,
      parsed_alight_car,parsed_alight_door,parsed_board_car,parsed_board_door,source
    ) VALUES (?,?,?,?,?,?,?,?,?,'kric-location-hint')
  `);
  let loaded = 0;
  db.transaction(() => {
    for (const { job, rows } of results) {
      for (const raw of rows) {
        let toLine = normalizeLine(rowValue(raw, "chtnLn"), job.stationName);
        if (!job.stationLines.includes(toLine)) {
          const others = job.stationLines.filter((line) => line !== job.source.logical_line);
          if (others.length === 1) toLine = others[0];
        }
        if (!toLine || toLine === job.source.logical_line || !job.stationLines.includes(toLine)) continue;
        const pair = db.query(`SELECT 1 AS ok FROM transfer_pair WHERE station_id=? AND from_line=? AND to_line=?`)
          .get(job.stationId, job.source.logical_line, toLine);
        if (!pair) continue;
        const startRaw = String(rowValue(raw, "stLocCont") ?? "").trim();
        const endRaw = String(rowValue(raw, "clsLocCont") ?? "").trim();
        if (!startRaw && !endRaw) continue;
        const start = parsePositionHint(startRaw); const end = parsePositionHint(endRaw);
        insert.run(job.stationId, job.source.logical_line, toLine, startRaw, endRaw, start.car, start.door, end.car, end.door);
        loaded += 1;
      }
    }
  })();
  buildSource(db, "kric-transfer-location-hints", `${KRIC_BASE}/convenientInfo/stationTransferInfo`, loaded, "location-only stLocCont/clsLocCont; chtnDst ignored; lower priority than upstream position data");
  return loaded;
}

export function seedFixtureMissingTransfers(db: Database): number {
  return seedMissingTransferFallbacks(db).insertedDirectedRows;
}
