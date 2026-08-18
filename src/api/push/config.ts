import { resolve } from "node:path";

export interface RedisConfiguration { url: string; token: string; }

export const integerEnv = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number(Bun.env[name]);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};
export const subscriptionStoreKey = (): string =>
  Bun.env.PUSH_REDIS_KEY?.trim() || "jigeumta:push:subscriptions";
export const alertStoreKey = (): string =>
  Bun.env.PUSH_REDIS_ALERTS_KEY?.trim() || "jigeumta:push:alerts";
export const subscriptionGlobalLimit = (): number =>
  integerEnv("PUSH_MAX_SUBSCRIPTIONS", 5_000, 1, 100_000);
export const subscriptionSourceLimit = (): number =>
  integerEnv("PUSH_MAX_SUBSCRIPTIONS_PER_SOURCE", 20, 1, 10_000);
export const alertGlobalLimit = (): number =>
  integerEnv("PUSH_MAX_ALERTS", 5_000, 1, 100_000);
export const registrationRateLimit = (): number =>
  integerEnv("PUSH_REGISTRATION_RATE_LIMIT", 30, 1, 10_000);
export const registrationRateWindow = (): number =>
  integerEnv("PUSH_REGISTRATION_RATE_WINDOW_SECONDS", 3_600, 10, 86_400);
export const redisScanCount = (): number =>
  integerEnv("PUSH_REDIS_SCAN_COUNT", 100, 1, 500);
export const dispatchLeaseSeconds = (): number =>
  integerEnv("PUSH_DISPATCH_LEASE_SECONDS", 90, 90, 600);
export const deliveryClaimSeconds = (): number =>
  integerEnv("PUSH_DELIVERY_CLAIM_SECONDS", 90, 90, 600);
export const normalizeFilePath = (value: string | undefined, fallback: string): string =>
  resolve(value?.trim() || fallback);

export const redisConfiguration = (): RedisConfiguration | null => {
  const rawUrl = Bun.env.PUSH_REDIS_URL?.trim();
  const token = Bun.env.PUSH_REDIS_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) return null;
    return { url: parsed.toString().replace(/\/$/, ""), token };
  } catch { return null; }
};
