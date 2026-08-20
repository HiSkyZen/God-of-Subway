/** Domain contracts shared by the Bun engine and its adapters. */

export type ServiceMode = "DAY" | "SAT" | "END" | "AUTO";
export type ResolvedMode = "DAY" | "SAT" | "END";
export type LineName =
  | "1호선" | "2호선" | "3호선" | "4호선" | "5호선" | "6호선" | "7호선" | "8호선" | "9호선"
  | "경의중앙선" | "수인분당선" | "경춘선" | "경강선" | "서해선" | "공항철도" | "신분당선"
  | "GTX-A(북부)" | "GTX-A(남부)";

export const EXTRA_LINES: readonly LineName[] = ["경의중앙선", "수인분당선", "경춘선", "경강선", "서해선", "공항철도", "신분당선", "GTX-A(북부)", "GTX-A(남부)"];
export const LINE_NAMES: readonly LineName[] = [
  "1호선", "2호선", "3호선", "4호선", "5호선", "6호선", "7호선", "8호선", "9호선", ...EXTRA_LINES,
];

export interface Stop { station: string; arr: number | null; dep: number | null; call: boolean; }
export interface Train {
  train_no: string; direction: string; service: string; start: string; dest: string; stops: Stop[];
  linked_train_no?: string; continuation_train_no?: string; train_numbers?: string[];
  continuation_station?: string; continuation_gap_seconds?: number; continuation_start_sec?: number;
  physical_continuation?: boolean; continuation_direction?: string;
}
export interface SegmentInput { line: string; from: string; to: string; transfer_walk?: number; transfer_seconds?: number; transfer_info?: TransferInfo | null; [key: string]: unknown; }
export interface PositionRow {
  subwayId?: string; subwayNm?: string; trainNo?: string; btrainNo?: string; statnNm?: string; statnTnm?: string;
  updnLine?: string; trainSttus?: string; recptnDt?: string; lastRecptnDt?: string; [key: string]: unknown;
}
export interface DelayObservation { train_no: string; direction: string; service: string; delay: number; current_station: string; status: string; observed: Date; ref: number; train: Train; raw: PositionRow; }
export interface Candidate {
  line: string; from: string; to: string; train_no: string; continuation_train_no: string; physical_continuation: boolean;
  service: string; direction: string; origin: string; destination: string; board_dt: Date; alight_dt: Date;
  wait_seconds: number; ride_seconds: number; delay_seconds: number; current_station: string; status: string;
  location_kind: "live" | "expected"; location_label: string; confidence: "높음" | "중간" | "낮음";
  method: string; projected: boolean; [key: string]: unknown;
}
export interface TransferInfo { station: string; seconds: number; distance_m: number | null; alight_position: string; board_position: string; from_direction: string; to_direction: string; matched: string; }
export interface PathEdge { from: [string, string]; to: [string, string]; kind: "ride" | "transfer" | "start" | "end"; weight: number; }
export interface Path { start: string; end: string; seconds: number; edges: PathEdge[]; }
export interface Diagnostics { positions: number; matched: number; unmatched_train: string[]; unmatched_station: string[]; matched_context?: number; realtime_available?: boolean; realtime_error?: string; realtime_query?: string; cache_state?: string; [key: string]: unknown; }
export interface PositionCacheEntry { rows: PositionRow[]; error: string; available: boolean; query?: string; cache_state?: string; }
export type PositionCache = Map<string, PositionCacheEntry | PositionRow[]> | Record<string, PositionCacheEntry | PositionRow[]>;
export interface CalculateRoutePayload { start_time?: string; day?: string; segments: SegmentInput[]; refresh_only?: boolean; baseline_minutes?: number | string | null; train_delay_cache?: unknown[]; [key: string]: unknown; }
export interface AutoRoutePayload { from: string; to: string; start_time?: string; day?: string; [key: string]: unknown; }
export interface LiveTripPayload { segments: SegmentInput[]; active_index?: number; boarded_train_no?: string; boarded_at?: string; day?: string; [key: string]: unknown; }
export interface RealtimeResult { ok: boolean; error?: { message: string } | string | null; data?: RealtimeEnvelope; }
export interface RealtimeEnvelope { RESULT?: { code?: string; message?: string }; realtimePositionList?: PositionRow[]; _jigeumta_query?: string; [key: string]: unknown; }
export interface EngineData {
  s1: { weekday: Record<string, RawTrain>; holiday: Record<string, RawTrain>; };
  s1Stations: string[];
  official: { meta?: { source?: string; version?: string; week_tags?: string[]; note?: string; [key: string]: unknown }; days?: Record<string, Record<string, Record<string, RawMetroTrain>>>; stations?: Record<string, string[]>; };
  extra: Record<string, { stations?: string[]; trains?: Record<string, Record<string, RawTrain>> }>;
  holidays: { dates?: Record<string, { name?: string }> };
  graph: { meta?: Record<string, unknown>; modes?: Record<string, unknown[]> };
  transfers: { pairs?: Record<string, RawTransfer> };
}
export interface RawTrain { direction?: string; service?: string; start?: string; dest?: string; linked_train_no?: string; stops?: Array<{ station?: string; arr?: number | null; dep?: number | null; call?: boolean }>; [key: string]: unknown; }
export type RawMetroTrain = [string, string | number, string, string, Array<[string, number | null, number | null]>];
export interface RawTransfer { station?: string; from_line?: string; to_line?: string; distance_m?: number | null; distance_seconds?: number | null; default_seconds?: number | null; records?: Array<Record<string, unknown>>; [key: string]: unknown; }
export interface PublicCandidate {
  train_no: string; continuation_train_no: string; physical_continuation: boolean; service: string; direction: string; origin: string; destination: string;
  board_dt: string | null; alight_dt: string | null; wait_seconds: number; ride_seconds: number; delay_seconds: number;
  current_station: string; status: string; location_kind: string; location_label: string; confidence: string; method: string; projected: boolean; live_detected: boolean; selected: boolean;
}
export type Serialized = Record<string, unknown>;
