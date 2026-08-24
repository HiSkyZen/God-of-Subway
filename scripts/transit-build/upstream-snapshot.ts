import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATASETS, buildSource, parseTsv, tsvFiles } from "./common";
import { transferStationId } from "./static";

interface TransferRow { station:string; from_line:string; to_line:string; distance_m:string; seconds:string; source:string; }
const n = (value: string): number | null => value.trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);

/** Deterministic CI/offline snapshot. Seoul rows are loaded first and win. */
export function loadUpstreamTransferSnapshot(db: Database): number {
  const dir = resolve(DATASETS, "transfers/upstream-pairs");
  if (!existsSync(dir)) return 0;
  const rows = tsvFiles(dir).flatMap((path) => parseTsv(path)) as unknown as TransferRow[];
  const insert = db.prepare(`INSERT OR IGNORE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source) VALUES (?,?,?,?,?,?)`);
  let loaded = 0;
  db.transaction(() => {
    for (const row of rows) {
      const stationId = transferStationId(db, row.station, row.from_line, row.to_line);
      const seconds = n(row.seconds);
      if (!stationId || seconds === null || seconds < 0) continue;
      loaded += Number(insert.run(stationId,row.from_line,row.to_line,n(row.distance_m),Math.round(seconds),row.source || "upstream-snapshot").changes || 0);
    }
  })();
  buildSource(db,"upstream-transfer-snapshot","datasets/transfers/upstream-pairs/*.tsv",loaded,"fallback snapshot; Seoul authoritative rows preserved by INSERT OR IGNORE");
  return loaded;
}
