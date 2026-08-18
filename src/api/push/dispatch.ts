import { errorBody, internalErrorResponse, jsonResponse } from "../errors";
import { pushCapabilities, vapidConfiguration } from "../push-capability";
import {
  deliveryClaimSeconds,
  dispatchLeaseSeconds,
  integerEnv,
} from "./config";
import type {
  LiveTripCalculator,
  PushAlertRecord,
  PushAlertStore,
} from "./contracts";
import { PushStorageUnavailable } from "./contracts";
import { pushDelivery } from "./delivery";
import {
  claimAlertForDelivery,
  completeAlertDelivery,
  getSubscription,
  nextAlertBatch,
  releaseAlertDelivery,
  removeOwnedAlert,
} from "./store-helpers";
import { pushAlertStore, pushSubscriptionStore } from "./stores";
import { isExpired, statusCodeOf } from "./validation";

let dispatchInFlight = false;
const unavailable = (): Response => jsonResponse({
  ...errorBody("ETA 도착 알림 scheduler가 설정되지 않았습니다."),
  code: "arrival_alert_unavailable",
  capable: false,
}, 422);
const skippedDispatchResponse = (): Response => jsonResponse({
  ok: true,
  evaluated: 0,
  delivered: 0,
  removed: 0,
  failed: 0,
  has_more: true,
  next_cursor: null,
  skipped: true,
  reason: "dispatch_in_progress",
});

export const handlePushDispatch = async (
  request: Request,
  calculateLiveTrip: LiveTripCalculator,
): Promise<Response> => {
  if (request.method === "GET") {
    const cronSecret = Bun.env.CRON_SECRET?.trim();
    if (!cronSecret || request.headers.get("authorization") !== "Bearer " + cronSecret) {
      return jsonResponse(errorBody("Unauthorized"), 401);
    }
  } else {
    if (Bun.env.NODE_ENV !== "production" && Bun.env.PUSH_CRON_ENABLED !== "1") {
      return jsonResponse(errorBody("Push scheduler is disabled"), 404);
    }
    const cronToken = Bun.env.PUSH_CRON_TOKEN?.trim()
      || (Bun.env.NODE_ENV === "production" ? Bun.env.CRON_SECRET?.trim() : undefined);
    const provided = request.headers.get("x-push-cron-token")
      || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!cronToken || provided !== cronToken) return jsonResponse(errorBody("Unauthorized"), 401);
  }
  const config = vapidConfiguration();
  if (!config.capable || !pushCapabilities().arrivalAlertCapable) return unavailable();
  if (dispatchInFlight) return skippedDispatchResponse();
  dispatchInFlight = true;
  const leaseToken = crypto.randomUUID();
  let leaseAcquired = false;
  let alertStore: PushAlertStore | undefined;
  try {
    const subscriptionStore = pushSubscriptionStore();
    alertStore = pushAlertStore();
    if (alertStore.acquireDispatchLease) {
      leaseAcquired = await alertStore.acquireDispatchLease(leaseToken, dispatchLeaseSeconds());
      if (!leaseAcquired) return skippedDispatchResponse();
    }
    let evaluated = 0;
    let delivered = 0;
    let removed = 0;
    let failed = 0;
    const batchSize = integerEnv("PUSH_DISPATCH_BATCH_SIZE", 50, 1, 100);
    const page = await nextAlertBatch(alertStore, batchSize);
    const processAlert = async (alert: PushAlertRecord): Promise<void> => {
      if (Date.parse(alert.expiresAt) <= Date.now()) {
        if (await removeOwnedAlert(alertStore!, alert.subscriptionEndpoint, alert.alertId)) removed += 1;
        return;
      }
      const subscription = await getSubscription(subscriptionStore, alert.subscriptionEndpoint);
      if (!subscription || isExpired(subscription)) {
        if (subscription && await subscriptionStore.remove(subscription.endpoint)) removed += 1;
        if (await removeOwnedAlert(alertStore!, alert.subscriptionEndpoint, alert.alertId)) removed += 1;
        return;
      }
      evaluated += 1;
      let result: unknown;
      try { result = await calculateLiveTrip(alert.tripPayload); }
      catch { failed += 1; return; }
      if (!result || typeof result !== "object"
        || (result as Record<string, unknown>).ok === false) return;
      const remaining = Number((result as Record<string, unknown>).remaining_seconds);
      if (!Number.isFinite(remaining) || remaining > alert.thresholdSeconds) return;

      // The claim atomically rechecks alertId after ETA calculation. While it
      // is held, store replacements return "busy", so a committed replacement
      // can never receive a notification calculated for the stale alert.
      const claimToken = crypto.randomUUID();
      const claimed = await claimAlertForDelivery(
        alertStore!,
        alert.subscriptionEndpoint,
        alert.alertId,
        claimToken,
        deliveryClaimSeconds(),
      );
      if (!claimed) return;
      let claimHeld = true;
      try {
        await pushDelivery(config).send(subscription, {
          title: "지금타 도착 알림",
          body: alert.destination + "까지 약 "
            + Math.max(0, Math.ceil(remaining / 60)) + "분 남았습니다.",
          url: "/",
          alert_id: alert.alertId,
          tag: "arrival-" + alert.alertId,
        });
        const completed = await completeAlertDelivery(
          alertStore!,
          alert.subscriptionEndpoint,
          alert.alertId,
          claimToken,
        );
        claimHeld = false;
        if (completed) delivered += 1;
        else failed += 1;
      } catch (error) {
        if (statusCodeOf(error) === 404 || statusCodeOf(error) === 410) {
          if (await subscriptionStore.remove(subscription.endpoint)) removed += 1;
          const completed = await completeAlertDelivery(
            alertStore!,
            alert.subscriptionEndpoint,
            alert.alertId,
            claimToken,
          );
          claimHeld = false;
          if (completed) removed += 1;
        } else {
          failed += 1;
        }
      } finally {
        if (claimHeld) {
          await releaseAlertDelivery(
            alertStore!,
            alert.subscriptionEndpoint,
            claimToken,
          ).catch(() => undefined);
        }
      }
    };
    const concurrency = integerEnv("PUSH_DISPATCH_CONCURRENCY", 4, 1, 8);
    let workIndex = 0;
    const worker = async (): Promise<void> => {
      while (workIndex < page.items.length) {
        const index = workIndex;
        workIndex += 1;
        await processAlert(page.items[index]);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(concurrency, page.items.length) },
      () => worker(),
    ));
    return jsonResponse({
      ok: failed === 0,
      evaluated,
      delivered,
      removed,
      failed,
      has_more: page.hasMore,
      next_cursor: page.nextCursor,
    }, failed === 0 ? 200 : 502);
  } catch (error) {
    if (error instanceof PushStorageUnavailable) {
      return jsonResponse({
        ...errorBody("푸시 scheduler 저장소를 사용할 수 없습니다."),
        code: "storage_unavailable",
      }, 503);
    }
    return internalErrorResponse();
  } finally {
    if (leaseAcquired && alertStore?.releaseDispatchLease) {
      await alertStore.releaseDispatchLease(leaseToken).catch(() => undefined);
    }
    dispatchInFlight = false;
  }
};
export const resetPushDispatchStateForTests = (): void => {
  dispatchInFlight = false;
};
