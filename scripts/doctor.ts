import { DATASET_METADATA } from "../src/engine/data-metadata";

const failures: string[] = [];
const dataFile = (name: string): string => `data/${name}`;
console.log(`[doctor] Bun ${Bun.version}`);
if (typeof Bun.version !== "string") failures.push("Bun runtime unavailable");

for (const [file, expected] of Object.entries(DATASET_METADATA.files)) {
  const path = dataFile(file);
  const handle = Bun.file(path);
  if (!(await handle.exists())) { failures.push(`missing ${path}`); continue; }
  const actual = handle.size;
  const state = actual === expected ? "ok" : `expected ${expected}`;
  console.log(`[doctor] ${path}: ${actual} bytes (${state})`);
  if (actual !== expected) failures.push(`${path}: ${actual} != ${expected}`);
}

type Pair = Record<string, unknown>;
const imported = await Bun.file(dataFile("transfer_data.json")).json() as { pairs?: Record<string, Pair> };
const completion = await Bun.file(dataFile("transfer_overlay.json")).json() as { pairs?: Record<string, Pair> };
const merged = { ...(imported.pairs ?? {}), ...(completion.pairs ?? {}) };
const pairs = Object.values(merged);
const missingDurations = pairs.filter((pair) => !Number.isFinite(Number(pair.default_seconds ?? pair.distance_seconds))).length;
const placeholder = pairs.filter((pair) => Number(pair.default_seconds ?? pair.distance_seconds) === 240).length;
console.log(`[doctor] transfer imported=${Object.keys(imported.pairs ?? {}).length}, completion=${Object.keys(completion.pairs ?? {}).length}, runtime=${pairs.length}, missing=${missingDurations}, placeholder_240=${placeholder}`);
console.log(`[doctor] transfer upstream=${DATASET_METADATA.transfers.upstream_version}, verification backlog=${DATASET_METADATA.transfers.audit_remaining_needs_verification}`);
if (missingDurations) failures.push(`runtime transfer durations missing: ${missingDurations}`);
if (placeholder) failures.push(`240-second placeholder transfer durations remain: ${placeholder}`);

if (failures.length) {
  console.error("\n[doctor] FAIL");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("[doctor] PASS");
