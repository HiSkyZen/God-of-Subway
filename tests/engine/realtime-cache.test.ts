import { afterEach, expect, test } from "bun:test";
import { fetchPosition, positionRows } from "../../src/engine/realtime-service";
import { resetCacheStateForTests } from "../../src/infra/cache";
import { resetValkeyRuntimeForTests } from "../../src/infra/valkey";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCacheStateForTests();
  resetValkeyRuntimeForTests();
  delete Bun.env.SEOUL_API_KEY;
  delete Bun.env.VALKEY_URL;
  delete Bun.env.REDIS_URL;
});

test("GTX north and south reuse one upstream 1032 source cache", async () => {
  Bun.env.SEOUL_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      realtimePositionList: [
        { subwayId: "1032", statnNm: "서울역", trainNo: "X001" },
        { subwayId: "1032", statnNm: "수서", trainNo: "X002" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const north = await fetchPosition("GTX-A(북부)");
  const south = await fetchPosition("GTX-A(남부)");

  expect(north.ok).toBe(true);
  expect(south.ok).toBe(true);
  expect(positionRows(north.data).map((row) => row.statnNm)).toEqual(["서울역"]);
  expect(positionRows(south.data).map((row) => row.statnNm)).toEqual(["수서"]);
  expect(north.data?._jigeumta_cache_state).toBe("miss");
  expect(south.data?._jigeumta_cache_state).toBe("hit");
  expect(calls).toBe(1);
});
