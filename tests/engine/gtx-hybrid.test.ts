import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { calculateAutoRoute } from "../../src/engine/index";

const previousKey = Bun.env.SEOUL_API_KEY;
const emptyRealtime = async (): Promise<Response> => new Response(JSON.stringify({ realtimePositionList: [] }));
const gtxRealtime = async (): Promise<Response> => new Response(JSON.stringify({ realtimePositionList: [
  { subwayId: "1032", trainNo: "A101", statnNm: "운정중앙", statnTnm: "서울역", updnLine: "하행", trainSttus: "2", recptnDt: "2026-08-18 10:00:00" },
  { subwayId: "1032", trainNo: "A201", statnNm: "수서", statnTnm: "동탄", updnLine: "하행", trainSttus: "2", recptnDt: "2026-08-18 10:00:00" },
] }));

beforeEach(() => { Bun.env.SEOUL_API_KEY = "test"; });
afterEach(() => { if (previousKey == null) delete Bun.env.SEOUL_API_KEY; else Bun.env.SEOUL_API_KEY = previousKey; });

describe("GTX-A integrated automatic routing", () => {
  test("a normal trip from 연신내 to 시청 still works when GTX has no usable train", async () => {
    const result = await calculateAutoRoute({ from: "연신내", to: "시청", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.some((segment) => String(segment.line).startsWith("GTX-A"))).toBe(false);
  });

  test("GTX-exclusive origin does not fabricate a train when realtime has none", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "강남", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("이용 가능한 열차 경로");
  });

  test("운정중앙 can use a real GTX-A train and then the normal route graph", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "강남", day: "DAY", start_time: "2026-08-18 10:00:00" }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "운정중앙", train_no: "A101" });
    expect(segments.at(-1)?.to).toBe("강남");
  });

  test("동탄 can be reached through a real GTX-A south train", async () => {
    const result = await calculateAutoRoute({ from: "강남", to: "동탄", day: "DAY", start_time: "2026-08-18 10:00:00" }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.at(-1)).toMatchObject({ line: "GTX-A(남부)", to: "동탄", train_no: "A201" });
  });

  test("exclude_gtx reruns through the ordinary network", async () => {
    const result = await calculateAutoRoute({ from: "연신내", to: "서울역", day: "DAY", start_time: "2026-08-18 10:00:00", exclude_gtx: true }, gtxRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.some((segment) => String(segment.line).startsWith("GTX-A"))).toBe(false);
    expect(result.gtx_excluded).toBe(true);
  });
});
