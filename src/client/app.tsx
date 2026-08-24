import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BellIcon, InstallSheet, LivePanel, PushOptInSheet, ShareIcon, StationInput } from "./components";
import { UpstreamJourneyView } from "./journey-view";
import { useClock, useToast } from "./hooks";
import { useJourneySearch, type JourneySearchOptions } from "./use-journey-search";
import { useLiveJourney } from "./use-live-journey";
import { usePushPwa } from "./use-push-pwa";

declare global { interface Window { __jigeumtaReactRoot?: Root; } }
type Theme = "light" | "dark";

function initialTheme(): Theme {
  const saved = localStorage.getItem("jigeumta_theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function timeText(date: Date): string {
  return date.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s+/g, " ").trim();
}
function timeValue(date: Date): string { return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
function shiftClock(value: string, delta: number): string {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return value;
  const minutes = (Number(match[1]) * 60 + Number(match[2]) + delta + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function App(): ReactElement {
  const now = useClock();
  const [toast, notify] = useToast();
  const search = useJourneySearch(notify);
  const push = usePushPwa(notify, "/sw.js");
  const live = useLiveJourney({ result: search.result, day: search.day, alert: push.pushAlert, notify, onSyncAlert: push.syncArrivalAlert, onClearAlert: push.clearArrivalAlert });
  const inputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [debugQuery, setDebugQuery] = useState(() => localStorage.getItem("jigeumta_debug_query") === "1");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("jigeumta_theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b1118" : "#ffffff");
  }, [theme]);
  useEffect(() => { localStorage.setItem("jigeumta_debug_query", debugQuery ? "1" : "0"); }, [debugQuery]);
  useEffect(() => { if (!live.liveTrip || search.result || !live.restoredResult) return; search.restoreTrip(live.liveTrip, live.restoredResult); }, [live.liveTrip?.journeyStartedAt, Boolean(search.result)]);

  const activeSegments = live.liveTrip?.displaySegments || live.liveResult?.segments || search.result?.segments || [];
  const visibleTrip = live.liveTrip && (live.liveResult || live.liveTrip.displaySegments.length > 0) ? live.liveTrip : null;
  const totalSeconds = live.liveResult?.remaining_seconds ?? live.liveResult?.estimated_total_seconds ?? search.result?.total_seconds ?? search.result?.estimated_total_seconds ?? 0;
  const arrivalTime = live.liveResult?.arrival_time ?? live.liveResult?.estimated_arrival_time ?? search.result?.arrival_time ?? search.result?.estimated_arrival_time;
  const selectedDate = useMemo(() => {
    if (search.exactTime) {
      const [hour, minute] = search.exactTime.split(":").map(Number);
      const copy = new Date(now); copy.setHours(hour || 0, minute || 0, 0, 0); return copy;
    }
    return new Date(now.getTime() + search.searchMinutes * 60_000);
  }, [now, search.exactTime, search.searchMinutes]);

  const runSearch = async (event?: FormEvent, offset?: number, options?: JourneySearchOptions): Promise<void> => {
    event?.preventDefault();
    if (live.liveTrip && live.liveTrip.phase !== "done") {
      const proceed = window.confirm("새 경로를 조회하면 현재 추적이 중단됩니다. 계속할까요?");
      if (!proceed) return;
      live.stopTracking(true);
    }
    if (await search.search(undefined, offset, options)) live.clearLiveResult();
  };
  const refreshJourney = async (): Promise<void> => { try { if (await live.refreshLiveJourney()) return; await search.refreshRoute(); } catch (caught: unknown) { notify(caught instanceof Error ? `갱신 실패: ${caught.message}` : "갱신에 실패했습니다."); } };
  const closeSuggestions = (side: "from" | "to"): void => { window.setTimeout(() => { const focused = document.activeElement; if (focused instanceof HTMLInputElement && focused.getAttribute("aria-controls")?.endsWith("-station-suggestions")) return; search.setActiveSuggestion((current) => current === side ? null : current); }, 140); };
  const shiftSearchTime = (minutes: number): void => { if (search.exactTime) search.setExactTime(shiftClock(search.exactTime, minutes)); else search.adjustTime(search.searchMinutes + minutes); };
  const shareRoute = async (): Promise<void> => {
    const text = `${search.from} → ${search.to}`;
    try {
      if (navigator.share) { await navigator.share({ title: "지금타 경로", text }); return; }
      await navigator.clipboard?.writeText(text); notify("경로를 복사했습니다.");
    } catch (caught: unknown) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      try { await navigator.clipboard?.writeText(text); notify("경로를 복사했습니다."); } catch { notify("경로 공유에 실패했습니다."); }
    }
  };

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="./" aria-label="지금타 홈"><img src="./jigeumta_logo_140.png" alt="" /><span>지금<span>타</span></span></a>
      <nav className="header-actions" aria-label="주요 작업">
        <span className={`service-status ${search.healthState}`}><i /> {search.healthState === "ok" ? "서버 연결됨" : search.healthState === "error" ? "서버 연결 실패" : "서버 확인 중"}</span>
        <button className="header-button theme-toggle" type="button" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}>{theme === "dark" ? "☀ 라이트" : "◐ 다크"}</button>
        <button className="header-button" type="button" onClick={() => push.setPushSheet(true)}><BellIcon /> 알림</button>
        {(push.installEvent || push.showInstallSheet) && <button className="header-button" type="button" onClick={() => push.installEvent ? void push.install() : push.setShowInstallSheet(true)}>앱 설치</button>}
        <button className="header-button" type="button" onClick={search.toggleSettings}>설정</button>
      </nav>
    </header>

    <main>
      <section className="search-card">
        <form className="search-panel" onSubmit={(event) => void runSearch(event)}>
          <StationInput label="출발역" value={search.from} side="from" suggestions={search.activeSuggestion === "from" ? search.suggestions : []} activeIndex={search.suggestionIndex} inputRef={inputRef} onChange={search.setFrom} onFocus={() => { search.setActiveSuggestion("from"); search.setSuggestionIndex(-1); }} onBlur={() => closeSuggestions("from")} onKeyDown={search.onStationKeyDown} onSelect={search.selectSuggestion} />
          <button type="button" className="swap-button" onClick={search.swap} aria-label="출발역과 도착역 바꾸기">⇄</button>
          <StationInput label="도착역" value={search.to} side="to" suggestions={search.activeSuggestion === "to" ? search.suggestions : []} activeIndex={search.suggestionIndex} onChange={search.setTo} onFocus={() => { search.setActiveSuggestion("to"); search.setSuggestionIndex(-1); }} onBlur={() => closeSuggestions("to")} onKeyDown={search.onStationKeyDown} onSelect={search.selectSuggestion} />
          <button className="primary-button search-button" type="submit" disabled={search.loading}>{search.loading ? "조회 중…" : "경로 조회"}</button>
        </form>
        <div className="time-strip" aria-label="조회 시각 조정">
          <button type="button" onClick={() => search.adjustTime(0)}>지금</button>
          <span className="time-step-group"><button type="button" onClick={() => shiftSearchTime(-5)}>−5분</button><button type="button" onClick={() => shiftSearchTime(-1)}>−1분</button></span>
          <label className="selected-time time-picker" aria-label="조회 시각 직접 선택"><span>{timeText(selectedDate)}</span><input type="time" value={timeValue(selectedDate)} onChange={(event) => search.setExactTime(event.target.value)} /></label>
          <span className="time-step-group"><button type="button" onClick={() => shiftSearchTime(1)}>+1분</button><button type="button" onClick={() => shiftSearchTime(5)}>+5분</button></span>
        </div>
        <div className="route-objective-strip" role="radiogroup" aria-label="경로 최적화 기준">
          <button type="button" role="radio" aria-checked={search.objective === "fastest"} className={search.objective === "fastest" ? "active" : ""} onClick={() => search.setObjective("fastest")}>최단시간</button>
          <button type="button" role="radio" aria-checked={search.objective === "fewest_transfers"} className={search.objective === "fewest_transfers" ? "active" : ""} onClick={() => search.setObjective("fewest_transfers")}>최소환승</button>
          <button type="button" role="radio" aria-checked={search.objective === "lowest_cost"} className={search.objective === "lowest_cost" ? "active" : ""} onClick={() => search.setObjective("lowest_cost")}>최소비용</button>
        </div>
      </section>

      {search.favorites.length > 0 && <section className="favorites-panel" aria-label="즐겨찾기 경로">
        <div className="section-heading"><div><span>즐겨찾기</span><h2>자주 가는 경로</h2></div><small>저장한 경로를 한 번에 불러옵니다.</small></div>
        <div className="favorite-list">{search.favorites.map((favorite) => <article className="favorite-card" key={favorite.id}><button type="button" className="favorite-load" onClick={() => search.loadFavorite(favorite)}><span className="favorite-star">★</span><strong>{favorite.segments[0]?.from || "출발"} <span>→</span> {favorite.segments.at(-1)?.to || "도착"}</strong><small>{favorite.segments.map((segment) => segment.line).filter(Boolean).join(" · ") || "자동 경로"}</small></button><button type="button" className="favorite-delete" onClick={() => search.deleteFavorite(favorite.id)} aria-label={`${favorite.name} 즐겨찾기 삭제`}>삭제</button></article>)}</div>
      </section>}

      {search.showSettings && <section className="settings-panel" aria-label="상세 설정">
        <label>운행일<select value={search.day} onChange={(event) => search.setDay(event.target.value === "DAY" ? "DAY" : "END")}><option value="DAY">평일</option><option value="END">주말·공휴일</option></select></label>
        <label className="checkbox-label"><input type="checkbox" checked={debugQuery} onChange={(event) => setDebugQuery(event.target.checked)} /> 디버그모드 조회</label>
        <label className="checkbox-label"><input type="checkbox" checked={search.useGtx} onChange={(event) => search.setUseGtx(event.target.checked)} /> GTX 이용</label>
      </section>}

      {search.error && <p className="error-banner" role="alert"><strong>조회 실패</strong><span>{search.error}</span></p>}

      {search.result ? <UpstreamJourneyView result={search.result} segments={activeSegments} arrivalTime={arrivalTime} totalSeconds={totalSeconds} activeIndex={live.liveTrip?.activeIndex ?? 0} liveTrip={visibleTrip} onBoard={live.startTracking} onRefresh={() => void refreshJourney()} onExcludeGtx={() => void runSearch(undefined, undefined, { useGtx: false })} /> : <section className="empty-state"><h1>출발역과 도착역만 입력하세요.</h1><p>현재 운행 중인 열차 위치와 실제 환승 소요시간을 반영해 최종 도착 시각을 계산합니다.</p></section>}

      {live.liveTrip && <LivePanel trip={live.liveTrip} result={live.liveResult} alertActive={Boolean(push.pushAlert && !push.pushAlert.pending_cancel)} arrivalAlertCapable={push.arrivalAlertCapable} onAlert={() => void push.registerArrivalAlert(live.liveTrip)} onClearAlert={() => void push.clearArrivalAlert()} onFinishTransfer={() => void live.finishTransfer()} onAlight={live.handleAlight} onStop={live.stopTracking} />}

      {search.result && <div className="bottom-actions"><button type="button" className="favorite-save" onClick={search.saveFavorite}>☆ 이 경로 즐겨찾기</button><button type="button" className="share-route" onClick={() => void shareRoute()}><ShareIcon /> <span>경로 공유</span></button><span className="tool-spacer" /><button type="button" className="refresh-route" onClick={() => void refreshJourney()}>현재 정보로 다시 계산</button></div>}
    </main>

    <footer className="app-footer">실시간 정보는 교통상황 및 열차운행에 따라 변경될 수 있습니다. <span>정보 출처 · 서울특별시 열린데이터광장 및 노선별 시간표 데이터</span></footer>
    {toast && <div className="toast" role="status">{toast}</div>}
    {push.pushSheet && <PushOptInSheet state={push.pushState} onAllow={() => void push.requestPush()} onLater={() => push.setPushSheet(false)} />}
    {push.showInstallSheet && !push.installEvent && <InstallSheet onClose={() => push.setShowInstallSheet(false)} />}
    {push.updateReady && <div className="update-toast">새 버전이 준비되었습니다. <button onClick={() => window.location.reload()}>새로고침</button></div>}
  </div>;
}

const rootElement = document.getElementById("root") || (() => { const element = document.createElement("div"); element.id = "root"; document.body.appendChild(element); return element; })();
const root: Root = window.__jigeumtaReactRoot || createRoot(rootElement);
window.__jigeumtaReactRoot = root;
root.render(<App />);
