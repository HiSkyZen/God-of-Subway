import { afterEach, expect, test } from "bun:test";
import { pushCapabilities } from "../../src/api/push-capability";
import {
  ValkeyPushAlertStore,
  ValkeyPushSubscriptionStore,
  type PushValkeyCommandClient,
} from "../../src/api/push/valkey-stores";
import type { PushAlertRecord, PushSubscriptionRecord } from "../../src/api/push/contracts";
import { resetValkeyRuntimeForTests } from "../../src/infra/valkey";

const p256dhBytes = new Uint8Array(65).fill(7);
p256dhBytes[0] = 4;
const validKeys = {
  p256dh: Buffer.from(p256dhBytes).toString("base64url"),
  auth: Buffer.from(new Uint8Array(16).fill(9)).toString("base64url"),
};
const subscription: PushSubscriptionRecord = {
  endpoint: "https://push.example/native-valkey",
  expirationTime: null,
  keys: validKeys,
  updatedAt: new Date().toISOString(),
  sourceHash: "source-a",
};
const alert: PushAlertRecord = {
  alertId: "11111111-1111-4111-8111-111111111111",
  subscriptionEndpoint: subscription.endpoint,
  destination: "잠실",
  thresholdSeconds: 60,
  tripPayload: { segments: [{ line: "2호선", from: "강남", to: "잠실" }], active_index: 0, boarded_train_no: "A1" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

const setVapid = (): void => {
  Bun.env.VAPID_PUBLIC_KEY = validKeys.p256dh;
  Bun.env.VAPID_PRIVATE_KEY = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");
  Bun.env.VAPID_SUBJECT = "mailto:test@example.invalid";
};

afterEach(() => {
  resetValkeyRuntimeForTests();
  for (const key of [
    "NODE_ENV", "VALKEY_URL", "REDIS_URL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
    "PUSH_REDIS_URL", "PUSH_REDIS_TOKEN", "PUSH_REDIS_KEY", "PUSH_REDIS_ALERTS_KEY",
  ]) delete Bun.env[key];
});

test("production push capability accepts native VALKEY_URL without REST credentials", () => {
  Bun.env.NODE_ENV = "production";
  Bun.env.VALKEY_URL = "rediss://default:secret@cache.example:12345/0";
  setVapid();
  expect(pushCapabilities()).toMatchObject({ subscriptionCapable: true });
});

test("native Valkey push stores preserve atomic Lua and lease operations", async () => {
  const commands: string[][] = [];
  const client: PushValkeyCommandClient = {
    command: async <T>(args: readonly string[]): Promise<T> => {
      commands.push([...args]);
      if (args[0] === "EVAL") return 1 as T;
      if (args[0] === "SET" && args.includes("NX")) return "OK" as T;
      if (args[0] === "HLEN") return 1 as T;
      return null as T;
    },
  };
  const subscriptions = new ValkeyPushSubscriptionStore(client);
  const alerts = new ValkeyPushAlertStore(client);

  expect(await subscriptions.upsertWithinLimits(subscription, 5_000, 20)).toBe("created");
  expect(commands[0][0]).toBe("EVAL");
  expect(commands[0].join(" ")).toContain("HEXISTS");

  expect(await alerts.acquireDispatchLease("lease-token", 90)).toBe(true);
  const lease = commands.find((command) => command[0] === "SET" && command.includes("dispatch-lease"));
  expect(lease?.slice(-3)).toEqual(["NX", "EX", "90"]);

  expect(await alerts.claimForDelivery(subscription.endpoint, alert.alertId, "claim-token", 90)).toBe(true);
  expect(commands.at(-1)?.[0]).toBe("EVAL");
  expect(commands.at(-1)?.join(" ")).toContain("NX");
});
