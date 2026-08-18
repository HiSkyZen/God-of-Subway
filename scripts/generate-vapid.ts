import webpush from "web-push";

const outputPath = Bun.env.VAPID_OUTPUT_PATH || ".env.push.local";
const subject = Bun.env.VAPID_SUBJECT || "mailto:admin@example.invalid";
const keys = webpush.generateVAPIDKeys();

// Keep private material in a local ignored file. The command intentionally
// does not print either key to stdout or include them in a generated report.
await Bun.write(outputPath, [
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  `VAPID_SUBJECT=${subject}`,
  "",
].join("\n"));
console.log(`VAPID material written to ${outputPath}; keep this file private.`);
