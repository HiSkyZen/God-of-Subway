import { Database } from "bun:sqlite";
import { buildSource, cleanName } from "./common";
import { transferStationId } from "./static";

const UPSTREAM_URL = "https://raw.githubusercontent.com/unending314/God-of-Subway/main/transfer_data.json";
const SUPPORTED = new Set([
  "1호선","2호선","3호선","4호선","5호선","6호선","7호선","8호선","9호선",
  "경의중앙선","공항철도","경춘선","수인분당선","신분당선","경강선","서해선",
  "인천1호선","인천2호선","용인에버라인","의정부경전철","우이신설선","신림선","김포골드라인",
  "GTX-A(북부)","GTX-A(남부)",
]);
const SOUTH_GTX = new Set(["수서","성남","구성","동탄"]);

interface UpstreamRecord {
  from_direction?: unknown;
  to_direction?: unknown;
  alight_car?: unknown;
  alight_door?: unknown;
  board_car?: unknown;
  board_door?: unknown;
  seconds?: unknown;
}
interface UpstreamPair {
  station?: unknown;
  from_line?: unknown;
  to_line?: unknown;
  distance_m?: unknown;
  default_seconds?: unknown;
  records?: UpstreamRecord[];
}
interface UpstreamPayload {
  meta?: { version?: unknown };
  pairs?: Record<string, UpstreamPair>;
}

function lineName(raw: unknown, station: string): string {
  const text = String(raw ?? "").trim().replaceAll(" ", "");
  const aliases: Record<string, string> = {
    경의중앙: "경의중앙선", 경의선: "경의중앙선", 수인분당: "수인분당선",
    분당선: "수인분당선", 수인선: "수인분당선", 경춘: "경춘선", 경강: "경강선",
    서해: "서해선", 신분당: "신분당선", 공항: "공항철도", 용인경전철: "용인에버라인",
    에버라인: "용인에버라인", 의정부: "의정부경전철", 우이신설: "우이신설선",
    신림: "신림선", 김포골드: "김포골드라인", 김포도시철도: "김포골드라인",
  };
  if (aliases[text]) return aliases[text];
  if (/^[1-9]호선$/u.test(text)) return text;
  if (/^[1-9]$/u.test(text)) return `${text}호선`;
  if (text.toUpperCase() === "GTX-A") return SOUTH_GTX.has(station) ? "GTX-A(남부)" : "GTX-A(북부)";
  return text;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}

/**
 * Refresh upstream transfer fallbacks during the scheduled live DB job.
 * Seoul authoritative transfer_pair rows are already loaded, so INSERT OR IGNORE
 * guarantees upstream can only fill missing pairs. Upstream-provided duration is
 * copied directly; no distance/coordinate-derived duration is ever synthesized.
 */
export async function loadLiveUpstreamTransfers(db: Database): Promise<{ pairs: number; details: number; version: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let payload: UpstreamPayload;
  try {
    const response = await fetch(UPSTREAM_URL, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json() as UpstreamPayload;
  } catch (error) {
    console.warn(`[build:data] upstream transfer refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { pairs: 0, details: 0, version: "unavailable" };
  } finally {
    clearTimeout(timer);
  }

  const version = String(payload.meta?.version ?? "unknown");
  const pairInsert = db.prepare(`
    INSERT OR IGNORE INTO transfer_pair(station_id,from_line,to_line,distance_m,seconds,source)
    VALUES (?,?,?,?,?,?)
  `);
  const detailInsert = db.prepare(`
    INSERT INTO transfer_detail(
      station_id,from_line,to_line,from_direction,to_direction,
      alight_car,alight_door,board_car,board_door,seconds,source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  let pairs = 0;
  let details = 0;
  db.transaction(() => {
    for (const item of Object.values(payload.pairs ?? {})) {
      const station = cleanName(String(item.station ?? ""));
      const fromLine = lineName(item.from_line, station);
      const toLine = lineName(item.to_line, station);
      if (!station || !SUPPORTED.has(fromLine) || !SUPPORTED.has(toLine)) continue;
      const stationId = transferStationId(db, station, fromLine, toLine);
      const seconds = nullableNumber(item.default_seconds);
      if (!stationId || seconds === null || seconds < 0) continue;
      pairs += Number(pairInsert.run(
        stationId, fromLine, toLine, nullableNumber(item.distance_m), Math.round(seconds), `upstream-${version}`,
      ).changes || 0);
      for (const record of item.records ?? []) {
        detailInsert.run(
          stationId, fromLine, toLine,
          cleanName(String(record.from_direction ?? "").replace(/\s*방면$/u, "")),
          cleanName(String(record.to_direction ?? "").replace(/\s*방면$/u, "")),
          String(record.alight_car ?? ""), String(record.alight_door ?? ""),
          String(record.board_car ?? ""), String(record.board_door ?? ""),
          nullableNumber(record.seconds), `upstream-${version}`,
        );
        details += 1;
      }
    }
  })();
  buildSource(db, "upstream-transfer-live", UPSTREAM_URL, pairs + details,
    `version=${version}; Seoul pair rows remain authoritative; upstream seconds copied directly; no distance-derived duration`);
  return { pairs, details, version };
}
