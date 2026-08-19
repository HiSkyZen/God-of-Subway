import { valkeyConfigured, valkeyTransport } from "./valkey";

type CacheEnvelope<T> = {
  value: T;
  freshUntil: number;
  staleUntil: number;
};

type MemoryEntry = CacheEnvelope<unknown>;
export interface CacheRefreshLease {
  configured: boolean;
  token: string | null;
}

const prefix = (Bun.env.REDIS_PREFIX || "jigeumta:v14").trim();
const memory = new Map<string, MemoryEntry>();
let lastRedisError = "";
const counters = {
  hit: 0,
  staleHit: 0,
  miss: 0,
  write: 0,
  redisError: 0,
  lockAcquired: 0,
  lockContended: 0,
};

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

function recordRedisError(error: unknown): void {
  counters.redisError += 1;
  lastRedisError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function cacheGetJson<T>(key: string, allowStale = false): Promise<{ value: T; stale: boolean } | null> {
  const client = valkeyTransport();
  if (client) {
    try {
      const raw = await client.command<string | null>(["GET", fullKey(key)]);
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
      recordRedisError(error);
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

  const client = valkeyTransport();
  if (!client) return;
  try {
    await client.command(["SET", fullKey(key), JSON.stringify(envelope), "EX", String(stale)]);
  } catch (error) {
    recordRedisError(error);
  }
}

export async function cacheTryRefreshLease(key: string, ttlSeconds = 5): Promise<CacheRefreshLease> {
  const client = valkeyTransport();
  if (!client) return { configured: false, token: null };
  const token = crypto.randomUUID();
  try {
    const result = await client.command<unknown>([
      "SET", fullKey(`lock:${key}`), token, "NX", "EX", String(Math.max(1, Math.trunc(ttlSeconds))),
    ]);
    if (result === "OK") {
      counters.lockAcquired += 1;
      return { configured: true, token };
    }
    counters.lockContended += 1;
    return { configured: true, token: null };
  } catch (error) {
    recordRedisError(error);
    return { configured: false, token: null };
  }
}

export async function cacheReleaseRefreshLease(key: string, token: string): Promise<void> {
  const client = valkeyTransport();
  if (!client) return;
  const script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
  try {
    await client.command(["EVAL", script, "1", fullKey(`lock:${key}`), token]);
  } catch (error) {
    recordRedisError(error);
  }
}

export function cacheSnapshot(): Record<string, unknown> {
  return {
    redis_configured: valkeyConfigured(),
    backend: valkeyConfigured() ? "native-valkey" : "memory",
    namespace: prefix,
    memory_entries: memory.size,
    counters: { ...counters },
    last_redis_error: lastRedisError || null,
  };
}

export function resetCacheStateForTests(): void {
  memory.clear();
  lastRedisError = "";
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
}
