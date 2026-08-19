import { expect, test } from "bun:test";
import { routeTimestamp } from "../../src/client/journey-view";

test("backend KST wall-clock timestamps are timezone-stable", () => {
  expect(routeTimestamp("2026-08-19 22:00:00")).toBe(Date.parse("2026-08-19T22:00:00+09:00"));
  expect(routeTimestamp("2026-08-19T13:00:00Z")).toBe(Date.parse("2026-08-19T13:00:00Z"));
});

test("journey view keeps client-local transfer deadlines separate from backend KST route times", async () => {
  const source = await Bun.file("src/client/journey-view.tsx").text();
  expect(source).toContain("routeTimestamp(startValue)");
  expect(source).toContain("routeTimestamp(endValue)");
  expect(source).toContain("localTimestamp(liveTrip?.transferEndsAt)");
});
