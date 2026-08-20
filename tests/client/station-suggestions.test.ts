import { describe, expect, test } from "bun:test";
import { lineBadgeSpec, stationSuggestionOptions } from "../../src/client/station-suggestions";

describe("station suggestions", () => {
  const stations = {
    "2호선": ["신촌", "합정"],
    "6호선": ["합정"],
    "경의중앙선": ["신촌", "양평"],
    "5호선": ["양평"],
  };

  test("ordinary interchange stations are shown once with all line badges", () => {
    const result = stationSuggestionOptions(stations, "합정");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ station: "합정", selector: "합정", disambiguated: false });
    expect(result[0].lines.sort()).toEqual(["2호선", "6호선"]);
  });

  test("physically separate same-name stations stay line-qualified", () => {
    const sinchon = stationSuggestionOptions(stations, "신촌");
    expect(sinchon).toHaveLength(2);
    expect(sinchon.every((item) => item.station === "신촌" && item.lines.length === 1 && item.disambiguated)).toBe(true);
    expect(sinchon.map((item) => item.selector).sort()).toEqual(["신촌\u001f2호선", "신촌\u001f경의중앙선"].sort());
    const yangpyeong = stationSuggestionOptions(stations, "양평");
    expect(yangpyeong.map((item) => item.selector).sort()).toEqual(["양평\u001f5호선", "양평\u001f경의중앙선"].sort());
  });

  test("Korean IME partial composition matches while visible value remains station-only", () => {
    const result = stationSuggestionOptions(stations, "합ㅈ");
    expect(result).toHaveLength(1);
    expect(result[0].station).toBe("합정");
    expect(result[0].selector).toBe("합정");
  });

  test("line badges use circle numbers and pill labels instead of emoji", () => {
    expect(lineBadgeSpec("2호선")).toMatchObject({ text: "2", shape: "circle", color: "#00A84D" });
    expect(lineBadgeSpec("경의중앙선")).toMatchObject({ text: "경의중앙", shape: "pill" });
    expect(lineBadgeSpec("우이신설선")).toMatchObject({ text: "우이신설", shape: "pill" });
  });
});
