import { describe, expect, test } from "bun:test";
import { RAPID_SERVICE_LINES } from "../../src/engine/rapid-service";
import { autoFindPath, stationRequiresLineSelection, stationSelector, transferSeconds } from "../../src/engine/routing-service";
import { directionalTransferOverride, transferLoadEstimate, transferOverride } from "../../src/engine/transfer-policy";

describe("transit routing overhaul", () => {
  test("current rapid-service coverage is explicit", () => {
    expect([...RAPID_SERVICE_LINES].sort()).toEqual(["1호선", "4호선", "9호선", "경의중앙선", "경춘선", "수인분당선"].sort());
  });

  test("homonymous physical stations require a line-qualified candidate", () => {
    expect(stationRequiresLineSelection("신촌")).toBe(true);
    expect(stationRequiresLineSelection("양평")).toBe(true);
    expect(() => autoFindPath("신촌", "합정", "DAY")).toThrow(/동명이의역/);
    expect(autoFindPath("🟢 2호선 · 신촌", "🟢 2호선 · 합정", "DAY").seconds).toBeGreaterThan(0);
    expect(stationSelector("🟢 2호선 · 신촌")).toEqual({ station: "신촌", line: "2호선" });
  });

  test("GJ-Seohae shared corridor keeps station-by-station physical costs", () => {
    expect(transferSeconds("능곡", "경의중앙선", "서해선")).toBe(180);
    expect(transferOverride("대곡", "경의중앙선", "서해선")).toMatchObject({ seconds: 30, mode: "cross-platform" });
    expect(transferOverride("일산", "경의중앙선", "서해선")).toMatchObject({ seconds: 15, mode: "same-platform" });
    expect(directionalTransferOverride("대곡", "경의중앙선", "서해선", "곡산", "곡산")).toMatchObject({ seconds: 30, mode: "cross-platform" });
  });

  test("4-SuinBundang shared corridor is convenient but never an instant teleport", () => {
    expect(directionalTransferOverride("한대앞", "4호선", "수인분당선", "중앙", "중앙")).toMatchObject({ seconds: 15, mode: "same-platform" });
    expect(directionalTransferOverride("초지", "4호선", "수인분당선", "안산", "안산")).toMatchObject({ seconds: 15, mode: "same-platform" });
    expect(directionalTransferOverride("초지", "4호선", "수인분당선", "고잔", "안산")).toMatchObject({ seconds: 90, mode: "passage" });
    expect(transferOverride("안산", "4호선", "수인분당선")).toMatchObject({ seconds: 30, mode: "cross-platform" });
    expect(transferOverride("오이도", "4호선", "수인분당선")).toMatchObject({ seconds: 30, mode: "cross-platform" });
  });

  test("rush-hour crowding applies only 06:50-09:30 and 16:50-19:30", () => {
    const estimate = (hour: number, minute: number) => transferLoadEstimate("서울역", new Date(Date.UTC(2026, 7, 20, hour, minute, 0)), 4).multiplier;
    expect(estimate(6, 49)).toBe(1);
    expect(estimate(6, 50)).toBeGreaterThan(1);
    expect(estimate(8, 0)).toBeLessThanOrEqual(1.75);
    expect(estimate(9, 30)).toBeGreaterThan(1);
    expect(estimate(9, 31)).toBe(1);
    expect(estimate(16, 49)).toBe(1);
    expect(estimate(16, 50)).toBeGreaterThan(1);
    expect(estimate(19, 30)).toBeGreaterThan(1);
    expect(estimate(19, 31)).toBe(1);
  });
});
