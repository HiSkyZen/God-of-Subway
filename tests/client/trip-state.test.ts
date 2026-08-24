import { describe, expect, test } from "bun:test";
import type { LiveTripState, RouteSegment } from "../../src/client/contract";
import { alightTrip, boardWaitingTrain, completeTransfer, mergeCalculatedSegments, remainingRouteRequest, remainingRouteStartIndex, restoredRouteResult } from "../../src/client/trip-state";

function twoSegmentTrip(): LiveTripState {
  const segments = [
    { line: "2호선", from: "강남", to: "교대", transfer_seconds: 90 },
    { line: "3호선", from: "교대", to: "고속터미널", transfer_seconds: 0 },
  ];
  return {
    activeIndex: 0, phase: "ride", boardedTrainNo: "2001", boardedAt: "2026-08-18 09:00:00",
    trackingStartedAt: "2026-08-18 09:00:00", platformStart: "2026-08-18 08:59:00", segments,
    day: "AUTO", previousNextTrain: null, displaySegments: segments,
    transferEndsAt: null, journeyStartedAt: "2026-08-18 09:00:00",
  };
}

describe("multi-segment live-trip golden transitions", () => {
  test("first alight transfers, completion waits, explicit boarding rides, and only final alight is done", () => {
    const initial = twoSegmentTrip();
    const transfer = alightTrip(initial, new Date(2026, 7, 18, 9, 5, 0));
    expect(transfer.phase).toBe("transfer");
    expect(transfer.activeIndex).toBe(0);
    expect(transfer.boardedTrainNo).toBe("");
    expect(transfer.transferEndsAt).toBe("2026-08-18 09:06:30");

    const waiting = completeTransfer(transfer);
    expect(waiting.phase).toBe("waiting");
    expect(waiting.activeIndex).toBe(1);
    expect(waiting.boardedTrainNo).toBe("");
    expect(remainingRouteStartIndex(waiting)).toBe(1);
    expect(remainingRouteRequest(waiting, new Date(2026, 7, 18, 9, 7, 0))).toMatchObject({ refresh_only: false, start_time: "2026-08-18 09:07:00", segments: [waiting.segments[1]] });

    const unchanged = boardWaitingTrain(waiting, 1, "", new Date(2026, 7, 18, 9, 7, 0));
    expect(unchanged).toBe(waiting);
    const secondRide = boardWaitingTrain(waiting, 1, "3012", new Date(2026, 7, 18, 9, 7, 0));
    expect(secondRide.phase).toBe("ride");
    expect(secondRide.activeIndex).toBe(1);
    expect(secondRide.boardedTrainNo).toBe("3012");

    const done = alightTrip(secondRide, new Date(2026, 7, 18, 9, 15, 0));
    expect(done.phase).toBe("done");
    expect(done.activeIndex).toBe(1);
  });

  test("merges recalculated remaining segments without shifting global indexes", () => {
    const existing = twoSegmentTrip().displaySegments;
    const calculated: RouteSegment[] = [{ ...existing[1]!, train_no: "3012", board_dt: "2026-08-18 09:07:00" }];
    const merged = mergeCalculatedSegments(existing, 1, calculated);
    expect(merged[0]?.from).toBe("강남");
    expect(merged[1]?.train_no).toBe("3012");
    expect(restoredRouteResult({ ...twoSegmentTrip(), displaySegments: merged })).toMatchObject({ ok: true, from: "강남", to: "고속터미널", transfer_count: 1, segments: merged });
  });
});
