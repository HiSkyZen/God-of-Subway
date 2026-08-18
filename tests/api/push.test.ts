import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  pushAlertStore,
  pushSubscriptionStore,
  resetPushRuntimeStateForTests,
  setPushAlertStore,
  setPushDelivery,
  setPushSubscriptionStore,
  type PushAlertRecord,
  type PushAlertStore,
  type PushDelivery,
  type PushSubscriptionRecord,
  type PushSubscriptionStore,
} from "../../src/api/push";
import { createFetchHandler, type AssetProvider } from "../../src/api/router";
import type { EnginePort } from "../../src/api/types";

const engine: EnginePort = {
  nowKst: () => new Date(),
  healthSnapshot: () => ({}),
  stationsByLine: {},
  calculateRoute: () => ({ ok: true }),
  calculateAutoRoute: () => ({ ok: true }),
  calculateLiveTrip: () => ({ ok: true, remaining_seconds: 120, segments: [{}] }),
};
const assets: AssetProvider = {
  index: () => new Response("html"), logo: () => new Response("png"),
  serviceWorker: () => new Response("sw"), manifest: () => new Response("{}"), icon: () => new Response("png"),
};
const future = (minutes = 60): string => new Date(Date.now() + minutes * 60_000).toISOString();
const p256dhBytes = new Uint8Array(65).fill(7);
p256dhBytes[0] = 4;
const validKeys = {
  p256dh: Buffer.from(p256dhBytes).toString("base64url"),
  auth: Buffer.from(new Uint8Array(16).fill(9)).toString("base64url"),
};
const record = (endpoint: string, expirationTime: number | null = null): PushSubscriptionRecord => ({
  endpoint, expirationTime, keys: validKeys, updatedAt: new Date().toISOString(),
});
const tripPayload = { segments: [{ line: "2호선", from: "강남", to: "잠실" }], active_index: 0, boarded_train_no: "A1" };
const configure = (records: PushSubscriptionRecord[] = [], alerts: PushAlertRecord[] = []) => {
  const subscriptionStore: PushSubscriptionStore = {
    list: async () => records.slice(),
    get: async (endpoint) => records.find((item) => item.endpoint === endpoint),
    upsert: async (value) => { const index = records.findIndex((item) => item.endpoint === value.endpoint); if (index >= 0) records[index] = value; else records.push(value); },
    remove: async (endpoint) => { const index = records.findIndex((item) => item.endpoint === endpoint); if (index < 0) return false; records.splice(index, 1); return true; },
    count: async () => records.length,
  };
  const alertStore: PushAlertStore = {
    list: async () => alerts.slice(),
    getByEndpoint: async (endpoint) => alerts.find((item) => item.subscriptionEndpoint === endpoint),
    upsert: async (value) => { const next = alerts.filter((item) => item.alertId !== value.alertId && item.subscriptionEndpoint !== value.subscriptionEndpoint); next.push(value); alerts.splice(0, alerts.length, ...next); },
    replaceForEndpoint: async (value) => { const next = alerts.filter((item) => item.subscriptionEndpoint !== value.subscriptionEndpoint); next.push(value); alerts.splice(0, alerts.length, ...next); },
    remove: async (id) => { const index = alerts.findIndex((item) => item.alertId === id); if (index < 0) return false; alerts.splice(index, 1); return true; },
    removeOwned: async (endpoint, id) => { const index = alerts.findIndex((item) => item.alertId === id && item.subscriptionEndpoint === endpoint); if (index < 0) return false; alerts.splice(index, 1); return true; },
    count: async () => alerts.length,
  };
  setPushSubscriptionStore(subscriptionStore);
  setPushAlertStore(alertStore);
  return { records, alerts, subscriptionStore, alertStore };
};
const request = (handler: ReturnType<typeof createFetchHandler>, path: string, init?: RequestInit) => handler(new Request(`http://localhost${path}`, init));
const setVapid = (): void => {
  Bun.env.VAPID_PUBLIC_KEY = validKeys.p256dh;
  Bun.env.VAPID_PRIVATE_KEY = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");
  Bun.env.VAPID_SUBJECT = "mailto:test@example.invalid";
};
const subscriptionBody = (endpoint: string, managementToken?: string) => ({
  endpoint,
  expirationTime: null,
  keys: validKeys,
  ...(managementToken ? { management_token: managementToken } : {}),
});

afterEach(() => {
  resetPushRuntimeStateForTests();
  for (const key of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "PUSH_TEST_ENABLED", "PUSH_TEST_TOKEN", "PUSH_CRON_ENABLED", "PUSH_CRON_TOKEN", "CRON_SECRET", "PUSH_SCHEDULER_MODE", "PUSH_SCHEDULER_INTERVAL_SECONDS", "PUSH_DISPATCH_BATCH_SIZE", "PUSH_DISPATCH_CONCURRENCY", "PUSH_DISPATCH_LEASE_SECONDS", "PUSH_DELIVERY_CLAIM_SECONDS", "PUSH_REDIS_URL", "PUSH_REDIS_TOKEN", "PUSH_REDIS_SCAN_COUNT", "PUSH_STORE_PATH", "PUSH_ALERTS_PATH", "PUSH_MAX_SUBSCRIPTIONS", "PUSH_MAX_SUBSCRIPTIONS_PER_SOURCE", "PUSH_MAX_ALERTS", "PUSH_REGISTRATION_RATE_LIMIT", "PUSH_REGISTRATION_RATE_WINDOW_SECONDS", "PUSH_TRUST_PROXY", "VERCEL", "NODE_ENV"]) delete Bun.env[key];
});

test("push test sends a standards payload and prunes expired/410 subscriptions", async () => {
  setVapid(); Bun.env.PUSH_TEST_ENABLED = "1"; Bun.env.PUSH_TEST_TOKEN = "test-token";
  const active = record("https://push.example/active", Date.now() + 60_000);
  const gone = record("https://push.example/gone");
  const { records } = configure([active, gone, record("https://push.example/expired", Date.now() - 1)]);
  const sent: string[] = [];
  setPushDelivery({ send: async (subscription, message) => { if (subscription.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 }); sent.push(`${subscription.endpoint}:${message.title}:${message.body}`); } });
  const response = await request(createFetchHandler(engine, assets), "/api/push/test", {
    method: "POST", headers: { "x-push-test-token": "test-token", "content-type": "application/json" },
    body: JSON.stringify({ title: "지금타", body: "곧 도착합니다", url: "/" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, delivered: 1, removed: 2, failed: 0 });
  expect(sent).toEqual(["https://push.example/active:지금타:곧 도착합니다"]);
  expect(records.map((item) => item.endpoint)).toEqual(["https://push.example/active"]);
});

test("alert registration owns the subscription, validates the trip, and replaces/deletes one active alert", async () => {
  setVapid(); Bun.env.PUSH_SCHEDULER_MODE = "external"; Bun.env.CRON_SECRET = "cron-secret";
  const { alerts } = configure();
  const handler = createFetchHandler(engine, assets);
  const subscription = await request(handler, "/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscriptionBody("https://push.example/alert")) });
  const owner = await subscription.json() as { endpoint: string; management_token: string };
  expect(subscription.status).toBe(200);
  const invalid = await request(handler, "/api/push/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription_endpoint: owner.endpoint, management_token: owner.management_token, destination: "잠실", threshold_seconds: 60, trip_payload: { segments: [] } }) });
  expect(invalid.status).toBe(422);
  const create = async (destination: string) => request(handler, "/api/push/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription_endpoint: owner.endpoint, management_token: owner.management_token, destination, threshold_seconds: 60, trip_payload: tripPayload }) });
  const first = await create("잠실"); const firstBody = await first.json() as { alert_id: string; expires_at: string };
  expect(first.status).toBe(200); expect(firstBody.alert_id).toBeTruthy(); expect(Date.parse(firstBody.expires_at)).toBeGreaterThan(Date.now());
  const second = await create("성수"); const secondBody = await second.json() as { alert_id: string };
  expect(second.status).toBe(200); expect(secondBody.alert_id).not.toBe(firstBody.alert_id); expect(alerts).toHaveLength(1); expect(alerts[0].destination).toBe("성수");
  const forbidden = await request(handler, "/api/push/alerts", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ alert_id: secondBody.alert_id, subscription_endpoint: owner.endpoint, management_token: "wrong-management-token-000000" }) });
  expect(forbidden.status).toBe(403);
  const removed = await request(handler, "/api/push/alerts", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ alert_id: secondBody.alert_id, subscription_endpoint: owner.endpoint, management_token: owner.management_token }) });
  expect(removed.status).toBe(200); expect(alerts).toHaveLength(0);
});

test("public push capability distinguishes subscription from scheduled arrival alerts", async () => {
  setVapid();
  const handler = createFetchHandler(engine, assets);
  const unavailable = await request(handler, "/api/push/public-key");
  expect(await unavailable.json()).toMatchObject({ capable: true, subscription_capable: true, arrival_alert_capable: false, scheduler_mode: null });
  Bun.env.PUSH_SCHEDULER_MODE = "external"; Bun.env.CRON_SECRET = "cron-secret";
  const available = await request(handler, "/api/push/public-key");
  expect(await available.json()).toMatchObject({ capable: true, subscription_capable: true, arrival_alert_capable: true, scheduler_mode: "external" });
});

test("capability validates VAPID material and never advertises an interval scheduler on Vercel", async () => {
  setVapid();
  const handler = createFetchHandler(engine, assets);
  Bun.env.PUSH_SCHEDULER_INTERVAL_SECONDS = "60";
  Bun.env.PUSH_CRON_ENABLED = "1";
  Bun.env.PUSH_CRON_TOKEN = "local-cron";
  Bun.env.VERCEL = "1";
  expect(await (await request(handler, "/api/push/public-key")).json()).toMatchObject({
    subscription_capable: true,
    arrival_alert_capable: false,
    scheduler_mode: null,
  });
  Bun.env.PUSH_SCHEDULER_MODE = "external";
  Bun.env.CRON_SECRET = "cron-secret";
  expect(await (await request(handler, "/api/push/public-key")).json()).toMatchObject({
    arrival_alert_capable: true,
    scheduler_mode: "external",
  });

  const validPublic = Bun.env.VAPID_PUBLIC_KEY;
  const validPrivate = Bun.env.VAPID_PRIVATE_KEY;
  for (const invalid of [
    () => { Bun.env.VAPID_PUBLIC_KEY = Buffer.from(new Uint8Array(64).fill(4)).toString("base64url"); },
    () => { Bun.env.VAPID_PUBLIC_KEY = validPublic; Bun.env.VAPID_PRIVATE_KEY = Buffer.from(new Uint8Array(31)).toString("base64url"); },
    () => { Bun.env.VAPID_PRIVATE_KEY = validPrivate; Bun.env.VAPID_SUBJECT = "ftp://example.invalid"; },
  ]) {
    setVapid(); invalid();
    expect(await (await request(handler, "/api/push/public-key")).json()).toMatchObject({
      capable: false,
      subscription_capable: false,
      arrival_alert_capable: false,
      public_key: null,
    });
  }
});

test("production rejects invalid or credential-bearing Redis URLs before sending the token", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("must not send");
  }) as unknown as typeof fetch;
  try {
    for (const redisUrl of [
      "http://redis.example",
      "https://user:password@redis.example",
      "not a URL",
    ]) {
      resetPushRuntimeStateForTests();
      setVapid();
      Bun.env.NODE_ENV = "production";
      Bun.env.PUSH_REDIS_URL = redisUrl;
      Bun.env.PUSH_REDIS_TOKEN = "must-never-leave-process";
      const handler = createFetchHandler(engine, assets);
      const capability = await request(handler, "/api/push/public-key");
      expect(await capability.json()).toMatchObject({
        subscription_capable: false,
        arrival_alert_capable: false,
        public_key: null,
      });
      expect(pushSubscriptionStore().upsert(record("https://push.example/rejected"))).rejects.toThrow();
    }
    expect(fetchCalls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatch uses GET Bearer cron auth, retains waiting alerts, and sends once at threshold", async () => {
  setVapid(); Bun.env.CRON_SECRET = "cron-secret"; Bun.env.PUSH_SCHEDULER_MODE = "external";
  const { alerts } = configure([record("https://push.example/alert")]);
  alerts.push({ alertId: "retained", subscriptionEndpoint: "https://push.example/alert", destination: "잠실", thresholdSeconds: 60, tripPayload, createdAt: new Date().toISOString(), expiresAt: future() });
  let remaining = 120; const sent: string[] = [];
  setPushDelivery({ send: async (_subscription, message) => { sent.push(message.body); } });
  const handler = createFetchHandler({ ...engine, calculateLiveTrip: async () => ({ ok: true, remaining_seconds: remaining }) }, assets);
  expect((await request(handler, "/api/push/dispatch", { method: "GET", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  const waiting = await request(handler, "/api/push/dispatch", { method: "GET", headers: { authorization: "Bearer cron-secret" } });
  expect(await waiting.json()).toEqual({ ok: true, evaluated: 1, delivered: 0, removed: 0, failed: 0, has_more: false, next_cursor: "0" }); expect(alerts).toHaveLength(1);
  remaining = 20;
  const delivered = await request(handler, "/api/push/dispatch", { method: "GET", headers: { authorization: "Bearer cron-secret" } });
  expect(await delivered.json()).toEqual({ ok: true, evaluated: 1, delivered: 1, removed: 0, failed: 0, has_more: false, next_cursor: "0" }); expect(sent).toHaveLength(1); expect(alerts).toHaveLength(0);
  expect(await (await request(handler, "/api/push/dispatch", { method: "GET", headers: { authorization: "Bearer cron-secret" } })).json()).toEqual({ ok: true, evaluated: 0, delivered: 0, removed: 0, failed: 0, has_more: false, next_cursor: "0" });
});

test("dispatch expiry and delivery 404/410 prune alert and subscription; engine errors retain alert", async () => {
  setVapid(); Bun.env.PUSH_CRON_ENABLED = "1"; Bun.env.PUSH_CRON_TOKEN = "local-cron"; Bun.env.PUSH_SCHEDULER_MODE = "external"; Bun.env.CRON_SECRET = "cron-secret";
  const expired = record("https://push.example/expired"); const gone = record("https://push.example/gone");
  const { records, alerts } = configure([expired, gone], [
    { alertId: "expired", subscriptionEndpoint: expired.endpoint, destination: "잠실", thresholdSeconds: 60, tripPayload, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() },
    { alertId: "gone", subscriptionEndpoint: gone.endpoint, destination: "성수", thresholdSeconds: 60, tripPayload, createdAt: new Date().toISOString(), expiresAt: future() },
  ]);
  setPushDelivery({ send: async () => { throw Object.assign(new Error("gone"), { statusCode: 404 }); } });
  const handler = createFetchHandler({ ...engine, calculateLiveTrip: async () => ({ ok: true, remaining_seconds: 0 }) }, assets);
  const response = await request(handler, "/api/push/dispatch", { method: "POST", headers: { "x-push-cron-token": "local-cron" } });
  expect(await response.json()).toEqual({ ok: true, evaluated: 1, delivered: 0, removed: 3, failed: 0, has_more: false, next_cursor: "0" }); expect(records).toHaveLength(1); expect(alerts).toHaveLength(0);

  records.push(gone); alerts.push({ alertId: "failing", subscriptionEndpoint: gone.endpoint, destination: "잠실", thresholdSeconds: 60, tripPayload, createdAt: new Date().toISOString(), expiresAt: future() });
  setPushDelivery({ send: async () => undefined });
  const failing = createFetchHandler({ ...engine, calculateLiveTrip: async () => { throw new Error("temporary engine error"); } }, assets);
  const failedResponse = await request(failing, "/api/push/dispatch", { method: "POST", headers: { "x-push-cron-token": "local-cron" } });
  expect(failedResponse.status).toBe(502); expect((await failedResponse.json()).failed).toBe(1); expect(alerts).toHaveLength(1);
});

test("dispatch batch is bounded and Redis persistence uses hash field operations", async () => {
  setVapid(); Bun.env.CRON_SECRET = "cron-secret"; Bun.env.PUSH_SCHEDULER_MODE = "external"; Bun.env.PUSH_DISPATCH_BATCH_SIZE = "1";
  const first = record("https://push.example/one"); const second = record("https://push.example/two");
  const alert = (id: string, endpoint: string): PushAlertRecord => ({ alertId: id, subscriptionEndpoint: endpoint, destination: "잠실", thresholdSeconds: 60, tripPayload, createdAt: new Date().toISOString(), expiresAt: future() });
  const { alerts } = configure([first, second], [alert("one", first.endpoint), alert("two", second.endpoint)]);
  let sent = 0; setPushDelivery({ send: async () => { sent += 1; } });
  const handler = createFetchHandler({ ...engine, calculateLiveTrip: async () => ({ ok: true, remaining_seconds: 0 }) }, assets);
  const response = await request(handler, "/api/push/dispatch", { method: "GET", headers: { authorization: "Bearer cron-secret" } });
  expect(await response.json()).toEqual({ ok: true, evaluated: 1, delivered: 1, removed: 0, failed: 0, has_more: true, next_cursor: "1" }); expect(sent).toBe(1); expect(alerts).toHaveLength(1);
  const originalFetch = globalThis.fetch;
  const commands: string[][] = [];
  const redisAlert = alert(crypto.randomUUID(), first.endpoint);
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as string[];
    commands.push(command);
    const result = command[0] === "GET" ? "0"
      : command[0] === "HSCAN" ? ["7", [first.endpoint, JSON.stringify(redisAlert)]]
      : command[0] === "SET" ? "OK"
      : 1;
    return Response.json({ result });
  }) as typeof fetch;
  try {
    setPushSubscriptionStore(undefined); setPushAlertStore(undefined); Bun.env.NODE_ENV = "production"; Bun.env.PUSH_REDIS_URL = "https://redis.example"; Bun.env.PUSH_REDIS_TOKEN = "redis-token";
    const subscriptions = pushSubscriptionStore(); const redisAlerts = pushAlertStore();
    await subscriptions.upsert(first); await redisAlerts.upsert(redisAlert);
    const page = await redisAlerts.nextBatch!(1);
    expect(page).toMatchObject({ nextCursor: "7", hasMore: true });
    expect(await redisAlerts.acquireDispatchLease!("lease-token", 90)).toBeTrue();
    await redisAlerts.releaseDispatchLease!("lease-token");
    expect(await redisAlerts.claimForDelivery!(first.endpoint, redisAlert.alertId, "claim-token", 90)).toBeTrue();
    expect(await redisAlerts.completeDeliveryClaim!(first.endpoint, redisAlert.alertId, "claim-token")).toBeTrue();
    expect(await redisAlerts.removeOwned!(first.endpoint, redisAlert.alertId)).toBeTrue();
    expect(commands[0][0]).toBe("HSET"); expect(commands[0][2]).toBe(first.endpoint);
    expect(commands[1][0]).toBe("EVAL"); expect(commands[1].join(" ")).toContain("EXISTS"); expect(commands[1].join(" ")).toContain(first.endpoint);
    expect(commands.some((command) => command[0] === "HGETALL")).toBeFalse();
    expect(commands.some((command) => command[0] === "HSCAN" && command.includes("COUNT"))).toBeTrue();
    expect(commands.some((command) => command[0] === "SET" && command.includes("NX") && command.includes("EX"))).toBeTrue();
    expect(commands.filter((command) => command[0] === "EVAL").some((command) => command.join(" ").includes("redis.call('GET'"))).toBeTrue();
    expect(commands.filter((command) => command[0] === "EVAL").some((command) => command.join(" ").includes("alertId"))).toBeTrue();
    expect(commands.filter((command) => command[0] === "EVAL").some((command) => command.join(" ").includes("delivery-claim"))).toBeTrue();
  } finally { globalThis.fetch = originalFetch; delete Bun.env.NODE_ENV; delete Bun.env.PUSH_REDIS_URL; delete Bun.env.PUSH_REDIS_TOKEN; }
});

test("dispatch worker pool enforces explicit concurrency limit", async () => {
  setVapid(); Bun.env.CRON_SECRET = "cron-secret"; Bun.env.PUSH_SCHEDULER_MODE = "external"; Bun.env.PUSH_DISPATCH_BATCH_SIZE = "4"; Bun.env.PUSH_DISPATCH_CONCURRENCY = "2";
  const records = Array.from({ length: 4 }, (_, index) => record(`https://push.example/${index}`));
  const alerts = records.map((item, index): PushAlertRecord => ({ alertId: `alert-${index}`, subscriptionEndpoint: item.endpoint, destination: "잠실", thresholdSeconds: 60, tripPayload, createdAt: new Date().toISOString(), expiresAt: future() }));
  configure(records, alerts);
  let inFlight = 0; let peak = 0;
  setPushDelivery({ send: async () => undefined });
  const handler = createFetchHandler({ ...engine, calculateLiveTrip: async () => { inFlight += 1; peak = Math.max(peak, inFlight); await Bun.sleep(5); inFlight -= 1; return { ok: true, remaining_seconds: 0 }; } }, assets);
  const response = await request(handler, "/api/push/dispatch", { method: "GET", headers: { authorization: "Bearer cron-secret" } });
  expect(response.status).toBe(200); expect((await response.json()).delivered).toBe(4); expect(peak).toBeLessThanOrEqual(2);
});

test("strict subscription validation and bounded registration quotas reject abuse safely", async () => {
  setVapid();
  const { subscriptionStore } = configure();
  const handler = createFetchHandler(engine, assets);
  const shortKey = await request(handler, "/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "https://push.example/invalid", expirationTime: null, keys: { p256dh: "AA", auth: "AA" } }),
  });
  expect(shortKey.status).toBe(422);
  const credentials = await request(handler, "/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://user:password@push.example/invalid")),
  });
  expect(credentials.status).toBe(422);

  Bun.env.PUSH_MAX_SUBSCRIPTIONS = "1";
  const first = await request(handler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/quota-one")),
  });
  expect(first.status).toBe(200);
  const overflow = await request(handler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/quota-two")),
  });
  expect(overflow.status).toBe(503);
  expect(await overflow.json()).toMatchObject({ code: "push_capacity_exceeded" });

  Bun.env.PUSH_MAX_SUBSCRIPTIONS = "100";
  subscriptionStore.consumeRateLimit = async () => false;
  const throttled = await request(handler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/rate")),
  });
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get("retry-after")).toBeTruthy();
  expect(await throttled.json()).toMatchObject({ code: "rate_limited" });
});

test("existing subscription reconciliation preserves ownership and key possession can recover a lost token", async () => {
  setVapid();
  const { records } = configure();
  const handler = createFetchHandler(engine, assets);
  const firstResponse = await request(handler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/reconcile")),
  });
  const first = await firstResponse.json() as { management_token: string };
  const reconciledResponse = await request(handler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/reconcile", first.management_token)),
  });
  const reconciled = await reconciledResponse.json() as { management_token: string; reconciled: boolean };
  expect(reconciledResponse.status).toBe(200);
  expect(reconciled).toMatchObject({ management_token: first.management_token, reconciled: true });

  const recoveredResponse = await request(handler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/reconcile")),
  });
  const recovered = await recoveredResponse.json() as { management_token: string };
  expect(recoveredResponse.status).toBe(200);
  expect(recovered.management_token).not.toBe(first.management_token);
  expect(records).toHaveLength(1);

  const wrongP256 = new Uint8Array(p256dhBytes);
  wrongP256[1] ^= 1;
  const wrongKeys = { ...validKeys, p256dh: Buffer.from(wrongP256).toString("base64url") };
  const rejected = await request(handler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "https://push.example/reconcile", expirationTime: null, keys: wrongKeys }),
  });
  expect(rejected.status).toBe(403);
  const ownedDelete = await request(handler, "/api/push/subscriptions", {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "https://push.example/reconcile", management_token: recovered.management_token }),
  });
  expect(ownedDelete.status).toBe(200);
});

test("fair cursor advances past waiting alerts so a later eligible alert is not starved", async () => {
  setVapid();
  Bun.env.CRON_SECRET = "cron-secret";
  Bun.env.PUSH_SCHEDULER_MODE = "external";
  Bun.env.PUSH_DISPATCH_BATCH_SIZE = "1";
  const records = Array.from({ length: 3 }, (_, index) => record("https://push.example/fair-" + index));
  const alerts = records.map((item): PushAlertRecord => ({
    alertId: crypto.randomUUID(),
    subscriptionEndpoint: item.endpoint,
    destination: "잠실",
    thresholdSeconds: 60,
    tripPayload,
    createdAt: new Date().toISOString(),
    expiresAt: future(),
  }));
  configure(records, alerts);
  let sent = 0;
  setPushDelivery({ send: async () => { sent += 1; } });
  const handler = createFetchHandler({
    ...engine,
    calculateLiveTrip: async (payload) => ({
      ok: true,
      remaining_seconds: (payload as { boarded_train_no?: string }).boarded_train_no === "eligible" ? 0 : 600,
    }),
  }, assets);
  alerts[2].tripPayload = { ...tripPayload, boarded_train_no: "eligible" };
  const bodies: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await request(handler, "/api/push/dispatch", {
      method: "GET", headers: { authorization: "Bearer cron-secret" },
    });
    bodies.push(await response.json() as Record<string, unknown>);
  }
  expect(bodies.map((body) => body.next_cursor)).toEqual(["1", "2", "0"]);
  expect(bodies.every((body) => body.has_more === true)).toBeTrue();
  expect(sent).toBe(1);
  expect(alerts).toHaveLength(2);
});

test("overlapping dispatches use a single-flight lease and send an alert only once", async () => {
  setVapid();
  Bun.env.CRON_SECRET = "cron-secret";
  Bun.env.PUSH_SCHEDULER_MODE = "external";
  Bun.env.PUSH_DISPATCH_LEASE_SECONDS = "15";
  const subscription = record("https://push.example/overlap");
  const alert: PushAlertRecord = {
    alertId: crypto.randomUUID(), subscriptionEndpoint: subscription.endpoint, destination: "잠실",
    thresholdSeconds: 60, tripPayload, createdAt: new Date().toISOString(), expiresAt: future(),
  };
  const { alertStore } = configure([subscription], [alert]);
  let leaseTtl = 0;
  alertStore.acquireDispatchLease = async (_token, ttl) => { leaseTtl = ttl; return true; };
  alertStore.releaseDispatchLease = async () => undefined;
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolveGate) => { releaseSend = resolveGate; });
  let enteredSend!: () => void;
  const sendEntered = new Promise<void>((resolveEntered) => { enteredSend = resolveEntered; });
  let sent = 0;
  setPushDelivery({ send: async () => { sent += 1; enteredSend(); await sendGate; } });
  const handler = createFetchHandler({ ...engine, calculateLiveTrip: async () => ({ ok: true, remaining_seconds: 0 }) }, assets);
  const first = request(handler, "/api/push/dispatch", {
    method: "GET", headers: { authorization: "Bearer cron-secret" },
  });
  await sendEntered;
  const overlapping = await request(handler, "/api/push/dispatch", {
    method: "GET", headers: { authorization: "Bearer cron-secret" },
  });
  expect(await overlapping.json()).toMatchObject({ skipped: true, reason: "dispatch_in_progress" });
  releaseSend();
  expect((await first).status).toBe(200);
  expect(sent).toBe(1);
  expect(leaseTtl).toBe(90);
});

test("a replacement committed during ETA calculation prevents the stale alert from sending", async () => {
  setVapid();
  Bun.env.CRON_SECRET = "cron-secret";
  Bun.env.PUSH_SCHEDULER_MODE = "external";
  const { alerts } = configure();
  const setupHandler = createFetchHandler(engine, assets);
  const subscriptionResponse = await request(setupHandler, "/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/replacement-race")),
  });
  const owner = await subscriptionResponse.json() as { endpoint: string; management_token: string };
  const saveAlert = (destination: string) => request(setupHandler, "/api/push/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription_endpoint: owner.endpoint,
      management_token: owner.management_token,
      destination,
      threshold_seconds: 60,
      trip_payload: tripPayload,
    }),
  });
  const original = await (await saveAlert("이전 목적지")).json() as { alert_id: string };

  let etaStarted!: () => void;
  const etaEntered = new Promise<void>((resolveStarted) => { etaStarted = resolveStarted; });
  let releaseEta!: () => void;
  const etaGate = new Promise<void>((resolveEta) => { releaseEta = resolveEta; });
  let sent = 0;
  setPushDelivery({ send: async () => { sent += 1; } });
  const dispatchHandler = createFetchHandler({
    ...engine,
    calculateLiveTrip: async () => {
      etaStarted();
      await etaGate;
      return { ok: true, remaining_seconds: 0 };
    },
  }, assets);
  const staleDispatch = request(dispatchHandler, "/api/push/dispatch", {
    method: "GET",
    headers: { authorization: "Bearer cron-secret" },
  });
  await etaEntered;
  const replacementResponse = await saveAlert("새 목적지");
  const replacement = await replacementResponse.json() as { alert_id: string };
  expect(replacementResponse.status).toBe(200);
  expect(replacement.alert_id).not.toBe(original.alert_id);
  releaseEta();
  expect(await (await staleDispatch).json()).toMatchObject({ delivered: 0, failed: 0 });
  expect(sent).toBe(0);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ alertId: replacement.alert_id, destination: "새 목적지" });

  let sendStarted!: () => void;
  const sendEntered = new Promise<void>((resolveStarted) => { sendStarted = resolveStarted; });
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolveSend) => { releaseSend = resolveSend; });
  setPushDelivery({ send: async () => { sent += 1; sendStarted(); await sendGate; } });
  const claimedHandler = createFetchHandler({
    ...engine,
    calculateLiveTrip: async () => ({ ok: true, remaining_seconds: 0 }),
  }, assets);
  const claimedDispatch = request(claimedHandler, "/api/push/dispatch", {
    method: "GET",
    headers: { authorization: "Bearer cron-secret" },
  });
  await sendEntered;
  const blockedReplacement = await saveAlert("경합 목적지");
  expect(blockedReplacement.status).toBe(409);
  expect(await blockedReplacement.json()).toMatchObject({ code: "alert_delivery_in_progress" });
  expect(alerts[0].alertId).toBe(replacement.alert_id);
  releaseSend();
  expect(await (await claimedDispatch).json()).toMatchObject({ delivered: 1, failed: 0 });
  expect(sent).toBe(1);
  expect(alerts).toHaveLength(0);

  expect((await saveAlert("재시도 목적지")).status).toBe(200);
  expect(alerts).toHaveLength(1);
});

test("server-generated alert ids enforce endpoint ownership, status reconciliation, and subscription cascade", async () => {
  setVapid();
  Bun.env.PUSH_SCHEDULER_MODE = "external";
  Bun.env.CRON_SECRET = "cron-secret";
  const { alerts } = configure();
  const handler = createFetchHandler(engine, assets);
  const register = async (endpoint: string) => {
    const response = await request(handler, "/api/push/subscriptions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(subscriptionBody(endpoint)),
    });
    return response.json() as Promise<{ endpoint: string; management_token: string }>;
  };
  const first = await register("https://push.example/owner-one");
  const second = await register("https://push.example/owner-two");
  const create = async (owner: { endpoint: string; management_token: string }) => {
    const response = await request(handler, "/api/push/alerts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alert_id: "client-forced-collision",
        subscription_endpoint: owner.endpoint,
        management_token: owner.management_token,
        destination: "잠실",
        threshold_seconds: 60,
        trip_payload: tripPayload,
      }),
    });
    return response.json() as Promise<{ alert_id: string; expires_at: string; status_url: string; notification_tag: string }>;
  };
  const firstAlert = await create(first);
  const secondAlert = await create(second);
  expect(firstAlert.alert_id).not.toBe(secondAlert.alert_id);
  expect(firstAlert.alert_id).not.toBe("client-forced-collision");
  expect(firstAlert).toMatchObject({
    status_url: "/api/push/alerts/status",
    notification_tag: "arrival-" + firstAlert.alert_id,
  });

  const crossDelete = await request(handler, "/api/push/alerts", {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      alert_id: firstAlert.alert_id,
      subscription_endpoint: second.endpoint,
      management_token: second.management_token,
    }),
  });
  expect(crossDelete.status).toBe(403);
  expect(alerts).toHaveLength(2);

  const status = await request(handler, "/api/push/alerts/status", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      alert_id: firstAlert.alert_id,
      subscription_endpoint: first.endpoint,
      management_token: first.management_token,
    }),
  });
  expect(await status.json()).toMatchObject({
    active: true,
    status: "active",
    expires_at: firstAlert.expires_at,
    notification_tag: "arrival-" + firstAlert.alert_id,
  });

  const deleted = await request(handler, "/api/push/subscriptions", {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: first.endpoint, management_token: first.management_token }),
  });
  expect(await deleted.json()).toMatchObject({ removed: true, alerts_removed: 1 });
  expect(alerts.map((item) => item.alertId)).toEqual([secondAlert.alert_id]);
});

test("alert registration calls the live engine after auth/rate checks and rejects invalid semantic trips", async () => {
  setVapid();
  Bun.env.PUSH_SCHEDULER_MODE = "external";
  Bun.env.CRON_SECRET = "cron-secret";
  const { alerts } = configure();
  const baseHandler = createFetchHandler(engine, assets);
  const registration = await request(baseHandler, "/api/push/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(subscriptionBody("https://push.example/semantic")),
  });
  const owner = await registration.json() as { endpoint: string; management_token: string };
  const alertRequest = () => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription_endpoint: owner.endpoint,
      management_token: owner.management_token,
      destination: "잠실",
      threshold_seconds: 60,
      trip_payload: tripPayload,
    }),
  });
  for (const calculateLiveTrip of [
    async () => { throw new Error("internal engine detail"); },
    async () => ({ ok: false, error: "internal engine detail" }),
    async () => ({ ok: true, segments: [] }),
  ]) {
    const semanticHandler = createFetchHandler({ ...engine, calculateLiveTrip }, assets);
    const response = await request(semanticHandler, "/api/push/alerts", alertRequest());
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).not.toContain("internal engine detail");
  }
  expect(alerts).toHaveLength(0);
});

test("JSON stores share a file-path mutex and use atomic unique replacement under concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jigeumta-push-store-"));
  const safeRoot = resolve(tmpdir()) + "\\";
  expect(resolve(directory).startsWith(safeRoot)).toBeTrue();
  try {
    Bun.env.PUSH_STORE_PATH = join(directory, ".push-subscriptions.json");
    Bun.env.PUSH_ALERTS_PATH = join(directory, ".push-alerts.json");
    resetPushRuntimeStateForTests();
    const subscriptionsA = pushSubscriptionStore();
    const subscriptionsB = pushSubscriptionStore();
    expect(subscriptionsA).toBe(subscriptionsB);
    const records = Array.from({ length: 24 }, (_, index) => record("https://push.example/json-" + index));
    await Promise.all(records.map((item, index) => (index % 2 ? subscriptionsA : subscriptionsB).upsert(item)));
    expect(await subscriptionsA.count()).toBe(24);
    expect(JSON.parse(await readFile(Bun.env.PUSH_STORE_PATH, "utf8"))).toHaveLength(24);

    const alertsA = pushAlertStore();
    const alertsB = pushAlertStore();
    expect(alertsA).toBe(alertsB);
    await Promise.all(records.map((item) => alertsA.upsert({
      alertId: crypto.randomUUID(),
      subscriptionEndpoint: item.endpoint,
      destination: "잠실",
      thresholdSeconds: 60,
      tripPayload,
      createdAt: new Date().toISOString(),
      expiresAt: future(),
    })));
    expect(await alertsA.count!()).toBe(24);
    expect(JSON.parse(await readFile(Bun.env.PUSH_ALERTS_PATH, "utf8"))).toHaveLength(24);
    const claimed = (await alertsA.list())[0];
    expect(await alertsA.claimForDelivery!(claimed.subscriptionEndpoint, claimed.alertId, "json-claim", 90)).toBeTrue();
    expect(await alertsA.replaceWithinLimit!({ ...claimed, alertId: crypto.randomUUID() }, 100)).toBe("busy");
    expect(await alertsA.completeDeliveryClaim!(claimed.subscriptionEndpoint, claimed.alertId, "json-claim")).toBeTrue();
    expect(await alertsA.count!()).toBe(23);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBeFalse();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
