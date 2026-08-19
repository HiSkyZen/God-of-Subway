import { valkeyConfigured } from "../../infra/valkey";
import { setPushAlertStore, setPushSubscriptionStore } from "./stores";
import { ValkeyPushAlertStore, ValkeyPushSubscriptionStore } from "./valkey-stores";

let nativeStorageInstalled = false;

export function configureNativePushStorage(): boolean {
  if (nativeStorageInstalled || !valkeyConfigured()) return nativeStorageInstalled;
  setPushSubscriptionStore(new ValkeyPushSubscriptionStore());
  setPushAlertStore(new ValkeyPushAlertStore());
  nativeStorageInstalled = true;
  return true;
}

export function resetNativePushStorageStateForTests(): void {
  nativeStorageInstalled = false;
}
