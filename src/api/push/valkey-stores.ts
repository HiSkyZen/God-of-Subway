import { createHash } from "node:crypto";
import { valkeyCommand } from "../../infra/valkey";
import {
  alertStoreKey,
  redisScanCount,
  subscriptionStoreKey,
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

export interface PushValkeyCommandClient {
  command<T = unknown>(args: readonly string[]): Promise<T>;
}

class SharedValkeyCommandClient implements PushValkeyCommandClient {
  async command<T = unknown>(args: readonly string[]): Promise<T> {
    try {
      return await valkeyCommand<T>(args);
    } catch {
      throw new PushStorageUnavailable("Push storage request failed");
    }
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

export class ValkeyPushSubscriptionStore implements PushSubscriptionStore {
  private readonly client: PushValkeyCommandClient;
  private readonly key = subscriptionStoreKey();
  constructor(client: PushValkeyCommandClient = new SharedValkeyCommandClient()) {
    this.client = client;
  }
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

export class ValkeyPushAlertStore implements PushAlertStore {
  private readonly client: PushValkeyCommandClient;
  private readonly key = alertStoreKey();
  private readonly cursorKey = this.key + ":dispatch-cursor";
  private readonly leaseKey = this.key + ":dispatch-lease";
  constructor(client: PushValkeyCommandClient = new SharedValkeyCommandClient()) {
    this.client = client;
  }
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
