import { expect, test } from "bun:test";
import { calculateAutoRoute } from "../../src/engine/index";

const offlineFetch = async (): Promise<Response> => new Response("offline", { status: 503 });

for (const [from, to] of [["대곡", "수서"], ["별내", "신내"]] as const) {
  test(`reported route ${from} → ${to} calculates without a server exception`, async () => {
    const result = await calculateAutoRoute({
      from,
      to,
      start_time: "2026-08-18 12:00:00",
      day: "DAY",
    }, offlineFetch);
    expect(result.ok).toBe(true);
    expect(result.from).toBe(from);
    expect(result.to).toBe(to);
    expect(Array.isArray(result.segments)).toBe(true);
    expect((result.segments as unknown[]).length).toBeGreaterThan(0);
  });
}
