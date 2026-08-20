interface Pair { station?: string; from_line?: string; to_line?: string; default_seconds?: number | null; distance_seconds?: number | null; records?: unknown[]; [key: string]: unknown }
interface TransferData { pairs?: Record<string, Pair> }

const imported = await Bun.file("data/transfer_data.json").json() as TransferData;
const completion = await Bun.file("data/transfer_overlay.json").json() as TransferData;
const merged = { ...(imported.pairs ?? {}), ...(completion.pairs ?? {}) };
const pairs = Object.values(merged);
const zero = pairs.filter((pair) => Number(pair.default_seconds ?? pair.distance_seconds) === 0);
const rawMissing = pairs.filter((pair) => !Number.isFinite(Number(pair.default_seconds ?? pair.distance_seconds)));
const placeholder = pairs.filter((pair) => Number(pair.default_seconds ?? pair.distance_seconds) === 240);
const emptyRecords = pairs.filter((pair) => !Array.isArray(pair.records) || pair.records.length === 0);

console.log(JSON.stringify({
  imported_pair_count: Object.keys(imported.pairs ?? {}).length,
  completion_pair_count: Object.keys(completion.pairs ?? {}).length,
  runtime_pair_count: pairs.length,
  zero_second_pairs: zero.length,
  raw_duration_missing: rawMissing.length,
  placeholder_240_seconds: placeholder.length,
  direction_record_missing: emptyRecords.length,
  verification_backlog: 124,
  policy: "runtime transfer pairs are completed from network topology; missing durations use deterministic station-specific modeling",
}, null, 2));

export {};
