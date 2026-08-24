import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { calculateAutoRoute } from "../../src/engine/index";
import { scheduledGtxCandidates } from "../../src/engine/gtx-schedule";

const previousKey = Bun.env.SEOUL_API_KEY;
const emptyRealtime = async (): Promise<Response> => new Response(JSON.stringify({ realtimePositionList: [] }));
const gtxRealtime = async (): Promise<Response> => new Response(JSON.stringify({ realtimePositionList: [
  { subwayId: "1032", trainNo: "1079", statnNm: "운정중앙", statnTnm: "서울역", updnLine: "1", trainSttus: "2", recptnDt: "2026-08-18 10:00:00" },
  { subwayId: "1032", trainNo: "0031", statnNm: "수서", statnTnm: "동탄", updnLine: "1", trainSttus: "2", recptnDt: "2026-08-18 10:04:00" },
] }));

beforeEach(() => { Bun.env.SEOUL_API_KEY = "test"; });
afterEach(() => { if (previousKey == null) delete Bun.env.SEOUL_API_KEY; else Bun.env.SEOUL_API_KEY = previousKey; });

function hasGtx(result: Record<string, unknown>): boolean {
  const segments = result.segments as Array<Record<string, unknown>> | undefined;
  return Boolean(segments?.some((segment) => String(segment.line).startsWith("GTX-A")));
}

describe("GTX-A integrated automatic routing", () => {
  test("normalized timetable candidates always carry public X service numbers", () => {
    for (const [line, from, to] of [
      ["GTX-A(북부)", "운정중앙", "서울역"],
      ["GTX-A(북부)", "서울역", "운정중앙"],
      ["GTX-A(남부)", "수서", "동탄"],
      ["GTX-A(남부)", "동탄", "수서"],
    ] as const) {
      for (const mode of ["DAY", "SAT", "END"]) {
        const candidate = scheduledGtxCandidates(line, from, to, new Date("2026-08-18T05:29:00Z"), mode)[0];
        expect(candidate).toBeDefined();
        expect(candidate?.trainNo).toMatch(/^X\d{4}$/);
      }
    }
  });

  test("대곡 → 시청 stays routable when GTX competes with ordinary rail", async () => {
    const result = await calculateAutoRoute({ from: "대곡", to: "시청", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe.true);
    expect((result.segments as Array<Record<string, unknown>>).at(-1)?.to).toBe("시청");
  });

  test("연신내 → 용산 stays routable when GTX competes with ordinary rail", async () => {
    const result = await calculateAutoRoute({ from: "연신내", to: "용산", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    expect((result.segments as Array<Record<string, unknown>>).at(-1)?.to).toBe("용산");
  });

  test("운정중앙 → 시청 works from the GTX-exclusive origin using timetable candidates", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "시청", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "운정중앙" });
    expect(String(segments[0]?.train_no || "")).toMatch(/^X1\d{3}$/);
    expect(String(segments[0]?.tracking_id || "")).toMatch(/^X1\d{3}$/);
    expect(segments.at(-1)?.to).toBe("시청");
  });

  test("킨텍스 → 용산 works from the GTX-exclusive origin using timetable candidates", async () => {
    const result = await calculateAutoRoute({ from: "킨텍스", to: "용산", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe.true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "킨텍스" });
    expect(String(segments[0]?.train_no || "")).toMatch(/^X1\d{3}$/);
    expect(segments.at(-1)?.to).toBe("용산");
  });

  test("GTX-exclusive origin reports no service after the final scheduled train", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "시청", day: "DAY", start_time: "2026-08-19 01:10:00" }, emptyRealtime);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("이용 가능한 열차 경로");
  });

  test("realtime GTX row keeps its public X-number and detailed state", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "강남", day: "DAY", start_time: "2026-08-18 10:00:00" }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "운정중앙", train_no: "X1079", tracking_id: "X1079", confidence: "높음", location_label: "운정중앙 출발" });
    expect(segments.at(-1)?.to).toBe("강남");
  });

  test("동탄 can be reached through the integrated GTX-A south section", async () => {
    const result = await calculateAutoRoute({ from: "강남", to: "동탄", day: "DAY", start_time: "2026-08-18 10:00:00" }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    const last = segments.at(-1);
    expect(last).toMatchObject({ line: "GTX-A(남부)", to: "동탄" });
    expect(String(last?.tracking_id || "")).not.toBe("");
    expect(String(last?.train_no || "")).toMatch(/^X0\d{3}$/);
  });

  test("exclude_gtx reruns through the ordinary network", async () => {
    const result = await calculateAutoRoute({ from: "연신내", to: "서울역", day: "DAY", start_time: "2026-08-18 10:00:00", exclude_gtx: true }, gtxRealtime);
    expect(result.ok).toBe(true);
    expect(hasGtx(result)).toBe(false);
    expect(result.gtx_excluded).toBe(true);
  });

  test("GTX off still preserves the south section for GTX-exclusive Dongtan", async () => {
    const result = await calculateAutoRoute({ from: "강남", to: "동탄", day: "DAY", start_time: "2026-08-18 10:00:00", use_gtx: false }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.at(-1)).toMatchObject({ line: "GTX-A(남부)", to: "동탄" });
    expect(result.gtx_enabled).toBe(false);
    expect(result.gtx_excluded_lines).toEqual(["GTX-A(북부)"]);
  });
});
