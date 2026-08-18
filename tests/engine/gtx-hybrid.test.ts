import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { calculateAutoRoute } from "../../src/engine/index";

const previousKey = Bun.env.SEOUL_API_KEY;
const emptyRealtime = async (): Promise<Response> => new Response(JSON.stringify({ realtimePositionList: [] }));

beforeEach(() => { Bun.env.SEOUL_API_KEY = "test"; });
afterEach(() => { if (previousKey == null) delete Bun.env.SEOUL_API_KEY; else Bun.env.SEOUL_API_KEY = previousKey; });

describe("GTX-A exclusive station automatic routing", () => {
  test("운정중앙 can transfer from GTX-A north into the normal route graph", async () => {
    const result = await calculateAutoRoute({ from: "운정중앙", to: "강남", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toMatchObject({ line: "GTX-A(북부)", from: "운정중앙" });
    expect(segments.at(-1)?.to).toBe("강남");
  });

  test("동탄 can be reached by transferring from the normal route graph into GTX-A south", async () => {
    const result = await calculateAutoRoute({ from: "강남", to: "동탄", day: "DAY", start_time: "2026-08-18 10:00:00" }, emptyRealtime);
    expect(result.ok).toBe(true);
    const segments = result.segments as Array<Record<string, unknown>>;
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]?.from).toBe("강남");
    expect(segments.at(-1)).toMatchObject({ line: "GTX-A(남부)", to: "동탄" });
  });
});
