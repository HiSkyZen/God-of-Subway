import { expect, test } from "bun:test";
import { calculateGtxTrip } from "../../src/engine/gtx-service";
import { formatKst, nowKst } from "../../src/engine/timetable-service";

test("unknown GTX realtime station never fabricates a between-station label and status remains semantic", async () => {
  const oldKey = Bun.env.SEOUL_API_KEY;
  Bun.env.SEOUL_API_KEY = "test";
  try {
    const observed = formatKst(nowKst());
    const result = await calculateGtxTrip({
      day: "DAY",
      active_index: 0,
      boarded_train_no: "X1001",
      boarded_at: observed,
      segments: [{ line: "GTX-A(북부)", from: "운정중앙", to: "서울역" }],
    }, async () => new Response(JSON.stringify({
      realtimePositionList: [{
        subwayId: "1032",
        trainNo: "1001",
        statnNm: "미확인역",
        statnTnm: "서울역",
        updnLine: "1",
        trainSttus: "3",
        recptnDt: observed,
      }],
    })));

    expect(result?.ok).toBe(true);
    const segment = Array.isArray(result?.segments) ? result.segments[0] as Record<string, unknown> : null;
    expect(segment?.location_label).toBe("미확인");
    expect(String(segment?.location_label ?? "")).not.toContain("운정중앙-");
    expect(segment?.status).toBe("운행 중");
    expect(result?.current_status).toBe("운행 중");
  } finally {
    if (oldKey == null) delete Bun.env.SEOUL_API_KEY;
    else Bun.env.SEOUL_API_KEY = oldKey;
  }
});
