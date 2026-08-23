import { describe, expect, test } from "bun:test";
import {
  unorderedLinePairs,
  unorderedTransferPairCount,
} from "../../src/infra/transfer-pairs";

describe("physical transfer pair combinatorics", () => {
  test("one distance exists for every unordered pair of lines (nC2)", () => {
    expect(unorderedTransferPairCount(0)).toBe(0);
    expect(unorderedTransferPairCount(1)).toBe(0);
    expect(unorderedTransferPairCount(2)).toBe(1);
    expect(unorderedTransferPairCount(3)).toBe(3);
    expect(unorderedTransferPairCount(4)).toBe(6);
    expect(unorderedTransferPairCount(5)).toBe(10);
  });

  test("pair generation does not collapse a multi-line station to one distance", () => {
    const pairs = unorderedLinePairs(["1호선", "2호선", "GTX-A(북부)", "경의중앙선"]);
    expect(pairs).toHaveLength(6);
    expect(new Set(pairs.map(([a, b]) => `${a}|${b}`)).size).toBe(6);
  });
});
