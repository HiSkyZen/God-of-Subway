import {
  alertGlobalLimit,
  subscriptionGlobalLimit,
  subscriptionSourceLimit,
} from "./config";
import type {
  AlertWriteResult,
  PushAlertPage,
  PushAlertRecord,
  PushAlertStore,
  PushSubscriptionRecord,
  PushSubscriptionStore,
  SubscriptionWriteResult,
} from "./contracts";

export const getSubscription = async (
  store: PushSubscriptionStore,
  endpoint: string,
): Promise<PushSubscriptionRecord | undefined> =>
  store.get ? store.get(endpoint) : (await store.list()).find((item) => item.endpoint === endpoint);
export const getAlertByEndpoint = async (
  store: PushAlertStore,
  endpoint: string,
): Promise<PushAlertRecord | undefined> =>
  store.getByEndpoint
    ? store.getByEndpoint(endpoint)
    : (await store.list()).find((item) => item.subscriptionEndpoint === endpoint);
export const removeOwnedAlert = async (
  store: PushAlertStore,
  endpoint: string,
  alertId: string,
): Promise<boolean> => {
  if (store.removeOwned) return store.removeOwned(endpoint, alertId);
  const current = await getAlertByEndpoint(store, endpoint);
  return current?.alertId === alertId ? store.remove(alertId) : false;
};

let fallbackAlertCursors = new WeakMap<PushAlertStore, number>();
export const nextAlertBatch = async (
  store: PushAlertStore,
  count: number,
): Promise<PushAlertPage> => {
  if (store.nextBatch) return store.nextBatch(count);
  const records = await store.list();
  if (records.length === 0) return { items: [], nextCursor: "0", hasMore: false };
  const start = (fallbackAlertCursors.get(store) ?? 0) % records.length;
  const take = Math.min(count, records.length);
  const items = Array.from({ length: take }, (_, offset) => records[(start + offset) % records.length]);
  const next = (start + take) % records.length;
  fallbackAlertCursors.set(store, next);
  return { items, nextCursor: String(next), hasMore: records.length > take };
};

export const writeSubscriptionWithinLimits = async (
  store: PushSubscriptionStore,
  record: PushSubscriptionRecord,
): Promise<SubscriptionWriteResult> => {
  if (store.upsertWithinLimits) {
    return store.upsertWithinLimits(record, subscriptionGlobalLimit(), subscriptionSourceLimit());
  }
  const existing = await getSubscription(store, record.endpoint);
  if (!existing && await store.count() >= subscriptionGlobalLimit()) return "global_limit";
  if (!existing && record.sourceHash) {
    const sameSource = (await store.list()).filter((item) => item.sourceHash === record.sourceHash).length;
    if (sameSource >= subscriptionSourceLimit()) return "source_limit";
  }
  await store.upsert(record);
  return existing ? "updated" : "created";
};

interface FallbackClaim { token: string; alertId: string; }
let fallbackClaims = new WeakMap<PushAlertStore, Map<string, FallbackClaim>>();
let fallbackLockTails = new WeakMap<PushAlertStore, Map<string, Promise<void>>>();
const claimMapFor = (store: PushAlertStore): Map<string, FallbackClaim> => {
  const existing = fallbackClaims.get(store);
  if (existing) return existing;
  const created = new Map<string, FallbackClaim>();
  fallbackClaims.set(store, created);
  return created;
};
const lockMapFor = (store: PushAlertStore): Map<string, Promise<void>> => {
  const existing = fallbackLockTails.get(store);
  if (existing) return existing;
  const created = new Map<string, Promise<void>>();
  fallbackLockTails.set(store, created);
  return created;
};
const withFallbackEndpointLock = async <T>(
  store: PushAlertStore,
  endpoint: string,
  action: () => Promise<T>,
): Promise<T> => {
  const locks = lockMapFor(store);
  const previous = locks.get(endpoint) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate);
  locks.set(endpoint, tail);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (locks.get(endpoint) === tail) locks.delete(endpoint);
  }
};

export const writeAlertWithinLimit = async (
  store: PushAlertStore,
  alert: PushAlertRecord,
): Promise<AlertWriteResult> => {
  if (store.replaceWithinLimit) return store.replaceWithinLimit(alert, alertGlobalLimit());
  return withFallbackEndpointLock(store, alert.subscriptionEndpoint, async () => {
    if (claimMapFor(store).has(alert.subscriptionEndpoint)) return "busy";
    const existing = await getAlertByEndpoint(store, alert.subscriptionEndpoint);
    if (!existing && store.count && await store.count() >= alertGlobalLimit()) return "global_limit";
    if (store.replaceForEndpoint) await store.replaceForEndpoint(alert);
    else await store.upsert(alert);
    return existing ? "updated" : "created";
  });
};

export const claimAlertForDelivery = async (
  store: PushAlertStore,
  endpoint: string,
  alertId: string,
  token: string,
  ttlSeconds: number,
): Promise<boolean> => {
  if (store.claimForDelivery) return store.claimForDelivery(endpoint, alertId, token, ttlSeconds);
  return withFallbackEndpointLock(store, endpoint, async () => {
    const claims = claimMapFor(store);
    if (claims.has(endpoint)) return false;
    if ((await getAlertByEndpoint(store, endpoint))?.alertId !== alertId) return false;
    claims.set(endpoint, { token, alertId });
    return true;
  });
};
export const completeAlertDelivery = async (
  store: PushAlertStore,
  endpoint: string,
  alertId: string,
  token: string,
): Promise<boolean> => {
  if (store.completeDeliveryClaim) return store.completeDeliveryClaim(endpoint, alertId, token);
  return withFallbackEndpointLock(store, endpoint, async () => {
    const claims = claimMapFor(store);
    const claim = claims.get(endpoint);
    if (!claim || claim.token !== token || claim.alertId !== alertId) return false;
    claims.delete(endpoint);
    const current = await getAlertByEndpoint(store, endpoint);
    return current?.alertId === alertId ? store.remove(alertId) : false;
  });
};
export const releaseAlertDelivery = async (
  store: PushAlertStore,
  endpoint: string,
  token: string,
): Promise<void> => {
  if (store.releaseDeliveryClaim) return store.releaseDeliveryClaim(endpoint, token);
  await withFallbackEndpointLock(store, endpoint, async () => {
    const claims = claimMapFor(store);
    if (claims.get(endpoint)?.token === token) claims.delete(endpoint);
  });
};
export const resetPushStoreHelpersForTests = (): void => {
  fallbackAlertCursors = new WeakMap<PushAlertStore, number>();
  fallbackClaims = new WeakMap<PushAlertStore, Map<string, FallbackClaim>>();
  fallbackLockTails = new WeakMap<PushAlertStore, Map<string, Promise<void>>>();
};
