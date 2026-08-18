import webpush from "web-push";
import { vapidConfiguration, type VapidConfiguration } from "../push-capability";
import type {
  PushDelivery,
  PushMessage,
  PushSubscriptionRecord,
} from "./contracts";

class WebPushDelivery implements PushDelivery {
  constructor(private readonly config: VapidConfiguration) {
    if (config.capable) {
      webpush.setVapidDetails(config.subject!, config.publicKey!, config.privateKey!);
    }
  }
  async send(subscription: PushSubscriptionRecord, message: PushMessage): Promise<void> {
    if (!this.config.capable) throw new Error("Web Push is not configured");
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: subscription.keys,
      },
      JSON.stringify(message),
      { TTL: 300 },
    );
  }
}

let configuredDelivery: PushDelivery | undefined;
export const setPushDelivery = (delivery: PushDelivery | undefined): void => {
  configuredDelivery = delivery;
};
export const pushDelivery = (
  config: VapidConfiguration = vapidConfiguration(),
): PushDelivery => configuredDelivery ?? new WebPushDelivery(config);
export const resetPushDeliveryStateForTests = (): void => {
  configuredDelivery = undefined;
};
