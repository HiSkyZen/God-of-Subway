import { integerEnv } from "./config";
import type {
  PushAlertRecord,
  PushMessage,
  PushSubscriptionRecord,
} from "./contracts";

const decodeBase64Url = (value: unknown): Uint8Array | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch { return null; }
};
export const validP256dh = (value: unknown): value is string => {
  const decoded = decodeBase64Url(value);
  return Boolean(decoded && decoded.byteLength === 65 && decoded[0] === 4);
};
export const validAuthSecret = (value: unknown): value is string =>
  decodeBase64Url(value)?.byteLength === 16;
export const parseEndpoint = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || !endpoint.hostname
      || endpoint.username || endpoint.password || endpoint.hash) return null;
    const normalized = endpoint.toString();
    return normalized.length <= 2_048 ? normalized : null;
  } catch { return null; }
};
const storedExpirationValid = (value: unknown): boolean => value === null
  || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
export const isSubscriptionRecord = (value: unknown): value is PushSubscriptionRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = candidate.keys;
  return Boolean(parseEndpoint(candidate.endpoint) && storedExpirationValid(candidate.expirationTime)
    && keys && typeof keys === "object" && !Array.isArray(keys)
    && validP256dh((keys as Record<string, unknown>).p256dh)
    && validAuthSecret((keys as Record<string, unknown>).auth)
    && typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
    && (candidate.managementTokenHash === undefined
      || (typeof candidate.managementTokenHash === "string" && /^[a-f0-9]{64}$/.test(candidate.managementTokenHash)))
    && (candidate.sourceHash === undefined
      || (typeof candidate.sourceHash === "string" && /^[a-f0-9]{64}$/.test(candidate.sourceHash))));
};
export const isAlertRecord = (value: unknown): value is PushAlertRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.alertId === "string" && /^[0-9a-f-]{36}$/i.test(candidate.alertId)
    && Boolean(parseEndpoint(candidate.subscriptionEndpoint))
    && typeof candidate.destination === "string"
    && candidate.destination.length > 0 && candidate.destination.length <= 160
    && typeof candidate.thresholdSeconds === "number" && Number.isSafeInteger(candidate.thresholdSeconds)
    && candidate.thresholdSeconds >= 30 && candidate.thresholdSeconds <= 3_600
    && Boolean(candidate.tripPayload && typeof candidate.tripPayload === "object"
      && !Array.isArray(candidate.tripPayload))
    && typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt))
    && typeof candidate.expiresAt === "string" && Number.isFinite(Date.parse(candidate.expiresAt));
};
const parseExpiration = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < Date.now()) return undefined;
  return value;
};
export const parseSubscription = (
  payload: Record<string, unknown>,
): PushSubscriptionRecord | null => {
  const endpoint = parseEndpoint(payload.endpoint);
  const keys = payload.keys;
  const expirationTime = parseExpiration(payload.expirationTime);
  if (!endpoint || !keys || typeof keys !== "object" || Array.isArray(keys)
    || expirationTime === undefined) return null;
  const record = keys as Record<string, unknown>;
  if (!validP256dh(record.p256dh) || !validAuthSecret(record.auth)) return null;
  return {
    endpoint,
    expirationTime,
    keys: { p256dh: record.p256dh, auth: record.auth },
    updatedAt: new Date().toISOString(),
  };
};
export const parseMessage = (payload: Record<string, unknown>): PushMessage | null => {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const url = payload.url === undefined ? undefined : typeof payload.url === "string" ? payload.url : null;
  if (!title || !body || title.length > 120 || body.length > 500
    || url === null || (url && url.length > 2_048)) return null;
  return { title, body, ...(url ? { url } : {}) };
};
export const isExpired = (subscription: PushSubscriptionRecord): boolean =>
  subscription.expirationTime !== null && subscription.expirationTime <= Date.now();
export const statusCodeOf = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>).statusCode;
  return typeof value === "number" ? value : null;
};
const isTripPayload = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const segments = payload.segments;
  const activeIndex = payload.active_index === undefined ? 0 : payload.active_index;
  const trainNo = payload.boarded_train_no;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 8
    || !Number.isSafeInteger(activeIndex) || Number(activeIndex) < 0
    || Number(activeIndex) >= segments.length
    || typeof trainNo !== "string" || trainNo.trim().length === 0 || trainNo.length > 80) return false;
  return segments.every((segment) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) return false;
    const item = segment as Record<string, unknown>;
    return ["line", "from", "to"].every((key) =>
      typeof item[key] === "string" && (item[key] as string).trim().length > 0
      && (item[key] as string).length <= 120);
  });
};
export const parseAlertPayload = (
  payload: Record<string, unknown>,
): Omit<PushAlertRecord, "alertId" | "createdAt"> | null => {
  const endpoint = parseEndpoint(payload.subscription_endpoint);
  const destination = typeof payload.destination === "string" ? payload.destination.trim() : "";
  const thresholdSeconds = typeof payload.threshold_seconds === "number"
    ? payload.threshold_seconds : Number.NaN;
  const tripPayload = payload.trip_payload;
  if (!endpoint || !destination || destination.length > 160
    || !Number.isSafeInteger(thresholdSeconds) || thresholdSeconds < 30 || thresholdSeconds > 3_600
    || !isTripPayload(tripPayload)) return null;
  try {
    const maxBytes = integerEnv("PUSH_MAX_TRIP_PAYLOAD_BYTES", 32_768, 1_024, 65_536);
    if (new TextEncoder().encode(JSON.stringify(tripPayload)).byteLength > maxBytes) return null;
  } catch { return null; }
  const now = Date.now();
  const suppliedExpiry = payload.expires_at === undefined ? Number.NaN
    : typeof payload.expires_at === "string" ? Date.parse(payload.expires_at) : Number.NaN;
  const expiry = payload.expires_at === undefined ? now + 24 * 60 * 60 * 1_000 : suppliedExpiry;
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 7 * 24 * 60 * 60 * 1_000) return null;
  return {
    subscriptionEndpoint: endpoint,
    destination,
    thresholdSeconds,
    tripPayload: tripPayload as Record<string, unknown>,
    expiresAt: new Date(expiry).toISOString(),
  };
};
export const isValidatedLiveTrip = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === true && Array.isArray(result.segments) && result.segments.length > 0;
};
