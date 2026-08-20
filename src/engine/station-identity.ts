export interface DisjointHomonymStation {
  station: string;
  lines: readonly [string, string];
  note: string;
}

/**
 * Same-name stations that are different physical facilities and must never be
 * connected by a zero-/walking-transfer edge merely because their names match.
 *
 * Keep this registry deliberately small and auditable. Legitimate same-name
 * interchange stations are represented by transfer_data.json/physical policy.
 */
export const DISJOINT_HOMONYM_STATIONS: readonly DisjointHomonymStation[] = [
  {
    station: "신촌",
    lines: ["2호선", "경의중앙선"],
    note: "2호선 신촌역과 경의중앙선 신촌역은 약 700m 떨어진 별도 역사이며 철도 환승역이 아님",
  },
  {
    station: "양평",
    lines: ["5호선", "경의중앙선"],
    note: "5호선 양평역은 서울 영등포구, 경의중앙선 양평역은 경기 양평군의 별도 역사",
  },
] as const;

function normalizedName(value: unknown): string {
  let station = String(value ?? "").trim().replaceAll(" ", "");
  if (station.endsWith("역") && station !== "서울역") station = station.slice(0, -1);
  return station;
}

export function isDisjointHomonymTransfer(station: unknown, fromLine: unknown, toLine: unknown): boolean {
  const name = normalizedName(station);
  const from = String(fromLine ?? "").trim();
  const to = String(toLine ?? "").trim();
  if (!name || !from || !to || from === to) return false;
  return DISJOINT_HOMONYM_STATIONS.some((entry) => {
    if (entry.station !== name) return false;
    const [a, b] = entry.lines;
    return (from === a && to === b) || (from === b && to === a);
  });
}
