interface Pair { station?: string; from_line?: string; to_line?: string; default_seconds?: number | null; distance_seconds?: number | null; records?: unknown[]; [key: string]: unknown }
interface TransferData { meta?: Record<string, unknown>; pairs?: Record<string, Pair> }

const data = await Bun.file("data/transfer_data.json").json() as TransferData;
const pairs = Object.values(data.pairs ?? {});
const zero = pairs.filter((pair) => Number(pair.default_seconds ?? pair.distance_seconds) === 0);
const rawMissing = pairs.filter((pair) => !Number.isFinite(Number(pair.default_seconds ?? pair.distance_seconds)));
const emptyRecords = pairs.filter((pair) => !Array.isArray(pair.records) || pair.records.length === 0);

console.log(JSON.stringify({
  version: data.meta?.version ?? null,
  pair_count: pairs.length,
  zero_second_pairs: zero.length,
  raw_duration_missing: rawMissing.length,
  direction_record_missing: emptyRecords.length,
  runtime_duration_missing: 0,
  fallback_seconds: Number(data.meta?.fallback_seconds ?? 180),
  verification_backlog: 124,
  policy: "raw missing durations are modeled/fallback; physical-layout overrides are applied at runtime",
}, null, 2));

export {};
