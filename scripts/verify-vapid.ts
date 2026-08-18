import webpush from "web-push";

const publicKey = Bun.env.VAPID_PUBLIC_KEY?.trim();
const privateKey = Bun.env.VAPID_PRIVATE_KEY?.trim();
const subject = Bun.env.VAPID_SUBJECT?.trim();
if (!publicKey || !privateKey || !subject) {
  console.error("VAPID configuration is incomplete.");
  process.exit(1);
}
try {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  console.log("VAPID configuration is valid.");
} catch {
  console.error("VAPID configuration is invalid.");
  process.exit(1);
}
