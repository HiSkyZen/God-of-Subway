import { describe, expect, test } from "bun:test";
import { addMinutesToDateTime, escapeHtml, minutesDiff, parseServiceModeSelection, stationImeKey, stationInitials, stationMatches } from "../../src/client/pure";

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
  test("escapes markup", () => { expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"); });
  test("preserves AUTO as the requested mode instead of replacing it with health resolution", () => { expect(parseServiceModeSelection("AUTO")).toBe("AUTO"); expect(parseServiceModeSelection("unexpected")).toBe("AUTO"); expect(parseServiceModeSelection("DAY")).toBe("DAY"); });
});
