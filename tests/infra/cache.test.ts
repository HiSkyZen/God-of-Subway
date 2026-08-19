import { afterEach, expect, test } from "bun:test";
import {
  cacheReleaseRefreshLease,
  cacheSetJson,
  cacheSnapshot,
  cacheTryRefreshLease,
  resetCacheStateForTests,
} from "../../src/infra/cache";
import {
  configuredValkeyUrl,
  nativeValkeyClientOptions,
  resetValkeyRuntimeForTests,
  setValkeyTransportForTests,
} from "../../src/infra/valkey";

afterEach(() => {
  resetCacheStateForTests();
  resetValkeyRuntimeForTests();
  delete Bun.env.VALKEY_URL;
  delete Bun.env.REDIS_URL;
});

test("cache writes value and TTL atomically with SET EX", async () => {
  const commands: string[][] = [];
  setValkeyTransportForTests({
    command: async <T>(args: readonly string[]): Promise<T> => {
      commands.push([...args]);
      return "OK" as T;
    },
  });

  await cacheSetJson("realtime-source:1002", { rows: 1 }, 12, 90);

  expect(commands).toHaveLength(1);
  expect(commands[0][0]).toBe("SET");
  expect(commands[0][1]).toContain("realtime-source:1002");
  expect(commands[0].slice(3)).toEqual(["EX", "90"]);
});

test("cache normalizes non-finite TTLs before issuing Valkey commands", async () => {
  const commands: string[][] = [];
  setValkeyTransportForTests({
    command: async <T>(args: readonly string[]): Promise<T> => {
      commands.push([...args]);
      return "OK" as T;
    },
  });

  await cacheSetJson("realtime-source:bad-ttl", { rows: 1 }, Number.NaN, Number.POSITIVE_INFINITY);
  const lease = await cacheTryRefreshLease("realtime-source:bad-ttl", Number.NaN);

  expect(commands[0].slice(-2)).toEqual(["EX", "1"]);
  const envelope = JSON.parse(commands[0][2]) as { freshUntil: number; staleUntil: number };
  expect(Number.isFinite(envelope.freshUntil)).toBe(true);
  expect(Number.isFinite(envelope.staleUntil)).toBe(true);
  expect(lease.configured).toBe(true);
  expect(lease.token).toBeTruthy();
  expect(commands[1].slice(-3)).toEqual(["NX", "EX", "5"]);
  expect(commands.flat()).not.toContain("NaN");
  expect(commands.flat()).not.toContain("Infinity");
});

test("cache health never exposes raw Valkey client error messages", async () => {
  setValkeyTransportForTests({
    command: async <T>(): Promise<T> => {
      const error = Object.assign(
        new Error("connect rediss://default:super-secret@cache.example:6379/0 failed"),
        { code: "ECONNREFUSED" },
      );
      throw error;
    },
  });

  await cacheSetJson("realtime-source:error", { rows: 1 }, 12, 90);
  const snapshot = cacheSnapshot();

  expect(snapshot.last_redis_error).toBe("Error (ECONNREFUSED)");
  expect(JSON.stringify(snapshot)).not.toContain("super-secret");
  expect(JSON.stringify(snapshot)).not.toContain("cache.example");
});

test("refresh lease uses SET NX EX and compare-delete release", async () => {
  const commands: string[][] = [];
  let leaseAttempts = 0;
  setValkeyTransportForTests({
    command: async <T>(args: readonly string[]): Promise<T> => {
      commands.push([...args]);
      if (args[0] === "SET" && args.includes("NX")) {
        leaseAttempts += 1;
        return (leaseAttempts === 1 ? "OK" : null) as T;
      }
      if (args[0] === "EVAL") return 1 as T;
      return null as T;
    },
  });

  const acquired = await cacheTryRefreshLease("realtime-source:1032", 5);
  const contended = await cacheTryRefreshLease("realtime-source:1032", 5);
  expect(acquired.configured).toBe(true);
  expect(acquired.token).toBeTruthy();
  expect(contended).toEqual({ configured: true, token: null });
  expect(commands[0].slice(-3)).toEqual(["NX", "EX", "5"]);

  const token = acquired.token;
  if (!token) throw new Error("expected refresh lease token");
  await cacheReleaseRefreshLease("realtime-source:1032", token);
  expect(commands.at(-1)?.[0]).toBe("EVAL");
  expect(commands.at(-1)?.at(-1)).toBe(token);
});

test("native Valkey URL accepts TLS Redis/Valkey schemes and rejects HTTP", () => {
  Bun.env.VALKEY_URL = "rediss://cache.example:12345/0";
  expect(configuredValkeyUrl()).toBe("rediss://cache.example:12345/0");
  Bun.env.VALKEY_URL = "https://cache.example";
  expect(configuredValkeyUrl()).toBeNull();
  Bun.env.VALKEY_URL = "";
  Bun.env.REDIS_URL = "valkey://cache.internal:6379";
  expect(configuredValkeyUrl()).toBe("valkey://cache.internal:6379");
});

test("native Valkey queues cold-start commands while TLS and authentication connect", () => {
  expect(nativeValkeyClientOptions.enableOfflineQueue).toBe(true);
});
