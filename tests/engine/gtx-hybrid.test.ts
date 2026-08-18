import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { calculateAutoRoute } from "../../src/engine/index";

const previousKey = Bun.env.SEOUL_API_KEY;
const emptyRealtime = async (): Promise<Response> => new Response(JSON.stringify({ realtimePositionList: [] }));
const gtxRealtime = async (): Promise<Response> => new Response(JSON.stringify({ realtimePositionList: [
  { subwayId: "1032", trainNo: "A101", statnNm: "운정중앙", statnTnm: "서울역", updnLine: "1", trainSttus: "2", recptnDt: "2026-08-18 10:00:00" },
  { subwayId: "1032", trainNo: "A201", statnNm: "수서", statnTnm: "동탄", updnLine: "1", trainSttus: "2", recptnDt: "2026-08-18 10:00:00" },
] }));

beforeEach(() => { Bun.env.SEOUL_API_KEY = "test"; });
afterEach(() => { if (previousKey == null) delete Bun.env.SEOUL_API_KEY; else Bun.env.SEOUL_API_KEY = previousKey; });

function hasGtx(result: Record<string, unknown>): boolean {
  const segments = result.segments as Array<Record<string, unknown>> | undefined;
  return Boolean(segments?.some((segment) => String(segment.line).startsWith("GTX-A")));
}

describe("GTX-A integrated automatic routing", () => {
  test("대곡 → 시청 prefers the useful GTX-A path", async () => {
    const result = await calculateAutoRoute({ from: "대곡", to: "시청", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    expect(hasGtx(result)).toBe(true);
  });

  test("연신내 → 용산 prefers the useful GTX-A path", async () => {
    const result = await calculateAutoRoute({ from: "연신내", to: "용산", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    expect(hasGtx(result)).toBe(true);
  });

  test("운정중앙 → 시청 works from the GTX-exclusive origin using timetable candidates", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "시청", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "운정중앙" });
    expect(segments.at(-1)?.to).toBe("시청");
  });

  test("킨텍스 → 용산 works from the GTX-exclusive origin using timetable candidates", async () => {
    const result = await calculateAutoRoute({ from: "킨텍스", to: "용산", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "킨텍스" });
    expect(segments.at(-1)?.to).toBe("용산");
  });

  test("GTX-exclusive origin reports no service after the final scheduled train", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "시청", day: "DAY", start_time: "2026-08-19 01:10:00" }, emptyRealtime);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("이용 가능한 열차 경로");
  });

  test("realtime GTX row wins when it gives an earlier valid train", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "강남", day: "DAY", start_time: "2026-08-18 10:00:00" }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "운정중앙", train_no: "A101", confidence: "높음" });
    expect(segments.at(-1)?.to).toBe("강남");
  });

  test("동탄 can be reached through the integrated GTX-A south section", async () => {
    const result = await calculateAutoRoute({ from: "강남", to: "동탄", day: "DAY", start_time: "2026-08-18 10:00:00" }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.at(-1)).toMatchObject({ line: "GTX-A(남부)", to: "동탄" });
    expect(String(segments.at(-1)?.train_no || "")).not.toBe("");
  });

  test("exclude_gtx reruns through the ordinary network", async () => {
    const result = await calculateAutoRoute({ from: "연신내", to: "서울역", day: "DAY", start_time: "2026-08-18 10:00:00", exclude_gtx: true }, gtxRealtime);
    expect(result.ok).toBe(true);
    expect(hasGtx(result)).toBe(false);
    expect(result.gtx_excluded).toBe(true);
  });
});
