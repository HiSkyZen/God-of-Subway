import { redisConfiguration } from "./push/config";

export interface PushCapabilities {
  subscriptionCapable: boolean;
  arrivalAlertCapable: boolean;
  schedulerMode: "external" | "interval" | null;
}
export interface VapidConfiguration {
  capable: boolean;
  publicKey: string | null;
  privateKey: string | null;
  subject: string | null;
}

const decodeCanonicalBase64Url = (value: string | null): Uint8Array | null => {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch { return null; }
};
const validSubject = (value: string | null): boolean => {
  if (!value || value.length > 2_048) return false;
  try {
    const subject = new URL(value);
    if (subject.protocol === "mailto:") return subject.pathname.includes("@") && !subject.search && !subject.hash;
    return subject.protocol === "https:" && Boolean(subject.hostname)
      && !subject.username && !subject.password && !subject.hash;
  } catch { return false; }
};

export const vapidConfiguration = (): VapidConfiguration => {
  const publicKey = Bun.env.VAPID_PUBLIC_KEY?.trim() || null;
  const privateKey = Bun.env.VAPID_PRIVATE_KEY?.trim() || null;
  const subject = Bun.env.VAPID_SUBJECT?.trim() || null;
  const publicBytes = decodeCanonicalBase64Url(publicKey);
  const privateBytes = decodeCanonicalBase64Url(privateKey);
  const capable = Boolean(
    publicBytes && publicBytes.byteLength === 65 && publicBytes[0] === 4
    && privateBytes && privateBytes.byteLength === 32
    && validSubject(subject),
  );
  return { capable, publicKey, privateKey, subject };
};

const persistentStoreConfigured = (): boolean => Bun.env.NODE_ENV !== "production"
  || redisConfiguration() !== null;
const intervalConfigured = (): boolean => {
  if (Bun.env.VERCEL === "1") return false;
  const seconds = Number(Bun.env.PUSH_SCHEDULER_INTERVAL_SECONDS || 0);
  if (!Number.isSafeInteger(seconds) || seconds < 60) return false;
  return Bun.env.NODE_ENV === "production"
    ? Boolean(Bun.env.CRON_SECRET?.trim())
    : Bun.env.PUSH_CRON_ENABLED === "1" && Boolean(Bun.env.PUSH_CRON_TOKEN?.trim());
};
const externalConfigured = (): boolean =>
  Bun.env.PUSH_SCHEDULER_MODE?.trim().toLowerCase() === "external"
  && Boolean(Bun.env.CRON_SECRET?.trim());

export const pushCapabilities = (): PushCapabilities => {
  const subscriptionCapable = vapidConfiguration().capable && persistentStoreConfigured();
  const schedulerMode = intervalConfigured() ? "interval" : externalConfigured() ? "external" : null;
  return {
    subscriptionCapable,
    arrivalAlertCapable: subscriptionCapable && schedulerMode !== null,
    schedulerMode,
  };
};
