import { DATASET_METADATA } from "../src/engine/data-metadata";

const failures: string[] = [];
console.log(`[doctor] Bun ${Bun.version}`);
if (typeof Bun.version !== "string") failures.push("Bun runtime unavailable");

for (const [file, expected] of Object.entries(DATASET_METADATA.files)) {
  const handle = Bun.file(file);
  if (!(await handle.exists())) { failures.push(`missing ${file}`); continue; }
  const actual = handle.size;
  const state = actual === expected ? "ok" : `expected ${expected}`;
  console.log(`[doctor] ${file}: ${actual} bytes (${state})`);
  if (actual !== expected) failures.push(`${file}: ${actual} != ${expected}`);
}

const transfers = await Bun.file("transfer_data.json").json() as { meta?: Record<string, unknown>; pairs?: Record<string, Record<string, unknown>> };
const pairs = Object.values(transfers.pairs ?? {});
const missingDurations = pairs.filter((pair) => !Number.isFinite(Number(pair.default_seconds ?? pair.distance_seconds))).length;
console.log(`[doctor] transfer pairs=${pairs.length}, raw missing duration=${missingDurations}, runtime fallback=${String(transfers.meta?.fallback_seconds ?? 180)}s`);
console.log(`[doctor] transfer upstream=${DATASET_METADATA.transfers.upstream_version}, verification backlog=${DATASET_METADATA.transfers.audit_remaining_needs_verification}`);

if (failures.length) {
  console.error("\n[doctor] FAIL");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("[doctor] PASS");
