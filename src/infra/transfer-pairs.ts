/** Number of distinct unordered line-to-line transfers at one physical station. */
export function unorderedTransferPairCount(lineCount: number): number {
  const n = Math.max(0, Math.trunc(lineCount));
  return n < 2 ? 0 : n * (n - 1) / 2;
}

export function unorderedLinePairs(lines: readonly string[]): Array<readonly [string, string]> {
  const unique = [...new Set(lines.map((line) => line.trim()).filter(Boolean))].sort();
  const pairs: Array<readonly [string, string]> = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      pairs.push([unique[i], unique[j]] as const);
    }
  }
  return pairs;
}
