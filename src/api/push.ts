import { configureNativePushStorage, resetNativePushStorageStateForTests } from "./push/configure-storage";

configureNativePushStorage();

export * from "./push/contracts";
export {
  pushAlertStore,
  pushSubscriptionStore,
  setPushAlertStore,
  setPushSubscriptionStore,
} from "./push/stores";
export { setPushDelivery } from "./push/delivery";
export {
  handlePushAlertDelete,
  handlePushAlertPost,
  handlePushAlertStatus,
  handlePushSubscriptionDelete,
  handlePushSubscriptionPost,
  handlePushTest,
} from "./push/handlers";
export { handlePushPublicKey } from "./push/public-key";
export { handlePushDispatch } from "./push/dispatch";
export { configureNativePushStorage } from "./push/configure-storage";

import { resetPushDeliveryStateForTests } from "./push/delivery";
import { resetPushDispatchStateForTests } from "./push/dispatch";
import { resetPushStoreHelpersForTests } from "./push/store-helpers";
import { resetPushStoreStateForTests } from "./push/stores";

export const resetPushRuntimeStateForTests = (): void => {
  resetPushDeliveryStateForTests();
  resetPushDispatchStateForTests();
  resetPushStoreHelpersForTests();
  resetNativePushStorageStateForTests();
  resetPushStoreStateForTests();
};
