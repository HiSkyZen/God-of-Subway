import { describe, expect, test } from "bun:test";
import type { LiveTripState } from "../../src/client/contract";
import { alertNeedsTripReplacement, buildPushAlertRequest, markAlertCancellationPending, pushAlertStatusIsActive, pushTripSnapshot, shouldReconcilePushOnVisibility } from "../../src/client/push-alert";

const trip = (activeIndex: number, trainNo: string, boardedAt: string): LiveTripState => ({
  activeIndex, phase: "ride", boardedTrainNo: trainNo, boardedAt,
  trackingStartedAt: "2026-08-18 09:00:00", platformStart: null,
  segments: [{ line: "2호선", from: "강남", to: "교대" }, { line: "3호선", from: "교대", to: "고속터미널" }],
  day: "AUTO", baseline: null, previousNextTrain: null, displaySegments: [], transferEndsAt: null, journeyStartedAt: "2026-08-18 09:00:00",
});

describe("push trip alert snapshot", () => {
  test("server owns alert ids and a next-segment boarding produces a replacement payload", () => {
    const first = trip(0, "2001", "2026-08-18 09:00:00");
    const second = trip(1, "3012", "2026-08-18 09:07:00");
    const request = buildPushAlertRequest({ trip: second, subscriptionEndpoint: "https://push.example/e", managementToken: "token", destination: "고속터미널" });
    expect("alert_id" in request).toBe(false);
    expect(request.trip_payload.active_index).toBe(1);
    expect(request.trip_payload.boarded_train_no).toBe("3012");
    expect(alertNeedsTripReplacement(pushTripSnapshot(first), second)).toBe(true);
    expect(alertNeedsTripReplacement(pushTripSnapshot(second), second)).toBe(false);
  });

  test("keeps live polling subscribed to alert snapshot changes", async () => {
    const source = await Bun.file("src/client/use-live-journey.ts").text();
    expect(source).toContain("options.alert?.alert_id, options.alert?.trip_snapshot, options.alert?.pending_cancel");
    expect(source).toContain("const optionsRef = useRef(options)");
    expect(source).toContain("const requestTrip = liveTripRef.current");
  });

  test("keeps failed cancellation pending and reconciles active/expired status", () => {
    const pending = markAlertCancellationPending({ alert_id: "a", pending_cancel: false });
    expect(pending.alert_id).toBe("a");
    expect(pending.pending_cancel).toBe(true);
    const now = new Date("2026-08-18T09:00:00Z");
    expect(pushAlertStatusIsActive({ active: true, status: "active", expires_at: "2026-08-18T10:00:00Z" }, now)).toBe(true);
    expect(pushAlertStatusIsActive({ active: true, status: "active", expires_at: "2026-08-18T08:00:00Z" }, now)).toBe(false);
    expect(pushAlertStatusIsActive({ active: false, status: "missing", expires_at: null }, now)).toBe(false);
    expect(shouldReconcilePushOnVisibility("visible")).toBe(true);
    expect(shouldReconcilePushOnVisibility("hidden")).toBe(false);
  });
});
