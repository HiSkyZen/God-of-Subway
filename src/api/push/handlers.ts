import { errorBody, internalErrorResponse, invalidRequestResponse, jsonResponse } from "../errors";
import { readJsonPayload, RequestBodyError } from "../handlers";
import { pushCapabilities, vapidConfiguration } from "../push-capability";
import {
  ownsSubscription,
  sameSubscriptionKeys,
  sha256Hex,
  sourceHashFor,
  tokenLooksValid,
} from "./auth";
import {
  registrationRateLimit,
  registrationRateWindow,
} from "./config";
import type {
  LiveTripCalculator,
  PushMessage,
  PushSubscriptionStore,
} from "./contracts";
import { PushStorageUnavailable } from "./contracts";
import { pushDelivery } from "./delivery";
import {
  getAlertByEndpoint,
  getSubscription,
  removeOwnedAlert,
  writeAlertWithinLimit,
  writeSubscriptionWithinLimits,
} from "./store-helpers";
import { pushAlertStore, pushSubscriptionStore } from "./stores";
import {
  isExpired,
  isValidatedLiveTrip,
  parseAlertPayload,
  parseEndpoint,
  parseMessage,
  parseSubscription,
  statusCodeOf,
} from "./validation";

const unavailable = (
  message = "Web Push is not configured",
  code = "push_unavailable",
): Response => jsonResponse({ ...errorBody(message), code, capable: false }, 422);
const consumeRegistrationRate = async (
  store: PushSubscriptionStore,
  sourceHash: string,
  action: string,
): Promise<boolean> => {
  if (!store.consumeRateLimit) return true;
  const bucket = await sha256Hex(sourceHash + ":" + action);
  return store.consumeRateLimit(bucket, registrationRateLimit(), registrationRateWindow());
};
const rateLimitedResponse = (): Response => jsonResponse(
  { ...errorBody("등록 요청 한도를 초과했습니다."), code: "rate_limited" },
  429,
  { "retry-after": String(registrationRateWindow()) },
);
const sourceLimitResponse = (): Response => jsonResponse(
  { ...errorBody("이 연결에서 등록할 수 있는 알림 수를 초과했습니다."), code: "push_source_quota_exceeded" },
  429,
);
const capacityResponse = (): Response => jsonResponse(
  { ...errorBody("푸시 저장 용량 한도에 도달했습니다."), code: "push_capacity_exceeded" },
  503,
);

export const handlePushPublicKey = (): Response => {
  const config = vapidConfiguration();
  const capabilities = pushCapabilities();
  return jsonResponse({
    ok: true,
    capable: capabilities.subscriptionCapable,
    subscription_capable: capabilities.subscriptionCapable,
    arrival_alert_capable: capabilities.arrivalAlertCapable,
    scheduler_mode: capabilities.schedulerMode,
    public_key: capabilities.subscriptionCapable && config.capable ? config.publicKey : null,
  });
};

export const handlePushSubscriptionPost = async (request: Request): Promise<Response> => {
  const config = vapidConfiguration();
  if (!config.capable || !pushCapabilities().subscriptionCapable) return unavailable();
  try {
    const payload = await readJsonPayload(request);
    const parsed = parseSubscription(payload);
    if (!parsed) return invalidRequestResponse("유효한 Web Push 구독이 필요합니다.");
    const store = pushSubscriptionStore();
    const sourceHash = await sourceHashFor(request);
    if (!(await consumeRegistrationRate(store, sourceHash, "subscription"))) {
      return rateLimitedResponse();
    }
    const existing = await getSubscription(store, parsed.endpoint);
    let managementToken: string;
    let managementTokenHash: string;
    if (existing) {
      if (await ownsSubscription(existing, payload.management_token)) {
        managementToken = payload.management_token as string;
        managementTokenHash = existing.managementTokenHash!;
      } else if (payload.management_token === undefined
        && sameSubscriptionKeys(existing.keys, parsed.keys)) {
        managementToken = crypto.randomUUID();
        managementTokenHash = await sha256Hex(managementToken);
      } else {
        return jsonResponse({
          ...errorBody("기존 구독을 갱신할 권한을 확인할 수 없습니다."),
          code: "subscription_ownership_required",
        }, 403);
      }
    } else {
      managementToken = crypto.randomUUID();
      managementTokenHash = await sha256Hex(managementToken);
    }
    const subscription = {
      ...parsed,
      managementTokenHash,
      sourceHash: existing?.sourceHash || sourceHash,
    };
    const outcome = await writeSubscriptionWithinLimits(store, subscription);
    if (outcome === "global_limit") return capacityResponse();
    if (outcome === "source_limit") return sourceLimitResponse();
    return jsonResponse({
      ok: true,
      capable: true,
      endpoint: subscription.endpoint,
      management_token: managementToken,
      reconciled: outcome === "updated",
    });
  } catch (error) {
    if (error instanceof RequestBodyError) return invalidRequestResponse(error.message);
    if (error instanceof PushStorageUnavailable) {
      return jsonResponse({
        ...errorBody("푸시 구독 저장소를 사용할 수 없습니다."),
        code: "storage_unavailable",
      }, 503);
    }
    return internalErrorResponse();
  }
};

export const handlePushSubscriptionDelete = async (request: Request): Promise<Response> => {
  if (!vapidConfiguration().capable || !pushCapabilities().subscriptionCapable) return unavailable();
  try {
    const payload = await readJsonPayload(request);
    const endpoint = parseEndpoint(payload.endpoint);
    if (!endpoint) return invalidRequestResponse("유효한 구독 endpoint가 필요합니다.");
    const store = pushSubscriptionStore();
    const subscription = await getSubscription(store, endpoint);
    if (!subscription || !(await ownsSubscription(subscription, payload.management_token))) {
      return jsonResponse(errorBody("구독 관리 토큰이 올바르지 않습니다."), 403);
    }
    const alertStore = pushAlertStore();
    const activeAlert = await getAlertByEndpoint(alertStore, endpoint);
    const alertRemoved = activeAlert
      ? await removeOwnedAlert(alertStore, endpoint, activeAlert.alertId) : false;
    const removed = await store.remove(endpoint);
    return jsonResponse({ ok: true, capable: true, removed, alerts_removed: alertRemoved ? 1 : 0 });
  } catch (error) {
    if (error instanceof RequestBodyError) return invalidRequestResponse(error.message);
    if (error instanceof PushStorageUnavailable) {
      return jsonResponse({
        ...errorBody("푸시 구독 저장소를 사용할 수 없습니다."),
        code: "storage_unavailable",
      }, 503);
    }
    return internalErrorResponse();
  }
};

export const handlePushAlertPost = async (
  request: Request,
  calculateLiveTrip: LiveTripCalculator,
): Promise<Response> => {
  if (!vapidConfiguration().capable || !pushCapabilities().arrivalAlertCapable) {
    return unavailable("ETA 도착 알림 scheduler가 설정되지 않았습니다.", "arrival_alert_unavailable");
  }
  try {
    const payload = await readJsonPayload(request);
    const alert = parseAlertPayload(payload);
    if (!alert || !tokenLooksValid(payload.management_token)) {
      return invalidRequestResponse("유효한 도착 알림 요청이 필요합니다.");
    }
    const subscriptionStore = pushSubscriptionStore();
    const subscription = await getSubscription(subscriptionStore, alert.subscriptionEndpoint);
    if (!subscription || !(await ownsSubscription(subscription, payload.management_token))) {
      return jsonResponse(errorBody("구독 관리 토큰이 올바르지 않습니다."), 403);
    }
    const sourceHash = await sourceHashFor(request);
    if (!(await consumeRegistrationRate(subscriptionStore, sourceHash, "alert"))) {
      return rateLimitedResponse();
    }
    let validation: unknown;
    try { validation = await calculateLiveTrip(alert.tripPayload); }
    catch {
      return invalidRequestResponse("현재 여정을 확인할 수 없어 도착 알림을 저장하지 않았습니다.");
    }
    if (!isValidatedLiveTrip(validation)) {
      return invalidRequestResponse("유효한 여정만 도착 알림으로 저장할 수 있습니다.");
    }
    const alertId = crypto.randomUUID();
    const savedAlert = { ...alert, alertId, createdAt: new Date().toISOString() };
    const outcome = await writeAlertWithinLimit(pushAlertStore(), savedAlert);
    if (outcome === "global_limit") return capacityResponse();
    if (outcome === "busy") {
      return jsonResponse({
        ...errorBody("이전 알림을 발송 중입니다. 잠시 후 다시 시도해 주세요."),
        code: "alert_delivery_in_progress",
      }, 409);
    }
    return jsonResponse({
      ok: true,
      capable: true,
      alert_id: alertId,
      threshold_seconds: alert.thresholdSeconds,
      expires_at: alert.expiresAt,
      status_url: "/api/push/alerts/status",
      notification_tag: "arrival-" + alertId,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) return invalidRequestResponse(error.message);
    if (error instanceof PushStorageUnavailable) {
      return jsonResponse({
        ...errorBody("푸시 알림 저장소를 사용할 수 없습니다."),
        code: "storage_unavailable",
      }, 503);
    }
    return internalErrorResponse();
  }
};

export const handlePushAlertDelete = async (request: Request): Promise<Response> => {
  if (!vapidConfiguration().capable || !pushCapabilities().arrivalAlertCapable) {
    return unavailable("ETA 도착 알림 scheduler가 설정되지 않았습니다.", "arrival_alert_unavailable");
  }
  try {
    const payload = await readJsonPayload(request);
    const alertId = typeof payload.alert_id === "string" ? payload.alert_id : "";
    const endpoint = parseEndpoint(payload.subscription_endpoint);
    if (!/^[0-9a-f-]{36}$/i.test(alertId) || !endpoint
      || !tokenLooksValid(payload.management_token)) {
      return invalidRequestResponse("유효한 도착 알림 삭제 요청이 필요합니다.");
    }
    const subscription = await getSubscription(pushSubscriptionStore(), endpoint);
    if (!subscription || !(await ownsSubscription(subscription, payload.management_token))) {
      return jsonResponse(errorBody("구독 관리 토큰이 올바르지 않습니다."), 403);
    }
    const alertStore = pushAlertStore();
    const ownedAlert = await getAlertByEndpoint(alertStore, endpoint);
    if (!ownedAlert || ownedAlert.alertId !== alertId) {
      return jsonResponse(errorBody("해당 구독이 소유한 알림이 아닙니다."), 403);
    }
    const removed = await removeOwnedAlert(alertStore, endpoint, alertId);
    return jsonResponse({ ok: true, capable: true, removed });
  } catch (error) {
    if (error instanceof RequestBodyError) return invalidRequestResponse(error.message);
    if (error instanceof PushStorageUnavailable) {
      return jsonResponse({
        ...errorBody("푸시 알림 저장소를 사용할 수 없습니다."),
        code: "storage_unavailable",
      }, 503);
    }
    return internalErrorResponse();
  }
};

export const handlePushAlertStatus = async (request: Request): Promise<Response> => {
  if (!vapidConfiguration().capable || !pushCapabilities().subscriptionCapable) return unavailable();
  try {
    const payload = await readJsonPayload(request);
    const alertId = typeof payload.alert_id === "string" ? payload.alert_id : "";
    const endpoint = parseEndpoint(payload.subscription_endpoint);
    if (!/^[0-9a-f-]{36}$/i.test(alertId) || !endpoint
      || !tokenLooksValid(payload.management_token)) {
      return invalidRequestResponse("유효한 도착 알림 상태 요청이 필요합니다.");
    }
    const subscription = await getSubscription(pushSubscriptionStore(), endpoint);
    if (!subscription || !(await ownsSubscription(subscription, payload.management_token))) {
      return jsonResponse(errorBody("구독 관리 토큰이 올바르지 않습니다."), 403);
    }
    const alert = await getAlertByEndpoint(pushAlertStore(), endpoint);
    const active = Boolean(alert && alert.alertId === alertId && Date.parse(alert.expiresAt) > Date.now());
    return jsonResponse({
      ok: true,
      capable: true,
      alert_id: alertId,
      active,
      status: active ? "active" : "missing",
      expires_at: active ? alert!.expiresAt : null,
      notification_tag: "arrival-" + alertId,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) return invalidRequestResponse(error.message);
    if (error instanceof PushStorageUnavailable) {
      return jsonResponse({
        ...errorBody("푸시 알림 저장소를 사용할 수 없습니다."),
        code: "storage_unavailable",
      }, 503);
    }
    return internalErrorResponse();
  }
};

export const handlePushTest = async (request: Request): Promise<Response> => {
  if (Bun.env.NODE_ENV === "production" || Bun.env.PUSH_TEST_ENABLED !== "1") {
    return jsonResponse(errorBody("Push test endpoint is disabled"), 404);
  }
  const expected = Bun.env.PUSH_TEST_TOKEN;
  if (!expected || request.headers.get("x-push-test-token") !== expected) {
    return jsonResponse(errorBody("Unauthorized"), 401);
  }
  const config = vapidConfiguration();
  if (!config.capable) return unavailable();
  let message: PushMessage;
  try {
    const parsed = parseMessage(await readJsonPayload(request));
    if (!parsed) throw new RequestBodyError("유효한 푸시 메시지가 필요합니다.");
    message = parsed;
  } catch (error) {
    return error instanceof RequestBodyError
      ? invalidRequestResponse(error.message) : internalErrorResponse();
  }
  try {
    const store = pushSubscriptionStore();
    const delivery = pushDelivery(config);
    let delivered = 0;
    let removed = 0;
    let failed = 0;
    for (const subscription of await store.list()) {
      if (isExpired(subscription)) {
        if (await store.remove(subscription.endpoint)) removed += 1;
        continue;
      }
      try {
        await delivery.send(subscription, message);
        delivered += 1;
      } catch (error) {
        if (statusCodeOf(error) === 404 || statusCodeOf(error) === 410) {
          if (await store.remove(subscription.endpoint)) removed += 1;
        } else {
          failed += 1;
        }
      }
    }
    return jsonResponse({ ok: failed === 0, delivered, removed, failed }, failed === 0 ? 200 : 502);
  } catch (error) {
    if (error instanceof PushStorageUnavailable) {
      return jsonResponse({
        ...errorBody("푸시 구독 저장소를 사용할 수 없습니다."),
        code: "storage_unavailable",
      }, 503);
    }
    return internalErrorResponse();
  }
};
