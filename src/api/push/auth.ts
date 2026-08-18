import { timingSafeEqual } from "node:crypto";
import type { PushSubscriptionKeys, PushSubscriptionRecord } from "./contracts";

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
};
export const tokenLooksValid = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 24 && value.length <= 256;
export const ownsSubscription = async (
  record: PushSubscriptionRecord,
  token: unknown,
): Promise<boolean> => {
  if (!record.managementTokenHash || !/^[a-f0-9]{64}$/.test(record.managementTokenHash)
    || !tokenLooksValid(token)) return false;
  const expected = Buffer.from(record.managementTokenHash, "hex");
  const candidate = Buffer.from(await sha256Hex(token), "hex");
  return expected.byteLength === candidate.byteLength && timingSafeEqual(expected, candidate);
};
export const sameSubscriptionKeys = (left: PushSubscriptionKeys, right: PushSubscriptionKeys): boolean => {
  const leftP256 = Buffer.from(left.p256dh, "base64url");
  const rightP256 = Buffer.from(right.p256dh, "base64url");
  const leftAuth = Buffer.from(left.auth, "base64url");
  const rightAuth = Buffer.from(right.auth, "base64url");
  return leftP256.byteLength === rightP256.byteLength
    && leftAuth.byteLength === rightAuth.byteLength
    && timingSafeEqual(leftP256, rightP256)
    && timingSafeEqual(leftAuth, rightAuth);
};
const trustedSourceAddress = (request: Request): string => {
  let forwarded: string | null = null;
  if (Bun.env.VERCEL === "1") {
    forwarded = request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for");
  } else if (Bun.env.PUSH_TRUST_PROXY === "1") {
    forwarded = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip");
  }
  const candidate = forwarded?.split(",", 1)[0]?.trim();
  return candidate && candidate.length <= 128 && /^[0-9a-fA-F:.]+$/.test(candidate)
    ? candidate : "unresolved-direct-client";
};
export const sourceHashFor = async (request: Request): Promise<string> =>
  sha256Hex("push-source:" + trustedSourceAddress(request));
