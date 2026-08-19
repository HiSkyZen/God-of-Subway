import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UpstreamJourneyView } from "../../src/client/journey-view";
import type { AutoRouteResponse, RouteSegment } from "../../src/client/contract";

const segments: RouteSegment[] = [
  {
    line: "6호선",
    from: "합정",
    to: "공덕",
    train_no: "6123",
    destination: "응암",
    board_dt: "2026-08-18 23:45:00",
    alight_dt: "2026-08-18 23:55:00",
    transfer_seconds: 210,
    transfer_info: { station: "공덕", seconds: 210, alight_position: "4-2", board_position: "6-1", from_direction: "이상한 방향값", to_direction: "이상한 방향값" },
    nearby_candidates: [{ line: "6호선", from: "합정", to: "공덕", train_no: "6125", board_dt: "2026-08-18 23:48:00" }],
    previous_candidate: { line: "6호선", from: "합정", to: "공덕", train_no: "6121", board_dt: "2026-08-18 23:42:00" },
    confidence: "높음",
  },
  {
    line: "공항철도",
    from: "공덕",
    to: "김포공항",
    train_no: "A101",
    destination: "인천공항2터미널",
    board_dt: "2026-08-18 23:58:30",
    alight_dt: "2026-08-19 00:12:00",
    confidence: "중간",
  },
];

const result: AutoRouteResponse = {
  ok: true,
  from: "합정",
  to: "김포공항",
  arrival_time: "2026-08-19 00:12:00",
  total_seconds: 1620,
  transfer_count: 1,
  segments,
};

test("journey timeline renders useful transfer details without direction noise", () => {
  const html = renderToStaticMarkup(<UpstreamJourneyView result={result} segments={segments} arrivalTime={result.arrival_time} totalSeconds={1620} activeIndex={0} liveTrip={null} onBoard={() => undefined} onRefresh={() => undefined} onExcludeGtx={() => undefined} />);
  expect(html).toContain("합정");
  expect(html).toContain("환승 3분 30초");
  expect(html).toContain("내릴 문");
  expect(html).toContain("4-2");
  expect(html).toContain("탈 문");
  expect(html).toContain("6-1");
  expect(html).not.toContain("내리는 방향");
  expect(html).not.toContain("타는 방향");
  expect(html).not.toContain("이상한 방향값");
  expect(html).toContain("다른 열차를 탔어요");
  expect(html).toContain("김포공항");
  expect(html).toContain("최종 목적지");
});

test("GTX route exposes a one-click exclusion rerun when an ordinary route is possible", () => {
  const gtx: RouteSegment[] = [{ line: "GTX-A(북부)", from: "연신내", to: "서울역", train_no: "X1009", tracking_id: "1009", board_dt: "2026-08-18 23:45:00", alight_dt: "2026-08-18 23:51:00" }];
  const gtxResult: AutoRouteResponse = { ok: true, from: "연신내", to: "서울역", arrival_time: "2026-08-18 23:51:00", segments: gtx };
  const html = renderToStaticMarkup(<UpstreamJourneyView result={gtxResult} segments={gtx} arrivalTime={gtxResult.arrival_time} totalSeconds={360} activeIndex={0} liveTrip={null} onBoard={() => undefined} onRefresh={() => undefined} onExcludeGtx={() => undefined} />);
  expect(html).toContain("GTX-A 제외하기");
});

test("GTX-exclusive endpoints never offer an impossible GTX exclusion", () => {
  const gtx: RouteSegment[] = [{ line: "GTX-A(북부)", from: "운정중앙", to: "서울역", train_no: "X1011", tracking_id: "1011", board_dt: "2026-08-18 23:45:00", alight_dt: "2026-08-18 23:57:00" }];
  const gtxResult: AutoRouteResponse = { ok: true, from: "운정중앙", to: "서울역", arrival_time: "2026-08-18 23:57:00", segments: gtx };
  const html = renderToStaticMarkup(<UpstreamJourneyView result={gtxResult} segments={gtx} arrivalTime={gtxResult.arrival_time} totalSeconds={720} activeIndex={0} liveTrip={null} onBoard={() => undefined} onRefresh={() => undefined} onExcludeGtx={() => undefined} />);
  expect(html).not.toContain("GTX-A 제외하기");
});

test("public train number is shown without leaking the Shinbundang timetable id", () => {
  const sb: RouteSegment[] = [{ line: "신분당선", from: "강남", to: "판교", train_no: "D007", tracking_id: "SB-W-0042", board_dt: "2026-08-18 10:00:00", alight_dt: "2026-08-18 10:15:00" }];
  const sbResult: AutoRouteResponse = { ok: true, from: "강남", to: "판교", arrival_time: "2026-08-18 10:15:00", segments: sb };
  const html = renderToStaticMarkup(<UpstreamJourneyView result={sbResult} segments={sb} arrivalTime={sbResult.arrival_time} totalSeconds={900} activeIndex={0} liveTrip={null} onBoard={() => undefined} onRefresh={() => undefined} onExcludeGtx={() => undefined} />);
  expect(html).toContain("D007열차");
  expect(html).not.toContain("SB-W-0042");
});

test("app source keeps time controls, tracking guard, theme, favorites, and opt-in experiment panel", async () => {
  const source = await Bun.file("src/client/app.tsx").text();
  expect(source).toContain("−5분");
  expect(source).toContain("−1분");
  expect(source).toContain("+1분");
  expect(source).toContain("+5분");
  expect(source).toContain("time-picker");
  expect(source).toContain("새 경로를 조회하면 현재 추적이 중단됩니다");
  expect(source).toContain("excludeGtx: true");
  expect(source).toContain("◐ 다크");
  expect(source).toContain("favorite-card");
  expect(source).toContain("experimentOptIn && <ExperimentPanel");
});
