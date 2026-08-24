import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { DATASETS, buildSource, parseTsv, tsvFiles } from "./common";
import { transferStationId } from "./static";

interface CoordinateRow {
  logical_line: string;
  station: string;
  latitude: string;
  longitude: string;
}

function parseCoordinateText(text: string): CoordinateRow[] {
  const normalized = text.replace(/^\uFEFF/u, "").trimEnd();
  if (!normalized) return [];
  const [header, ...lines] = normalized.split(/\r?\n/u);
  const keys = header.split("\t");
  return lines.filter(Boolean).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ""])) as unknown as CoordinateRow;
  });
}

function coordinateRows(dir: string): CoordinateRow[] {
  const rows = tsvFiles(dir).flatMap((path) => parseTsv(path)) as unknown as CoordinateRow[];
  const compressed = resolve(dir, "coordinates.tsv.gz.b64");
  if (!existsSync(compressed)) return rows;
  const encoded = readFileSync(compressed, "utf8").trim();
  if (!encoded) return rows;
  const text = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
  return [...rows, ...parseCoordinateText(text)];
}

/**
 * Fare-distance coordinates only.
 *
 * The source snapshot is normalized from MOLIT 2026-06-30 station metadata.
 * These coordinates must never be used to infer platform walking distance or
 * transfer duration; they exist only to estimate fare-distance when the public
 * fare-settlement distance is unavailable.
 */
export function loadStationCoordinates(db: Database): number {
  const dir = resolve(DATASETS, "stations/coordinates");
  if (!existsSync(dir)) return 0;
  const rows = coordinateRows(dir);
  const update = db.prepare(`UPDATE station SET latitude=?, longitude=? WHERE station_id=?`);
  let loaded = 0;
  db.transaction(() => {
    for (const row of rows) {
      const latitude = Number(row.latitude);
      const longitude = Number(row.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const stationId = transferStationId(db, row.station, row.logical_line, row.logical_line);
      if (!stationId) continue;
      loaded += Number(update.run(latitude, longitude, stationId).changes || 0);
    }
  })();
  buildSource(
    db,
    "molit-station-coordinates",
    "datasets/stations/coordinates/coordinates.tsv.gz.b64",
    loaded,
    "MOLIT 2026-06-30 station coordinates; fare-distance estimate only; never transfer walking time",
  );
  return loaded;
}
