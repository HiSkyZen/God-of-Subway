import { afterEach, expect, test } from "bun:test";
import { handlePushPublicKey } from "../../src/api/push/public-key";
import { resetValkeyRuntimeForTests } from "../../src/infra/valkey";

const p256dhBytes = new Uint8Array(65).fill(7);
p256dhBytes[0] = 4;

const setVapid = (): void => {
  Bun.env.VAPID_PUBLIC_KEY = Buffer.from(p256dhBytes).toString("base64url");
  Bun.env.VAPID_PRIVATE_KEY = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");
  Bun.env.VAPID_SUBJECT = "mailto:test@example.invalid";
};

const bodyOf = async (response: Response): Promise<Record<string, unknown>> => response.json() as Promise<Record<string, unknown>>;

afterEach(() => {
  resetValkeyRuntimeForTests();
  for (const key of [
    "NODE_ENV", "VALKEY_URL", "REDIS_URL", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
    "PUSH_REDIS_URL", "PUSH_REDIS_TOKEN", "PUSH_SCHEDULER_MODE", "CRON_SECRET", "VERCEL",
  ]) delete Bun.env[key];
});

test("public push capability reports missing VAPID and storage separately", async () => {
  Bun.env.NODE_ENV = "production";
  const response = handlePushPublicKey();
  const body = await bodyOf(response);
  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    capable: false,
    configuration_issues: ["vapid_unavailable", "storage_unavailable", "scheduler_unavailable"],
  });
  expect(String(body.configuration_message)).toContain("VAPID");
  expect(String(body.configuration_message)).toContain("Valkey/Redis");
});

test("public push capability identifies a missing persistent store", async () => {
  Bun.env.NODE_ENV = "production";
  setVapid();
  const response = handlePushPublicKey();
  const body = await bodyOf(response);
  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    capable: false,
    configuration_issues: ["storage_unavailable", "scheduler_unavailable"],
  });
  expect(String(body.configuration_message)).toContain("Valkey/Redis");
});

test("subscription capability remains available when only the scheduler is absent", async () => {
  Bun.env.NODE_ENV = "production";
  Bun.env.VALKEY_URL = "rediss://default:secret@valkey.example:6380";
  setVapid();
  const response = handlePushPublicKey();
  const body = await bodyOf(response);
  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    capable: true,
    subscription_capable: true,
    arrival_alert_capable: false,
    scheduler_mode: null,
    configuration_issues: ["scheduler_unavailable"],
    configuration_message: null,
  });
  expect(typeof body.public_key).toBe("string");
});

test("external scheduler completes arrival-alert capability", async () => {
  Bun.env.NODE_ENV = "production";
  Bun.env.VALKEY_URL = "rediss://default:secret@valkey.example:6380";
  Bun.env.PUSH_SCHEDULER_MODE = "external";
  Bun.env.CRON_SECRET = "cron-secret-long-enough";
  setVapid();
  const response = handlePushPublicKey();
  expect(response.status).toBe(200);
  expect(await bodyOf(response)).toMatchObject({
    capable: true,
    arrival_alert_capable: true,
    scheduler_mode: "external",
    configuration_issues: [],
    configuration_message: null,
  });
});
