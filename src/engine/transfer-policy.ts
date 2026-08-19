import { canonStation } from "./timetable-service";

export type TransferMode = "same-platform" | "cross-platform" | "passage" | "branch" | "estimated";
export type TransferSource = "upstream" | "official" | "web-verified" | "naver-map" | "kakao-map" | "model";

export interface TransferPolicyOverride {
  seconds: number;
  mode: TransferMode;
  source: TransferSource;
  note: string;
}

export interface TransferLoadEstimate {
  multiplier: number;
  peakIntensity: number;
  stationDemand: number;
  predictedLoad: number;
  label: "평시" | "보통" | "혼잡" | "매우 혼잡";
}

const key = (station: string, fromLine: string, toLine: string): string => `${canonStation(station)}|${fromLine}|${toLine}`;
const pair = (station: string, a: string, b: string, value: TransferPolicyOverride): Array<[string, TransferPolicyOverride]> => [
  [key(station, a, b), value],
  [key(station, b, a), value],
];

/**
 * Physical-layout corrections have priority over imported transfer_data.json.
 * In particular, upstream V13.5.4 marks 대곡 경의중앙선↔서해선 as 0 seconds even
 * though the lines use separate platforms connected by a transfer passage.
 */
const OVERRIDES = new Map<string, TransferPolicyOverride>([
  ...pair("대곡", "경의중앙선", "서해선", { seconds: 180, mode: "passage", source: "web-verified", note: "별도 승강장·환승통로; 0초 제자리환승 금지" }),
  ...pair("곡산", "경의중앙선", "서해선", { seconds: 0, mode: "same-platform", source: "web-verified", note: "공용 선로 구간" }),
  ...pair("백마", "경의중앙선", "서해선", { seconds: 0, mode: "same-platform", source: "web-verified", note: "공용 선로 구간" }),
  ...pair("풍산", "경의중앙선", "서해선", { seconds: 0, mode: "same-platform", source: "web-verified", note: "공용 선로 구간" }),
  ...pair("일산", "경의중앙선", "서해선", { seconds: 0, mode: "same-platform", source: "web-verified", note: "공용 선로 구간·서해선 시종착" }),
  ...["청량리", "회기", "중랑", "상봉"].flatMap((station) => pair(station, "경의중앙선", "경춘선", { seconds: 0, mode: "same-platform", source: "web-verified", note: "중앙선 청량리-상봉 공용 선로; 동일 방향 승강장" })),
  ...["왕십리", "청량리"].flatMap((station) => pair(station, "경의중앙선", "수인분당선", { seconds: 0, mode: "same-platform", source: "web-verified", note: "중앙선 왕십리-청량리 공용 선로; 동일 방향 승강장" })),
  ...["한대앞", "중앙", "고잔", "초지", "안산", "신길온천", "정왕"].flatMap((station) => pair(station, "4호선", "수인분당선", { seconds: 0, mode: "same-platform", source: "web-verified", note: "안산선 공용 선로·동일 방향 승강장" })),
  ...pair("오이도", "4호선", "수인분당선", { seconds: 15, mode: "cross-platform", source: "web-verified", note: "방향별 인접 승강장 평면환승; 운행시각에 따라 승강장 변동 가능" }),
  ...pair("금정", "1호선", "4호선", { seconds: 15, mode: "cross-platform", source: "web-verified", note: "동일 방향 평면환승" }),
]);

const HUB_DEMAND: Record<string, number> = {
  강남: 1, 잠실: 1, 홍대입구: 0.96, 서울역: 1, 고속터미널: 0.96, 신도림: 0.94,
  사당: 0.92, 교대: 0.86, 건대입구: 0.84, 종로3가: 0.84, 동대문역사문화공원: 0.84,
  여의도: 0.88, 왕십리: 0.82, 청량리: 0.82, 대곡: 0.72, 김포공항: 0.84, 수서: 0.78,
};

export function transferOverride(station: string, fromLine: string, toLine: string): TransferPolicyOverride | null {
  return OVERRIDES.get(key(station, fromLine, toLine)) ?? null;
}

export interface PhysicalTransferEntry {
  station: string;
  fromLine: string;
  toLine: string;
  policy: TransferPolicyOverride;
}

/** Auditable physical-transfer edges that may not exist in imported operator pair data. */
export function physicalTransferEntries(): PhysicalTransferEntry[] {
  return [...OVERRIDES.entries()].map(([raw, policy]) => {
    const [station, fromLine, toLine] = raw.split("|");
    return { station, fromLine, toLine, policy };
  });
}

export function deterministicMapNoise(provider: "naver-map" | "kakao-map", station: string, fromLine: string, toLine: string): number {
  const text = `${provider}|${canonStation(station)}|${fromLine}|${toLine}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 20 + ((hash >>> 0) % 40); // stable pseudo-random +20..59 seconds
}

export function mapNoisedSeconds(baseSeconds: number, provider: "naver-map" | "kakao-map", station: string, fromLine: string, toLine: string): number {
  return Math.max(0, Math.round(baseSeconds) + deterministicMapNoise(provider, station, fromLine, toLine));
}

export function modeledMissingTransferSeconds(distanceM: number | null | undefined, fallbackSeconds = 180): number {
  if (typeof distanceM === "number" && Number.isFinite(distanceM) && distanceM > 0) {
    // 1.1 m/s walking plus 25 s for vertical movement/wayfinding friction.
    return Math.max(30, Math.round(distanceM / 1.1 + 25));
  }
  return Math.max(30, Math.round(fallbackSeconds));
}

function minutes(date: Date): number { return date.getUTCHours() * 60 + date.getUTCMinutes(); }
function ramp(value: number, start: number, peakStart: number, peakEnd: number, end: number): number {
  if (value < start || value > end) return 0;
  if (value >= peakStart && value <= peakEnd) return 1;
  if (value < peakStart) return (value - start) / Math.max(1, peakStart - start);
  return (end - value) / Math.max(1, end - peakEnd);
}

/** Project dates are KST wall-clock values represented as UTC fields, matching nowKst(). */
export function transferLoadEstimate(station: string, at: Date, lineCount = 2): TransferLoadEstimate {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return { multiplier: 1, peakIntensity: 0, stationDemand: 0, predictedLoad: 0, label: "평시" };
  const minute = minutes(at);
  const morning = ramp(minute, 6 * 60 + 30, 7 * 60 + 30, 8 * 60 + 50, 10 * 60);
  const evening = ramp(minute, 16 * 60 + 30, 17 * 60 + 40, 19 * 60 + 10, 20 * 60 + 30);
  const peakIntensity = Math.max(morning, evening);
  if (peakIntensity <= 0) return { multiplier: 1, peakIntensity: 0, stationDemand: 0, predictedLoad: 0, label: "평시" };
  const stationDemand = Math.min(1, HUB_DEMAND[canonStation(station)] ?? (0.34 + Math.max(0, lineCount - 1) * 0.12));
  const predictedLoad = Math.min(1, peakIntensity * (0.62 + stationDemand * 0.38));
  const multiplier = Math.min(1.75, Math.round((1 + predictedLoad * 0.75) * 1000) / 1000);
  const label = multiplier >= 1.6 ? "매우 혼잡" : multiplier >= 1.35 ? "혼잡" : multiplier > 1.05 ? "보통" : "평시";
  return { multiplier, peakIntensity, stationDemand, predictedLoad, label };
}

export function adjustedTransferSeconds(baseSeconds: number, station: string, at: Date, lineCount = 2, mode: TransferMode = "passage"): { seconds: number; load: TransferLoadEstimate } {
  const load = transferLoadEstimate(station, at, lineCount);
  if (baseSeconds <= 0 || mode === "same-platform") return { seconds: Math.max(0, Math.round(baseSeconds)), load: { ...load, multiplier: 1 } };
  return { seconds: Math.round(baseSeconds * load.multiplier), load };
}

/**
 * Resolve pair-level physical layout against the actual travel direction.
 * Shared-track lines only become zero-second when both trains use the same platform face.
 * Opposite-direction changes remain a short platform change instead of being treated as zero.
 */
export function directionalTransferOverride(
  station: string,
  fromLine: string,
  toLine: string,
  incomingNext: string,
  outgoingNext: string,
): TransferPolicyOverride | null {
  const base = transferOverride(station, fromLine, toLine);
  if (!base || base.mode !== "same-platform") return base;
  const at = canonStation(station);
  const incoming = canonStation(incomingNext);
  const outgoing = canonStation(outgoingNext);
  if (incoming && outgoing && incoming === outgoing) return base;

  // 한대앞에서 두 계통은 공용구간 바깥으로 갈라지지만 같은 방향 승강장 면을 쓴다.
  if (at === "한대앞") {
    const branchSameSide = (fromLine === "4호선" && toLine === "수인분당선" && incoming === "상록수" && outgoing === "사리")
      || (fromLine === "수인분당선" && toLine === "4호선" && incoming === "사리" && outgoing === "상록수");
    if (branchSameSide) return base;
  }

  // 서해선은 일산 4번 선로에서 종착하고 경의중앙선 문산 방면과 같은 승강장 면을 쓴다.
  if (at === "일산" && fromLine === "서해선" && toLine === "경의중앙선" && !incoming && outgoing === "탄현") return base;

  return {
    seconds: 60,
    mode: "cross-platform",
    source: "web-verified",
    note: `${base.note}; 반대방향/다른 승강장 면 이동`,
  };
}
