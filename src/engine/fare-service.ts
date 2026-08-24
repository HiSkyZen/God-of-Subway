import type { SegmentInput } from "../types/domain";
import { repository } from "./data-repository";
import { GTX_LINES, isGtxLine, type GtxLine } from "./gtx-topology";
import { canonStation, routePair, routeTrains } from "./timetable-service";

export interface FareEstimate {
  adult_card_won: number;
  distance_km: number;
  standard_distance_km: number;
  gtx_distance_km: number;
  shinbundang_surcharge_won: number;
  basis: string;
}

const SHINBUNDANG = [
  "신사", "논현", "신논현", "강남", "양재", "양재시민의숲", "청계산입구", "판교",
  "정자", "미금", "동천", "수지구청", "성복", "상현", "광교중앙", "광교",
] as const;

function radians(value: number): number { return value * Math.PI / 180; }
function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const earthKm = 6371.0088;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude); const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function gtxDistance(line: GtxLine, from: string, to: string): number {
  const cfg = GTX_LINES[line];
  const a = cfg.stations.indexOf(canonStation(from) as never);
  const b = cfg.stations.indexOf(canonStation(to) as never);
  if (a < 0 || b < 0 || a === b) return 0;

  // Public fare material gives the complete operating-section length, but not
  // every interstation settlement distance in the timetable API.  Allocate the
  // section distance by scheduled interstation running time and label the final
  // result as an estimate.
  const sectionKm = line === "GTX-A(남부)" ? 32.8 : 32.3;
  const fullSeconds = cfg.segmentSeconds.reduce((sum, value) => sum + value, 0);
  let seconds = 0;
  for (let index = Math.min(a, b); index < Math.max(a, b); index += 1) {
    seconds += cfg.segmentSeconds[index] ?? 0;
  }
  return fullSeconds > 0 ? sectionKm * seconds / fullSeconds : 0;
}

function stationPath(line: string, mode: string, from: string, to: string): string[] {
  const a = canonStation(from); const b = canonStation(to);
  for (const train of routeTrains(line, mode, a, b)) {
    const pair = routePair(train.stops, a, b);
    if (!pair) continue;
    return train.stops
      .slice(pair[0], pair[1] + 1)
      .filter((stop) => stop.call !== false)
      .map((stop) => canonStation(stop.station));
  }
  return [a, b];
}

function ordinaryDistance(line: string, mode: string, from: string, to: string): number {
  const stations = stationPath(line, mode, from, to);
  let total = 0; let usableEdges = 0;
  for (let index = 0; index < stations.length - 1; index += 1) {
    const a = repository.stationCoordinates(line, stations[index]);
    const b = repository.stationCoordinates(line, stations[index + 1]);
    if (!a || !b) continue;
    total += haversineKm(a, b);
    usableEdges += 1;
  }
  if (usableEdges) return total;
  const a = repository.stationCoordinates(line, canonStation(from));
  const b = repository.stationCoordinates(line, canonStation(to));
  return a && b ? haversineKm(a, b) : 0;
}

export function standardDistanceFare(distanceKm: number): number {
  if (distanceKm <= 10) return 1550;
  if (distanceKm <= 50) return 1550 + Math.ceil((distanceKm - 10 - 1e-9) / 5) * 100;
  return 2350 + Math.ceil((distanceKm - 50 - 1e-9) / 8) * 100;
}

export function gtxDistanceFare(distanceKm: number): number {
  if (distanceKm <= 10) return 3200;
  return 3200 + Math.ceil((distanceKm - 10 - 1e-9) / 5) * 250;
}

function shinbundangSectionMask(from: string, to: string): number {
  const a = SHINBUNDANG.indexOf(canonStation(from) as never);
  const b = SHINBUNDANG.indexOf(canonStation(to) as never);
  if (a < 0 || b < 0 || a === b) return 0;
  const lo = Math.min(a, b); const hi = Math.max(a, b);
  const gangnam = SHINBUNDANG.indexOf("강남");
  const jeongja = SHINBUNDANG.indexOf("정자");
  let mask = 0;
  if (lo < gangnam && hi > 0) mask |= 1;
  if (lo < jeongja && hi > gangnam) mask |= 2;
  if (lo < SHINBUNDANG.length - 1 && hi > jeongja) mask |= 4;
  return mask;
}

export function shinbundangSurcharge(segments: readonly SegmentInput[]): number {
  let mask = 0;
  for (const segment of segments) {
    if (String(segment.line) !== "신분당선") continue;
    mask |= shinbundangSectionMask(String(segment.from), String(segment.to));
  }
  switch (mask) {
    case 1: return 700;
    case 2:
    case 4: return 1000;
    case 3: return 1700;
    case 6: return 1500;
    case 7: return 2200;
    default: return 0;
  }
}

/**
 * Adult-card fare estimate for route ranking.
 *
 * Ordinary metro follows the metropolitan 1,550-won / distance-band schedule.
 * GTX-A follows the public 3,200-won base and 250 won per additional 5 km after
 * 10 km. Shinbundang adds the current section surcharge. Public timetable data
 * does not expose the settlement distance used by the fare engine, so station
 * coordinates are used only for this fare estimate, never for transfer time.
 */
export function estimateRouteFare(segments: readonly SegmentInput[], mode = "DAY"): FareEstimate {
  let standardDistanceKm = 0;
  let gtxDistanceKm = 0;
  for (const segment of segments) {
    const line = String(segment.line ?? "");
    if (isGtxLine(line)) {
      gtxDistanceKm += gtxDistance(line, String(segment.from), String(segment.to));
    } else {
      standardDistanceKm += ordinaryDistance(line, mode, String(segment.from), String(segment.to));
    }
  }
  const surcharge = shinbundangSurcharge(segments);
  const ordinaryFare = standardDistanceFare(standardDistanceKm);
  let fare = ordinaryFare;
  if (gtxDistanceKm > 0) {
    fare = gtxDistanceFare(gtxDistanceKm) + Math.max(0, ordinaryFare - 1550);
  }
  fare += surcharge;
  return {
    adult_card_won: fare,
    distance_km: Math.round((standardDistanceKm + gtxDistanceKm) * 10) / 10,
    standard_distance_km: Math.round(standardDistanceKm * 10) / 10,
    gtx_distance_km: Math.round(gtxDistanceKm * 10) / 10,
    shinbundang_surcharge_won: surcharge,
    basis: "수도권 거리비례 운임 + GTX-A 거리운임 + 신분당선 구간별 별도운임(예상)",
  };
}
