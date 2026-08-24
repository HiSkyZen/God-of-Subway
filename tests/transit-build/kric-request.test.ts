import { describe, expect, test } from "bun:test";
import {
  buildKricUrl,
  normalizeKricServiceKey,
  parseKricJsonText,
} from "../../scripts/transit-build/common";

describe("KRIC request construction", () => {
  test("does not double-encode a data-portal encoded service key", () => {
    const encodedKey = "abc%2Fdef%2Bghi%3D%3D";
    const url = buildKricUrl("trainUseInfo/subwayTimetableExp", {
      railOprIsttCd: "KR",
      dayCd: "8",
      lnCd: "1",
      stinCd: "P152",
    }, encodedKey);

    expect(url.searchParams.get("serviceKey")).toBe("abc/def+ghi==");
    expect(url.href).toContain("serviceKey=abc%2Fdef%2Bghi%3D%3D");
    expect(url.href).not.toContain("%252F");
    expect(url.href).not.toContain("%252B");
  });

  test("keeps a decoded service key semantically identical", () => {
    expect(normalizeKricServiceKey(" abc/def+ghi== ")).toBe("abc/def+ghi==");
    const url = buildKricUrl("trainUseInfo/subwayTimetableExp", {
      railOprIsttCd: "KR",
      dayCd: "8",
      lnCd: "1",
      stinCd: "152",
    }, "abc/def+ghi==");
    expect(url.searchParams.get("serviceKey")).toBe("abc/def+ghi==");
  });

  test("matches the documented timetable query parameter order", () => {
    const url = buildKricUrl("trainUseInfo/subwayTimetableExp", {
      stinCd: "152",
      lnCd: "1",
      dayCd: "8",
      railOprIsttCd: "KR",
    }, "test-key");
    expect(url.search).toBe(
      "?serviceKey=test-key&format=json&railOprIsttCd=KR&dayCd=8&lnCd=1&stinCd=152",
    );
  });

  test("accepts UTF-8 BOM-prefixed JSON responses", () => {
    expect(parseKricJsonText("\uFEFF  {\"ok\":true}\n")).toEqual({ ok: true });
  });
});
