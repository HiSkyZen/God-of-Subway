import { describe, expect, test } from "bun:test";
import {
  compareAutoRouteScores,
  gtxExclusionsForPreference,
  type AutoRouteScore,
} from "../../src/engine/auto-route-service";
import {
  gtxDistanceFare,
  shinbundangSurcharge,
  standardDistanceFare,
  type FareEstimate,
} from "../../src/engine/fare-service";
import type { RouteCandidate } from "../../src/engine/route-candidate-service";
import type { SegmentInput, Serialized } from "../../src/types/domain";

function fare(won: number): FareEstimate {
  return {
    adult_card_won: won,
    distance_km: 0,
    standard_distance_km: 0,
    gtx_distance_km: 0,
    shinbundang_surcharge_won: 0,
    basis: "test",
  };
}

function candidate(segments: SegmentInput[], seconds = 600): RouteCandidate {
  return {
    path: { start: String(segments[0]?.from ?? "A"), end: String(segments.at(-1)?.to ?? "B"), seconds, edges: [] },
    segments,
    signature: segments.map((segment) => `${segment.line}:${segment.from}:${segment.to}`).join("|"),
    seed: "time",
  };
}

function score(
  segments: SegmentInput[],
  arrival: string,
  won: number,
  seconds = 600,
): AutoRouteScore {
  return {
    candidate: candidate(segments, seconds),
    result: { ok: true, arrival_time: arrival } as Serialized,
    fare: fare(won),
  };
}

describe("fare bands", () => {
  test("ordinary metropolitan distance bands follow the adult-card schedule", () => {
    expect(standardDistanceFare(0)).toBe(1550);
    expect(standardDistanceFare(10)).toBe(1550);
    expect(standardDistanceFare(10.1)).toBe(1650);
    expect(standardDistanceFare(50)).toBe(2350);
    expect(standardDistanceFare(50.1)).toBe(2450);
  });

  test("GTX-A uses 3,200 won base plus 250 won per 5 km after 10 km", () => {
    expect(gtxDistanceFare(10)).toBe(3200);
    expect(gtxDistanceFare(10.1)).toBe(3450);
    expect(gtxDistanceFare(32.8)).toBe(4450);
  });

  test("Shinbundang section surcharge is accumulated by crossed concession sections", () => {
    expect(shinbundangSurcharge([{ line: "신분당선", from: "신사", to: "강남" }])).toBe(700);
    expect(shinbundangSurcharge([{ line: "신분당선", from: "강남", to: "정자" }])).toBe(1000);
    expect(shinbundangSurcharge([{ line: "신분당선", from: "강남", to: "광교" }])).toBe(1500);
    expect(shinbundangSurcharge([{ line: "신분당선", from: "신사", to: "정자" }])).toBe(1700);
    expect(shinbundangSurcharge([{ line: "신분당선", from: "신사", to: "광교" }])).toBe(2200);
  });
});

describe("automatic route objectives", () => {
  const ordinary = [{ line: "3호선", from: "연신내", to: "서울역" }];
  const gtx = [{ line: "GTX-A(북부)", from: "연신내", to: "서울역" }];

  test("fastest uses actual arrival and exact ties prefer non-GTX", () => {
    const withGtx = score(gtx, "2026-08-18 10:30:00", 3200, 300);
    const withoutGtx = score(ordinary, "2026-08-18 10:30:00", 1550, 900);
    expect(compareAutoRouteScores(withoutGtx, withGtx, "fastest")).toBeLessThan(0);
    expect(compareAutoRouteScores(
      score(gtx, "2026-08-18 10:29:00", 3200),
      withoutGtx,
      "fastest",
    )).toBeLessThan(0);
  });

  test("fewest transfers sorts by transfer count before ETA", () => {
    const oneRide = score([{ line: "2호선", from: "강남", to: "잠실" }], "2026-08-18 10:35:00", 1550);
    const twoRide = score([
      { line: "2호선", from: "강남", to: "교대" },
      { line: "3호선", from: "교대", to: "고속터미널" },
    ], "2026-08-18 10:30:00", 1550);
    expect(compareAutoRouteScores(oneRide, twoRide, "fewest_transfers")).toBeLessThan(0);
  });

  test("lowest cost sorts by fare before ETA", () => {
    const cheap = score(ordinary, "2026-08-18 10:35:00", 1550);
    const expensive = score(gtx, "2026-08-18 10:29:00", 3200);
    expect(compareAutoRouteScores(cheap, expensive, "lowest_cost")).toBeLessThan(0);
  });

  test("GTX off preserves a section required by an exclusive endpoint", () => {
    expect(gtxExclusionsForPreference("강남", "동탄", false)).toEqual(["GTX-A(북부)"]);
    expect(gtxExclusionsForPreference("연신내", "서울역", false)).toEqual(["GTX-A(북부)", "GTX-A(남부)"]);
    expect(gtxExclusionsForPreference("강남", "동탄", true)).toEqual([]);
  });
});
