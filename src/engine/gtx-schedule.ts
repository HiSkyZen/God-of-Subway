import { GTX_LINES, type GtxLine } from "./gtx-topology";
import { canonStation, routePair, routeTrains, scheduleDtAfter, stopAlightSec, stopBoardSec } from "./timetable-service";

export interface GtxScheduledCandidate { trainNo: string; board: Date; alight: Date; wanted: 1 | -1; scheduled: true; }
function publicTrainNo(value: unknown): string { const raw = String(value ?? "").trim().toUpperCase(); if (/^X\d{4}$/.test(raw)) return raw; const digits = raw.replace(/\D/g, ""); return digits ? `X${digits.slice(-4).padStart(4, "0")}` : raw; }
export function scheduledGtxTrainNumber(_line: GtxLine, _forward: boolean, index: number): string { return `X${String(index + 1).padStart(4, "0")}`; }
/** GTX-A timetable candidates are read from the same normalized SQLite trip/stop_time tables as every other line. */
export function scheduledGtxCandidates(line: GtxLine, from: string, to: string, start: Date, mode = "DAY", maxWaitSeconds = 3600): GtxScheduledCandidate[] {
  const cfg = GTX_LINES[line]; const fromName = canonStation(from); const toName = canonStation(to); const fi = cfg.stations.indexOf(fromName as never); const ti = cfg.stations.indexOf(toName as never); if (fi < 0 || ti < 0 || fi === ti) return []; const wanted: 1 | -1 = fi < ti ? 1 : -1; const result: GtxScheduledCandidate[] = [];
  for (const train of routeTrains(line, mode, fromName, toName)) { const pair = routePair(train.stops, fromName, toName); if (!pair) continue; const boardSec = stopBoardSec(train.stops[pair[0]]); let alightSec = stopAlightSec(train.stops[pair[1]]); if (boardSec === null || alightSec === null) continue; while (alightSec < boardSec) alightSec += 86400; const board = scheduleDtAfter(boardSec, start, 0); if (!board) continue; const wait = (board.getTime() - start.getTime()) / 1000; if (wait < -5 || wait > maxWaitSeconds) continue; result.push({ trainNo: publicTrainNo(train.train_no), board, alight: new Date(board.getTime() + (alightSec - boardSec) * 1000), wanted, scheduled: true }); }
  return result.sort((a, b) => a.board.getTime() - b.board.getTime()).slice(0, 8);
}
