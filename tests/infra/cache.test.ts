import { afterEach, expect, test } from "bun:test";
import {
  cacheReleaseRefreshLease,
  cacheSetJson,
  cacheTryRefreshLease,
  resetCacheStateForTests,
} from "../../src/infra/cache";
import {
  configuredValkeyUrl,
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

  await cacheReleaseRefreshLease("realtime-source:1032", acquired.token!);
  expect(commands.at(-1)?.[0]).toBe("EVAL");
  expect(commands.at(-1)?.at(-1)).toBe(acquired.token);
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
