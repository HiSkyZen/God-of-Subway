import { describe, expect, test } from "bun:test";
import { createFetchHandler, type AssetProvider } from "../../src/api/router";
import type { EnginePort } from "../../src/api/types";

const engine: EnginePort = {
  nowKst: () => new Date("2026-08-18T12:00:00+09:00"),
  healthSnapshot: () => ({ version: "test", nested: { secret: "must-not-leak" } }),
  stationsByLine: { "2호선": ["강남", "잠실"] },
  calculateRoute: async () => ({ ok: true, route_seconds: 120 }),
  calculateAutoRoute: async () => ({ ok: true, segments: [] }),
  calculateLiveTrip: async () => ({ ok: true, phase: "ride" }),
};

const assets: AssetProvider = {
  index: () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
  logo: () => new Response("png", { headers: { "content-type": "image/png" } }),
  serviceWorker: () => new Response("self.addEventListener('fetch', () => undefined)", { headers: { "content-type": "application/javascript", "service-worker-allowed": "/" } }),
  manifest: () => new Response("{}", { headers: { "content-type": "application/manifest+json" } }),
  icon: () => new Response("png", { headers: { "content-type": "image/png" } }),
};

const handler = createFetchHandler(engine, assets);
const request = (path: string, init?: RequestInit) => handler(new Request(`http://localhost${path}`, init));

describe("Bun API contract", () => {
  test("serves allowlisted static routes and blocks .env", async () => {
    expect((await request("/")).status).toBe(200);
    expect((await request("/logo")).status).toBe(200);
    expect((await request("/sw.js")).headers.get("service-worker-allowed")).toBe("/");
    expect((await request("/manifest.webmanifest")).status).toBe(200);
    expect((await request("/icons/icon-192.png")).status).toBe(200);
    expect((await request("/.env")).status).toBe(404);
    expect((await request("/engine.py")).status).toBe(404);
  });

  test("applies a no-inline CSP and baseline security headers to static, API, and Vercel responses", async () => {
    for (const path of ["/", "/api/health", "/missing"]) {
      const response = await request(path);
      const csp = response.headers.get("content-security-policy") || "";
      expect(csp).toContain("script-src 'self' https://www.googletagmanager.com");
      expect(csp).toContain("worker-src 'self'");
      expect(csp).toContain("manifest-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
    }
    const vercel = JSON.parse(await Bun.file("vercel.json").text()) as {
      headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }>;
    };
    const global = vercel.headers?.find((entry) => entry.source === "/(.*)")?.headers || [];
    const byName = new Map(global.map((entry) => [entry.key?.toLowerCase(), entry.value || ""]));
    expect(byName.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(byName.get("content-security-policy")).not.toContain("'unsafe-inline'");
    expect(byName.get("x-content-type-options")).toBe("nosniff");
  });

  test("never serves secret or source-like paths, including HEAD and traversal forms", async () => {
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/.env", "/.env.local", "/%2e%2e/.env", "/%2e%2e%5c.env", "/engine.py"]) {
        const response = await request(path, { method });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
      }
    }
  });

  test("exposes health and stations without leaking secrets", async () => {
    const health = await request("/api/health");
    const body = await health.json();
    expect(health.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.api_key_configured).toBe("boolean");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");

    const stations = await request("/api/stations");
    expect(stations.status).toBe(200);
    expect((await stations.json()).stations["2호선"]).toEqual(["강남", "잠실"]);
  });

  test("enforces methods and JSON body limits", async () => {
    expect((await request("/api/route", { method: "GET" })).status).toBe(405);
    expect((await request("/api/route", { method: "POST", body: "not-json" })).status).toBe(422);
    expect((await request("/api/route", { method: "POST" })).status).toBe(422);
    expect((await request("/api/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    })).status).toBe(200);
  });

  test("returns generic 500 when engine fails", async () => {
    const failing = createFetchHandler({ ...engine, calculateRoute: () => { throw new Error("private details"); } }, assets);
    const response = await failing(new Request("http://localhost/api/route", {
      method: "POST",
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("서버 내부 오류가 발생했습니다.");
    expect(JSON.stringify(body)).not.toContain("private details");
  });

  test("maps known engine validation to safe 422 Korean contract", async () => {
    const invalid = createFetchHandler({ ...engine, calculateRoute: () => { throw new Error("구간은 1~8개로 입력하세요."); } }, assets);
    const response = await invalid(new Request("http://localhost/api/route", { method: "POST", body: JSON.stringify({}) }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: "요청 값이 올바르지 않습니다." });
  });

  test("reports push capability without exposing private VAPID material", async () => {
    const saved = {
      publicKey: Bun.env.VAPID_PUBLIC_KEY,
      privateKey: Bun.env.VAPID_PRIVATE_KEY,
      subject: Bun.env.VAPID_SUBJECT,
    };
    delete Bun.env.VAPID_PUBLIC_KEY;
    delete Bun.env.VAPID_PRIVATE_KEY;
    delete Bun.env.VAPID_SUBJECT;
    try {
      const response = await request("/api/push/public-key");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: true,
        capable: false,
        subscription_capable: false,
        arrival_alert_capable: false,
        scheduler_mode: null,
        public_key: null,
        configuration_issues: expect.arrayContaining(["vapid_unavailable"]),
        configuration_message: "Web Push VAPID 키가 구성되지 않았습니다.",
      });
      expect(JSON.stringify(body)).not.toContain("privateKey");
      expect(JSON.stringify(body)).not.toContain("VAPID_PRIVATE_KEY");
      expect((await request("/api/push/subscriptions", { method: "POST", body: "{}" })).status).toBe(422);
    } finally {
      if (saved.publicKey === undefined) delete Bun.env.VAPID_PUBLIC_KEY; else Bun.env.VAPID_PUBLIC_KEY = saved.publicKey;
      if (saved.privateKey === undefined) delete Bun.env.VAPID_PRIVATE_KEY; else Bun.env.VAPID_PRIVATE_KEY = saved.privateKey;
      if (saved.subject === undefined) delete Bun.env.VAPID_SUBJECT; else Bun.env.VAPID_SUBJECT = saved.subject;
    }
  });
});
