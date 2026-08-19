import { jsonResponse } from "../errors";
import { pushCapabilities, vapidConfiguration } from "../push-capability";

export const handlePushPublicKey = (): Response => {
  const config = vapidConfiguration();
  const capabilities = pushCapabilities();
  return jsonResponse({
    ok: true,
    capable: capabilities.subscriptionCapable,
    subscription_capable: capabilities.subscriptionCapable,
    arrival_alert_capable: capabilities.arrivalAlertCapable,
    scheduler_mode: capabilities.schedulerMode,
    configuration_issues: capabilities.configurationIssues,
    public_key: capabilities.subscriptionCapable && config.capable ? config.publicKey : null,
  });
};
