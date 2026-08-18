import { describe, expect, test } from "bun:test";
import { GA_MEASUREMENT_ID, initializeAnalytics, track, trackOnce, type AnalyticsDocument, type AnalyticsWindow } from "../../src/client/analytics";

function harness(hostname: string): { targetWindow: AnalyticsWindow; targetDocument: AnalyticsDocument; appended: HTMLScriptElement[] } {
  const appended: HTMLScriptElement[] = [];
  const storage = new Map<string, string>();
  const targetWindow: AnalyticsWindow = {
    location: { hostname },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
    },
  };
  const targetDocument: AnalyticsDocument = {
    createElement: () => ({ async: false, src: "", setAttribute: () => undefined } as unknown as HTMLScriptElement),
    querySelector: () => null,
    head: { appendChild: (node) => { expect(targetWindow.dataLayer?.at(-1)?.[0]).toBe("config"); appended.push(node as unknown as HTMLScriptElement); return node; } },
  };
  return { targetWindow, targetDocument, appended };
}

describe("GA4 bootstrap", () => {
  test("owns the only gtag network loader outside HTML", async () => {
    const html = await Bun.file("src/client/index.html").text();
    expect(html).not.toContain("googletagmanager.com/gtag/js");
    const source = await Bun.file("src/client/analytics.ts").text();
    expect(source.match(/googletagmanager\.com\/gtag\/js/g)).toHaveLength(1);
  });

  test("queues internal traffic before a single config and only then loads gtag.js", () => {
    const { targetWindow, targetDocument, appended } = harness("localhost");
    initializeAnalytics(targetWindow, targetDocument, new Date("2026-08-18T00:00:00Z"));
    initializeAnalytics(targetWindow, targetDocument, new Date("2026-08-19T00:00:00Z"));

    expect(targetWindow.dataLayer?.map((entry) => entry[0])).toEqual(["js", "set", "config"]);
    expect(targetWindow.dataLayer?.[1]?.[1]).toEqual({ traffic_type: "internal", debug_mode: true });
    expect(targetWindow.dataLayer?.filter((entry) => entry[0] === "config")).toEqual([["config", GA_MEASUREMENT_ID]]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.src).toContain(GA_MEASUREMENT_ID);
  });

  test("production omits debug flags while events and session-once funnels enter the queue", () => {
    const { targetWindow, targetDocument } = harness("god-of-subway.vercel.app");
    initializeAnalytics(targetWindow, targetDocument);
    track("route_search", { from: "강남" }, targetWindow);
    trackOnce("station_set", "강남→잠실", { to: "잠실" }, targetWindow);
    trackOnce("station_set", "강남→잠실", { to: "잠실" }, targetWindow);

    expect(targetWindow.dataLayer?.map((entry) => entry[0])).toEqual(["js", "config", "event", "event"]);
    expect(targetWindow.dataLayer?.filter((entry) => entry[1] === "station_set")).toHaveLength(1);
  });
});
