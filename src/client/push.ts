export interface PushCapabilityInput {
  notification: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
}

export interface PushCapabilities {
  supported: boolean;
  reason: "supported" | "notification" | "service-worker" | "push-manager";
}

export function base64UrlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes as Uint8Array<ArrayBuffer>;
}

export function detectPushCapabilities(input: PushCapabilityInput): PushCapabilities {
  if (!input.notification) return { supported: false, reason: "notification" };
  if (!input.serviceWorker) return { supported: false, reason: "service-worker" };
  if (!input.pushManager) return { supported: false, reason: "push-manager" };
  return { supported: true, reason: "supported" };
}

function bytesFromBufferSource(source: BufferSource): Uint8Array<ArrayBuffer> {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
  bytes.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  return bytes;
}

export function subscriptionMatchesApplicationServerKey(subscription: PushSubscription, vapidPublicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const currentBytes = bytesFromBufferSource(current);
  const expectedBytes = base64UrlToUint8Array(vapidPublicKey);
  if (currentBytes.byteLength !== expectedBytes.byteLength) return false;
  return currentBytes.every((value, index) => value === expectedBytes[index]);
}

export interface EnsuredPushSubscription {
  subscription: PushSubscription;
  replaced: boolean;
}

export interface PushRegistrationState {
  endpoint: string | null;
  managementToken: string | null;
}

export interface ReconciledPushSubscription extends PushRegistrationState {
  subscription: PushSubscription;
  serverSynced: boolean;
}

export function pushSubscriptionSyncPayload(subscription: PushSubscriptionJSON, stored: PushRegistrationState): PushSubscriptionJSON & { management_token?: string } {
  return { ...subscription, ...(stored.managementToken ? { management_token: stored.managementToken } : {}) };
}

export async function ensurePushSubscription(registration: ServiceWorkerRegistration, vapidPublicKey: string): Promise<EnsuredPushSubscription> {
  const existing = await registration.pushManager.getSubscription();
  if (existing && subscriptionMatchesApplicationServerKey(existing, vapidPublicKey)) return { subscription: existing, replaced: false };
  if (existing) await existing.unsubscribe();
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(vapidPublicKey) });
  return { subscription, replaced: Boolean(existing) };
}

export async function reconcilePushSubscription(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
  stored: PushRegistrationState,
  save: (subscription: PushSubscriptionJSON, stored: PushRegistrationState) => Promise<{ management_token: string }>,
): Promise<ReconciledPushSubscription> {
  const ensured = await ensurePushSubscription(registration, vapidPublicKey);
  const endpoint = ensured.subscription.endpoint;
  const saved = await save(ensured.subscription.toJSON(), stored);
  if (!saved.management_token) throw new Error("알림 구독 관리 토큰이 없습니다.");
  return { subscription: ensured.subscription, endpoint, managementToken: saved.management_token, serverSynced: true };
}

export async function subscribeToPush(registration: ServiceWorkerRegistration, vapidPublicKey: string): Promise<PushSubscription> {
  return (await ensurePushSubscription(registration, vapidPublicKey)).subscription;
}

export async function unsubscribeFromPush(registration: ServiceWorkerRegistration): Promise<boolean> {
  const existing = await registration.pushManager.getSubscription();
  return existing ? existing.unsubscribe() : false;
}
