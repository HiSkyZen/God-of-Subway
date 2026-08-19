import { GTX_LINES, type GtxLine } from "./gtx-topology";
import { canonStation, dayStart } from "./timetable-service";

const NORTH_TO_SEOUL = `05:30 05:40 05:50 06:00 06:06 06:12 06:18 06:25 06:31 06:37 06:43 06:50 06:56 07:02 07:08 07:15 07:21 07:27 07:33 07:40 07:46 07:52 07:58 08:05 08:11 08:17 08:23 08:30 08:36 08:42 08:48 08:55 09:03 09:11 09:19 09:27 09:35 09:43 09:51 10:00 10:10 10:20 10:30 10:40 10:50 11:00 11:10 11:20 11:30 11:40 11:50 12:00 12:10 12:20 12:30 12:40 12:50 13:00 13:10 13:20 13:30 13:40 13:48 13:56 14:04 14:12 14:20 14:28 14:36 14:44 14:52 15:00 15:08 15:16 15:24 15:32 15:40 15:48 15:56 16:04 16:12 16:20 16:27 16:34 16:40 16:46 16:52 16:59 17:05 17:11 17:17 17:24 17:30 17:36 17:42 17:49 17:55 18:01 18:07 18:14 18:20 18:26 18:32 18:39 18:45 18:51 18:57 19:04 19:10 19:16 19:22 19:29 19:37 19:45 19:53 20:01 20:09 20:17 20:25 20:33 20:41 20:49 20:57 21:05 21:13 21:21 21:30 21:40 21:50 22:00 22:10 22:20 22:30 22:45 23:00 23:15 23:30 23:45 00:00 00:18 00:38`.split(" ");
const NORTH_TO_UNJEONG = `05:30 05:45 06:00 06:10 06:20 06:30 06:36 06:42 06:48 06:55 07:01 07:07 07:13 07:20 07:26 07:32 07:38 07:45 07:51 07:57 08:03 08:10 08:16 08:22 08:28 08:35 08:41 08:47 08:53 09:00 09:06 09:12 09:18 09:25 09:33 09:41 09:49 09:57 10:05 10:13 10:21 10:30 10:40 10:50 11:00 11:10 11:20 11:30 11:40 11:50 12:00 12:10 12:20 12:30 12:40 12:50 13:00 13:10 13:20 13:30 13:40 13:50 14:00 14:10 14:18 14:26 14:34 14:42 14:50 14:58 15:06 15:14 15:22 15:38 15:46 15:54 16:02 16:10 16:18 16:26 16:34 16:42 16:50 16:57 17:04 17:10 17:16 17:22 17:29 17:35 17:41 17:47 17:54 18:00 18:06 18:12 18:19 18:25 18:31 18:37 18:44 18:50 18:56 19:02 19:09 19:15 19:21 19:27 19:34 19:40 19:46 19:52 19:59 20:07 20:15 20:23 20:31 20:39 20:47 20:55 21:03 21:11 21:19 21:27 21:35 21:43 21:51 22:00 22:10 22:20 22:30 22:40 22:55 23:10 23:25 23:40 23:55 00:10 00:25 00:38`.split(" ");
const SOUTH_TO_DONGTAN = `05:45 06:04 06:13 06:21 06:44 07:09 07:29 07:46 08:09 08:21 08:35 08:49 09:10 09:27 09:47 10:04 10:10 10:36 11:04 11:30 11:50 12:09 12:32 12:41 13:14 13:34 13:46 14:00 14:20 14:45 15:10 15:33 15:47 16:02 16:25 16:43 16:59 17:15 17:34 17:47 18:10 18:28 18:42 18:51 19:28 19:46 20:04 20:19 20:35 20:50 21:12 21:32 21:50 22:08 22:30 23:00 23:25 23:50 00:15 00:39`.split(" ");
const SOUTH_TO_SUSEO = `05:30 05:49 06:09 06:26 06:43 07:02 07:22 07:36 07:55 08:14 08:28 08:44 09:00 09:18 09:30 09:50 10:14 10:30 10:50 11:12 11:36 12:05 12:32 12:55 13:12 13:22 13:47 14:09 14:24 14:45 15:10 15:28 15:38 15:58 16:10 16:33 16:49 17:07 17:26 17:44 18:06 18:19 18:43 19:00 19:15 19:29 19:46 20:00 20:35 20:47 21:00 21:17 21:31 21:44 22:15 22:37 23:12 23:39 00:06 00:27`.split(" ");

const OFFSETS: Record<GtxLine, { forward: number[]; reverse: number[] }> = {
  "GTX-A(북부)": {
    forward: [0, 240, 540, 960, 1320],
    reverse: [1260, 1020, 720, 360, 0],
  },
  "GTX-A(남부)": {
    forward: [0, 420, 840, 1260],
    reverse: [1260, 840, 420, 0],
  },
};

const TERMINAL_TIMES: Record<GtxLine, { forward: string[]; reverse: string[] }> = {
  "GTX-A(북부)": { forward: NORTH_TO_SEOUL, reverse: NORTH_TO_UNJEONG },
  "GTX-A(남부)": { forward: SOUTH_TO_DONGTAN, reverse: SOUTH_TO_SUSEO },
};

function clockSeconds(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 3600 + m * 60;
}

function serviceOccurrence(start: Date, clock: string, stationOffset: number): Date {
  const seconds = clockSeconds(clock) + stationOffset;
  const serviceBase = dayStart(new Date(start.getTime() - (start.getUTCHours() < 2 ? 86400000 : 0)));
  const afterMidnight = clockSeconds(clock) < 2 * 3600 ? 86400 : 0;
  return new Date(serviceBase.getTime() + (seconds + afterMidnight) * 1000);
}

export interface GtxScheduledCandidate {
  /** Internal schedule identity only; never a public GTX-A service number. */
  trainNo: string;
  board: Date;
  alight: Date;
  wanted: 1 | -1;
  scheduled: true;
}

export function scheduledGtxCandidates(line: GtxLine, from: string, to: string, start: Date, maxWaitSeconds = 3600): GtxScheduledCandidate[] {
  const cfg = GTX_LINES[line];
  const fromName = canonStation(from);
  const toName = canonStation(to);
  const fi = cfg.stations.indexOf(fromName as never);
  const ti = cfg.stations.indexOf(toName as never);
  if (fi < 0 || ti < 0 || fi === ti) return [];
  const forward = fi < ti;
  const wanted: 1 | -1 = forward ? 1 : -1;
  const times = forward ? TERMINAL_TIMES[line].forward : TERMINAL_TIMES[line].reverse;
  const offsets = forward ? OFFSETS[line].forward : OFFSETS[line].reverse;
  const boardOffset = offsets[fi];
  const alightOffset = offsets[ti];
  const rideSeconds = Math.abs(alightOffset - boardOffset);
  const out: GtxScheduledCandidate[] = [];
  times.forEach((clock, index) => {
    const board = serviceOccurrence(start, clock, boardOffset);
    const wait = (board.getTime() - start.getTime()) / 1000;
    if (wait < -5 || wait > maxWaitSeconds) return;
    out.push({
      trainNo: `GTX-SCHED-${line === "GTX-A(북부)" ? "N" : "S"}-${forward ? "F" : "R"}-${String(index + 1).padStart(3, "0")}`,
      board,
      alight: new Date(board.getTime() + rideSeconds * 1000),
      wanted,
      scheduled: true,
    });
  });
  return out.sort((a, b) => a.board.getTime() - b.board.getTime()).slice(0, 8);
}
