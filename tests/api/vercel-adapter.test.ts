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

test("Vercel publishes static output while only /api is deployed as a Bun Function", async () => {
  const config = JSON.parse(await Bun.file("vercel.json").text()) as {
    framework?: string | null;
    bunVersion?: string;
    outputDirectory?: string;
    regions?: string[];
    functions?: Record<string, { includeFiles?: string }>;
    crons?: unknown;
  };

  // Explicitly select the "Other" preset. Without this, Vercel can persist or
  // auto-detect the Bun/Node zero-config backend preset from src/server.ts and
  // try to bundle the local Bun HTML server as the deployment backend.
  expect(config.framework).toBeNull();
  expect(config.bunVersion).toBe("1.x");
  expect(config.outputDirectory).toBe("dist/public");
  expect(config.regions).toEqual(["icn1"]);
  expect(config.crons).toBeUndefined();
  const includeFiles = config.functions?.["api/index.ts"]?.includeFiles || "";
  expect(includeFiles).toBe(
    "{schedule_weekday.json,schedule_holiday.json,stations.json,official_2to9_schedule.json,korail_extra_lines_schedule.json,sinbundang_schedule.json,kr_holidays_2026_2035.json,route_graph.json,transfer_data.json}",
  );
  expect(includeFiles).toContain("sinbundang_schedule.json");

  expect(await Bun.file("src/server.ts").exists()).toBeTrue();
  expect(await Bun.file("src/bun-server.ts").exists()).toBeFalse();
  expect(await Bun.file("api/index.ts").text()).not.toContain("../src/server");
});
