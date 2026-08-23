import { canonStation } from "./timetable-service";

export type TransferMode = "same-platform" | "cross-platform" | "passage" | "branch" | "estimated";
export type TransferSource = "upstream" | "official" | "web-verified" | "model" | "timetable";

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

const samePlatform = (note: string): TransferPolicyOverride => ({ seconds: 15, mode: "same-platform", source: "web-verified", note });
const crossPlatform = (note: string): TransferPolicyOverride => ({ seconds: 30, mode: "cross-platform", source: "web-verified", note });
const passage = (seconds: number, note: string): TransferPolicyOverride => ({ seconds, mode: "passage", source: "web-verified", note });

/**
 * Physical interchange topology only. These values are minimum walking / door
 * change allowances, not route preferences: actual connection waiting time is
 * evaluated from the timetable after the candidate interchange station is chosen.
 */
const OVERRIDES = new Map<string, TransferPolicyOverride>([
  ...pair("능곡", "경의중앙선", "서해선", passage(180, "경의중앙선·서해선 승강장 분리; 환승통로 이동 필요")),
  ...pair("대곡", "경의중앙선", "서해선", crossPlatform("같은 진행방향은 맞은편 평면환승 가능; 운행계통·대기시간은 시간표로 평가")),
  ...["곡산", "백마", "풍산", "일산"].flatMap((station) => pair(station, "경의중앙선", "서해선", samePlatform(`${station} 공용 선로·승강장; 실제 다음 열차 대기시간을 별도 평가`))),

  ...["청량리", "회기", "중랑", "상봉"].flatMap((station) => pair(station, "경의중앙선", "경춘선", samePlatform("중앙선 공용 선로·동일 진행방향 승강장"))),
  ...["왕십리", "청량리"].flatMap((station) => pair(station, "경의중앙선", "수인분당선", samePlatform("중앙선 공용 선로·동일 진행방향 승강장"))),

  ...["한대앞", "중앙", "고잔", "초지", "신길온천", "정왕"].flatMap((station) => pair(station, "4호선", "수인분당선", samePlatform(`${station} 안산선 공용 선로·동일 진행방향 승강장`))),
  ...pair("안산", "4호선", "수인분당선", crossPlatform("안산 종착 4호선 편성의 별도 홈 가능; 실제 종착·후속열차 시각을 함께 평가")),
  ...pair("오이도", "4호선", "수인분당선", crossPlatform("방향별 평면환승 가능하나 두 계통 시종착·착발순서가 달라 실제 대기시간을 함께 평가")),
  ...pair("금정", "1호선", "4호선", crossPlatform("동일 방향 평면환승")),

  ...pair("대곡", "GTX-A(북부)", "3호선", { seconds: 270, mode: "passage", source: "web-verified", note: "GTX-A 승강장→3호선 승강장 현장 측정 약 4분30초" }),
  ...pair("대곡", "GTX-A(북부)", "경의중앙선", { seconds: 320, mode: "passage", source: "web-verified", note: "GTX-A 승강장→경의중앙선 승강장 현장 측정 약 5분20초" }),
  ...pair("대곡", "GTX-A(북부)", "서해선", { seconds: 330, mode: "passage", source: "model", note: "GTX-A와 서해선 별도 승강장 구조 기준 보수 추정" }),
  ...pair("연신내", "GTX-A(북부)", "3호선", { seconds: 330, mode: "passage", source: "model", note: "GTX-A 대심도 승강장과 3호선 수직 환승 구조 기준 추정" }),
  ...pair("연신내", "GTX-A(북부)", "6호선", { seconds: 300, mode: "passage", source: "model", note: "GTX-A와 6호선 연결 구조 기준 추정" }),
  ...pair("서울역", "GTX-A(북부)", "1호선", { seconds: 247, mode: "passage", source: "model", note: "GTX-A↔1호선 환승통로 보수 추정" }),
  ...pair("서울역", "GTX-A(북부)", "4호선", { seconds: 300, mode: "passage", source: "model", note: "GTX-A 서울역 환승대합실·4호선 연결 동선 기준 추정" }),
  ...pair("서울역", "GTX-A(북부)", "경의중앙선", { seconds: 360, mode: "passage", source: "model", note: "GTX-A 서울역과 경의중앙선 승강장 간 장거리 이동 추정" }),
  ...pair("서울역", "GTX-A(북부)", "공항철도", { seconds: 360, mode: "passage", source: "model", note: "GTX-A 서울역과 공항철도 승강장 간 장거리 이동 추정" }),

  ...pair("수서", "GTX-A(남부)", "3호선", { seconds: 210, mode: "passage", source: "model", note: "GTX-A 수서역↔3호선 환승통로 기준 추정" }),
  ...pair("수서", "GTX-A(남부)", "수인분당선", { seconds: 253, mode: "passage", source: "model", note: "GTX-A 수서역↔수인분당선 환승통로 기준 추정" }),
  ...pair("성남", "GTX-A(남부)", "경강선", { seconds: 180, mode: "passage", source: "model", note: "GTX-A 성남역↔경강선 환승통로 기준 추정" }),
  ...pair("구성", "GTX-A(남부)", "수인분당선", { seconds: 180, mode: "passage", source: "model", note: "GTX-A 구성역↔수인분당선 환승통로 기준 추정" }),
]);

const HUB_DEMAND: Record<string, number> = {
  강남: 1, 잠실: 1, 홍대입구: 0.96, 서울역: 1, 고속터미널: 0.96, 신도림: 0.94,
  사당: 0.92, 교대: 0.86, 건대입구: 0.84, 종로3가: 0.84, 동대문역사문화공원: 0.84,
  여의도: 0.88, 왕십리: 0.82, 청량리: 0.82, 대곡: 0.72, 김포공항: 0.84, 수서: 0.78,
};

export function transferOverride(station: string, fromLine: string, toLine: string): TransferPolicyOverride | null {
  return OVERRIDES.get(key(station, fromLine, toLine)) ?? null;
}

export interface SharedTrackInterchange { station: string; fromLine: string; toLine: string; }

export const SHARED_TRACK_INTERCHANGES: readonly SharedTrackInterchange[] = [
  ...["능곡", "대곡", "곡산", "백마", "풍산", "일산"].map((station) => ({ station, fromLine: "경의중앙선", toLine: "서해선" })),
  ...["한대앞", "중앙", "고잔", "초지", "안산", "신길온천", "정왕", "오이도"].map((station) => ({ station, fromLine: "4호선", toLine: "수인분당선" })),
  ...["청량리", "회기", "중랑", "상봉"].map((station) => ({ station, fromLine: "경의중앙선", toLine: "경춘선" })),
  ...["왕십리", "청량리"].map((station) => ({ station, fromLine: "경의중앙선", toLine: "수인분당선" })),
] as const;

export interface PhysicalTransferEntry {
  station: string;
  fromLine: string;
  toLine: string;
  policy: TransferPolicyOverride;
}

export function physicalTransferEntries(): PhysicalTransferEntry[] {
  return [...OVERRIDES.entries()].map(([raw, policy]) => {
    const [station, fromLine, toLine] = raw.split("|");
    return { station, fromLine, toLine, policy };
  });
}

export function modeledMissingTransferSeconds(
  _distanceM: number | null | undefined,
  _station = "",
  _fromLine = "",
  _toLine = "",
  _lineCount = 2,
): number {
  return 180;
}

function minutes(date: Date): number { return date.getUTCHours() * 60 + date.getUTCMinutes(); }
function ramp(value: number, start: number, peakStart: number, peakEnd: number, end: number): number {
  if (value < start || value > end) return 0;
  if (value >= peakStart && value <= peakEnd) return 1;
  const linear = value < peakStart
    ? (value - start) / Math.max(1, peakStart - start)
    : (end - value) / Math.max(1, end - peakEnd);
  return 0.15 + Math.max(0, Math.min(1, linear)) * 0.85;
}

export function transferLoadEstimate(station: string, at: Date, lineCount = 2): TransferLoadEstimate {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return { multiplier: 1, peakIntensity: 0, stationDemand: 0, predictedLoad: 0, label: "평시" };
  const minute = minutes(at);
  const morning = ramp(minute, 6 * 60 + 50, 7 * 60 + 30, 8 * 60 + 50, 9 * 60 + 30);
  const evening = ramp(minute, 16 * 60 + 50, 17 * 60 + 40, 19 * 60 + 10, 19 * 60 + 30);
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

export function directionalTransferOverride(
  station: string,
  fromLine: string,
  toLine: string,
  incomingNext: string,
  outgoingNext: string,
): TransferPolicyOverride | null {
  const base = transferOverride(station, fromLine, toLine);
  if (!base) return null;
  const incoming = canonStation(incomingNext);
  const outgoing = canonStation(outgoingNext);
  if (!incoming || !outgoing || incoming === outgoing) return base;
  if (base.mode === "same-platform") {
    return { seconds: 90, mode: "passage", source: "web-verified", note: `${base.note}; 반대방향/분기 변경으로 승강장 통로 이동` };
  }
  if (base.mode === "cross-platform") {
    return { seconds: Math.max(60, base.seconds), mode: "passage", source: "web-verified", note: `${base.note}; 반대방향/분기 변경은 평면환승이 아니므로 통로 이동` };
  }
  return base;
}
