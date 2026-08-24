import { useState } from "react";
import type { ReactElement } from "react";
import type { AutoRouteResponse, LiveTripState, RouteSegment } from "./contract";
import { useClock } from "./hooks";
import { formatDuration, parseLocalDateTime } from "./pure";


function clock(value?: string | null): string {
  if (!value) return "--:--";
  const match = String(value).match(/(\d{2}):(\d{2})(?::\d{2})?$/);
  return match ? `${match[1]}:${match[2]}` : String(value);
}

export function routeTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const text = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}+09:00`
    : text;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function localTimestamp(value?: string | null): number | null { return parseLocalDateTime(value)?.getTime() ?? null; }
function lineClass(line: string): string { return line.replace(/[^0-9A-Za-z가-힣]/g, ""); }
function confidence(segments: RouteSegment[]): string {
  if (segments.some((segment) => segment.confidence === "낮음")) return "낮음";
  if (segments.some((segment) => segment.confidence === "중간")) return "중간";
  return "높음";
}
function seconds(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0; }
function isSamePlatform(segment: RouteSegment): boolean {
  const info = segment.transfer_info || {};
  return info.mode === "same-platform" || info.matched === "same-platform-service-change";
}
function transferSeconds(segment: RouteSegment): number {
  if (isSamePlatform(segment)) return 0;
  const info = segment.transfer_info || {};
  const walkingMinutes = Number(segment.transfer_walk);
  return seconds(segment.transfer_seconds) || seconds(info.seconds) || seconds(info.walking_seconds) || (Number.isFinite(walkingMinutes) && walkingMinutes > 0 ? Math.round(walkingMinutes * 60) : 0);
}
function durationText(value: number): string {
  const safe = Math.max(0, Math.round(value));
  const minutes = Math.floor(safe / 60); const rest = safe % 60;
  if (!minutes) return `${rest}초`;
  return rest ? `${minutes}분 ${rest}초` : `${minutes}분`;
}
function transferText(segment: RouteSegment): string {
  if (isSamePlatform(segment)) return "제자리 환승 · 이동 없음";
  const value = transferSeconds(segment);
  return value ? durationText(value) : "환승 시간 정보 없음";
}
function crowdingText(segment: RouteSegment): string {
  const info = segment.transfer_info || {};
  const multiplier = Number(info.crowding_multiplier ?? 1);
  const level = typeof info.crowding_level === "string" ? info.crowding_level : "";
  return Number.isFinite(multiplier) && multiplier > 1.001 ? `${level || "혼잡"} ×${multiplier.toFixed(2)}` : "";
}
function infoText(value: unknown): string { return typeof value === "string" && value.trim() ? value.trim() : ""; }
function trackingKey(candidate: RouteSegment): string { return String(candidate.tracking_id ?? candidate.train_no ?? "").trim(); }
function publicTrainText(candidate: RouteSegment): string { return String(candidate.train_no ?? "").trim() || "열번 확인 중"; }
function trainLabel(candidate: RouteSegment): string { const publicNo = String(candidate.train_no ?? "").trim(); return publicNo ? `${publicNo}열차` : "열차 정보 확인 중"; }
function candidateKey(candidate: RouteSegment): string { return trackingKey(candidate); }
function alternateCandidates(segment: RouteSegment): RouteSegment[] {
  const current = trackingKey(segment);
  const raw = [segment.previous_candidate, ...(Array.isArray(segment.nearby_candidates) ? segment.nearby_candidates : [])].filter((candidate): candidate is RouteSegment => Boolean(candidate && trackingKey(candidate)));
  const seen = new Set<string>(); const result: RouteSegment[] = [];
  for (const candidate of raw) { const key = candidateKey(candidate); if (!key || key === current || seen.has(key)) continue; seen.add(key); result.push(candidate); }
  return result.slice(0, 8);
}
function locationText(segment: RouteSegment): string { return segment.location_label || segment.current_station_name || segment.current_station || segment.location || "확인 중"; }
function delayText(value: unknown): string { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 30) return "정시권"; return `+${Math.max(1, Math.round(parsed / 60))}분`; }
function progress(startValue: string | undefined, endValue: string | undefined, now: number): number {
  const start = routeTimestamp(startValue); const end = routeTimestamp(endValue);
  if (start === null || end === null || end <= start) return 0;
  return Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
}
function phaseLabel(liveTrip: LiveTripState | null, index: number): string {
  if (!liveTrip) return "";
  if (liveTrip.phase === "done" || index < liveTrip.activeIndex) return "완료";
  if (index > liveTrip.activeIndex) return "예정";
  if (liveTrip.phase === "ride") return "탑승 중";
  if (liveTrip.phase === "transfer") return "하차 · 환승 중";
  return "탑승 대기";
}

export function UpstreamJourneyView({ result, segments, arrivalTime, totalSeconds, activeIndex, liveTrip, onBoard, onRefresh, onExcludeGtx }: {
  result: AutoRouteResponse; segments: RouteSegment[]; arrivalTime?: string; totalSeconds: number; activeIndex: number; liveTrip: LiveTripState | null;
  onBoard: (index: number, trainNo: string | number, displayLabel?: string) => void; onRefresh: () => void; onExcludeGtx: () => void;
}): ReactElement {
  const [candidateIndex, setCandidateIndex] = useState<number | null>(null);
  const now = useClock(1_000).getTime();
  const first = segments[0]; const last = segments.at(-1);
  const from = first?.from || result.from || "출발역"; const to = last?.to || result.to || "도착역";
  const transferCount = result.transfer_count ?? Math.max(0, segments.length - 1);
  const hasGtx = segments.some((segment) => segment.line.startsWith("GTX-A"));
  const canExcludeGtx = hasGtx;
  return <>
    <section className="route-overview" aria-live="polite">
      <div className="route-overview-main"><span className="route-kicker">추천 경로</span><h1><strong>{from}</strong><span>→</span><strong>{to}</strong></h1><p>환승 {transferCount}회 · 총 {formatDuration(totalSeconds)} · 신뢰도 {confidence(segments)}</p></div>
      <div className="route-arrival"><span>예상 도착</span><strong>{clock(arrivalTime)}</strong><div className="route-overview-actions"><button type="button" onClick={onRefresh}>새로고침</button>{canExcludeGtx && <button type="button" className="exclude-gtx" onClick={onExcludeGtx}>GTX-A 제외하기</button>}</div></div>
    </section>
    <section className={`route-timeline ${liveTrip ? "journey-started" : ""}`} aria-label={`${from}에서 ${to}까지 이동 경로`}>
      <TimelineStation kind="origin" time={clock(first?.board_dt || result.start_time)} station={from} label="출발" completed={Boolean(liveTrip)} />
      {segments.map((segment, index) => {
        const next = segments[index + 1]; const trackingId = trackingKey(segment); const visibleTrainLabel = trainLabel(segment);
        const tracking = Boolean(liveTrip?.phase === "ride" && liveTrip.activeIndex === index);
        const completed = Boolean(liveTrip && (liveTrip.phase === "done" || index < liveTrip.activeIndex || (index === liveTrip.activeIndex && liveTrip.phase === "transfer")));
        const current = Boolean(liveTrip && index === liveTrip.activeIndex && liveTrip.phase !== "done"); const future = Boolean(liveTrip && index > liveTrip.activeIndex);
        const transfer = index < segments.length - 1; const activeTransfer = Boolean(liveTrip?.phase === "transfer" && liveTrip.activeIndex === index);
        const info = segment.transfer_info || {}; const alightPosition = infoText(info.alight_position); const boardPosition = infoText(info.board_position);
        const candidates = alternateCandidates(segment); const choosing = candidateIndex === index; const totalTransfer = transferSeconds(segment);
        const transferEnd = activeTransfer ? localTimestamp(liveTrip?.transferEndsAt) : null;
        const transferRemaining = transferEnd === null ? totalTransfer : Math.max(0, Math.ceil((transferEnd - now) / 1000));
        const transferProgress = activeTransfer && totalTransfer > 0 ? Math.max(0, Math.min(100, ((totalTransfer - transferRemaining) / totalTransfer) * 100)) : completed ? 100 : 0;
        const rideProgress = completed ? 100 : tracking ? progress(segment.board_dt, segment.alight_dt, now) : 0;
        const phase = phaseLabel(liveTrip, index); const crowd = crowdingText(segment); const samePlatform = isSamePlatform(segment);
        return <div className={`timeline-section ${completed ? "completed" : ""} ${current ? "current" : ""} ${future ? "future" : ""} ${activeTransfer ? "active-transfer" : ""}`} key={`${segment.line}-${segment.from}-${segment.to}-${index}`}>
          <article className={`ride-card ${tracking ? "active" : ""} ${completed ? "completed" : ""}`}>
            <div className="ride-line"><span className={`line-tag line-${lineClass(segment.line)}`}>{segment.line}</span><strong>{segment.destination ? `${segment.destination} 방면` : segment.direction || "운행 방향 확인"}</strong>{phase && <span className={`journey-phase phase-${liveTrip?.phase || "planned"}`}>{phase}</span>}</div>
            <div className="ride-times"><span><b>{clock(segment.board_dt)}</b> {segment.from} 승차</span><span className="ride-arrow">→</span><span><b>{clock(segment.alight_dt)}</b> {segment.to} 하차</span></div>
            {(tracking || completed) && <div className="journey-progress" aria-label={`이동 진행률 ${Math.round(rideProgress)}%`}><i style={{ width: `${rideProgress}%` }} /></div>}
            <div className="ride-meta"><span>열차 <b>{publicTrainText(segment)}</b></span><span>현재 위치 <b>{locationText(segment)}</b></span><span>지연 <b>{delayText(segment.delay_seconds)}</b></span><span>신뢰도 <b>{segment.confidence || "낮음"}</b></span></div>
            {trackingId && !completed && <div className="ride-actions"><button type="button" className="primary-button" disabled={tracking && String(liveTrip?.boardedTrainNo) === trackingId} onClick={() => onBoard(index, trackingId, visibleTrainLabel)}>{tracking && String(liveTrip?.boardedTrainNo) === trackingId ? "✓ 탑승 추적 중" : "이 열차를 탔어요"}</button>{candidates.length > 0 && <button type="button" className="secondary-button" aria-expanded={choosing} onClick={() => setCandidateIndex(choosing ? null : index)}>다른 열차를 탔어요</button>}</div>}
            {choosing && candidates.length > 0 && <div className="train-choice-panel" aria-label="주변 열차 선택">{candidates.map((candidate) => <button type="button" className="train-choice" key={candidateKey(candidate)} onClick={() => { onBoard(index, trackingKey(candidate), trainLabel(candidate)); setCandidateIndex(null); }}><strong>{trainLabel(candidate)}</strong><span>{clock(candidate.board_dt)} 승차{candidate.location_label ? ` · ${candidate.location_label}` : candidate.current_station ? ` · ${candidate.current_station}` : ""}</span></button>)}</div>}
          </article>
          {transfer && <div className={`transfer-block ${activeTransfer ? "active" : ""} ${completed && !activeTransfer ? "completed" : ""} ${samePlatform ? "same-platform" : ""}`}>
            <div className="transfer-time"><strong>{clock(segment.alight_dt)}</strong><span>{activeTransfer ? "환승 중" : "환승"}</span></div><div className="transfer-marker" />
            <div className="transfer-copy"><div className="transfer-heading"><strong>{segment.to}</strong><span>{segment.line} → {next?.line || "다음 노선"}</span>{samePlatform && <b className="transfer-mode-badge">제자리 환승</b>}</div><div className="transfer-duration">{activeTransfer ? `환승 중 · ${durationText(transferRemaining)} 남음` : `환승 ${transferText(segment)}`}{crowd && <small className="crowding-badge">{crowd}</small>}</div>{activeTransfer && totalTransfer > 0 && <div className="transfer-progress" role="progressbar" aria-label="환승 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(transferProgress)}><i style={{ width: `${transferProgress}%` }} /></div>}<div className="transfer-detail">{alightPosition && <span>내릴 문 <b>{alightPosition}</b></span>}{boardPosition && <span>탈 문 <b>{boardPosition}</b></span>}{!alightPosition && !boardPosition && <span>{samePlatform ? "같은 승강장에서 다음 열차를 기다리세요." : "환승 위치 정보 없음"}</span>}</div></div>
          </div>}
        </div>;
      })}
      <TimelineStation kind="destination" time={clock(last?.alight_dt || arrivalTime)} station={to} label="도착" completed={liveTrip?.phase === "done"} />
    </section>
  </>;
}

function TimelineStation({ kind, time, station, label, completed = false }: { kind: "origin" | "destination"; time: string; station: string; label: string; completed?: boolean }): ReactElement {
  return <div className={`timeline-station ${kind} ${completed ? "completed" : ""}`}><div className="timeline-station-time"><strong>{time}</strong><span>{label}</span></div><div className="timeline-station-marker" /><div className="timeline-station-copy"><strong>{station}</strong><span>{kind === "origin" ? "여정 시작" : completed ? "도착 완료" : "최종 목적지"}</span></div></div>;
}
