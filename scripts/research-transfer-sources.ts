import { deterministicMapNoise } from "../src/engine/transfer-policy";

type Provider = "naver-map" | "kakao-map";
interface Target { provider: Provider; url: string; station: string; from_line: string; to_line: string }
interface Result extends Target { observed_seconds: number; noise_seconds: number; normalized_seconds: number; fetched_at: string }

const input = process.argv[2];
if (!input) throw new Error("Usage: bun run research:transfers <targets.json> [output.json]");
const output = process.argv[3] ?? "tmp/transfer-map-samples.generated.json";
const targets = await Bun.file(input).json() as Target[];
if (!Array.isArray(targets)) throw new Error("targets.json must be an array");

function transferDuration(text: string): number | null {
  const compact = text.replace(/\s+/g, " ");
  const patterns = [
    /환승.{0,120}?(\d{1,2})\s*분\s*(?:(\d{1,2})\s*초)?/i,
    /(\d{1,2})\s*분\s*(?:(\d{1,2})\s*초)?.{0,120}?환승/i,
    /환승.{0,120}?(\d{1,3})\s*초/i,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = compact.match(pattern);
    if (!match) continue;
    if (index < 2) return Number(match[1]) * 60 + Number(match[2] ?? 0);
    return Number(match[1]);
  }
  return null;
}

const results: Result[] = [];
for (const target of targets) {
  if (!/^https:\/\//.test(target.url)) throw new Error(`HTTPS URL required: ${target.url}`);
  const response = await fetch(target.url, { headers: { "user-agent": "God-of-Subway transfer research/1.0" } });
  if (!response.ok) { console.warn(`[research] ${target.provider} ${target.station}: HTTP ${response.status}; skipped`); continue; }
  const seconds = transferDuration(await response.text());
  if (seconds === null) { console.warn(`[research] ${target.provider} ${target.station}: no transfer-duration phrase; skipped`); continue; }
  const noise = deterministicMapNoise(target.provider, target.station, target.from_line, target.to_line);
  results.push({ ...target, observed_seconds: seconds, noise_seconds: noise, normalized_seconds: seconds + noise, fetched_at: new Date().toISOString() });
  await Bun.sleep(1_500);
}

await Bun.write(output, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2) + "\n");
console.log(`[research] wrote ${results.length}/${targets.length} usable observations to ${output}`);
