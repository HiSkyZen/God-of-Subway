import { expect, test } from "bun:test";
import adapter from "../../api/index";

test("Vercel adapter restores wildcard API path when rewrites target /api", async () => {
  const response = await adapter.fetch(new Request("https://example.test/api?path=health"));
  expect(response.status).toBe(200);
  expect((await response.json()).ok).toBe(true);
});

test("Vercel adapter leaves already-routed API paths unchanged", async () => {
  const response = await adapter.fetch(new Request("https://example.test/api/stations"));
  expect(response.status).toBe(200);
  expect((await response.json()).stations).toBeDefined();
});

test("Vercel publishes only public assets and traces every engine data file into the icn1 Bun Function", async () => {
  const config = JSON.parse(await Bun.file("vercel.json").text()) as {
    bunVersion?: string;
    outputDirectory?: string;
    regions?: string[];
    functions?: Record<string, { includeFiles?: string }>;
    crons?: unknown;
  };
  expect(config.bunVersion).toBe("1.x");
  expect(config.outputDirectory).toBe("dist/public");
  expect(config.regions).toEqual(["icn1"]);
  expect(config.crons).toBeUndefined();
  expect(config.functions?.["api/index.ts"]?.includeFiles).toBe(
    "{schedule_weekday.json,schedule_holiday.json,stations.json,official_2to9_schedule.json,korail_extra_lines_schedule.json,kr_holidays_2026_2035.json,route_graph.json,transfer_data.json}",
  );
  expect(await Bun.file("api/index.ts").text()).not.toContain("../src/server");
});
