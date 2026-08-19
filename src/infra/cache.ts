import { RedisClient } from "bun";

type CacheEnvelope<T> = {
  value: T;
  freshUntil: number;
  staleUntil: number;
};

type MemoryEntry = CacheEnvelope<unknown>;

const prefix = (Bun.env.REDIS_PREFIX || "jigeumta:v14").trim();
const memory = new Map<string, MemoryEntry>();
let redisClient: RedisClient | null | undefined;
let lastRedisError = "";
const counters = { hit: 0, staleHit: 0, miss: 0, write: 0, redisError: 0 };

function redis(): RedisClient | null {
  if (redisClient !== undefined) return redisClient;
  const url = (Bun.env.REDIS_URL || Bun.env.VALKEY_URL || "").trim();
  redisClient = url ? new RedisClient(url) : null;
  return redisClient;
}

function fullKey(key: string): string {
  return `${prefix}:${key}`;
}

function usable<T>(entry: CacheEnvelope<T>, allowStale: boolean): { value: T; stale: boolean } | null {
  const now = Date.now();
  if (entry.freshUntil > now) return { value: entry.value, stale: false };
  if (allowStale && entry.staleUntil > now) return { value: entry.value, stale: true };
  return null;
}

function remember(key: string, entry: MemoryEntry): void {
  memory.set(key, entry);
  if (memory.size <= 512) return;
  const oldest = memory.keys().next().value as string | undefined;
  if (oldest) memory.delete(oldest);
}

export async function cacheGetJson<T>(key: string, allowStale = false): Promise<{ value: T; stale: boolean } | null> {
  const client = redis();
  if (client) {
    try {
      const raw = await client.get(fullKey(key));
      if (raw) {
        const parsed = JSON.parse(raw) as CacheEnvelope<T>;
        const found = usable(parsed, allowStale);
        if (found) {
          remember(key, parsed as MemoryEntry);
          if (found.stale) counters.staleHit += 1; else counters.hit += 1;
          return found;
        }
      }
    } catch (error) {
      counters.redisError += 1;
      lastRedisError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
  }

  const local = memory.get(key) as CacheEnvelope<T> | undefined;
  if (local) {
    const found = usable(local, allowStale);
    if (found) {
      if (found.stale) counters.staleHit += 1; else counters.hit += 1;
      return found;
    }
    if (local.staleUntil <= Date.now()) memory.delete(key);
  }
  counters.miss += 1;
  return null;
}

export async function cacheSetJson<T>(key: string, value: T, ttlSeconds: number, staleSeconds = ttlSeconds): Promise<void> {
  const now = Date.now();
  const fresh = Math.max(1, Math.trunc(ttlSeconds));
  const stale = Math.max(fresh, Math.trunc(staleSeconds));
  const envelope: CacheEnvelope<T> = {
    value,
    freshUntil: now + fresh * 1000,
    staleUntil: now + stale * 1000,
  };
  remember(key, envelope as MemoryEntry);
  counters.write += 1;

  const client = redis();
  if (!client) return;
  try {
    await client.set(fullKey(key), JSON.stringify(envelope));
    await client.expire(fullKey(key), stale);
  } catch (error) {
    counters.redisError += 1;
    lastRedisError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

export function cacheSnapshot(): Record<string, unknown> {
  return {
    redis_configured: Boolean((Bun.env.REDIS_URL || Bun.env.VALKEY_URL || "").trim()),
    namespace: prefix,
    memory_entries: memory.size,
    counters: { ...counters },
    last_redis_error: lastRedisError || null,
  };
}
