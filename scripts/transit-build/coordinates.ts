import { Database } from "bun:sqlite";
import { DATASETS, buildSource, parseTsv, tsvFiles } from "./common";
import { transferStationId } from "./static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

interface CoordinateRow {
  logical_line: string;
  station: string;
  latitude: string;
  longitude: string;
}

/** Fare-distance coordinates only. Never use these values for transfer walking time. */
export function loadStationCoordinates(db: Database): number {
  const dir = resolve(DATASETS, "stations/coordinates");
  if (!existsSync(dir)) return 0;
  const rows = tsvFiles(dir).flatMap((path) => parseTsv(path)) as unknown as CoordinateRow[];
  const update = db.prepare(`UPDATE station SET latitude=?, longitude=? WHERE station_id=?`);
  let loaded = 0;
  db.transaction(() => {
    for (const row of rows) {
      const latitude = Number(row.latitude); const longitude = Number(row.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const stationId = transferStationId(db, row.station, row.logical_line, row.logical_line);
      if (!stationId) continue;
      loaded += Number(update.run(latitude, longitude, stationId).changes || 0);
    }
  })();
  buildSource(db, "molit-station-coordinates", "datasets/stations/coordinates/*.tsv", loaded,
    "MOLIT 2026-06-30 station coordinates; fare-distance estimate only; never transfer walking time");
  return loaded;
}
