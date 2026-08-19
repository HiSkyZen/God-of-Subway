import { describe, expect, test } from "bun:test";
import { RAPID_SERVICE_LINES } from "../../src/engine/rapid-service";
import { autoFindPath, stationRequiresLineSelection, stationSelector, transferSeconds } from "../../src/engine/routing-service";
import { directionalTransferOverride, transferLoadEstimate } from "../../src/engine/transfer-policy";

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

  test("대곡 is never treated as a same-platform GJ-Seohae transfer", () => {
    expect(transferSeconds("대곡", "경의중앙선", "서해선")).toBe(180);
    expect(directionalTransferOverride("대곡", "경의중앙선", "서해선", "곡산", "곡산")).toMatchObject({ seconds: 180, mode: "passage" });
  });

  test("shared-track same-direction transfer is zero but opposite direction is not", () => {
    expect(directionalTransferOverride("초지", "4호선", "수인분당선", "안산", "안산")).toMatchObject({ seconds: 0, mode: "same-platform" });
    expect(directionalTransferOverride("초지", "4호선", "수인분당선", "고잔", "안산")).toMatchObject({ seconds: 60, mode: "cross-platform" });
  });


  test("rush-hour crowding weight is bounded at 1.75 and off-peak is neutral", () => {
    const peak = transferLoadEstimate("서울역", new Date(Date.UTC(2026, 7, 20, 8, 0, 0)), 4);
    const offPeak = transferLoadEstimate("서울역", new Date(Date.UTC(2026, 7, 20, 13, 0, 0)), 4);
    expect(peak.multiplier).toBeGreaterThan(1); expect(peak.multiplier).toBeLessThanOrEqual(1.75); expect(offPeak.multiplier).toBe(1);
  });
});
