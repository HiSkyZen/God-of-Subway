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
    transfer_info: { station: "공덕", seconds: 210, alight_position: "4-2", board_position: "6-1" },
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

test("journey timeline renders origin, transfer duration, and final destination", () => {
  const html = renderToStaticMarkup(<UpstreamJourneyView result={result} segments={segments} arrivalTime={result.arrival_time} totalSeconds={1620} activeIndex={0} liveTrip={null} onBoard={() => undefined} onRefresh={() => undefined} />);
  expect(html).toContain("합정");
  expect(html).toContain("환승 3분 30초");
  expect(html).toContain("내릴 문");
  expect(html).toContain("4-2");
  expect(html).toContain("탈 문");
  expect(html).toContain("6-1");
  expect(html).toContain("김포공항");
  expect(html).toContain("최종 목적지");
});

test("app source keeps upstream time strip, visible theme toggle, favorite cards, and opt-in experiment panel", async () => {
  const source = await Bun.file("src/client/app.tsx").text();
  expect(source).toContain("−5분");
  expect(source).toContain("−1분");
  expect(source).toContain("+1분");
  expect(source).toContain("+5분");
  expect(source).toContain("◐ 다크");
  expect(source).toContain("favorite-card");
  expect(source).toContain("experimentOptIn && <ExperimentPanel");
});
