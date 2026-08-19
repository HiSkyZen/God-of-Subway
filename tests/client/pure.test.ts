import { describe, expect, test } from "bun:test";
import { addMinutesToDateTime, experimentsToCsv, escapeHtml, minutesDiff, parseServiceModeSelection, stationImeKey, stationInitials, stationMatches } from "../../src/client/pure";
import type { ExperimentRecord } from "../../src/client/contract";

describe("client pure functions", () => {
  test("matches Korean station names by syllable, initials, and IME composition prefixes", () => {
    expect(stationInitials("강남역")).toBe("ㄱㄴㅇ");
    expect(stationMatches("강남역", "ㄱㄴ")).toBe(true);
    expect(stationMatches("강남역", "강")).toBe(true);
    expect(stationMatches("강남역", "잠")).toBe(false);
    expect(stationImeKey("합정")).toBe("ㅎㅏㅂㅈㅓㅇ");
    for (const composing of ["ㅎ", "하", "합", "합ㅈ", "합저", "합정"]) expect(stationMatches("합정", composing)).toBe(true);
  });
  test("keeps local datetime arithmetic stable", () => { expect(addMinutesToDateTime("2026-08-18 23:55:00", 10)).toBe("2026-08-19 00:05:00"); expect(minutesDiff("2026-08-19 00:05:00", "2026-08-18 23:55:00")).toBe(10); });
  test("escapes markup and serializes CSV values", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    const record: ExperimentRecord = { id: "exp_1", fingerprint: "fp", created_at: "2026-08-18 09:00:00", completed_at: null, excluded: false, from: "강남", to: "잠실", planned_platform_arrival: "2026-08-18 09:00:00", day_requested: "AUTO", service_mode: "DAY", service_mode_reason: "평일", route_segments: [], route_text: "강남, 내선 → 잠실", transfer_count: 0, baseline_minutes: null, baseline_arrival: null, initial_eta: null, initial_total_seconds: null, initial_quality: "높음", initial_predictions: [], last_eta: null, last_quality: "높음", board_events: [], eta_events: [], actual_arrival: null, note: "" };
    expect(experimentsToCsv([record])).toContain('"강남, 내선 → 잠실"');
  });
  test("preserves AUTO as the requested mode instead of replacing it with health resolution", () => { expect(parseServiceModeSelection("AUTO")).toBe("AUTO"); expect(parseServiceModeSelection("unexpected")).toBe("AUTO"); expect(parseServiceModeSelection("DAY")).toBe("DAY"); });
});
