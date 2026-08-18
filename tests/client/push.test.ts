import { describe, expect, test } from "bun:test";
import { base64UrlToUint8Array, detectPushCapabilities, pushSubscriptionSyncPayload, reconcilePushSubscription, subscribeToPush, subscriptionMatchesApplicationServerKey } from "../../src/client/push";

describe("push capability boundary", () => {
  test("converts URL-safe VAPID keys without padding surprises", () => {
    const bytes = base64UrlToUint8Array("AQID-_w");
    expect([...bytes]).toEqual([1, 2, 3, 251, 252]);
  });

  test("reports the first unavailable browser capability", () => {
    expect(detectPushCapabilities({ notification: false, serviceWorker: true, pushManager: true })).toEqual({ supported: false, reason: "notification" });
    expect(detectPushCapabilities({ notification: true, serviceWorker: false, pushManager: true })).toEqual({ supported: false, reason: "service-worker" });
    expect(detectPushCapabilities({ notification: true, serviceWorker: true, pushManager: true })).toEqual({ supported: true, reason: "supported" });
  });

  test("reuses an existing subscription and avoids duplicate browser subscriptions", async () => {
    let subscribeCalls = 0;
    const existing = { endpoint: "https://push.example/subscription", options: { applicationServerKey: base64UrlToUint8Array("AQID") } } as unknown as PushSubscription;
    const registration = { pushManager: {
      getSubscription: async () => existing,
      subscribe: async () => { subscribeCalls += 1; return existing; },
    } } as unknown as ServiceWorkerRegistration;
    const result = await subscribeToPush(registration, "AQID");
    expect(result).toBe(existing);
    expect(subscribeCalls).toBe(0);
  });

  test("subscribes only when the browser has no existing subscription", async () => {
    let subscribeCalls = 0;
    const registration = { pushManager: {
      getSubscription: async () => null,
      subscribe: async (options: PushSubscriptionOptions) => { subscribeCalls += 1; expect(options.userVisibleOnly).toBe(true); expect(options.applicationServerKey instanceof Uint8Array).toBe(true); return { endpoint: "https://push.example/new" } as unknown as PushSubscription; },
    } } as unknown as ServiceWorkerRegistration;
    await subscribeToPush(registration, "AQID");
    expect(subscribeCalls).toBe(1);
  });

  test("replaces a subscription when the configured VAPID public key changes", async () => {
    let unsubscribed = 0;
    let subscribeCalls = 0;
    const existing = { endpoint: "https://push.example/old", options: { applicationServerKey: base64UrlToUint8Array("AQID") }, unsubscribe: async () => { unsubscribed += 1; return true; } } as unknown as PushSubscription;
    const replacement = { endpoint: "https://push.example/new", options: { applicationServerKey: base64UrlToUint8Array("BAUG") }, toJSON: () => ({ endpoint: "https://push.example/new" }) } as unknown as PushSubscription;
    const registration = { pushManager: { getSubscription: async () => existing, subscribe: async () => { subscribeCalls += 1; return replacement; } } } as unknown as ServiceWorkerRegistration;
    expect(subscriptionMatchesApplicationServerKey(existing, "BAUG")).toBe(false);
    const reconciled = await reconcilePushSubscription(registration, "BAUG", { endpoint: existing.endpoint, managementToken: "old-token" }, async (_subscription, stored) => { expect(stored.managementToken).toBe("old-token"); return { management_token: "new-token" }; });
    expect(unsubscribed).toBe(1);
    expect(subscribeCalls).toBe(1);
    expect(reconciled).toMatchObject({ endpoint: replacement.endpoint, managementToken: "new-token", serverSynced: true });
  });

  test("re-syncs an owned matching subscription while preserving its management token", async () => {
    const existing = { endpoint: "https://push.example/current", options: { applicationServerKey: base64UrlToUint8Array("AQID") }, toJSON: () => ({ endpoint: "https://push.example/current" }) } as unknown as PushSubscription;
    const registration = { pushManager: { getSubscription: async () => existing, subscribe: async () => { throw new Error("must not subscribe"); } } } as unknown as ServiceWorkerRegistration;
    let saveCalls = 0;
    const reconciled = await reconcilePushSubscription(registration, "AQID", { endpoint: existing.endpoint, managementToken: "owned-token" }, async (_subscription, stored) => { saveCalls += 1; return { management_token: stored.managementToken || "recovered-token" }; });
    expect(saveCalls).toBe(1);
    expect(reconciled.managementToken).toBe("owned-token");
    expect(reconciled.serverSynced).toBe(true);
    expect(pushSubscriptionSyncPayload(existing.toJSON(), { endpoint: existing.endpoint, managementToken: "owned-token" })).toMatchObject({ endpoint: existing.endpoint, management_token: "owned-token" });
  });
});
