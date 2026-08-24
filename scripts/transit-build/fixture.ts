import { Database } from "bun:sqlite";
import type { TransitServiceDay } from "../../src/infra/transit-schema";
import { buildSource, cleanName, stationId, type Event, type SourceRow, type StationRow } from "./common";
import { insertTrip } from "./timetable";

function pathForSource(source: SourceRow, stations: StationRow[]): StationRow[] {
  if (source.logical_line.startsWith("GTX-A")) return [];
  return stations
    .filter((row) => row.source_id === source.source_id)
    .sort((a, b) => Number(a.sequence_hint) - Number(b.sequence_hint));
}

function fixtureEvents(
  db: Database,
  source: SourceRow,
  path: StationRow[],
  day: TransitServiceDay,
  trainNo: string,
  start: number,
  reverse: boolean,
  kind: string,
): Event[] {
  const list = reverse ? [...path].reverse() : path;
  return list.map((station, index) => {
    const sid = Number((db.query(`
      SELECT station_id FROM station_source WHERE source_id=? AND station_code=?
    `).get(source.source_id, station.station_code) as { station_id: number }).station_id);
    const sec = start + index * 90;
    return {
      sourceId: source.source_id,
      line: source.logical_line,
      day,
      trainNo,
      stationId: sid,
      stationCode: station.station_code,
      station: cleanName(station.canonical_name),
      arrival: index === 0 ? null : sec,
      departure: index === list.length - 1 ? null : sec + 20,
      sequenceHint: Number(station.sequence_hint),
      rawKind: kind,
    };
  });
}

function weekendClone(events: Event[]): Event[] {
  return events.map((event) => ({ ...event, day: "SAT" as const }));
}

export function loadFixtureTimetables(db: Database, sources: SourceRow[], stations: StationRow[]): number {
  let trips = 0;
  db.transaction(() => {
    for (const source of sources) {
      const path = pathForSource(source, stations);
      if (path.length < 2) continue;
      for (const day of ["DAY", "END"] as const) {
        for (let index = 0; index < 24; index += 1) {
          const reverse = index % 2 === 1;
          const start = 5 * 3600 + 30 * 60 + index * 30 * 60;
          const prefix = source.logical_line === "신분당선"
            ? "SB"
            : source.source_id.replace(/[^A-Za-z0-9]/g, "");
          const trainNo = `${prefix}-${day}-${String(index + 1).padStart(3, "0")}`;
          const localEvents = fixtureEvents(db, source, path, day, trainNo, start, reverse, "local");
          insertTrip(
            db,
            source.logical_line,
            day,
            trainNo,
            reverse ? "UP" : "DOWN",
            "local",
            [source.source_id],
            localEvents,
          );
          trips += 1;
          if (day === "END") {
            insertTrip(
              db,
              source.logical_line,
              "SAT",
              trainNo,
              reverse ? "UP" : "DOWN",
              "local",
              [source.source_id],
              weekendClone(localEvents),
            );
            trips += 1;
          }

          if (
            ["1호선", "4호선", "9호선", "경의중앙선", "경춘선", "수인분당선"].includes(source.logical_line)
            && index % 6 === 0
            && path.length > 5
          ) {
            const expressPath = path.filter((_, i) => i === 0 || i === path.length - 1 || i % 2 === 0);
            const expNo = `${prefix}-${day}-E${String(index + 1).padStart(3, "0")}`;
            const expressEvents = fixtureEvents(
              db,
              source,
              expressPath,
              day,
              expNo,
              start + 300,
              reverse,
              "express",
            );
            insertTrip(
              db,
              source.logical_line,
              day,
              expNo,
              reverse ? "UP" : "DOWN",
              "express",
              [source.source_id],
              expressEvents,
            );
            trips += 1;
            if (day === "END") {
              insertTrip(
                db,
                source.logical_line,
                "SAT",
                expNo,
                reverse ? "UP" : "DOWN",
                "express",
                [source.source_id],
                weekendClone(expressEvents),
              );
              trips += 1;
            }
          }
        }
      }
    }

    const gtx = (line: "GTX-A(북부)" | "GTX-A(남부)", names: string[], base: number) => {
      const source = sources.find((item) => item.logical_line === line)!;
      for (const day of ["DAY", "END"] as const) {
        for (let index = 0; index < 24; index += 1) {
          const reverse = index % 2 === 1;
          const ordered = reverse ? [...names].reverse() : names;
          const start = 5 * 3600 + 30 * 60 + index * 30 * 60;
          const trainNo = `X${String(base + index).padStart(4, "0")}`;
          const events: Event[] = ordered.map((name, i) => ({
            sourceId: source.source_id,
            line,
            day,
            trainNo,
            stationId: stationId(db, name),
            stationCode: "",
            station: name,
            arrival: i ? start + i * 300 : null,
            departure: i === ordered.length - 1 ? null : start + i * 300 + 20,
            sequenceHint: reverse ? ordered.length - i : i,
            rawKind: "express",
          }));
          insertTrip(db, line, day, trainNo, reverse ? "UP" : "DOWN", "express", [source.source_id], events);
          trips += 1;
          if (day === "END") {
            insertTrip(
              db,
              line,
              "SAT",
              trainNo,
              reverse ? "UP" : "DOWN",
              "express",
              [source.source_id],
              weekendClone(events),
            );
            trips += 1;
          }
        }
      }
    };
    gtx("GTX-A(북부)", ["운정중앙", "킨텍스", "대곡", "연신내", "서울역"], 1001);
    gtx("GTX-A(남부)", ["수서", "성남", "구성", "동탄"], 1);
  })();
  buildSource(
    db,
    "fixture-timetable",
    "generated:station-registry",
    trips,
    "CI-only deterministic timetable; SAT is an exact END(dayCd=9) clone; production uses KRIC",
  );
  return trips;
}
