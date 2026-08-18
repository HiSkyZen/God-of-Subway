import type { Confidence, ExperimentRecord, RouteSegment, ServiceMode } from "./contract";

export const CHOSEONG = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"] as const;

export function stationInitials(text: string): string {
  return [...String(text || "").normalize("NFC")].map((ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) return CHOSEONG[Math.floor((code - 0xac00) / 588)];
    return ch;
  }).join("");
}

export function stationMatches(name: string, query: string): boolean {
  const q = String(query || "").trim().normalize("NFC");
  if (!q) return false;
  const n = String(name || "").trim().normalize("NFC");
  if (/^[ㄱ-ㅎ]+$/.test(q)) return stationInitials(n).startsWith(q);
  return n.toLocaleLowerCase("ko-KR").startsWith(q.toLocaleLowerCase("ko-KR"));
}

export function parseServiceModeSelection(value: string): ServiceMode {
  return value === "DAY" || value === "SAT" || value === "END" ? value : "AUTO";
}

export function parseLocalDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
}

export function localDateTimeString(date: Date): string {
  const p = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function minutesDiff(a: string | null | undefined, b: string | null | undefined): number | null {
  const da = parseLocalDateTime(a);
  const db = parseLocalDateTime(b);
  return da && db ? (da.getTime() - db.getTime()) / 60000 : null;
}

export function addMinutesToDateTime(value: string | null | undefined, minutes: number | null | undefined): string | null {
  const date = parseLocalDateTime(value);
  if (!date || minutes == null || !Number.isFinite(minutes)) return null;
  date.setMinutes(date.getMinutes() + minutes);
  return localDateTimeString(date);
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(Math.max(0, Number(seconds) || 0) / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? "");
}

export function compactSegments(segments: RouteSegment[]): RouteSegment[] {
  return (segments || []).map((segment, index) => ({
    index,
    line: segment.line,
    from: segment.from,
    to: segment.to,
    train_no: segment.train_no || "",
    origin: segment.origin || "",
    destination: segment.destination || "",
    service: segment.service || "",
    confidence: segment.confidence || "",
    delay_seconds: Number(segment.delay_seconds) || 0,
    board_dt: segment.board_dt || "",
    alight_dt: segment.alight_dt || "",
  }));
}

export function experimentQuality(segments: RouteSegment[]): Confidence {
  const rank: Record<string, number> = { 높음: 3, 중간: 2, 낮음: 1 };
  return (segments || []).reduce<Confidence>((quality, segment) => {
    const current = String(segment.confidence || "낮음");
    return (rank[current] || 0) < (rank[String(quality)] || 0) ? current : quality;
  }, "높음");
}

export interface ExperimentMetricSummary {
  initial_error_min: number | null;
  final_error_min: number | null;
  baseline_error_min: number | null;
  error_gain_min: number | null;
  error_reduction_pct: number | null;
  first_platform_wait_min: number | null;
  recommendation_match_rate: number | null;
}

export function experimentMetrics(experiment: ExperimentRecord): ExperimentMetricSummary {
  if (!experiment.completed_at || !experiment.actual_arrival) return { initial_error_min: null, final_error_min: null, baseline_error_min: null, error_gain_min: null, error_reduction_pct: null, first_platform_wait_min: null, recommendation_match_rate: null };
  const absolute = (value: number | null): number | null => value == null ? null : Math.abs(value);
  const initialError = absolute(minutesDiff(experiment.actual_arrival, experiment.initial_eta));
  const finalEta = experiment.final_eta ?? experiment.last_eta;
  const finalError = absolute(minutesDiff(experiment.actual_arrival, finalEta));
  const baselineError = absolute(minutesDiff(experiment.actual_arrival, experiment.baseline_arrival));
  const firstBoard = experiment.board_events.slice().sort((a, b) => a.at.localeCompare(b.at))[0];
  const wait = firstBoard ? Math.max(0, minutesDiff(firstBoard.at, experiment.planned_platform_arrival) ?? 0) : null;
  const recommendations = experiment.board_events.filter((event) => Boolean(event.recommended_train_no));
  const matchRate = recommendations.length ? recommendations.filter((event) => event.matches_recommendation).length / recommendations.length : null;
  const gain = baselineError != null && initialError != null ? baselineError - initialError : null;
  return { initial_error_min: initialError, final_error_min: finalError, baseline_error_min: baselineError, error_gain_min: gain, error_reduction_pct: gain != null && baselineError != null && baselineError > 0 ? gain / baselineError * 100 : null, first_platform_wait_min: wait, recommendation_match_rate: matchRate };
}

export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function experimentsToJson(experiments: ExperimentRecord[]): string {
  return JSON.stringify(experiments, null, 2);
}

export function experimentsToCsv(experiments: ExperimentRecord[]): string {
  const head = ["experiment_id", "created_at", "completed_at", "from", "to", "route", "transfer_count", "initial_eta", "actual_arrival", "initial_quality", "baseline_minutes"].join(",");
  const rows = experiments.map((experiment) => [experiment.id, experiment.created_at, experiment.completed_at, experiment.from, experiment.to, experiment.route_text, experiment.transfer_count, experiment.initial_eta, experiment.actual_arrival, experiment.initial_quality, experiment.baseline_minutes].map(csvCell).join(","));
  return [head, ...rows].join("\r\n");
}
