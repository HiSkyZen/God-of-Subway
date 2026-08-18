import { useState } from "react";
import type { ReactElement } from "react";
import type { AutoRouteResponse, LiveTripState, RouteSegment } from "./contract";
import { formatDuration } from "./pure";

function clock(value?: string | null): string {
  if (!value) return "--:--";
  const match = String(value).match(/(\d{2}):(\d{2})(?::\d{2})?$/);
  return match ? `${match[1]}:${match[2]}` : String(value);
}

function lineClass(line: string): string { return line.replace(/[^0-9A-Za-z가-힣]/g, ""); }
function confidence(segments: RouteSegment[]): string {
  if (segments.some((segment) => segment.confidence === "낮음")) return "낮음";
  if (segments.some((segment) => segment.confidence === "중간")) return "중간";
  return "높음";
}
function seconds(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}
function transferSeconds(segment: RouteSegment): number {
  const info = segment.transfer_info || {};
  const walkingMinutes = Number(segment.transfer_walk);
  return seconds(segment.transfer_seconds) || seconds(info.seconds) || seconds(info.walking_seconds) || (Number.isFinite(walkingMinutes) && walkingMinutes > 0 ? Math.round(walkingMinutes * 60) : 0);
}
function transferText(segment: RouteSegment): string {
  const value = transferSeconds(segment);
  if (!value) return "환승 시간 정보 없음";
  const minutes = Math.floor(value / 60); const rest = value % 60;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}
function infoText(value: unknown): string { return typeof value === "string" && value.trim() ? value.trim() : ""; }
function candidateKey(candidate: RouteSegment): string { return String(candidate.train_no ?? "").trim(); }
function alternateCandidates(segment: RouteSegment): RouteSegment[] {
  const current = String(segment.train_no ?? "").trim();
  const raw = [segment.previous_candidate, ...(Array.isArray(segment.nearby_candidates) ? segment.nearby_candidates : [])]
    .filter((candidate): candidate is RouteSegment => Boolean(candidate && candidate.train_no));
  const seen = new Set<string>();
  const result: RouteSegment[] = [];
  for (const candidate of raw) {
    const key = candidateKey(candidate);
    if (!key || key === current || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result.slice(0, 8);
}

export function UpstreamJourneyView({
  result,
  segments,
  arrivalTime,
  totalSeconds,
  activeIndex,
  liveTrip,
  onBoard,
  onRefresh,
  onExcludeGtx,
}: {
  result: AutoRouteResponse;
  segments: RouteSegment[];
  arrivalTime?: string;
  totalSeconds: number;
  activeIndex: number;
  liveTrip: LiveTripState | null;
  onBoard: (index: number, trainNo: string | number) => void;
  onRefresh: () => void;
  onExcludeGtx: () => void;
}): ReactElement {
  const [candidateIndex, setCandidateIndex] = useState<number | null>(null);
  const first = segments[0]; const last = segments.at(-1);
  const from = first?.from || result.from || "출발역";
  const to = last?.to || result.to || "도착역";
  const transferCount = result.transfer_count ?? Math.max(0, segments.length - 1);
  const hasGtx = segments.some((segment) => segment.line.startsWith("GTX-A"));
  return <>
    <section className="route-overview" aria-live="polite">
      <div className="route-overview-main"><span className="route-kicker">추천 경로</span><h1><strong>{from}</strong><span>→</span><strong>{to}</strong></h1><p>환승 {transferCount}회 · 총 {formatDuration(totalSeconds)} · 신뢰도 {confidence(segments)}</p></div>
      <div className="route-arrival"><span>예상 도착</span><strong>{clock(arrivalTime)}</strong><div className="route-overview-actions"><button type="button" onClick={onRefresh}>새로고침</button>{hasGtx && <button type="button" className="exclude-gtx" onClick={onExcludeGtx}>GTX-A 제외하기</button>}</div></div>
    </section>
    <section className="route-timeline" aria-label={`${from}에서 ${to}까지 이동 경로`}>
      <TimelineStation kind="origin" time={clock(first?.board_dt || result.start_time)} station={from} label="출발" />
      {segments.map((segment, index) => {
        const next = segments[index + 1];
        const trainNo = segment.train_no;
        const tracking = Boolean(liveTrip?.phase === "ride" && liveTrip.activeIndex === index);
        const transfer = index < segments.length - 1;
        const info = segment.transfer_info || {};
        const alightPosition = infoText(info.alight_position);
        const boardPosition = infoText(info.board_position);
        const candidates = alternateCandidates(segment);
        const choosing = candidateIndex === index;
        return <div className="timeline-section" key={`${segment.line}-${segment.from}-${segment.to}-${index}`}>
          <article className={`ride-card ${index === activeIndex ? "active" : ""}`}>
            <div className="ride-line"><span className={`line-tag line-${lineClass(segment.line)}`}>{segment.line}</span><strong>{segment.destination ? `${segment.destination} 방면` : segment.direction || "운행 방향 확인"}</strong></div>
            <div className="ride-times"><span><b>{clock(segment.board_dt)}</b> {segment.from} 승차</span><span className="ride-arrow">→</span><span><b>{clock(segment.alight_dt)}</b> {segment.to} 하차</span></div>
            <div className="ride-meta"><span>열차 <b>{trainNo || "열차 없음"}</b></span><span>현재 위치 <b>{segment.current_station_name || segment.current_station || segment.location || "확인 중"}</b></span><span>지연 <b>{Math.abs(Number(segment.delay_seconds) || 0) < 30 ? "정시권" : `${Number(segment.delay_seconds) >= 0 ? "+" : "−"}${Math.round(Math.abs(Number(segment.delay_seconds)) / 60)}분`}</b></span><span>신뢰도 <b>{segment.confidence || "낮음"}</b></span></div>
            {trainNo && <div className="ride-actions"><button type="button" className="primary-button" disabled={tracking && String(liveTrip?.boardedTrainNo) === String(trainNo)} onClick={() => onBoard(index, trainNo)}>{tracking && String(liveTrip?.boardedTrainNo) === String(trainNo) ? "✓ 탑승 추적 중" : "이 열차를 탔어요"}</button>{candidates.length > 0 && <button type="button" className="secondary-button" aria-expanded={choosing} onClick={() => setCandidateIndex(choosing ? null : index)}>다른 열차를 탔어요</button>}</div>}
            {choosing && candidates.length > 0 && <div className="train-choice-panel" aria-label="주변 열차 선택">{candidates.map((candidate) => <button type="button" className="train-choice" key={candidateKey(candidate)} onClick={() => { onBoard(index, candidate.train_no as string | number); setCandidateIndex(null); }}><strong>{candidate.train_no}열차</strong><span>{clock(candidate.board_dt)} 승차{candidate.current_station ? ` · ${candidate.current_station}` : ""}</span></button>)}</div>}
          </article>
          {transfer && <div className="transfer-block">
            <div className="transfer-time"><strong>{clock(segment.alight_dt)}</strong><span>환승</span></div>
            <div className="transfer-marker" />
            <div className="transfer-copy"><div className="transfer-heading"><strong>{segment.to}</strong><span>{segment.line} → {next?.line || "다음 노선"}</span></div><div className="transfer-duration">환승 {transferText(segment)}</div><div className="transfer-detail">{alightPosition && <span>내릴 문 <b>{alightPosition}</b></span>}{boardPosition && <span>탈 문 <b>{boardPosition}</b></span>}{!alightPosition && !boardPosition && <span>환승 위치 정보 없음</span>}</div></div>
          </div>}
        </div>;
      })}
      <TimelineStation kind="destination" time={clock(last?.alight_dt || arrivalTime)} station={to} label="도착" />
    </section>
  </>;
}

function TimelineStation({ kind, time, station, label }: { kind: "origin" | "destination"; time: string; station: string; label: string }): ReactElement {
  return <div className={`timeline-station ${kind}`}><div className="timeline-station-time"><strong>{time}</strong><span>{label}</span></div><div className="timeline-station-marker" /><div className="timeline-station-copy"><strong>{station}</strong><span>{kind === "origin" ? "여정 시작" : "최종 목적지"}</span></div></div>;
}
