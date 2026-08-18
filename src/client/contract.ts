/** Client-owned wire contracts. Field names intentionally mirror the Python API. */
export type ServiceMode = "AUTO" | "DAY" | "SAT" | "END";
export type Confidence = "높음" | "중간" | "낮음" | string;

export interface TransferInfo {
  from_line?: string;
  to_line?: string;
  station?: string;
  walking_seconds?: number;
  [key: string]: unknown;
}

export interface RouteSegmentInput {
  line: string;
  from: string;
  to: string;
  transfer_walk?: number;
  transfer_seconds?: number;
  transfer_info?: TransferInfo | null;
}

export interface RouteSegment extends RouteSegmentInput {
  index?: number;
  train_no?: string | number;
  origin?: string;
  destination?: string;
  service?: string;
  confidence?: Confidence;
  delay_seconds?: number;
  board_dt?: string;
  alight_dt?: string;
  arrived?: boolean;
  current_station?: string;
  current_station_name?: string;
  direction?: string;
  location?: string;
  nearby_candidates?: RouteSegment[];
  previous_candidate?: RouteSegment | null;
  transfer_info?: TransferInfo | null;
  [key: string]: unknown;
}

export interface RouteRequest {
  start_time: string;
  baseline_minutes?: string | number | null;
  day: ServiceMode;
  segments: RouteSegmentInput[];
  refresh_only?: boolean;
}

export interface AutoRouteRequest {
  from: string;
  to: string;
  start_time: string;
  baseline_minutes?: string | number | null;
  day: ServiceMode;
}

export interface TripUpdateRequest {
  segments: RouteSegmentInput[];
  active_index: number;
  boarded_train_no: string;
  boarded_at: string | null;
  day: ServiceMode;
  baseline_minutes?: string | number | null;
}

export interface ApiEnvelope {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface HealthResponse extends ApiEnvelope {
  today_service_mode: ServiceMode;
  today_service_reason: string;
  today_is_holiday: boolean;
}

export interface StationsResponse extends ApiEnvelope {
  stations: Record<string, string[]>;
}

export interface PushPublicKeyResponse extends ApiEnvelope {
  capable: boolean;
  subscription_capable?: boolean;
  arrival_alert_capable?: boolean;
  scheduler_mode?: string;
  public_key: string | null;
}

export interface PushSubscriptionSaveResponse extends ApiEnvelope {
  capable: boolean;
  endpoint: string;
  management_token: string;
}

export interface PushAlertRequest {
  subscription_endpoint: string;
  management_token: string;
  destination: string;
  threshold_seconds: number;
  trip_payload: TripUpdateRequest;
  expires_at?: string;
}

export interface PushAlertResponse extends ApiEnvelope {
  capable: boolean;
  alert_id: string;
  threshold_seconds: number;
  expires_at?: string;
  status_url?: string;
  notification_tag?: string;
}

export interface PushAlertStatusRequest {
  alert_id: string;
  subscription_endpoint: string;
  management_token: string;
}

export interface PushAlertStatusResponse extends ApiEnvelope {
  capable: boolean;
  alert_id: string;
  active: boolean;
  status: "active" | "missing";
  expires_at: string | null;
  notification_tag: string;
}

export interface RouteResponse extends ApiEnvelope {
  from?: string;
  to?: string;
  start_time?: string;
  arrival_time: string;
  calculated_at?: string;
  updated_at?: string;
  total_seconds?: number;
  estimated_total_seconds?: number;
  remaining_seconds?: number;
  route_seconds?: number;
  estimated_arrival_time?: string;
  service_mode?: ServiceMode;
  service_mode_reason?: string;
  segments: RouteSegment[];
  warnings?: string[];
  positions?: number;
  matched?: number;
  transfer_count?: number;
  [key: string]: unknown;
}

export interface AutoRouteResponse extends RouteResponse {
  alternatives?: RouteResponse[];
  transfer_count?: number;
}

export interface TripUpdateResponse extends RouteResponse {
  active_index: number;
  boarded_train_no: string;
  current_segment_remaining_seconds: number;
}

export interface FavoriteRoute {
  id: string;
  name: string;
  segments: RouteSegmentInput[];
  day: ServiceMode;
}

export interface BoardEvent {
  at: string;
  segment_index: number;
  line: string;
  from: string;
  to: string;
  boarded_train_no: string;
  recommended_train_no: string;
  matches_recommendation: boolean;
  recommendation_confidence: Confidence;
  recommendation_delay_seconds: number;
  recommendation_eta: string;
}

export interface EtaEvent {
  at: string;
  kind: string;
  eta: string;
  remaining_seconds: number;
  quality: Confidence;
  segments: RouteSegment[];
}

export interface ExperimentRecord {
  id: string;
  fingerprint: string;
  created_at: string;
  completed_at: string | null;
  excluded: boolean;
  from: string;
  to: string;
  planned_platform_arrival: string;
  day_requested: ServiceMode;
  service_mode: string;
  service_mode_reason: string;
  route_segments: RouteSegmentInput[];
  route_text: string;
  transfer_count: number;
  baseline_minutes: number | null;
  baseline_arrival: string | null;
  initial_eta: string | null;
  initial_total_seconds: number | null;
  initial_quality: Confidence;
  initial_predictions: RouteSegment[];
  last_eta: string | null;
  final_eta?: string | null;
  last_quality: Confidence;
  board_events: BoardEvent[];
  eta_events: EtaEvent[];
  actual_arrival: string | null;
  note: string;
}

export type TripPhase = "ride" | "transfer" | "waiting" | "done";

export interface LiveTripState {
  activeIndex: number;
  phase: TripPhase;
  boardedTrainNo: string;
  boardedAt: string | null;
  trackingStartedAt: string;
  platformStart: string | null;
  segments: RouteSegmentInput[];
  day: ServiceMode;
  baseline: string | number | null;
  previousNextTrain: string | null;
  displaySegments: RouteSegment[];
  transferEndsAt: string | null;
  journeyStartedAt: string;
}
