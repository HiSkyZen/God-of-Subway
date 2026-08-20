import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement, RefObject } from "react";
import type { AutoRouteResponse, Confidence, ExperimentRecord, LiveTripState, RouteResponse, RouteSegment } from "./contract";
import { useClock } from "./hooks";
import { experimentMetrics, formatDuration } from "./pure";
import { lineBadgeSpec, type StationSuggestion } from "./station-suggestions";

export function formatClock(value?: string | null): string {
  if (!value) return "-";
  const match = String(value).match(/(\d{2}):(\d{2})(?::\d{2})?$/);
  return match ? `${match[1]}:${match[2]}` : value;
}

function confidenceLabel(value?: Confidence): string { return value || "낮음"; }
function delayLabel(value?: number): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 30) return "정시권";
  return `+${Math.max(1, Math.round(seconds / 60))}분`;
}
function lineClass(line: string): string { return line.replace(/[^0-9A-Za-z가-힣]/g, ""); }
function positionLabel(segment?: RouteSegment): string {
  return segment?.location_label || segment?.current_station_name || segment?.current_station || segment?.location || segment?.from || "확인 중";
}

export function BellIcon(): ReactElement { return <svg className="bell-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>; }
export function ShareIcon(): ReactElement { return <svg className="share-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 12v7h14v-7" /></svg>; }

export interface StationInputProps {
  label: string;
  side: "from" | "to";
  value: string;
  suggestions: StationSuggestion[];
  activeIndex: number;
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSelect: (suggestion: StationSuggestion) => void;
}

function LineBadge({ line }: { line: string }): ReactElement {
  const spec = lineBadgeSpec(line);
  const width = spec.shape === "circle" ? 24 : spec.width;
  return <svg className={`line-badge-svg ${spec.shape}`} width={width} height="24" viewBox={`0 0 ${width} 24`} role="img" aria-label={line}>
    {spec.shape === "circle" ? <circle cx="12" cy="12" r="11" fill={spec.color} /> : <rect x="1" y="1" width={width - 2} height="22" rx="11" fill={spec.color} />}
    <text x={width / 2} y="12.5" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={spec.shape === "circle" ? "12" : "10"} fontWeight="800">{spec.text}</text>
  </svg>;
}

export function StationInput({ label, side, value, suggestions, activeIndex, inputRef, onChange, onFocus, onBlur, onKeyDown, onSelect }: StationInputProps): ReactElement {
  const listId = `${side}-station-suggestions`;
  const activeId = activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;
  return <label className="station-control"><span>{label}</span><div className="input-wrap"><input ref={inputRef} value={value} placeholder={label} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={suggestions.length > 0} aria-controls={listId} aria-activedescendant={activeId} onChange={(event) => onChange(event.target.value)} onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown} /><button type="button" className="clear-input" onMouseDown={(event: ReactMouseEvent) => event.preventDefault()} onClick={() => onChange("")} aria-label={`${label} 지우기`}>×</button><span className="search-icon">⌕</span>{suggestions.length > 0 && <div id={listId} className="suggestions" role="listbox">{suggestions.map((suggestion, index) => <button id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex} aria-label={`${suggestion.station} ${suggestion.lines.join(" ")}`} type="button" className={index === activeIndex ? "active" : ""} key={`${suggestion.selector}-${suggestion.lines.join("|")}`} onMouseDown={(event) => { event.preventDefault(); onSelect(suggestion); }}><span className="suggestion-badges" aria-hidden="true">{suggestion.lines.map((line) => <LineBadge key={line} line={line} />)}</span><span className="suggestion-station">{suggestion.station}</span></button>)}</div>}</div></label>;
}

export function JourneySummary({ result, activeSegments, arrivalTime, totalSeconds, quality, live, onRefresh }: { result: AutoRouteResponse; activeSegments: RouteSegment[]; arrivalTime?: string; totalSeconds: number; quality: string; live: boolean; onRefresh: () => void }): ReactElement {
  const first = activeSegments[0];
  return <section className="journey-summary" aria-live="polite"><div className="summary-left"><span className="line-icon">▣</span><strong>{first?.line || "경로"}</strong><span>이용</span><i /> <span>환승 {result.transfer_count ?? Math.max(0, activeSegments.length - 1)}회</span><i /> <span>총 {formatDuration(totalSeconds)}</span></div><div className="summary-right"><span>예상 도착</span><strong>{formatClock(arrivalTime)}</strong><i /><span>실시간 연결</span><b className="status-good">{live ? "추적 중" : "보통"}</b><span className="quality-label">신뢰도 {quality}</span><button type="button" onClick={onRefresh} aria-label="경로 새로고침">⌃</button></div>{(result.alternatives?.length || 0) > 0 && <details className="route-alternatives"><summary>다른 경로 {result.alternatives?.length}개 보기</summary><div>{result.alternatives?.map((alternative, index) => <article key={`${alternative.arrival_time || index}-${index}`}><strong>{alternative.segments?.map((segment) => segment.line).filter(Boolean).join(" · ") || "대안 경로"}</strong><span>환승 {alternative.transfer_count ?? Math.max(0, (alternative.segments?.length || 1) - 1)}회 · {formatDuration(alternative.total_seconds ?? alternative.estimated_total_seconds ?? 0)}</span><b>{formatClock(alternative.arrival_time || alternative.estimated_arrival_time)}</b></article>)}</div></details>}</section>;
}

export function JourneyRail({ segments, activeIndex, liveTrip, onBoard }: { segments: RouteSegment[]; activeIndex: number; liveTrip: LiveTripState | null; onBoard: (index: number, trainNo: string | number) => void }): ReactElement {
  return <section className="journey-rail"><div className="rail-note">실시간 위치가 확인되면 해당 열차의 지연을 우선 사용합니다. 시간표 기반 결과는 변경될 수 있습니다.</div><div className="rail-list">{segments.map((segment, index) => <StationRow key={`${segment.line}-${segment.from}-${index}`} segment={segment} index={index} isFinal={index === segments.length - 1} active={index === activeIndex} tracking={Boolean(liveTrip?.phase === "ride" && index === liveTrip.activeIndex)} onBoard={onBoard} />)}</div></section>;
}

function StationRow({ segment, index, isFinal, active, tracking, onBoard }: { segment: RouteSegment; index: number; isFinal: boolean; active: boolean; tracking: boolean; onBoard: (index: number, trainNo: string | number) => void }): ReactElement {
  const trainNo = segment.train_no || "-";
  const stationLabel = index === 0 ? "출발" : isFinal ? "도착" : "환승";
  const serviceLabel = segment.service === "express" ? "급행" : segment.direction || "일반";
  const hasTrain = trainNo !== "-";
  const trainCandidates = [segment, ...(segment.nearby_candidates || []), ...(segment.previous_candidate ? [segment.previous_candidate] : [])].filter((candidate, candidateIndex, candidates): candidate is RouteSegment => Boolean(candidate?.train_no && candidate?.board_dt) && candidates.findIndex((item) => String(item.train_no) === String(candidate.train_no)) === candidateIndex).slice(0, 5);
  return <article className={`station-row ${active ? "active" : ""}`}><div className="station-time">{formatClock(segment.board_dt || segment.alight_dt)}<small>{stationLabel}</small></div><div className={`rail-dot ${active ? "selected" : ""}`} /><div className="station-copy"><div className="station-title"><strong>{segment.from || "-"}</strong><span className={`line-tag line-${lineClass(segment.line)}`}>{segment.line || "노선"}</span></div><p>{segment.origin || segment.destination || `${segment.line || ""} 이동`}</p>{(active || tracking) && <div className="active-train"><div><h3>{tracking ? "지금 타는 열차" : "탑승할 열차 선택"} <small>({serviceLabel})</small></h3><strong className="train-number">{trainNo}</strong><span>도착 예정 <b>{formatClock(segment.alight_dt)}</b></span><div className="train-cars" aria-label="열차 실시간 위치">실시간 위치 {positionLabel(segment)}</div>{trainCandidates.length > 1 && <div className="train-candidates" aria-label="탑승 열차 선택">{trainCandidates.map((candidate) => <button type="button" key={`${candidate.train_no}-${candidate.board_dt}`} disabled={tracking} onClick={() => onBoard(index, candidate.train_no || "-")}>{candidate.train_no} · {formatClock(candidate.board_dt)}</button>)}</div>}</div><div className="train-detail"><span>지연　<b className="danger-text">{delayLabel(segment.delay_seconds)}</b></span><span>실시간 소재　{positionLabel(segment)}</span><span>신뢰도　<b className="status-good">{confidenceLabel(segment.confidence)}</b></span></div><div className="train-action"><button type="button" className="primary-button" disabled={tracking || !hasTrain} onClick={() => onBoard(index, trainNo)}>{tracking ? "✓ 탑승 중" : hasTrain ? "✓ 이 열차를 탔어요" : "열차 정보 없음"}</button><small>○ 다음 업데이트　00:20<br />○ 자동 업데이트 중</small></div></div>}</div><div className="station-meta"><b className={Number(segment.delay_seconds) > 30 ? "danger-text" : ""}>{delayLabel(segment.delay_seconds)}</b><span>실시간 소재　{positionLabel(segment)}</span></div></article>;
}

export function LivePanel({ trip, result, alertActive, arrivalAlertCapable, onAlert, onClearAlert, onFinishTransfer, onAlight, onStop }: { trip: LiveTripState; result: RouteResponse | null; alertActive: boolean; arrivalAlertCapable: boolean | null; onAlert: () => void; onClearAlert: () => void; onFinishTransfer: () => void; onAlight: () => void; onStop: () => void }): ReactElement {
  const current = result?.segments?.[0] || trip.displaySegments[trip.activeIndex];
  const now = useClock(1_000);
  const transferRemaining = trip.transferEndsAt ? Math.max(0, Math.ceil((new Date(trip.transferEndsAt).getTime() - now.getTime()) / 1_000)) : 0;
  const publicTrainNo = String(current?.train_no ?? "").trim();
  const title = trip.phase === "ride" ? `${publicTrainNo || "현재"}열차 탑승 중` : trip.phase === "transfer" ? "환승 중" : trip.phase === "waiting" ? "다음 열차 탑승 대기" : "목적지 도착";
  const remaining = typeof result?.current_segment_remaining_seconds === "number" ? result.current_segment_remaining_seconds : 0;
  const currentPosition = positionLabel(current);
  return <section className="live-panel"><div><span className="live-dot" /><strong>{title}</strong><p>{currentPosition} · 20초마다 최신 운행정보로 자동 재계산합니다.</p></div><div className="live-stats"><span>현재 열차 <b>{publicTrainNo || (trip.phase === "waiting" ? "선택 대기" : trip.phase === "transfer" ? "환승" : "확인 중")}</b></span><span>현재 위치 <b>{currentPosition}</b></span><span>{trip.phase === "transfer" ? "환승 남은 시간" : trip.phase === "waiting" ? "다음 열차" : trip.activeIndex >= trip.segments.length - 1 ? "목적지 하차까지" : "다음 환승까지"} <b>{trip.phase === "transfer" ? formatDuration(transferRemaining) : trip.phase === "waiting" ? formatClock(current?.board_dt) : formatDuration(remaining)}</b></span></div><div className="live-actions">{trip.phase === "transfer" && <button type="button" onClick={onFinishTransfer}>환승을 마쳤어요</button>}{trip.phase === "waiting" && <span>다음 구간 열차를 자동으로 확인하고 있습니다.</span>}{arrivalAlertCapable === false ? <span className="alert-unavailable">이 배포 환경에서는 백그라운드 도착 알림을 지원하지 않습니다.</span> : trip.phase === "ride" || alertActive ? <button type="button" className={alertActive ? "alert-active" : ""} onClick={alertActive ? onClearAlert : onAlert}>{alertActive ? "도착 알림 해제" : "도착 알림 설정"}</button> : null}{trip.phase === "ride" && <button type="button" onClick={onAlight}>이제 내렸어요</button>}{trip.phase === "done" && <button type="button" onClick={onStop}>여정 종료</button>}</div></section>;
}

export function ExperimentPanel({ experiments, onArrive, onUpdate, onDelete, onCsv, onJson }: { experiments: ExperimentRecord[]; onArrive: () => void; onUpdate: (id: string, update: Partial<ExperimentRecord>) => void; onDelete: (id: string) => void; onCsv: () => void; onJson: () => void }): ReactElement {
  const completed = experiments.filter((experiment) => experiment.completed_at && !experiment.excluded);
  const active = experiments.find((experiment) => !experiment.completed_at && !experiment.excluded);
  const metrics = completed.map(experimentMetrics);
  const average = (values: Array<number | null>): number | null => { const valid = values.filter((value): value is number => value != null && Number.isFinite(value)); return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null; };
  const metricText = (value: number | null, suffix = "분"): string => value == null ? "-" : `${value.toFixed(1)}${suffix}`;
  const reduction = average(metrics.map((metric) => metric.error_reduction_pct));
  return <section className="experiment-panel"><div className="experiment-header"><div><h2>기말 실험 기록</h2><p>검색 → 탑승 → ETA 갱신 → 실제 도착을 이 브라우저에 기록합니다.</p></div><span>완료 {completed.length}건</span></div><div className="experiment-actions"><button type="button" disabled={!active} onClick={onArrive}>지금 목적지 도착 기록</button><button type="button" onClick={onCsv}>요약 CSV</button><button type="button" onClick={onJson}>상세 JSON</button>{active && <><button type="button" onClick={() => onUpdate(active.id, { excluded: true })}>현재 실험 제외</button><label className="experiment-note">메모<input value={active.note} onChange={(event) => onUpdate(active.id, { note: event.target.value })} placeholder="관찰 메모" /></label></>}</div><div className="experiment-metrics"><span>완료 이동 <b>{completed.length}건</b></span><span>지금타 초기 ETA MAE <b>{metricText(average(metrics.map((metric) => metric.initial_error_min)))}</b></span><span>기존 앱 ETA MAE <b>{metricText(average(metrics.map((metric) => metric.baseline_error_min)))}</b></span><span>ETA 오차 감소 <b>{reduction == null ? "-" : `${reduction.toFixed(0)}%`}</b></span><span>평균 첫 승강장 대기 <b>{metricText(average(metrics.map((metric) => metric.first_platform_wait_min)))}</b></span></div>{experiments.length > 0 && <div className="experiment-history" aria-label="최근 실험 기록">{experiments.slice().reverse().slice(0, 8).map((experiment) => <article key={experiment.id}><div><strong>{experiment.from} → {experiment.to}</strong><span>{experiment.excluded ? "제외" : experiment.completed_at ? "완료" : "기록 중"} · {experiment.created_at}</span>{experiment.note && <small>{experiment.note}</small>}</div><button type="button" onClick={() => onDelete(experiment.id)}>삭제</button></article>)}</div>}</section>;
}

export type PushPermissionState = "unsupported" | "default" | "granted" | "denied";

export function PushOptInSheet({ state, onAllow, onLater }: { state: PushPermissionState; onAllow: () => void; onLater: () => void }): ReactElement {
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { primaryRef.current?.focus(); const onKeyDown = (event: globalThis.KeyboardEvent): void => { if (event.key === "Escape") onLater(); }; document.addEventListener("keydown", onKeyDown); return () => document.removeEventListener("keydown", onKeyDown); }, [onLater]);
  return <div className="sheet-backdrop" role="presentation"><section className="push-sheet" role="dialog" aria-modal="true" aria-labelledby="push-title"><div className="sheet-handle" /><div className="push-icon"><BellIcon /></div><h2 id="push-title">도착 알림 받기</h2><p>내릴 역에 도착하기 전에 알림으로 안내해 드려요.</p>{state === "denied" && <p className="error-copy">알림이 차단되어 있습니다. 브라우저 설정에서 허용해 주세요.</p>}{state === "granted" ? <button ref={primaryRef} className="primary-button" onClick={onAllow}>알림 끄기</button> : <button ref={primaryRef} className="primary-button" onClick={onAllow} disabled={state === "unsupported" || state === "denied"}>알림 허용</button>}<button className="secondary-button" onClick={onLater}>나중에</button></section></div>;
}

export function InstallSheet({ onClose }: { onClose: () => void }): ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); const onKeyDown = (event: globalThis.KeyboardEvent): void => { if (event.key === "Escape") onClose(); }; document.addEventListener("keydown", onKeyDown); return () => document.removeEventListener("keydown", onKeyDown); }, [onClose]);
  return <div className="sheet-backdrop" role="presentation"><section className="push-sheet" role="dialog" aria-modal="true" aria-labelledby="install-title"><div className="sheet-handle" /><div className="push-icon">⇩</div><h2 id="install-title">지금타 앱 설치</h2><p>Safari 하단의 공유 버튼을 누른 뒤 <b>홈 화면에 추가</b>를 선택하면 앱처럼 사용할 수 있어요.</p><button ref={closeRef} className="primary-button" onClick={onClose}>확인</button></section></div>;
}
