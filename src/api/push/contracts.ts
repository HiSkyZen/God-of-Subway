export interface PushSubscriptionKeys { p256dh: string; auth: string; }
export interface PushSubscriptionRecord {
  endpoint: string;
  expirationTime: number | null;
  keys: PushSubscriptionKeys;
  updatedAt: string;
  managementTokenHash?: string;
  sourceHash?: string;
}
export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  alert_id?: string;
  tag?: string;
}
export type SubscriptionWriteResult = "created" | "updated" | "global_limit" | "source_limit";
export interface PushSubscriptionStore {
  list(): Promise<PushSubscriptionRecord[]>;
  upsert(subscription: PushSubscriptionRecord): Promise<void>;
  remove(endpoint: string): Promise<boolean>;
  count(): Promise<number>;
  get?(endpoint: string): Promise<PushSubscriptionRecord | undefined>;
  upsertWithinLimits?(
    subscription: PushSubscriptionRecord,
    globalLimit: number,
    sourceLimit: number,
  ): Promise<SubscriptionWriteResult>;
  consumeRateLimit?(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
}
export interface PushDelivery {
  send(subscription: PushSubscriptionRecord, message: PushMessage): Promise<void>;
}
export interface PushAlertRecord {
  alertId: string;
  subscriptionEndpoint: string;
  destination: string;
  thresholdSeconds: number;
  tripPayload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}
export interface PushAlertPage {
  items: PushAlertRecord[];
  nextCursor: string;
  hasMore: boolean;
}
export type AlertWriteResult = "created" | "updated" | "global_limit" | "busy";
export interface PushAlertStore {
  list(): Promise<PushAlertRecord[]>;
  upsert(alert: PushAlertRecord): Promise<void>;
  remove(alertId: string): Promise<boolean>;
  replaceForEndpoint?(alert: PushAlertRecord): Promise<void>;
  replaceWithinLimit?(alert: PushAlertRecord, globalLimit: number): Promise<AlertWriteResult>;
  getByEndpoint?(endpoint: string): Promise<PushAlertRecord | undefined>;
  removeOwned?(endpoint: string, alertId: string): Promise<boolean>;
  nextBatch?(count: number): Promise<PushAlertPage>;
  count?(): Promise<number>;
  acquireDispatchLease?(token: string, ttlSeconds: number): Promise<boolean>;
  releaseDispatchLease?(token: string): Promise<void>;
  claimForDelivery?(endpoint: string, alertId: string, token: string, ttlSeconds: number): Promise<boolean>;
  completeDeliveryClaim?(endpoint: string, alertId: string, token: string): Promise<boolean>;
  releaseDeliveryClaim?(endpoint: string, token: string): Promise<void>;
}
export type LiveTripCalculator = (payload: Record<string, unknown>) => unknown | Promise<unknown>;
export class PushStorageUnavailable extends Error {}
