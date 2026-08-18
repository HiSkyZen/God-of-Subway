import { describe, expect, test } from "bun:test";
import { calculateLiveTrip, calculateRoute, healthSnapshot, stationsByLine } from "../../src/engine/index";
import { canonStation, clockDtNear, nowKst, resolveServiceMode, routePair } from "../../src/engine/timetable-service";
import { compareAutoRouteLiveScores, type AutoRouteLiveScore } from "../../src/engine/eta-service";
import { JsonDataRepository } from "../../src/engine/data-repository";
import { autoFindPath, bestTransferDetail } from "../../src/engine/routing-service";

describe("지금타 Bun engine", () => {
  test("KST naive clock and aliases stay stable", () => {
    const value = clockDtNear("10:30:00", nowKst());
    expect(value.getUTCHours()).toBe(10);
    expect(canonStation("총신대입구 역")).toBe("총신대입구(이수)");
  });

  test("service mode resolves manual mode without host timezone", () => {
    const [mode, reason] = resolveServiceMode("DAY", nowKst());
    expect(mode).toBe("DAY");
    expect(reason).toBe("평일 수동 선택");
  });

  test("all supported lines expose station options", () => {
    expect(Object.keys(stationsByLine)).toHaveLength(15);
    expect(Object.fromEntries(Object.entries(stationsByLine).map(([line, stations]) => [line, stations.length]))).toEqual({
      "1호선": 103, "2호선": 51, "3호선": 44, "4호선": 51, "5호선": 56,
      "6호선": 39, "7호선": 53, "8호선": 24, "9호선": 38,
      "경의중앙선": 53, "수인분당선": 63, "경춘선": 25, "경강선": 12, "서해선": 21, "공항철도": 14,
    });
    expect(stationsByLine["2호선"]).toContain("강남");
    expect(stationsByLine["공항철도"]).toContain("서울역");
  });

  test("route graph finds a direct timetable path", () => {
    const path = autoFindPath("강남", "잠실", "DAY");
    expect(path.edges.length).toBeGreaterThan(0);
    expect(path.seconds).toBeGreaterThan(0);
  });

  test("교대 transfer chooses the exact incoming/outgoing direction record", () => {
    expect(bestTransferDetail(
      "교대",
      { line: "2호선", from: "강남", to: "교대" },
      { line: "3호선", from: "교대", to: "고속터미널" },
      "DAY",
    )).toEqual({
      station: "교대",
      seconds: 144,
      distance_m: 75,
      alight_position: "1-2",
      board_position: "7-4",
      from_direction: "서초",
      to_direction: "고속터미널",
      matched: "direction",
    });
  });

  test("live ETA tie uses schedule arrival before static path seconds", () => {
    const common = { result: { arrival_time: "2026-08-18 10:30:00" }, segments: [{ line: "2호선", from: "강남", to: "잠실" }] };
    const laterScheduleShortPath: AutoRouteLiveScore = { ...common, path: { seconds: 100 }, scheduleResult: { arrival_time: "2026-08-18 10:20:00" } };
    const earlierScheduleLongPath: AutoRouteLiveScore = { ...common, path: { seconds: 900 }, scheduleResult: { arrival_time: "2026-08-18 10:10:00" } };
    expect([laterScheduleShortPath, earlierScheduleLongPath].sort(compareAutoRouteLiveScores)[0]).toBe(earlierScheduleLongPath);
  });

  test("data repository parses schedule payloads only when requested", () => {
    const lazy = new JsonDataRepository();
    expect(lazy.loadedDatasets()).toEqual([]);
    expect(lazy.validate()).toMatchObject({ stationLines: 15, graphModes: ["DAY", "SAT", "END"] });
    expect(lazy.loadedDatasets()).toEqual(["graph"]);
    expect(Object.keys(lazy.data.s1.weekday)).toHaveLength(843);
    expect(lazy.loadedDatasets()).toEqual(["graph", "s1-weekday"]);
  });

  test("route falls back to timetable when realtime is unavailable", async () => {
    const cache = new Map([["2호선", { rows: [], error: "fixture timeout", available: false }]]);
    const result = await calculateRoute({ day: "DAY", start_time: "10:00", segments: [{ line: "2호선", from: "강남", to: "잠실" }] }, cache);
    expect(result.ok).toBe(true);
    expect(result.segments).toBeArray();
    const first = (result.segments as Array<Record<string, unknown>>)[0];
    expect(first.diagnostics).toMatchObject({ realtime_available: false });
  });

  test("health snapshot contains data counts and never exposes the key", () => {
    const health = healthSnapshot();
    expect(health.ok).toBe(true);
    expect(health).toMatchObject({ line1_weekday_trains: 843, line1_holiday_trains: 729, metro_source: "250930" });
    expect(health.api_key_configured).toBeBoolean();
    expect(JSON.stringify(health)).not.toContain("SEOUL_API_KEY=");
  });

  test("live trip keeps the active tracked segment identity after future segments recalculate", async () => {
    const cache = new Map([
      ["2호선", { rows: [], error: "fixture timeout", available: false }],
    ]);
    const result = await calculateLiveTrip({
      day: "DAY",
      active_index: 0,
      boarded_train_no: "2143",
      boarded_at: "2026-08-18 10:00:00",
      segments: [
        { line: "2호선", from: "강남", to: "잠실" },
        { line: "2호선", from: "잠실", to: "강변" },
      ],
    }, async () => new Response(JSON.stringify({ realtimePositionList: [] })),);
    expect(result.ok).toBe(true);
    expect(result.boarded_train_no).toBe("2143");
    expect(result.active_index).toBe(0);
  });
});
