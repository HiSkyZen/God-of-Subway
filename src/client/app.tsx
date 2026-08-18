import { useEffect, useRef } from "react";
import type { FormEvent, ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initializeAnalytics } from "./analytics";
import { BellIcon, ExperimentPanel, InstallSheet, JourneyRail, JourneySummary, LivePanel, PushOptInSheet, ShareIcon, StationInput } from "./components";
import { useClock, useToast } from "./hooks";
import { parseServiceModeSelection } from "./pure";
import { useJourneySearch } from "./use-journey-search";
import { useLiveJourney } from "./use-live-journey";
import { usePushPwa } from "./use-push-pwa";

initializeAnalytics();

declare global {
  interface Window {
    __jigeumtaReactRoot?: Root;
  }
}

function App(): ReactElement {
  const now = useClock();
  const [toast, notify] = useToast();
  const search = useJourneySearch(notify);
  const push = usePushPwa(notify, "/sw.js");
  const live = useLiveJourney({
    result: search.result,
    day: search.day,
    baseline: search.baseline,
    alert: push.pushAlert,
    notify,
    onBoardEvent: search.recordBoardEvent,
    onEtaEvent: search.recordEtaUpdate,
    onSyncAlert: push.syncArrivalAlert,
    onClearAlert: push.clearArrivalAlert,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!live.liveTrip || search.result || !live.restoredResult) return;
    search.restoreTrip(live.liveTrip, live.restoredResult);
  }, [live.liveTrip?.journeyStartedAt, Boolean(search.result)]);

  const activeSegments = live.liveTrip?.displaySegments || live.liveResult?.segments || search.result?.segments || [];
  const visibleTrip = live.liveTrip && (live.liveResult || live.liveTrip.displaySegments.length > 0) ? live.liveTrip : null;
  const totalSeconds = live.liveResult?.remaining_seconds ?? live.liveResult?.estimated_total_seconds ?? search.result?.total_seconds ?? search.result?.estimated_total_seconds ?? 0;
  const arrivalTime = live.liveResult?.arrival_time ?? live.liveResult?.estimated_arrival_time ?? search.result?.arrival_time ?? search.result?.estimated_arrival_time;
  const quality = activeSegments.reduce<string>((value, segment) => value === "낮음" || segment.confidence === "낮음" ? "낮음" : value === "중간" || segment.confidence === "중간" ? "중간" : "높음", "높음");

  const runSearch = async (event?: FormEvent, offset?: number): Promise<void> => {
    if (await search.search(event, offset)) live.clearLiveResult();
  };

  const refreshJourney = async (): Promise<void> => {
    try {
      if (await live.refreshLiveJourney()) return;
      await search.refreshRoute();
    } catch (caught: unknown) { notify(caught instanceof Error ? `갱신 실패: ${caught.message}` : "갱신에 실패했습니다."); }
  };

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="./" aria-label="지금타 홈"><img src="./jigeumta_logo_140.png" alt="" /><span>지금<span>타</span></span></a>
      <nav className="header-actions" aria-label="주요 작업">
        <span className={`service-status ${search.healthState}`}><i /> {search.healthState === "ok" ? "서비스 정상" : search.healthState === "error" ? "연결 확인 필요" : "연결 확인 중"}</span>
        <span className="clock-label">{now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
        <button className="text-action" onClick={() => push.setPushSheet(true)} aria-label="알림 받기"><BellIcon /> <span>알림 받기</span></button>
        {(push.installEvent || push.showInstallSheet) && <button className="text-action" onClick={() => push.installEvent ? void push.install() : push.setShowInstallSheet(true)}>⇩ <span>앱 설치</span></button>}
        <button className="text-action" onClick={search.saveFavorite}>☆ <span>즐겨찾기</span></button>
        <button className="text-action" onClick={search.toggleSettings}>⚙ <span>설정</span></button>
      </nav>
    </header>
    <main>
      <form className="search-panel" onSubmit={(event) => void runSearch(event)}>
        <StationInput label="출발역" value={search.from} side="from" suggestions={search.activeSuggestion === "from" ? search.suggestions : []} activeIndex={search.suggestionIndex} inputRef={inputRef} onChange={search.setFrom} onFocus={() => { search.setActiveSuggestion("from"); search.setSuggestionIndex(-1); }} onBlur={() => window.setTimeout(() => search.setActiveSuggestion(null), 140)} onKeyDown={search.onStationKeyDown} onSelect={search.selectSuggestion} />
        <button type="button" className="swap-button" onClick={search.swap} aria-label="출발역과 도착역 바꾸기">⇄</button>
        <StationInput label="도착역" value={search.to} side="to" suggestions={search.activeSuggestion === "to" ? search.suggestions : []} activeIndex={search.suggestionIndex} onChange={search.setTo} onFocus={() => { search.setActiveSuggestion("to"); search.setSuggestionIndex(-1); }} onBlur={() => window.setTimeout(() => search.setActiveSuggestion(null), 140)} onKeyDown={search.onStationKeyDown} onSelect={search.selectSuggestion} />
        <label className="time-control"><span>시간</span><select value={search.searchMinutes} onChange={(event) => search.adjustTime(Number(event.target.value))}><option value={0}>지금</option><option value={-5}>- 5분</option><option value={-1}>- 1분</option><option value={1}>+ 1분</option><option value={5}>+ 5분</option><option value={10}>+ 10분</option><option value={15}>+ 15분</option><option value={20}>+ 20분</option><option value={30}>+ 30분</option></select></label>
        <button className="primary-button search-button" type="submit" disabled={search.loading}>{search.loading ? "조회 중…" : "조회  →"}</button>
      </form>
      <div className="search-tools">
        <button type="button" onClick={search.toggleSettings}>{search.showSettings ? "설정 닫기" : "상세 설정"}</button>
        {search.favorites.length > 0 && <><select aria-label="즐겨찾기" id="favorite-route" onChange={(event) => { const favorite = search.favorites.find((item) => item.id === event.target.value); if (favorite) search.loadFavorite(favorite); }}><option value="">즐겨찾기</option>{search.favorites.map((favorite) => <option key={favorite.id} value={favorite.id}>{favorite.name}</option>)}</select><button type="button" onClick={() => { const select = document.getElementById("favorite-route"); if (select instanceof HTMLSelectElement) search.deleteFavorite(select.value); }}>삭제</button></>}
        <span className="tool-spacer" />
        {[-5, -1, 1, 5].map((minutes) => <button type="button" key={minutes} onClick={() => search.adjustTime(minutes)}>{minutes > 0 ? `+ ${minutes}` : minutes}분</button>)}
        <button type="button" onClick={search.saveFavorite}>☆ 즐겨찾기에 추가</button>
      </div>
      {search.showSettings && <section className="settings-panel" aria-label="상세 설정">
        <label>운행일<select value={search.day} onChange={(event) => search.setDay(parseServiceModeSelection(event.target.value))}><option value="AUTO">자동</option><option value="DAY">평일</option><option value="SAT">토요일</option><option value="END">일요일·공휴일</option></select></label>
        <label>조회 시각<input type="time" value={search.exactTime} onChange={(event) => search.setExactTime(event.target.value)} /></label>
        <label>기존 앱 예상 총시간 · 실험용<input type="number" min={1} value={search.baseline} onChange={(event) => search.setBaseline(event.target.value)} placeholder="예: 62" /></label>
        <label className="checkbox-label"><input type="checkbox" checked={search.experimentEnabled} onChange={(event) => search.setExperimentEnabled(event.target.checked)} /> 기말 실험 자동 기록</label>
      </section>}
      {search.error && <p className="error-banner" role="alert">{search.error}</p>}
      {search.result ? <JourneySummary result={search.result} activeSegments={activeSegments} arrivalTime={arrivalTime} totalSeconds={totalSeconds} quality={quality} live={Boolean(live.liveTrip)} onRefresh={() => void refreshJourney()} /> : <section className="empty-state"><span className="empty-train">◎</span><h1>출발역과 도착역만 입력하세요.</h1><p>현재 열차 위치와 실제 환승시간까지 반영합니다.</p></section>}
      {search.result && <JourneyRail segments={activeSegments} activeIndex={live.liveTrip?.activeIndex ?? 0} liveTrip={visibleTrip} onBoard={live.startTracking} />}
      {live.liveTrip && <LivePanel trip={live.liveTrip} result={live.liveResult} alertActive={Boolean(push.pushAlert && !push.pushAlert.pending_cancel)} arrivalAlertCapable={push.arrivalAlertCapable} onAlert={() => void push.registerArrivalAlert(live.liveTrip)} onClearAlert={() => void push.clearArrivalAlert()} onFinishTransfer={() => void live.finishTransfer()} onAlight={live.handleAlight} onStop={live.stopTracking} />}
      {search.result && <div className="bottom-actions">
        <button type="button" onClick={search.saveFavorite}>☆ 즐겨찾기에 추가</button>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(`${search.from} → ${search.to}`); notify("경로를 복사했습니다."); }}><ShareIcon /> 공유</button>
        <span className="tool-spacer" /><span>다른 시간 조회</span>
        {[-5, -1, 1, 5, 10, 15, 20, 30].map((minutes) => <button type="button" key={minutes} onClick={() => { search.adjustTime(minutes); void runSearch(undefined, minutes); }}>{minutes > 0 ? `+ ${minutes}` : minutes}분</button>)}
      </div>}
      <ExperimentPanel experiments={search.experiments} onArrive={search.arriveExperiment} onUpdate={search.updateExperiment} onDelete={search.deleteExperiment} onCsv={() => search.exportExperiments("csv")} onJson={() => search.exportExperiments("json")} />
    </main>
    <footer className="app-footer">실시간 정보는 교통상황 및 열차운행에 따라 변경될 수 있습니다. <span>정보 출처 · 서울교통공사</span></footer>
    {toast && <div className="toast" role="status">{toast}</div>}
    {push.pushSheet && <PushOptInSheet state={push.pushState} onAllow={() => void push.requestPush()} onLater={() => push.setPushSheet(false)} />}
    {push.showInstallSheet && !push.installEvent && <InstallSheet onClose={() => push.setShowInstallSheet(false)} />}
    {push.updateReady && <div className="update-toast">새 버전이 준비되었습니다. <button onClick={() => window.location.reload()}>새로고침</button></div>}
  </div>;
}

const rootElement = document.getElementById("root") || (() => {
  const element = document.createElement("div");
  element.id = "root";
  document.body.appendChild(element);
  return element;
})();
const root: Root = window.__jigeumtaReactRoot || createRoot(rootElement);
window.__jigeumtaReactRoot = root;
root.render(<App />);
