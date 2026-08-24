import { describe, expect, test } from "bun:test";
import { calculateAutoRoute, calculateLiveTrip, calculateRoute, healthSnapshot, shouldPreferNonGtxTie, stationsByLine } from "../../src/engine/index";
import { fetchPosition, formatGtxTrainNumber, formatSinbundangFormationNumber, publicTrainNumber } from "../../src/engine/realtime-service";
import { canonStation, clockDtNear, formatKst, nowKst, resolveServiceMode, routeTrains } from "../../src/engine/timetable-service";
import { compareAutoRouteLiveScores, observeDelays, type AutoRouteLiveScore } from "../../src/engine/eta-service";
import { SqliteDataRepository } from "../../src/engine/data-repository";
import { autoFindPath, transferSeconds } from "../../src/engine/routing-service";
import { RAPID_SERVICE_LINES, railServiceKind } from "../../src/engine/rapid-service";
import { modeledMissingTransferSeconds } from "../../src/engine/transfer-policy";
import type { Train } from "../../src/types/domain";

function firstTimed(train: Train): number {
  const value = train.stops.find((stop) => stop.dep !== null || stop.arr !== null);
  return Number(value?.dep ?? value?.arr ?? 0);
}
function observationTime(seconds: number): string {
  return formatKst(new Date(Date.UTC(2026, 7, 18) + seconds * 1000));
}

describe("지금타 Bun SQLite engine", () => {
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

  test("all supported lines expose station options including Shinbundang and both GTX-A sections", () => {
    expect(Object.keys(stationsByLine)).toHaveLength(25);
    expect(stationsByLine["2호선"]).toContain("강남");
    expect(stationsByLine["공항철도"]).toContain("서울역");
    expect(stationsByLine["신분당선"]).toContain("강남");
    expect(stationsByLine["우이신설선"]).toContain("신설동");
    expect(stationsByLine["신림선"]).toContain("샛강");
    expect(stationsByLine["GTX-A(북부)"]).toEqual(["운정중앙", "킨텍스", "대곡", "연신내", "서울역"]);
    expect(stationsByLine["GTX-A(남부)"]).toEqual(["수서", "성남", "구성", "동탄"]);
  });

  test("SQLite repository validates generated schema and stays lazy for materialized datasets", () => {
    const lazy = new SqliteDataRepository();
    expect(lazy.loadedDatasets()).toEqual([]);
    expect(lazy.validate()).toMatchObject({ stationLines: 25, graphModes: ["DAY", "SAT", "END"], schemaVersion: 2, buildMode: "fixture" });
    expect(lazy.loadedDatasets()).toEqual([]);
    expect(Object.keys(lazy.data.s1.weekday).length).toBeGreaterThan(0);
    expect(lazy.loadedDatasets()).toEqual(["s1-weekday"]);
  });

  test("Shinbundang timetable exposes stable internal ids rather than source labels", () => {
    const lazy = new SqliteDataRepository();
    const trains = lazy.data.extra["신분당선"].trains?.weekday ?? {};
    const keys = Object.keys(trains);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toStartWith("SB-W-");
    expect(keys.some((key) => key.startsWith("DX"))).toBe(false);
  });

  test("AREX direct service is excluded from rapid/local interchange logic", () => {
    expect(RAPID_SERVICE_LINES.has("공항철도")).toBe(false);
    const fake: Train = { train_no: "AREX-DIRECT", direction: "DOWN", service: "direct", start: "서울역", dest: "인천공항2터미널", stops: [] };
    expect(railServiceKind("공항철도", fake)).toBe("local");
  });

  test("missing transfer fallback ignores distance while Seoul Metro pair remains authoritative", () => {
    expect(modeledMissingTransferSeconds(120)).toBe(180);
    expect(transferSeconds("교대", "2호선", "3호선")).toBe(63);
  });

  test("route graph finds a direct timetable path", () => {
    const path = autoFindPath("강남", "잠실", "DAY");
    expect(path.edges.length).toBeGreaterThan(0);
    expect(path.seconds).toBeGreaterThan(0);
  });

  test("live ETA tie uses schedule arrival before static path seconds", () => {
    const common = { result: { arrival_time: "2026-08-18 10:30:00" }, segments: [{ line: "2호선", from: "강남", to: "잠실" }] };
    const laterScheduleShortPath: AutoRouteLiveScore = { ...common, path: { seconds: 100 }, scheduleResult: { arrival_time: "2026-08-18 10:20:00" } };
    const earlierScheduleLongPath: AutoRouteLiveScore = { ...common, path: { seconds: 900 }, scheduleResult: { arrival_time: "2026-08-18 10:10:00" } };
    expect([laterScheduleShortPath, earlierScheduleLongPath].sort(compareAutoRouteLiveScores)[0]).toBe(earlierScheduleLongPath);
  });

  test("equal arrival prefers the route without GTX-A", () => {
    const withGtx = { ok: true, arrival_time: "2026-08-18 10:30:00", segments: [{ line: "GTX-A(북부)", from: "연신내", to: "서울역" }] };
    const withoutGtx = { ok: true, arrival_time: "2026-08-18 10:30:00", segments: [{ line: "3호선", from: "연신내", to: "종로3가" }] };
    expect(shouldPreferNonGtxTie(withGtx, withoutGtx)).toBe(true);
    expect(shouldPreferNonGtxTie(withGtx, { ...withoutGtx, arrival_time: "2026-08-18 10:31:00" })).toBe(false);
  });

  test("route falls back to timetable when realtime is unavailable", async () => {
    const cache = new Map([["2호선", { rows: [], error: "fixture timeout", available: false }]]);
    const result = await calculateRoute({ day: "DAY", start_time: "10:00", segments: [{ line: "2호선", from: "강남", to: "잠실" }] }, cache);
    expect(result.ok).toBe(true);
    expect(result.segments).toBeArray();
    const first = (result.segments as Array<Record<string, unknown>>)[0];
    expect(first.diagnostics).toMatchObject({ realtime_available: false });
  });

  test("health snapshot reports SQLite metadata and never exposes credentials", () => {
    const health = healthSnapshot();
    expect(health.ok).toBe(true);
    expect(health).toMatchObject({ upstream_parity: "V13.4.8" });
    expect(health.data).toMatchObject({ storage: "sqlite", schema_version: 2, build_mode: "fixture" });
    expect(health.sqlite).toMatchObject({ schema_version: 2, build_mode: "fixture" });
    expect(health.api_key_configured).toBeBoolean();
    expect(health.cache).toBeObject();
    expect(health.transfer_policy).toMatchObject({ kric_runtime_distance: false, kric_location_hints: "daily-build-only-lowest-priority" });
    expect(JSON.stringify(health)).not.toContain("SEOUL_API_KEY=");
    expect(JSON.stringify(health)).not.toContain("KRIC_API_KEY=");
  });

  test("Shinbundang API formation number is displayed as D0XX while timetable matching stays internal", async () => {
    const old = Bun.env.SEOUL_API_KEY; Bun.env.SEOUL_API_KEY = "test";
    try {
      const result = await fetchPosition("신분당선", 5, async () => new Response(JSON.stringify({ realtimePositionList: [{ subwayId: "1077", trainNo: "7", statnNm: "강남", statnTnm: "광교", updnLine: "하행", trainSttus: "2", recptnDt: "2026-08-18 10:00:00" }] })));
      const row = result.data?.realtimePositionList?.[0];
      expect(result.ok).toBe(true);
      expect(row?._jigeumta_raw_train_no).toBe("7");
      expect(row?._jigeumta_display_train_no).toBe("D007");
      expect(String(row?.trainNo || "")).toStartWith("SB-W-");
      expect(publicTrainNumber("신분당선", row?.trainNo)).toBe("D007");
      expect(formatSinbundangFormationNumber("20")).toBe("D020");
    } finally { if (old == null) delete Bun.env.SEOUL_API_KEY; else Bun.env.SEOUL_API_KEY = old; }
  });

  test("realtime positions preserve arrival, departure and between-station state", () => {
    const train = routeTrains("3호선", "DAY", "종로3가", "고속터미널")[0];
    expect(train).toBeDefined();
    if (!train) return;
    const index = train.stops.findIndex((stop) => canonStation(stop.station) === "종로3가");
    expect(index).toBeGreaterThan(0);
    const stop = train.stops[index]; const previous = train.stops[index - 1];
    expect(stop.arr).not.toBeNull(); expect(stop.dep).not.toBeNull(); expect(previous.dep ?? previous.arr).not.toBeNull();
    if (stop.arr === null || stop.dep === null || (previous.dep ?? previous.arr) === null) return;
    const rows = [
      { trainNo: train.train_no, statnNm: "종로3가", trainSttus: "1", recptnDt: observationTime(stop.arr) },
      { trainNo: train.train_no, statnNm: "종로3가", trainSttus: "2", recptnDt: observationTime(stop.dep) },
      { trainNo: train.train_no, statnNm: "종로3가", trainSttus: "3", recptnDt: observationTime((previous.dep ?? previous.arr) as number) },
    ];
    const [observations] = observeDelays("3호선", "DAY", rows);
    expect(observations.map((item) => item.location_label)).toContain("종로3가 도착");
    expect(observations.map((item) => item.location_label)).toContain("종로3가 출발");
    expect(observations.some((item) => item.location_label.endsWith("-종로3가"))).toBe(true);
  });

  test("invalid delay uses the closest same-direction train ahead and behind average", () => {
    const all = routeTrains("3호선", "DAY", "종로3가", "고속터미널").filter((train) => train.stops.some((stop) => canonStation(stop.station) === "종로3가"));
    const groups = new Map<string, Train[]>();
    for (const train of all) groups.set(train.direction, [...(groups.get(train.direction) ?? []), train]);
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length)[0]?.sort((a, b) => firstTimed(a) - firstTimed(b)) ?? [];
    const distinct = ordered.filter((train, index, values) => index === 0 || firstTimed(train) !== firstTimed(values[index - 1]));
    expect(distinct.length).toBeGreaterThan(3);
    const center = Math.max(1, Math.min(distinct.length - 2, Math.floor(distinct.length / 2)));
    const trio = [distinct[center - 1], distinct[center], distinct[center + 1]];
    expect(new Set(trio.map((train) => train.direction)).size).toBe(1);
    const rows = trio.map((train, index) => {
      const stop = train.stops.find((item) => canonStation(item.station) === "종로3가"); const ref = stop?.dep ?? stop?.arr;
      expect(ref).not.toBeNull(); const offset = index === 0 ? 120 : index === 1 ? -600 : 240;
      return { trainNo: train.train_no, statnNm: "종로3가", trainSttus: "2", recptnDt: observationTime(Number(ref) + offset) };
    });
    const [observations, diagnostics] = observeDelays("3호선", "DAY", rows);
    const target = observations.find((item) => item.train_no === trio[1].train_no);
    expect(target).toBeDefined(); expect(target?.delay_failsafe).toBe(true); expect(target?.delay).toBe(180); expect(Number(diagnostics.delay_failsafe)).toBe(1);
    expect(observations.every((item) => item.delay >= 0)).toBe(true);
  });

  test("GTX-A public train number uses X plus four digits", async () => {
    const old = Bun.env.SEOUL_API_KEY; Bun.env.SEOUL_API_KEY = "test";
    try {
      expect(formatGtxTrainNumber("1009")).toBe("X1009"); expect(formatGtxTrainNumber("X1232")).toBe("X1232");
      const result = await calculateAutoRoute({ from: "수서", to: "동탄", day: "DAY", start_time: "2026-08-18 10:00:00" }, async () => new Response(JSON.stringify({ realtimePositionList: [{ subwayId: "1032", trainNo: "0031", statnNm: "수서", statnTnm: "동탄", updnLine: "1", trainSttus: "2", recptnDt: "2026-08-18 10:04:00" }] })));
      expect(result.ok).toBe(true); const first = (result.segments as Array<Record<string, unknown>>)[0];
      expect(first.line).toBe("GTX-A(남부)"); expect(String(first.train_no || "")).toMatch(/^X0\d{3}$/); expect(String(first.tracking_id || "")).toMatch(/^X0\d{3}$/);
    } finally { if (old == null) delete Bun.env.SEOUL_API_KEY; else Bun.env.SEOUL_API_KEY = old; }
  });

  test("ordinary live trip keeps the active tracked train identity", async () => {
    const tracked = routeTrains("2호선", "DAY", "강남", "잠실")[0]; expect(tracked).toBeDefined(); if (!tracked) return;
    const result = await calculateLiveTrip({ day: "DAY", active_index: 0, boarded_train_no: tracked.train_no, boarded_at: "2026-08-18 10:00:00", segments: [{ line: "2호선", from: "강남", to: "잠실" }] }, async () => new Response(JSON.stringify({ realtimePositionList: [] })));
    expect(result.ok).toBe(true); expect(result.boarded_train_no).toBe(tracked.train_no); expect(result.active_index).toBe(0);
  });
});
