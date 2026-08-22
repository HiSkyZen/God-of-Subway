import { describe, expect, test } from "bun:test";
import { TIMETABLE_ONLY_LINES } from "../../src/types/domain";
import { canonStation, routeTrains, stationOptions } from "../../src/engine/timetable-service";
import { repository } from "../../src/engine/data-repository";
import { isDisjointHomonymTransfer } from "../../src/engine/station-identity";
import { transferPairInfo, transferSeconds } from "../../src/engine/routing-service";
import { fetchPosition } from "../../src/engine/realtime-service";

const EXPECTED = ["인천1호선", "인천2호선", "용인에버라인", "김포골드라인", "의정부경전철", "우이신설선", "신림선"].sort();

describe("timetable-only urban rail", () => {
  test("all seven lines expose stations and weekday/holiday service", () => {
    expect([...TIMETABLE_ONLY_LINES].map(String).sort()).toEqual(EXPECTED);
    const options = stationOptions();
    for (const line of EXPECTED) {
      const stations = options[line] ?? [];
      expect(stations.length).toBeGreaterThan(8);
      const from = stations[0];
      const to = stations[stations.length - 1];
      expect(routeTrains(line, "DAY", from, to).length).toBeGreaterThan(0);
      expect(routeTrains(line, "END", from, to).length).toBeGreaterThan(0);
    }
  });

  test("fixture terminal schedules retain early-morning first service", () => {
    for (const [line, from, to] of [
      ["우이신설선", "북한산우이", "신설동"],
      ["신림선", "샛강", "관악산(서울대)"],
    ] as const) {
      for (const mode of ["DAY", "END"] as const) {
        const first = routeTrains(line, mode, from, to)[0];
        expect(first).toBeDefined();
        const origin = first?.stops.find((stop) => canonStation(stop.station) === canonStation(from));
        const seconds = Number(origin?.dep ?? origin?.arr ?? -1);
        expect(seconds).toBeGreaterThanOrEqual(5 * 3600 + 30 * 60);
        expect(seconds).toBeLessThan(5 * 3600 + 31 * 60);
      }
    }
  });

  test("timetable-only realtime lookup never waits for the network", async () => {
    for (const line of ["인천1호선", "우이신설선", "신림선"] as const) {
      let called = false;
      const fakeFetch = async (): Promise<Response> => { called = true; return new Response("unexpected"); };
      const result = await fetchPosition(line, 5, fakeFetch);
      expect(result.ok).toBe(false);
      expect(called).toBe(false);
    }
  });

  test("every feasible same-station line pair has explicit runtime transfer data", () => {
    const byStation = new Map<string, Set<string>>();
    for (const rows of Object.values(repository.data.graph.modes ?? {})) {
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 3 || typeof row[0] !== "string") continue;
        for (const rawStation of [row[1], row[2]]) {
          const station = canonStation(rawStation);
          if (!station) continue;
          const lines = byStation.get(station) ?? new Set<string>();
          lines.add(row[0]);
          byStation.set(station, lines);
        }
      }
    }
    let checked = 0;
    for (const [station, linesSet] of byStation) {
      const lines = [...linesSet];
      if (lines.length < 2) continue;
      for (const fromLine of lines) for (const toLine of lines) {
        if (fromLine === toLine || isDisjointHomonymTransfer(station, fromLine, toLine)) continue;
        const pair = transferPairInfo(station, fromLine, toLine);
        expect(pair).not.toBeNull();
        expect(transferSeconds(station, fromLine, toLine)).toBeGreaterThanOrEqual(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  test("new interchange pairs are routable", () => {
    for (const [station, a, b] of [
      ["계양","인천1호선","공항철도"],
      ["부평","인천1호선","1호선"],
      ["인천시청","인천1호선","인천2호선"],
      ["기흥","용인에버라인","수인분당선"],
      ["김포공항","김포골드라인","9호선"],
      ["회룡","의정부경전철","1호선"],
      ["신설동","우이신설선","1호선"],
      ["보문","우이신설선","6호선"],
      ["샛강","신림선","9호선"],
      ["신림","신림선","2호선"],
    ] as const) {
      expect(transferPairInfo(station, a, b)).not.toBeNull();
      expect(transferSeconds(station, a, b)).toBeGreaterThan(0);
    }
  });
});
