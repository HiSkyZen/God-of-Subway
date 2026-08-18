import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import {
  alertStoreKey,
  normalizeFilePath,
  redisConfiguration,
  redisScanCount,
  subscriptionStoreKey,
  type RedisConfiguration,
} from "./config";
import {
  type AlertWriteResult,
  type PushAlertPage,
  type PushAlertRecord,
  type PushAlertStore,
  PushStorageUnavailable,
  type PushSubscriptionRecord,
  type PushSubscriptionStore,
  type SubscriptionWriteResult,
} from "./contracts";
import { isAlertRecord, isSubscriptionRecord } from "./validation";

const fileMutationTails = new Map<string, Promise<void>>();
const jsonRateBuckets = new Map<string, { count: number; resetAt: number }>();
const jsonAlertCursors = new Map<string, number>();
const jsonDispatchLeases = new Map<string, { token: string; expiresAt: number }>();
const jsonDeliveryClaims = new Map<string, { token: string; alertId: string; expiresAt: number }>();

const withFileMutation = async <T>(path: string, action: () => Promise<T>): Promise<T> => {
  const previous = fileMutationTails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  fileMutationTails.set(path, tail);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (fileMutationTails.get(path) === tail) fileMutationTails.delete(path);
  }
};
const atomicJsonWrite = async (path: string, value: unknown, message: string): Promise<void> => {
  const temporary = path + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    await Bun.write(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, path);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new PushStorageUnavailable(message);
  }
};

class JsonFilePushSubscriptionStore implements PushSubscriptionStore {
  constructor(readonly path = normalizeFilePath(Bun.env.PUSH_STORE_PATH, ".push-subscriptions.json")) {}
  private async read(): Promise<PushSubscriptionRecord[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!Array.isArray(value)) throw new Error("invalid subscription store");
      return value.filter(isSubscriptionRecord);
    } catch { throw new PushStorageUnavailable("Push subscription store is unreadable"); }
  }
  private write(value: PushSubscriptionRecord[]): Promise<void> {
    return atomicJsonWrite(this.path, value, "Push subscription store is not writable");
  }
  async list(): Promise<PushSubscriptionRecord[]> { return this.read(); }
  async get(endpoint: string): Promise<PushSubscriptionRecord | undefined> {
    return (await this.read()).find((item) => item.endpoint === endpoint);
  }
  async upsert(subscription: PushSubscriptionRecord): Promise<void> {
    await withFileMutation(this.path, async () => {
      const records = await this.read();
      await this.write([...records.filter((item) => item.endpoint !== subscription.endpoint), subscription]);
    });
  }
  async upsertWithinLimits(
    subscription: PushSubscriptionRecord,
    globalLimit: number,
    sourceLimit: number,
  ): Promise<SubscriptionWriteResult> {
    return withFileMutation(this.path, async () => {
      const records = await this.read();
      const existing = records.find((item) => item.endpoint === subscription.endpoint);
      if (!existing && records.length >= globalLimit) return "global_limit";
      if (!existing && subscription.sourceHash
        && records.filter((item) => item.sourceHash === subscription.sourceHash).length >= sourceLimit) {
        return "source_limit";
      }
      await this.write([...records.filter((item) => item.endpoint !== subscription.endpoint), subscription]);
      return existing ? "updated" : "created";
    });
  }
  async consumeRateLimit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    return withFileMutation(this.path, async () => {
      const key = this.path + ":" + bucket;
      const now = Date.now();
      const previous = jsonRateBuckets.get(key);
      const next = !previous || previous.resetAt <= now
        ? { count: 1, resetAt: now + windowSeconds * 1_000 }
        : { count: previous.count + 1, resetAt: previous.resetAt };
      jsonRateBuckets.set(key, next);
      return next.count <= limit;
    });
  }
  async remove(endpoint: string): Promise<boolean> {
    return withFileMutation(this.path, async () => {
      const records = await this.read();
      const next = records.filter((item) => item.endpoint !== endpoint);
      if (next.length === records.length) return false;
      await this.write(next);
      return true;
    });
  }
  async count(): Promise<number> { return (await this.read()).length; }
}

class JsonFilePushAlertStore implements PushAlertStore {
  constructor(readonly path = normalizeFilePath(Bun.env.PUSH_ALERTS_PATH, ".push-alerts.json")) {}
  private async read(): Promise<PushAlertRecord[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!Array.isArray(value)) throw new Error("invalid alert store");
      return value.filter(isAlertRecord);
    } catch { throw new PushStorageUnavailable("Push alert store is unreadable"); }
  }
  private write(value: PushAlertRecord[]): Promise<void> {
    return atomicJsonWrite(this.path, value, "Push alert store is not writable");
  }
  private claimKey(endpoint: string): string { return this.path + "\0" + endpoint; }
  private activeClaim(endpoint: string, now = Date.now()): boolean {
    const key = this.claimKey(endpoint);
    const claim = jsonDeliveryClaims.get(key);
    if (claim && claim.expiresAt <= now) jsonDeliveryClaims.delete(key);
    return Boolean(claim && claim.expiresAt > now);
  }
  async list(): Promise<PushAlertRecord[]> { return this.read(); }
  async getByEndpoint(endpoint: string): Promise<PushAlertRecord | undefined> {
    return (await this.read()).find((item) => item.subscriptionEndpoint === endpoint);
  }
  async nextBatch(count: number): Promise<PushAlertPage> {
    const records = await this.read();
    if (records.length === 0) {
      jsonAlertCursors.set(this.path, 0);
      return { items: [], nextCursor: "0", hasMore: false };
    }
    const start = (jsonAlertCursors.get(this.path) ?? 0) % records.length;
    const take = Math.min(count, records.length);
    const items = Array.from({ length: take }, (_, offset) => records[(start + offset) % records.length]);
    const next = (start + take) % records.length;
    jsonAlertCursors.set(this.path, next);
    return { items, nextCursor: String(next), hasMore: records.length > take };
  }
  async upsert(alert: PushAlertRecord): Promise<void> {
    const outcome = await this.replaceWithinLimit(alert, Number.MAX_SAFE_INTEGER);
    if (outcome === "busy") throw new PushStorageUnavailable("Push alert delivery is in progress");
  }
  async replaceForEndpoint(alert: PushAlertRecord): Promise<void> { await this.upsert(alert); }
  async replaceWithinLimit(alert: PushAlertRecord, globalLimit: number): Promise<AlertWriteResult> {
    return withFileMutation(this.path, async () => {
      if (this.activeClaim(alert.subscriptionEndpoint)) return "busy";
      const records = await this.read();
      const existing = records.find((item) => item.subscriptionEndpoint === alert.subscriptionEndpoint);
      if (!existing && records.length >= globalLimit) return "global_limit";
      await this.write([...records.filter((item) => item.subscriptionEndpoint !== alert.subscriptionEndpoint), alert]);
      return existing ? "updated" : "created";
    });
  }
  async remove(alertId: string): Promise<boolean> {
    return withFileMutation(this.path, async () => {
      const records = await this.read();
      const next = records.filter((item) => item.alertId !== alertId);
      if (next.length === records.length) return false;
      await this.write(next);
      return true;
    });
  }
  async removeOwned(endpoint: string, alertId: string): Promise<boolean> {
    return withFileMutation(this.path, async () => {
      const records = await this.read();
      const owned = records.some((item) =>
        item.subscriptionEndpoint === endpoint && item.alertId === alertId);
      if (!owned) return false;
      await this.write(records.filter((item) =>
        !(item.subscriptionEndpoint === endpoint && item.alertId === alertId)));
      return true;
    });
  }
  async count(): Promise<number> { return (await this.read()).length; }
  async acquireDispatchLease(token: string, ttlSeconds: number): Promise<boolean> {
    return withFileMutation(this.path, async () => {
      const now = Date.now();
      const current = jsonDispatchLeases.get(this.path);
      if (current && current.expiresAt > now) return false;
      jsonDispatchLeases.set(this.path, { token, expiresAt: now + ttlSeconds * 1_000 });
      return true;
    });
  }
  async releaseDispatchLease(token: string): Promise<void> {
    await withFileMutation(this.path, async () => {
      if (jsonDispatchLeases.get(this.path)?.token === token) jsonDispatchLeases.delete(this.path);
    });
  }
  async claimForDelivery(
    endpoint: string,
    alertId: string,
    token: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return withFileMutation(this.path, async () => {
      if (this.activeClaim(endpoint)) return false;
      const current = (await this.read()).find((item) => item.subscriptionEndpoint === endpoint);
      if (current?.alertId !== alertId) return false;
      jsonDeliveryClaims.set(this.claimKey(endpoint), {
        token,
        alertId,
        expiresAt: Date.now() + ttlSeconds * 1_000,
      });
      return true;
    });
  }
  async completeDeliveryClaim(endpoint: string, alertId: string, token: string): Promise<boolean> {
    return withFileMutation(this.path, async () => {
      const key = this.claimKey(endpoint);
      const claim = jsonDeliveryClaims.get(key);
      if (!claim || claim.token !== token || claim.alertId !== alertId) return false;
      const records = await this.read();
      const current = records.find((item) => item.subscriptionEndpoint === endpoint);
      jsonDeliveryClaims.delete(key);
      if (current?.alertId !== alertId) return false;
      await this.write(records.filter((item) => item.subscriptionEndpoint !== endpoint));
      return true;
    });
  }
  async releaseDeliveryClaim(endpoint: string, token: string): Promise<void> {
    await withFileMutation(this.path, async () => {
      const key = this.claimKey(endpoint);
      if (jsonDeliveryClaims.get(key)?.token === token) jsonDeliveryClaims.delete(key);
    });
  }
}

class RedisRestClient {
  constructor(private readonly configuration: RedisConfiguration) {}
  async command<T>(args: string[]): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.configuration.url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.configuration.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      });
    } catch { throw new PushStorageUnavailable("Push storage request failed"); }
    if (!response.ok) throw new PushStorageUnavailable("Push storage request failed");
    const value = await response.json() as { result?: unknown; error?: unknown };
    if (value.error) throw new PushStorageUnavailable("Push storage command failed");
    return value.result as T;
  }
}
const stringsOnly = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const parseHashRecords = <T>(
  fields: string[],
  validator: (value: unknown) => value is T,
): T[] => {
  const records: T[] = [];
  for (let index = 1; index < fields.length; index += 2) {
    try {
      const parsed: unknown = JSON.parse(fields[index]);
      if (validator(parsed)) records.push(parsed);
    } catch { /* Malformed fields are skipped while the cursor advances. */ }
  }
  return records;
};
const parseScanResult = (value: unknown): { cursor: string; fields: string[] } => {
  if (!Array.isArray(value) || value.length < 2) return { cursor: "0", fields: [] };
  return { cursor: String(value[0] ?? "0"), fields: stringsOnly(value[1]) };
};

class RedisRestPushSubscriptionStore implements PushSubscriptionStore {
  private readonly client: RedisRestClient;
  private readonly key = subscriptionStoreKey();
  constructor(configuration: RedisConfiguration) { this.client = new RedisRestClient(configuration); }
  private sourceKey(sourceHash: string): string { return this.key + ":source:" + sourceHash; }
  async list(): Promise<PushSubscriptionRecord[]> {
    const scan = parseScanResult(await this.client.command<unknown>(
      ["HSCAN", this.key, "0", "COUNT", String(redisScanCount())],
    ));
    return parseHashRecords(scan.fields, isSubscriptionRecord);
  }
  async get(endpoint: string): Promise<PushSubscriptionRecord | undefined> {
    const value = await this.client.command<unknown>(["HGET", this.key, endpoint]);
    if (typeof value !== "string") return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return isSubscriptionRecord(parsed) ? parsed : undefined;
    } catch { return undefined; }
  }
  async upsert(subscription: PushSubscriptionRecord): Promise<void> {
    await this.client.command(["HSET", this.key, subscription.endpoint, JSON.stringify(subscription)]);
  }
  async upsertWithinLimits(
    subscription: PushSubscriptionRecord,
    globalLimit: number,
    sourceLimit: number,
  ): Promise<SubscriptionWriteResult> {
    const sourceHash = subscription.sourceHash || "legacy";
    const script = "local exists=redis.call('HEXISTS',KEYS[1],ARGV[1]); if exists==0 and redis.call('HLEN',KEYS[1])>=tonumber(ARGV[3]) then return -1 end; if exists==0 and redis.call('HLEN',KEYS[2])>=tonumber(ARGV[4]) then return -2 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); redis.call('HSET',KEYS[2],ARGV[1],'1'); if exists==1 then return 2 else return 1 end";
    const result = await this.client.command<number>([
      "EVAL", script, "2", this.key, this.sourceKey(sourceHash),
      subscription.endpoint, JSON.stringify(subscription), String(globalLimit), String(sourceLimit),
    ]);
    return result === -1 ? "global_limit" : result === -2 ? "source_limit"
      : result === 2 ? "updated" : "created";
  }
  async consumeRateLimit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const script = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; if n>tonumber(ARGV[2]) then return 0 else return 1 end";
    return (await this.client.command<number>([
      "EVAL", script, "1", this.key + ":rate:" + bucket, String(windowSeconds), String(limit),
    ])) === 1;
  }
  async remove(endpoint: string): Promise<boolean> {
    const current = await this.get(endpoint);
    if (!current) return false;
    const script = "local n=redis.call('HDEL',KEYS[1],ARGV[1]); redis.call('HDEL',KEYS[2],ARGV[1]); return n";
    return (await this.client.command<number>([
      "EVAL", script, "2", this.key, this.sourceKey(current.sourceHash || "legacy"), endpoint,
    ])) > 0;
  }
  async count(): Promise<number> {
    const value = await this.client.command<number | string>(["HLEN", this.key]);
    return Number(value) || 0;
  }
}

class RedisRestPushAlertStore implements PushAlertStore {
  private readonly client: RedisRestClient;
  private readonly key = alertStoreKey();
  private readonly cursorKey = this.key + ":dispatch-cursor";
  private readonly leaseKey = this.key + ":dispatch-lease";
  constructor(configuration: RedisConfiguration) { this.client = new RedisRestClient(configuration); }
  private claimKey(endpoint: string): string {
    return this.key + ":delivery-claim:" + createHash("sha256").update(endpoint).digest("hex");
  }
  async list(): Promise<PushAlertRecord[]> {
    const scan = parseScanResult(await this.client.command<unknown>(
      ["HSCAN", this.key, "0", "COUNT", String(redisScanCount())],
    ));
    return parseHashRecords(scan.fields, isAlertRecord);
  }
  async getByEndpoint(endpoint: string): Promise<PushAlertRecord | undefined> {
    const value = await this.client.command<unknown>(["HGET", this.key, endpoint]);
    if (typeof value !== "string") return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return isAlertRecord(parsed) ? parsed : undefined;
    } catch { return undefined; }
  }
  async nextBatch(count: number): Promise<PushAlertPage> {
    const stored = await this.client.command<unknown>(["GET", this.cursorKey]);
    const cursor = typeof stored === "string" && /^\d+$/.test(stored) ? stored : "0";
    const scan = parseScanResult(await this.client.command<unknown>(
      ["HSCAN", this.key, cursor, "COUNT", String(count)],
    ));
    await this.client.command(["SET", this.cursorKey, scan.cursor]);
    return {
      items: parseHashRecords(scan.fields, isAlertRecord),
      nextCursor: scan.cursor,
      hasMore: scan.cursor !== "0",
    };
  }
  async upsert(alert: PushAlertRecord): Promise<void> {
    const outcome = await this.replaceWithinLimit(alert, Number.MAX_SAFE_INTEGER);
    if (outcome === "busy") throw new PushStorageUnavailable("Push alert delivery is in progress");
  }
  async replaceForEndpoint(alert: PushAlertRecord): Promise<void> { await this.upsert(alert); }
  async replaceWithinLimit(alert: PushAlertRecord, globalLimit: number): Promise<AlertWriteResult> {
    const script = "if redis.call('EXISTS',KEYS[2])==1 then return -1 end; local exists=redis.call('HEXISTS',KEYS[1],ARGV[1]); if exists==0 and redis.call('HLEN',KEYS[1])>=tonumber(ARGV[3]) then return 0 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); if exists==1 then return 2 else return 1 end";
    const result = await this.client.command<number>([
      "EVAL", script, "2", this.key, this.claimKey(alert.subscriptionEndpoint),
      alert.subscriptionEndpoint, JSON.stringify(alert), String(globalLimit),
    ]);
    return result === -1 ? "busy" : result === 0 ? "global_limit"
      : result === 2 ? "updated" : "created";
  }
  async removeOwned(endpoint: string, alertId: string): Promise<boolean> {
    const script = "local v=redis.call('HGET',KEYS[1],ARGV[1]); if not v then return 0 end; local ok,obj=pcall(cjson.decode,v); if ok and obj.alertId==ARGV[2] then return redis.call('HDEL',KEYS[1],ARGV[1]) end; return 0";
    return (await this.client.command<number>(
      ["EVAL", script, "1", this.key, endpoint, alertId],
    )) > 0;
  }
  async remove(alertId: string): Promise<boolean> {
    const scan = parseScanResult(await this.client.command<unknown>(
      ["HSCAN", this.key, "0", "COUNT", String(redisScanCount())],
    ));
    const current = parseHashRecords(scan.fields, isAlertRecord)
      .find((item) => item.alertId === alertId);
    return current ? this.removeOwned(current.subscriptionEndpoint, alertId) : false;
  }
  async count(): Promise<number> {
    const value = await this.client.command<number | string>(["HLEN", this.key]);
    return Number(value) || 0;
  }
  async acquireDispatchLease(token: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.command<unknown>(
      ["SET", this.leaseKey, token, "NX", "EX", String(ttlSeconds)],
    )) === "OK";
  }
  async releaseDispatchLease(token: string): Promise<void> {
    const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    await this.client.command(["EVAL", script, "1", this.leaseKey, token]);
  }
  async claimForDelivery(
    endpoint: string,
    alertId: string,
    token: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const script = "local v=redis.call('HGET',KEYS[1],ARGV[1]); if not v then return 0 end; local ok,obj=pcall(cjson.decode,v); if not ok or obj.alertId~=ARGV[2] then return 0 end; local r=redis.call('SET',KEYS[2],ARGV[3],'NX','EX',ARGV[4]); if r then return 1 else return 0 end";
    return (await this.client.command<number>([
      "EVAL", script, "2", this.key, this.claimKey(endpoint),
      endpoint, alertId, token, String(ttlSeconds),
    ])) === 1;
  }
  async completeDeliveryClaim(endpoint: string, alertId: string, token: string): Promise<boolean> {
    const script = "if redis.call('GET',KEYS[2])~=ARGV[3] then return 0 end; local v=redis.call('HGET',KEYS[1],ARGV[1]); if not v then redis.call('DEL',KEYS[2]); return 0 end; local ok,obj=pcall(cjson.decode,v); if not ok or obj.alertId~=ARGV[2] then redis.call('DEL',KEYS[2]); return 0 end; local n=redis.call('HDEL',KEYS[1],ARGV[1]); redis.call('DEL',KEYS[2]); return n";
    return (await this.client.command<number>([
      "EVAL", script, "2", this.key, this.claimKey(endpoint), endpoint, alertId, token,
    ])) > 0;
  }
  async releaseDeliveryClaim(endpoint: string, token: string): Promise<void> {
    const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
    await this.client.command(["EVAL", script, "1", this.claimKey(endpoint), token]);
  }
}

class MissingProductionStore implements PushSubscriptionStore {
  private unavailable(): never {
    throw new PushStorageUnavailable("Persistent push subscription storage is not configured");
  }
  async list(): Promise<PushSubscriptionRecord[]> { return this.unavailable(); }
  async upsert(): Promise<void> { this.unavailable(); }
  async remove(): Promise<boolean> { return this.unavailable(); }
  async count(): Promise<number> { return this.unavailable(); }
}
class MissingProductionAlertStore implements PushAlertStore {
  private unavailable(): never {
    throw new PushStorageUnavailable("Persistent push alert storage is not configured");
  }
  async list(): Promise<PushAlertRecord[]> { return this.unavailable(); }
  async upsert(): Promise<void> { this.unavailable(); }
  async remove(): Promise<boolean> { return this.unavailable(); }
}

let configuredStore: PushSubscriptionStore | undefined;
let configuredAlertStore: PushAlertStore | undefined;
const productionStore = new MissingProductionStore();
const productionAlertStore = new MissingProductionAlertStore();
const jsonSubscriptionStores = new Map<string, JsonFilePushSubscriptionStore>();
const jsonAlertStores = new Map<string, JsonFilePushAlertStore>();
const redisSubscriptionStores = new Map<string, RedisRestPushSubscriptionStore>();
const redisAlertStores = new Map<string, RedisRestPushAlertStore>();

export const setPushSubscriptionStore = (store: PushSubscriptionStore | undefined): void => {
  configuredStore = store;
};
export const setPushAlertStore = (store: PushAlertStore | undefined): void => {
  configuredAlertStore = store;
};
export const pushSubscriptionStore = (): PushSubscriptionStore => {
  if (configuredStore) return configuredStore;
  if (Bun.env.NODE_ENV === "production") {
    const configuration = redisConfiguration();
    if (!configuration) return productionStore;
    const key = configuration.url + "|" + subscriptionStoreKey();
    const existing = redisSubscriptionStores.get(key);
    if (existing) return existing;
    const created = new RedisRestPushSubscriptionStore(configuration);
    redisSubscriptionStores.set(key, created);
    return created;
  }
  const path = normalizeFilePath(Bun.env.PUSH_STORE_PATH, ".push-subscriptions.json");
  const existing = jsonSubscriptionStores.get(path);
  if (existing) return existing;
  const created = new JsonFilePushSubscriptionStore(path);
  jsonSubscriptionStores.set(path, created);
  return created;
};
export const pushAlertStore = (): PushAlertStore => {
  if (configuredAlertStore) return configuredAlertStore;
  if (Bun.env.NODE_ENV === "production") {
    const configuration = redisConfiguration();
    if (!configuration) return productionAlertStore;
    const key = configuration.url + "|" + alertStoreKey();
    const existing = redisAlertStores.get(key);
    if (existing) return existing;
    const created = new RedisRestPushAlertStore(configuration);
    redisAlertStores.set(key, created);
    return created;
  }
  const path = normalizeFilePath(Bun.env.PUSH_ALERTS_PATH, ".push-alerts.json");
  const existing = jsonAlertStores.get(path);
  if (existing) return existing;
  const created = new JsonFilePushAlertStore(path);
  jsonAlertStores.set(path, created);
  return created;
};
export const resetPushStoreStateForTests = (): void => {
  configuredStore = undefined;
  configuredAlertStore = undefined;
  jsonSubscriptionStores.clear();
  jsonAlertStores.clear();
  redisSubscriptionStores.clear();
  redisAlertStores.clear();
  fileMutationTails.clear();
  jsonRateBuckets.clear();
  jsonAlertCursors.clear();
  jsonDispatchLeases.clear();
  jsonDeliveryClaims.clear();
};
