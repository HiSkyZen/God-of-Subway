import { describe, expect, test } from "bun:test";
import { formatStationSuggestion, stationSuggestionOptions } from "../../src/client/station-suggestions";

describe("station suggestions", () => {
  const stations = { "2호선": ["신촌", "합정"], "경의중앙선": ["신촌", "양평"], "5호선": ["양평"] };

  test("same-name stations keep every line identity", () => {
    const result = stationSuggestionOptions(stations, "신촌");
    expect(result.map((item) => item.line).sort()).toEqual(["2호선", "경의중앙선"]);
    expect(new Set(result.map((item) => item.label)).size).toBe(2);
  });

  test("Korean IME partial composition still matches and labels include a line icon", () => {
    const result = stationSuggestionOptions(stations, "합ㅈ");
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe(formatStationSuggestion("합정", "2호선"));
    expect(result[0].label).toContain("2호선 · 합정");
  });
});
