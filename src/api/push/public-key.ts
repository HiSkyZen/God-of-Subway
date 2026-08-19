import { jsonResponse } from "../errors";
import { pushCapabilities, vapidConfiguration, type PushConfigurationIssue } from "../push-capability";

const configurationMessage = (issues: PushConfigurationIssue[]): string | null => {
  const missingVapid = issues.includes("vapid_unavailable");
  const missingStorage = issues.includes("storage_unavailable");
  if (missingVapid && missingStorage) return "Web Push VAPID 키와 Valkey/Redis 저장소가 구성되지 않았습니다.";
  if (missingVapid) return "Web Push VAPID 키가 구성되지 않았습니다.";
  if (missingStorage) return "Valkey/Redis 푸시 저장소가 구성되지 않았습니다.";
  return null;
};

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
    configuration_message: configurationMessage(capabilities.configurationIssues),
    public_key: capabilities.subscriptionCapable && config.capable ? config.publicKey : null,
  });
};
