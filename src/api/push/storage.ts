import { valkeyConfigured } from "../../infra/valkey";
import type { PushAlertStore, PushSubscriptionStore } from "./contracts";
import {
  pushAlertStore as legacyPushAlertStore,
  pushSubscriptionStore as legacyPushSubscriptionStore,
  resetPushStoreStateForTests as resetLegacyPushStoreStateForTests,
} from "./stores";
import { ValkeyPushAlertStore, ValkeyPushSubscriptionStore } from "./valkey-stores";

let configuredSubscriptionStore: PushSubscriptionStore | undefined;
let configuredAlertStore: PushAlertStore | undefined;
let nativeSubscriptionStore: ValkeyPushSubscriptionStore | undefined;
let nativeAlertStore: ValkeyPushAlertStore | undefined;

export const setPushSubscriptionStore = (store: PushSubscriptionStore | undefined): void => {
  configuredSubscriptionStore = store;
};

export const setPushAlertStore = (store: PushAlertStore | undefined): void => {
  configuredAlertStore = store;
};

export const pushSubscriptionStore = (): PushSubscriptionStore => {
  if (configuredSubscriptionStore) return configuredSubscriptionStore;
  if (!valkeyConfigured()) return legacyPushSubscriptionStore();
  nativeSubscriptionStore ??= new ValkeyPushSubscriptionStore();
  return nativeSubscriptionStore;
};

export const pushAlertStore = (): PushAlertStore => {
  if (configuredAlertStore) return configuredAlertStore;
  if (!valkeyConfigured()) return legacyPushAlertStore();
  nativeAlertStore ??= new ValkeyPushAlertStore();
  return nativeAlertStore;
};

export const resetPushStorageStateForTests = (): void => {
  configuredSubscriptionStore = undefined;
  configuredAlertStore = undefined;
  nativeSubscriptionStore = undefined;
  nativeAlertStore = undefined;
  resetLegacyPushStoreStateForTests();
};
