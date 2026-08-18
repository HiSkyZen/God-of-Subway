import type { LiveTripState, PushAlertRequest } from "./contract";
import { tripUpdatePayload } from "./trip-state";

export interface PushAlertRequestInput {
  trip: LiveTripState;
  subscriptionEndpoint: string;
  managementToken: string;
  destination: string;
  thresholdSeconds?: number;
  expiresAt?: string;
}

export function pushTripSnapshot(trip: LiveTripState): string {
  return JSON.stringify({ active_index: trip.activeIndex, boarded_train_no: trip.boardedTrainNo, boarded_at: trip.boardedAt });
}

export function buildPushAlertRequest(input: PushAlertRequestInput): PushAlertRequest {
  return {
    subscription_endpoint: input.subscriptionEndpoint,
    management_token: input.managementToken,
    destination: input.destination,
    threshold_seconds: input.thresholdSeconds ?? 120,
    trip_payload: tripUpdatePayload(input.trip),
    ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
  };
}

export function alertNeedsTripReplacement(previousSnapshot: string | undefined, trip: LiveTripState): boolean {
  return previousSnapshot !== pushTripSnapshot(trip);
}

export function markAlertCancellationPending<T extends { pending_cancel?: boolean }>(alert: T): Omit<T, "pending_cancel"> & { pending_cancel: true } {
  return { ...alert, pending_cancel: true };
}

export function pushAlertStatusIsActive(status: { active: boolean; status: "active" | "missing"; expires_at: string | null }, now: Date): boolean {
  if (!status.active || status.status === "missing") return false;
  return status.expires_at === null || Date.parse(status.expires_at) > now.getTime();
}

export function shouldReconcilePushOnVisibility(state: DocumentVisibilityState): boolean {
  return state === "visible";
}
