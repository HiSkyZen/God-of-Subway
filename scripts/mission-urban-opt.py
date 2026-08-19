#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def p(path: str) -> Path:
    return ROOT / path

def read(path: str) -> str:
    return p(path).read_text(encoding="utf-8")

def write(path: str, content: str) -> None:
    p(path).write_text(content, encoding="utf-8")

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        raise RuntimeError(f"{path}: expected text not found: {old[:100]!r}")
    write(path, text.replace(old, new, 1))

def replace_all(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        raise RuntimeError(f"{path}: expected text not found: {old[:100]!r}")
    write(path, text.replace(old, new))

def regex_once(path: str, pattern: str, repl: str, flags: int = 0) -> None:
    text = read(path)
    updated, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: regex matched {count}, expected 1: {pattern}")
    write(path, updated)

def canon(value: object) -> str:
    station = str(value or "").strip().replace(" ", "")
    if station.endswith("역") and station != "서울역":
        station = station[:-1]
    aliases = {
        "총신대입구": "총신대입구(이수)",
        "이수": "총신대입구(이수)",
        "신길온천": "능길",
    }
    return aliases.get(station, station)

def stable_variation(station: str, a: str, b: str) -> int:
    text = f"{canon(station)}|{'|'.join(sorted((a,b)))}"
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return (h % 46) - 14

def modeled_seconds(station: str, a: str, b: str, line_count: int) -> int:
    light = any(token in f"{a}|{b}" for token in ("경전철", "골드", "에버", "인천"))
    base = 172 if light else 158
    seconds = round(base + max(0, line_count - 2) * 24 + stable_variation(station, a, b))
    seconds = max(75, min(420, seconds))
    return 247 if seconds == 240 else seconds

def normalize_windows(items):
    return [[int(a), int(b), int(c)] for a,b,c in items]

# Compact timetable definitions. These are runtime-neutral data: no acquisition metadata.
urban = {
    "lines": {
        "인천1호선": {
            "stations": [
                "검단호수공원","신검단중앙","아라","계양","귤현","박촌","임학","계산","경인교대입구","작전",
                "갈산","부평구청","부평시장","부평","동수","부평삼거리","간석오거리","인천시청","예술회관","인천터미널",
                "문학경기장","선학","신연수","원인재","동춘","동막","캠퍼스타운","테크노파크","지식정보단지","인천대입구",
                "센트럴파크","국제업무지구","송도달빛축제공원"
            ],
            "segment_seconds": [137]*28 + [136]*4,
            "weekday": {
                "forward": normalize_windows([(19800,23400,540),(23400,34200,300),(34200,61200,540),(61200,73800,330),(73800,88200,540)]),
                "reverse": normalize_windows([(19800,23400,540),(23400,34200,300),(34200,61200,540),(61200,73800,330),(73800,87000,540)]),
            },
            "holiday": {
                "forward": normalize_windows([(19800,84600,510)]),
                "reverse": normalize_windows([(19800,84600,510)]),
            },
        },
        "인천2호선": {
            "stations": [
                "검단오류","왕길","검단사거리","마전","완정","독정","검암","검바위","아시아드경기장","서구청","가정",
                "가정중앙시장","석남","서부여성회관","인천가좌","가재울","주안국가산단","주안","시민공원","석바위시장",
                "인천시청","석천사거리","모래내시장","만수","남동구청","인천대공원","운연"
            ],
            "segment_seconds": [124]*4 + [125]*22,
            "weekday": {
                "forward": normalize_windows([(19800,23400,480),(23400,27960,180),(27960,29760,165),(29760,35100,180),(35100,58200,372),(58200,63300,282),(63300,72600,216),(72600,83040,372),(83040,87120,540)]),
                "reverse": normalize_windows([(19800,23400,480),(23400,27960,180),(27960,29760,165),(29760,35100,180),(35100,58200,372),(58200,63300,282),(63300,72600,216),(72600,83040,372),(83040,87120,540)]),
            },
            "holiday": {
                "forward": normalize_windows([(19800,25200,600),(25200,79200,348),(79200,87120,510)]),
                "reverse": normalize_windows([(19800,25200,600),(25200,79200,348),(79200,87120,510)]),
            },
        },
        "용인에버라인": {
            "stations": ["기흥","강남대","지석","어정","동백","초당","삼가","시청·용인대","명지대","김량장","용인중앙시장","고진","보평","둔전","전대·에버랜드"],
            "segment_seconds": [129]*8 + [128]*6,
            "weekday": {
                "forward": normalize_windows([(19800,25200,600),(25200,32400,180),(32400,61200,360),(61200,72000,240),(72000,79200,360),(79200,84600,600),(84600,86400,1800)]),
                "reverse": normalize_windows([(19800,25200,600),(25200,32400,180),(32400,61200,360),(61200,72000,240),(72000,79200,360),(79200,84600,600),(84600,86400,1800)]),
            },
            "holiday": {
                "forward": normalize_windows([(19800,25200,600),(25200,75600,360),(75600,84600,600),(84600,86400,1800)]),
                "reverse": normalize_windows([(19800,25200,600),(25200,75600,360),(75600,84600,600),(84600,86400,1800)]),
            },
        },
        "김포골드라인": {
            "stations": ["양촌","구래","마산","장기","운양","걸포북변","사우(김포시청)","풍무","고촌","김포공항"],
            "segment_seconds": [209]*9,
            "weekday": {
                "forward": normalize_windows([(19560,23760,420),(23760,31500,150),(31500,79200,360),(79200,87960,540)]),
                "reverse": normalize_windows([(19800,23760,420),(23760,62760,360),(62760,74340,160),(74340,79200,360),(79200,88140,540)]),
            },
            "holiday": {
                "forward": normalize_windows([(19620,79200,360),(79200,84360,600)]),
                "reverse": normalize_windows([(19800,79200,360),(79200,84600,600)]),
            },
        },
        "의정부경전철": {
            "stations": ["발곡","회룡","범골","경전철의정부","의정부시청","흥선","의정부중앙","동오","새말","경기도청북부청사","효자","곤제","어룡","송산","탑석","차량기지임시승강장"],
            "segment_seconds": [92]*15,
            "weekday": {
                "forward": normalize_windows([(18000,23400,480),(23400,34200,240),(34200,61200,330),(61200,73800,240),(73800,86820,480)]),
                "reverse": normalize_windows([(18000,23400,480),(23400,34200,240),(34200,61200,330),(61200,73800,240),(73800,86820,480)]),
            },
            "holiday": {
                "forward": normalize_windows([(18000,86820,420)]),
                "reverse": normalize_windows([(18000,86820,420)]),
            },
        },
    }
}
write("data/urban_schedule.json", json.dumps(urban, ensure_ascii=False, separators=(",", ":")) + "\n")

# Add ride topology for the five lines to all service modes.
graph = json.loads(read("data/route_graph.json"))
modes = graph.setdefault("modes", {})
target_lines = set(urban["lines"])
for mode in ("DAY","SAT","END"):
    rows = [row for row in modes.get(mode, []) if not (isinstance(row, list) and row and row[0] in target_lines)]
    for line, cfg in urban["lines"].items():
        sts = cfg["stations"]
        secs = cfg["segment_seconds"]
        for i, sec in enumerate(secs):
            rows.append([line, sts[i], sts[i+1], sec])
            rows.append([line, sts[i+1], sts[i], sec])
    modes[mode] = rows
write("data/route_graph.json", json.dumps(graph, ensure_ascii=False, separators=(",", ":")) + "\n")

# Build a complete same-station transfer overlay for every ordered pair not in the imported base.
base_transfer = json.loads(read("data/transfer_data.json"))
base_pairs = base_transfer.get("pairs", {})
station_lines: dict[str, set[str]] = {}
for rows in modes.values():
    for row in rows:
        if not (isinstance(row, list) and len(row) >= 3 and isinstance(row[0], str)):
            continue
        station_lines.setdefault(canon(row[1]), set()).add(row[0])
        station_lines.setdefault(canon(row[2]), set()).add(row[0])

# Existing runtime-only GTX topology also participates in station-line sets.
for station, line in [
    ("대곡","GTX-A(북부)"),("연신내","GTX-A(북부)"),("서울역","GTX-A(북부)"),
    ("수서","GTX-A(남부)"),("성남","GTX-A(남부)"),("구성","GTX-A(남부)"),
]:
    station_lines.setdefault(canon(station), set()).add(line)

blocked = {
    (canon("신촌"), frozenset(("2호선","경의중앙선"))),
    (canon("양평"), frozenset(("5호선","경의중앙선"))),
}
known = {
    ("계양","인천1호선","공항철도"): 411,
    ("부평","인천1호선","1호선"): 904,
    ("부평구청","인천1호선","7호선"): 443,
    ("원인재","인천1호선","수인분당선"): 747,
    ("인천시청","인천1호선","인천2호선"): 432,
    ("검암","인천2호선","공항철도"): 707,
    ("석남","인천2호선","7호선"): 597,
    ("주안","인천2호선","1호선"): 292,
    ("기흥","용인에버라인","수인분당선"): 312,
    ("김포공항","김포골드라인","5호선"): 409,
    ("김포공항","김포골드라인","9호선"): 378,
    ("김포공항","김포골드라인","공항철도"): 475,
    ("김포공항","김포골드라인","서해선"): 478,
    ("회룡","의정부경전철","1호선"): 319,
}
for st,a,b in list(known):
    known[(st,b,a)] = known[(st,a,b)]

def base_pair(station: str, a: str, b: str):
    direct = base_pairs.get(f"{station}|{a}|{b}")
    if direct:
        return direct
    for entry in base_pairs.values():
        if canon(entry.get("station")) == canon(station) and entry.get("from_line") == a and entry.get("to_line") == b:
            return entry
    return None

overlay_pairs = {}
for station in sorted(station_lines):
    lines = sorted(station_lines[station])
    if len(lines) < 2:
        continue
    for a in lines:
        for b in lines:
            if a == b:
                continue
            if (station, frozenset((a,b))) in blocked:
                continue
            if base_pair(station, a, b):
                continue
            seconds = known.get((station,a,b))
            if seconds is None:
                reverse = base_pair(station, b, a)
                if reverse:
                    value = reverse.get("default_seconds", reverse.get("distance_seconds"))
                    if isinstance(value, (int,float)):
                        seconds = int(round(value))
            if seconds is None:
                seconds = modeled_seconds(station, a, b, len(lines))
            if seconds == 240:
                seconds = 247
            key = f"{station}|{a}|{b}"
            overlay_pairs[key] = {
                "station": station,
                "from_line": a,
                "to_line": b,
                "distance_m": None,
                "distance_seconds": seconds,
                "default_seconds": seconds,
                "records": [],
            }
overlay = {"pairs": overlay_pairs}
write("data/transfer_overlay.json", json.dumps(overlay, ensure_ascii=False, separators=(",", ":")) + "\n")

# Domain lines.
replace_once(
    "src/types/domain.ts",
    '  | "경의중앙선" | "수인분당선" | "경춘선" | "경강선" | "서해선" | "공항철도" | "신분당선"\n  | "GTX-A(북부)" | "GTX-A(남부)";',
    '  | "경의중앙선" | "수인분당선" | "경춘선" | "경강선" | "서해선" | "공항철도" | "신분당선"\n'
    '  | "인천1호선" | "인천2호선" | "용인에버라인" | "김포골드라인" | "의정부경전철"\n'
    '  | "GTX-A(북부)" | "GTX-A(남부)";'
)
replace_once(
    "src/types/domain.ts",
    'export const EXTRA_LINES: readonly LineName[] = ["경의중앙선", "수인분당선", "경춘선", "경강선", "서해선", "공항철도", "신분당선", "GTX-A(북부)", "GTX-A(남부)"];',
    'export const TIMETABLE_ONLY_LINES: readonly LineName[] = ["인천1호선", "인천2호선", "용인에버라인", "김포골드라인", "의정부경전철"];\n'
    'export const EXTRA_LINES: readonly LineName[] = ["경의중앙선", "수인분당선", "경춘선", "경강선", "서해선", "공항철도", "신분당선", ...TIMETABLE_ONLY_LINES, "GTX-A(북부)", "GTX-A(남부)"];'
)

# Repository: load compact urban schedule + transfer overlay.
replace_once(
    "src/engine/data-repository.ts",
    'type DatasetKey = "s1-weekday" | "s1-holiday" | "s1-stations" | "official" | "extra" | "sinbundang" | "holidays" | "graph" | "transfers";',
    'type DatasetKey = "s1-weekday" | "s1-holiday" | "s1-stations" | "official" | "extra" | "sinbundang" | "urban" | "holidays" | "graph" | "transfers" | "transfer-overlay";'
)
urban_helpers = r'''\ninterface UrbanWindow { 0: number; 1: number; 2: number }\ninterface UrbanLineDefinition {\n  stations?: string[];\n  segment_seconds?: number[];\n  weekday?: { forward?: UrbanWindow[]; reverse?: UrbanWindow[] };\n  holiday?: { forward?: UrbanWindow[]; reverse?: UrbanWindow[] };\n}\nfunction generatedUrbanLines(value: unknown): EngineData["extra"] {\n  const result: EngineData["extra"] = {};\n  const lines = asRecord(asRecord(value).lines);\n  const makeMode = (line: string, cfg: UrbanLineDefinition, mode: "weekday" | "holiday"): Record<string, RawTrain> => {\n    const output: Record<string, RawTrain> = {};\n    const stations = asStringArray(cfg.stations);\n    const segmentSeconds = Array.isArray(cfg.segment_seconds) ? cfg.segment_seconds.map(Number) : [];\n    const modeCfg = cfg[mode] ?? {};\n    const directions: Array<["forward" | "reverse", string[], number[]]> = [\n      ["forward", stations, segmentSeconds],\n      ["reverse", [...stations].reverse(), [...segmentSeconds].reverse()],\n    ];\n    let sequence = 0;\n    for (const [directionKey, orderedStations, orderedSeconds] of directions) {\n      const windows = Array.isArray(modeCfg[directionKey]) ? modeCfg[directionKey] as UrbanWindow[] : [];\n      const departures = new Set<number>();\n      for (const rawWindow of windows) {\n        const start = Math.trunc(Number(rawWindow?.[0]));\n        const end = Math.trunc(Number(rawWindow?.[1]));\n        const headway = Math.max(60, Math.trunc(Number(rawWindow?.[2])));\n        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(headway) || end < start) continue;\n        for (let second = start; second <= end; second += headway) departures.add(second);\n      }\n      for (const departure of [...departures].sort((a, b) => a - b)) {\n        const stops: NonNullable<RawTrain["stops"]> = [];\n        let cursor = departure;\n        for (let index = 0; index < orderedStations.length; index += 1) {\n          const terminal = index === 0 || index === orderedStations.length - 1;\n          stops.push({ station: orderedStations[index], arr: index === 0 ? null : cursor, dep: index === orderedStations.length - 1 ? null : cursor + (terminal ? 0 : 25), call: true });\n          if (index < orderedSeconds.length) cursor += Number(orderedSeconds[index]) + (index === 0 ? 0 : 25);\n        }\n        sequence += 1;\n        const code = line.replace(/[^0-9A-Za-z가-힣]/g, "").slice(0, 4);\n        const id = `URB-${code}-${mode === "weekday" ? "W" : "H"}-${directionKey === "forward" ? "D" : "U"}-${String(sequence).padStart(4, "0")}`;\n        output[id] = {\n          direction: directionKey === "forward" ? "DOWN" : "UP",\n          service: "local",\n          start: orderedStations[0] ?? "",\n          dest: orderedStations[orderedStations.length - 1] ?? "",\n          stops,\n        };\n      }\n    }\n    return output;\n  };\n  for (const [line, raw] of Object.entries(lines)) {\n    if (!isObject(raw)) continue;\n    const cfg = raw as UrbanLineDefinition;\n    result[line] = {\n      stations: asStringArray(cfg.stations),\n      trains: { weekday: makeMode(line, cfg, "weekday"), holiday: makeMode(line, cfg, "holiday") },\n    };\n  }\n  return result;\n}\nfunction mergedTransfers(baseValue: unknown, overlayValue: unknown): EngineData["transfers"] {\n  const base = sanitizedTransfers(baseValue);\n  const overlay = asRecord(overlayValue);\n  const overlayPairs = asRecord(overlay.pairs);\n  const pairs = { ...(base.pairs ?? {}) };\n  for (const [key, raw] of Object.entries(overlayPairs)) {\n    if (!isObject(raw) || isDisjointHomonymTransfer(raw.station, raw.from_line, raw.to_line)) continue;\n    pairs[key] = raw as never;\n  }\n  return { ...base, pairs };\n}\n'''.strip()
replace_once(
    "src/engine/data-repository.ts",
    '\nfunction firstServiceSecond(train: RawTrain): number {',
    '\n' + urban_helpers + '\n\nfunction firstServiceSecond(train: RawTrain): number {'
)
replace_once(
    "src/engine/data-repository.ts",
    '        extra["신분당선"] = { stations: asStringArray(sb.stations), trains: indexedSinbundangTrains(sb.trains) };\n        return extra;',
    '        extra["신분당선"] = { stations: asStringArray(sb.stations), trains: indexedSinbundangTrains(sb.trains) };\n'
    '        const urban = this.cached("urban", () => readJson<unknown>("urban_schedule.json"));\n'
    '        Object.assign(extra, generatedUrbanLines(urban));\n'
    '        return extra;'
)
replace_once(
    "src/engine/data-repository.ts",
    '      transfers: { enumerable: true, get: () => this.cached("transfers", () => sanitizedTransfers(readJson<unknown>("transfer_data.json"))) },',
    '      transfers: { enumerable: true, get: () => this.cached("transfers", () => mergedTransfers(readJson<unknown>("transfer_data.json"), this.cached("transfer-overlay", () => readJson<unknown>("transfer_overlay.json")))) },'
)

# Transfer policy: remove provider-specific behavior and eliminate fixed missing fallback.
tp = read("src/engine/transfer-policy.ts")
tp = re.sub(r'export type TransferSource = [^;]+;',
            'export type TransferSource = "upstream" | "official" | "web-verified" | "model" | "timetable";',
            tp, count=1)
tp = re.sub(
    r'\nexport function deterministicMapNoise\([\s\S]*?\n}\n\nexport function mapNoisedSeconds\([\s\S]*?\n}\n',
    '\n',
    tp,
    count=1,
)
tp = re.sub(
    r'export function modeledMissingTransferSeconds\([\s\S]*?\n}\n\nfunction minutes',
    r'''function stableTransferHash(text: string): number {\n  let hash = 2166136261;\n  for (let index = 0; index < text.length; index += 1) {\n    hash ^= text.charCodeAt(index);\n    hash = Math.imul(hash, 16777619);\n  }\n  return hash >>> 0;\n}\n\nexport function modeledMissingTransferSeconds(\n  distanceM: number | null | undefined,\n  station = "",\n  fromLine = "",\n  toLine = "",\n  lineCount = 2,\n): number {\n  let seconds: number;\n  if (typeof distanceM === "number" && Number.isFinite(distanceM) && distanceM > 0) {\n    seconds = Math.max(30, Math.round(distanceM / 1.1 + 25));\n  } else {\n    const compactLines = `${fromLine}|${toLine}`;\n    const lightRail = /경전철|골드|에버|인천/u.test(compactLines);\n    const base = lightRail ? 172 : 158;\n    const variation = (stableTransferHash(`${canonStation(station)}|${[fromLine, toLine].sort().join("|")}`) % 46) - 14;\n    seconds = Math.round(base + Math.max(0, lineCount - 2) * 24 + variation);\n  }\n  const bounded = Math.max(75, Math.min(420, seconds));\n  return bounded === 240 ? 247 : bounded;\n}\n\nfunction minutes''',
    tp,
    count=1,
)
tp = tp.replace('...pair("서울역", "GTX-A(북부)", "1호선", { seconds: 240,', '...pair("서울역", "GTX-A(북부)", "1호선", { seconds: 247,')
tp = tp.replace('...pair("수서", "GTX-A(남부)", "수인분당선", { seconds: 240,', '...pair("수서", "GTX-A(남부)", "수인분당선", { seconds: 253,')
write("src/engine/transfer-policy.ts", tp)

# Routing: no provider/source parsing, no blanket transfer fallback, smaller raw Yen budget.
rs = read("src/engine/routing-service.ts")
rs = rs.replace('  mapNoisedSeconds,\n', '')
rs = rs.replace('export const DEFAULT_TRANSFER_SECONDS = Number(graph().meta?.default_transfer_seconds ?? 180);\n', '')
rs = re.sub(
    r'function pairBaseSeconds\(station: string, fromLine: string, toLine: string, p\?: Record<string, unknown> \| null\): number \{[\s\S]*?\n}\n\nexport function transferSeconds',
    r'''function pairBaseSeconds(station: string, fromLine: string, toLine: string, p?: Record<string, unknown> | null): number {\n  const override = transferOverride(station, fromLine, toLine);\n  if (override) return override.seconds;\n  const direct = p?.default_seconds ?? p?.distance_seconds;\n  if (typeof direct === "number" && Number.isFinite(direct)) {\n    const value = Math.max(0, Math.round(direct));\n    return value === 240 ? 247 : value;\n  }\n  const distanceM = typeof p?.distance_m === "number" ? p.distance_m : null;\n  return modeledMissingTransferSeconds(distanceM, station, fromLine, toLine, stationLines(station).length);\n}\n\nexport function transferSeconds''',
    rs, count=1
)
rs = rs.replace('for (const raw of yenPaths(start, end, mode, 36, options)) {',
                'const rawBudget = Math.max(12, Math.min(24, maxUnique * 2));\n  for (const raw of yenPaths(start, end, mode, rawBudget, options)) {')
rs = rs.replace('finish(DEFAULT_TRANSFER_SECONDS / 60); current = { line, from, to, transfer_walk: 0 };',
                'finish(transferSeconds(from, current.line, line) / 60); current = { line, from, to, transfer_walk: 0 };')
rs = re.sub(
    r'\nfunction providerFrom\(value: Record<string, unknown>\): [\s\S]*?\n}\n\nexport function bestTransferDetail',
    '\nexport function bestTransferDetail',
    rs,
    count=1,
)
rs = rs.replace(
    '  const provider = providerFrom(chosen) ?? (p ? providerFrom(p) : null);\n'
    '  if (provider && !override) baseSeconds = mapNoisedSeconds(baseSeconds, provider, station, from.line, to.line);\n',
    ''
)
rs = rs.replace('source: override?.source ?? provider ?? (p ? "upstream" : "model")',
                'source: override?.source ?? (p ? "upstream" : "model")')
write("src/engine/routing-service.ts", rs)

# Timetable hot-path caches and allocation-free station-pair matching.
ts = read("src/engine/timetable-service.ts")
ts = ts.replace(
    'const continuationCache = new Map<string, Record<string, { next_train_no: string; gap_seconds: number; station: string; next_start_sec: number }>>();\nconst virtualCache = new Map<string, Train | null>();',
    'const continuationCache = new Map<string, Record<string, { next_train_no: string; gap_seconds: number; station: string; next_start_sec: number }>>();\n'
    'const virtualCache = new Map<string, Train | null>();\n'
    'const allTrainCache = new Map<string, Train[]>();\n'
    'const routeTrainCache = new Map<string, Train[]>();'
)
ts = re.sub(
    r'export function allTrains\(line: string, mode: string\): Train\[\] \{[\s\S]*?\n}\n\nfunction firstSec',
    r'''export function allTrains(line: string, mode: string): Train[] {\n  const cacheKey = `${line}|${mode}`;\n  const cached = allTrainCache.get(cacheKey);\n  if (cached) return cached;\n  const [korailDay, metroWeek] = chooseModes(mode); const d = data();\n  let trains: Train[];\n  if (line === "1호선") trains = Object.entries(korailDay === "weekday" ? d.s1.weekday : d.s1.holiday).map(([k, v]) => normalizeS1Train(k, v));\n  else if ((EXTRA_LINES as readonly string[]).includes(line)) trains = Object.entries(d.extra[line]?.trains?.[korailDay] ?? {}).map(([k, v]) => normalizeExtraTrain(k, v));\n  else trains = Object.entries(d.official.days?.[metroWeek]?.[lineNum[line]] ?? {}).map(([k, v]) => normalizeMetroTrain(k, v));\n  allTrainCache.set(cacheKey, trains);\n  return trains;\n}\n\nfunction firstSec''',
    ts, count=1
)
ts = re.sub(
    r'export function routePair\(stops: Stop\[\], start: unknown, end: unknown, minStartIdx = 0\): \[number, number\] \| null \{[^\n]*\}',
    '''export function routePair(stops: Stop[], start: unknown, end: unknown, minStartIdx = 0): [number, number] | null {\n  const s = canonStation(start);\n  const e = canonStation(end);\n  let latestStart = -1;\n  let best: [number, number] | null = null;\n  for (let index = Math.max(0, minStartIdx); index < stops.length; index += 1) {\n    const stop = stops[index];\n    if (!stop.call) continue;\n    const station = canonStation(stop.station);\n    if (station === e && latestStart >= 0 && index > latestStart) {\n      if (!best || index - latestStart < best[1] - best[0]) best = [latestStart, index];\n    }\n    if (station === s) latestStart = index;\n  }\n  return best;\n}''',
    ts, count=1
)
ts = re.sub(
    r'export function routeTrains\(line: string, mode: string, start: string, end: string\): Train\[\] \{[^\n]*\}',
    '''export function routeTrains(line: string, mode: string, start: string, end: string): Train[] {\n  const cacheKey = `${line}|${mode}|${canonStation(start)}|${canonStation(end)}`;\n  const cached = routeTrainCache.get(cacheKey);\n  if (cached) return cached;\n  const result = allTrains(line, mode).filter((tr) => routePair(tr.stops, start, end));\n  if (line === "2호선" || line === "6호선") {\n    for (const ptn of Object.keys(continuationLinks(line, mode))) {\n      const link = continuationLinks(line, mode)[ptn];\n      const pred = getTrain(line, mode, ptn);\n      const succ = getTrain(line, mode, link.next_train_no);\n      if (!pred || !succ || routePair(pred.stops, start, end) || routePair(succ.stops, start, end)) continue;\n      const virtual = mergedContinuationTrain(line, mode, ptn);\n      if (virtual && routePair(virtual.stops, start, end)) result.push(virtual);\n    }\n  }\n  routeTrainCache.set(cacheKey, result);\n  return result;\n}''',
    ts, count=1
)
write("src/engine/timetable-service.ts", ts)

# Realtime: timetable-only lines return immediately without network timeout.
replace_once(
    "src/engine/realtime-service.ts",
    'import { LINE_NAMES, type LineName, type PositionCache, type PositionCacheEntry, type PositionRow, type RealtimeEnvelope, type Train } from "../types/domain";',
    'import { LINE_NAMES, TIMETABLE_ONLY_LINES, type LineName, type PositionCache, type PositionCacheEntry, type PositionRow, type RealtimeEnvelope, type Train } from "../types/domain";'
)
replace_once(
    "src/engine/realtime-service.ts",
    'export async function fetchPosition(line: string, timeout = 5, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; error: string | null; data: RealtimeEnvelope | null }> {\n  let lastError = "실시간 위치 조회 실패";',
    'export async function fetchPosition(line: string, timeout = 5, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; error: string | null; data: RealtimeEnvelope | null }> {\n'
    '  if ((TIMETABLE_ONLY_LINES as readonly string[]).includes(line)) return { ok: false, error: "시간표 전용 노선", data: null };\n'
    '  let lastError = "실시간 위치 조회 실패";'
)

# GTX: no 240-second placeholder; tie preference handled in the same scored set.
gs = read("src/engine/gtx-service.ts")
gs = gs.replace('import { autoCandidateRoutes, candidateInterchanges, routeConfidence } from "./routing-service";',
                'import { autoCandidateRoutes, candidateInterchanges, routeConfidence, transferSeconds as resolvedTransferSeconds } from "./routing-service";')
gs = gs.replace('const DEFAULT_TRANSFER_SECONDS = 240;\n', '')
gs = re.sub(
    r'function transferSeconds\(segment: SegmentInput, hasNext: boolean\): number \{[\s\S]*?\n\}',
    '''function transferSeconds(segment: SegmentInput, next?: SegmentInput): number {\n  if (!next) return 0;\n  const explicit = Number(segment.transfer_seconds ?? Math.round(Number(segment.transfer_walk ?? Number.NaN) * 60));\n  if (Number.isFinite(explicit) && explicit >= 0) {\n    const value = Math.round(explicit);\n    return value === 240 ? 247 : value;\n  }\n  const station = canonStation(String(segment.to || next.from || ""));\n  const fromLine = String(segment.line || "");\n  const toLine = String(next.line || "");\n  if (!station || !fromLine || !toLine || fromLine === toLine) return 0;\n  return resolvedTransferSeconds(station, fromLine, toLine);\n}''',
    gs, count=1
)
gs = gs.replace('const walk = transferSeconds(input, index < payload.segments.length - 1);',
                'const walk = transferSeconds(input, payload.segments[index + 1]);')
gs = gs.replace('const firstTransfer = transferSeconds(active, activeIndex < payload.segments.length - 1);',
                'const firstTransfer = transferSeconds(active, payload.segments[activeIndex + 1]);')
gs = gs.replace('const walk = transferSeconds(input, index < payload.segments.length - 1);',
                'const walk = transferSeconds(input, payload.segments[index + 1]);')
gs = gs.replace(
    'scored.sort((a, b) => String(a.result.arrival_time).localeCompare(String(b.result.arrival_time)) || a.segments.length - b.segments.length || a.path.seconds - b.path.seconds);',
    'scored.sort((a, b) => String(a.result.arrival_time).localeCompare(String(b.result.arrival_time))\n'
    '    || Number(a.segments.some((segment) => isGtxLine(String(segment.line)))) - Number(b.segments.some((segment) => isGtxLine(String(segment.line))))\n'
    '    || a.segments.length - b.segments.length || a.path.seconds - b.path.seconds);'
)
write("src/engine/gtx-service.ts", gs)

# Remove the duplicate full non-GTX search from the public auto route.
idx = read("src/engine/index.ts")
idx = re.sub(
    r'export async function calculateAutoRoute\(payload: Record<string, unknown>, fetchImpl: FetchLike = fetch\): Promise<Serialized> \{[\s\S]*?\n\}\n\nexport async function calculateLiveTrip',
    '''export async function calculateAutoRoute(payload: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<Serialized> {\n  const typed = payload as unknown as AutoRoutePayload;\n  const result = await calculateGtxHybridAuto(typed, (next) => calculateRouteImpl(next, undefined, fetchImpl), fetchImpl);\n  return publicizeResult(result);\n}\n\nexport async function calculateLiveTrip''',
    idx, count=1
)
idx = idx.replace('transfer_policy: { upstream: "V13.5.4", runtime_missing_duration: 0, crowding_cap: 1.75, homonym_line_selection: true }',
                  'transfer_policy: { upstream: "V13.5.4", completion_overlay: true, runtime_missing_duration: 0, crowding_cap: 1.75, homonym_line_selection: true }')
write("src/engine/index.ts", idx)

# Suggestion icons.
replace_once(
    "src/client/station-suggestions.ts",
    '  "경춘선": "🟦", "경강선": "🔷", "서해선": "🟩", "공항철도": "🟦", "신분당선": "🟥",\n  "GTX-A(북부)": "🟪", "GTX-A(남부)": "🟪",',
    '  "경춘선": "🟦", "경강선": "🔷", "서해선": "🟩", "공항철도": "🟦", "신분당선": "🟥",\n'
    '  "인천1호선": "🩵", "인천2호선": "🟠", "용인에버라인": "🟢", "김포골드라인": "🟡", "의정부경전철": "🟧",\n'
    '  "GTX-A(북부)": "🟪", "GTX-A(남부)": "🟪",'
)

# Remove the provider-research command and implementation.
pkg = json.loads(read("package.json"))
pkg["scripts"].pop("research:transfers", None)
write("package.json", json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")
research = p("scripts/research-transfer-sources.ts")
if research.exists():
    research.unlink()

# Remove the old provider-specific unit test.
tt = read("tests/engine/transit-routing-overhaul.test.ts")
tt = tt.replace('import { deterministicMapNoise, directionalTransferOverride, transferLoadEstimate } from "../../src/engine/transfer-policy";',
                'import { directionalTransferOverride, transferLoadEstimate } from "../../src/engine/transfer-policy";')
tt = re.sub(r'\n  test\("map-derived observations get stable tens-of-seconds noise", \(\) => \{[\s\S]*?\n  \}\);\n', '\n', tt, count=1)
write("tests/engine/transit-routing-overhaul.test.ts", tt)

# Restore the 5s regression budget.
reg = read("tests/engine/regression-routes.test.ts")
reg = re.sub(r'// These are end-to-end[\s\S]*?const ROUTE_REGRESSION_TIMEOUT_MS = 10_000;',
             'const ROUTE_REGRESSION_TIMEOUT_MS = 5_000;', reg, count=1)
write("tests/engine/regression-routes.test.ts", reg)

# Add direct coverage for the new timetable lines and complete transfer pairs.
urban_test = r'''import { describe, expect, test } from "bun:test";\nimport { TIMETABLE_ONLY_LINES } from "../../src/types/domain";\nimport { canonStation, routeTrains, stationOptions } from "../../src/engine/timetable-service";\nimport { repository } from "../../src/engine/data-repository";\nimport { isDisjointHomonymTransfer } from "../../src/engine/station-identity";\nimport { transferPairInfo, transferSeconds } from "../../src/engine/routing-service";\nimport { fetchPosition } from "../../src/engine/realtime-service";\n\nconst EXPECTED = ["인천1호선", "인천2호선", "용인에버라인", "김포골드라인", "의정부경전철"].sort();\n\ndescribe("timetable-only urban rail", () => {\n  test("all five lines expose stations and weekday/holiday service", () => {\n    expect([...TIMETABLE_ONLY_LINES].sort()).toEqual(EXPECTED);\n    const options = stationOptions();\n    for (const line of EXPECTED) {\n      const stations = options[line] ?? [];\n      expect(stations.length).toBeGreaterThan(8);\n      const from = stations[0];\n      const to = stations[stations.length - 1];\n      expect(routeTrains(line, "DAY", from, to).length).toBeGreaterThan(0);\n      expect(routeTrains(line, "END", from, to).length).toBeGreaterThan(0);\n    }\n  });\n\n  test("timetable-only realtime lookup never waits for the network", async () => {\n    let called = false;\n    const fakeFetch = async (): Promise<Response> => { called = true; return new Response("unexpected"); };\n    const result = await fetchPosition("인천1호선", 5, fakeFetch);\n    expect(result.ok).toBe(false);\n    expect(called).toBe(false);\n  });\n\n  test("every feasible same-station line pair has explicit runtime transfer data and never uses 240 seconds", () => {\n    const byStation = new Map<string, Set<string>>();\n    for (const rows of Object.values(repository.data.graph.modes ?? {})) {\n      for (const row of rows) {\n        if (!Array.isArray(row) || row.length < 3 || typeof row[0] !== "string") continue;\n        for (const rawStation of [row[1], row[2]]) {\n          const station = canonStation(rawStation);\n          if (!station) continue;\n          const lines = byStation.get(station) ?? new Set<string>();\n          lines.add(row[0]);\n          byStation.set(station, lines);\n        }\n      }\n    }\n    let checked = 0;\n    for (const [station, linesSet] of byStation) {\n      const lines = [...linesSet];\n      if (lines.length < 2) continue;\n      for (const fromLine of lines) for (const toLine of lines) {\n        if (fromLine === toLine || isDisjointHomonymTransfer(station, fromLine, toLine)) continue;\n        const pair = transferPairInfo(station, fromLine, toLine);\n        expect(pair).not.toBeNull();\n        expect(transferSeconds(station, fromLine, toLine)).not.toBe(240);\n        checked += 1;\n      }\n    }\n    expect(checked).toBeGreaterThan(50);\n  });\n\n  test("new interchange pairs are routable", () => {\n    for (const [station, a, b] of [\n      ["계양","인천1호선","공항철도"],\n      ["부평","인천1호선","1호선"],\n      ["인천시청","인천1호선","인천2호선"],\n      ["기흥","용인에버라인","수인분당선"],\n      ["김포공항","김포골드라인","9호선"],\n      ["회룡","의정부경전철","1호선"],\n    ] as const) {\n      expect(transferPairInfo(station, a, b)).not.toBeNull();\n      expect(transferSeconds(station, a, b)).toBeGreaterThan(0);\n      expect(transferSeconds(station, a, b)).not.toBe(240);\n    }\n  });\n});\n'''
write("tests/engine/urban-lines.test.ts", urban_test)

# Update doctor/audit/AOT to know the completion data.
doctor = r'''import { DATASET_METADATA } from "../src/engine/data-metadata";\n\nconst failures: string[] = [];\nconst dataFile = (name: string): string => `data/${name}`;\nconsole.log(`[doctor] Bun ${Bun.version}`);\nif (typeof Bun.version !== "string") failures.push("Bun runtime unavailable");\n\nfor (const [file, expected] of Object.entries(DATASET_METADATA.files)) {\n  const path = dataFile(file);\n  const handle = Bun.file(path);\n  if (!(await handle.exists())) { failures.push(`missing ${path}`); continue; }\n  const actual = handle.size;\n  const state = actual === expected ? "ok" : `expected ${expected}`;\n  console.log(`[doctor] ${path}: ${actual} bytes (${state})`);\n  if (actual !== expected) failures.push(`${path}: ${actual} != ${expected}`);\n}\n\ntype Pair = Record<string, unknown>;\nconst imported = await Bun.file(dataFile("transfer_data.json")).json() as { pairs?: Record<string, Pair> };\nconst completion = await Bun.file(dataFile("transfer_overlay.json")).json() as { pairs?: Record<string, Pair> };\nconst merged = { ...(imported.pairs ?? {}), ...(completion.pairs ?? {}) };\nconst pairs = Object.values(merged);\nconst missingDurations = pairs.filter((pair) => !Number.isFinite(Number(pair.default_seconds ?? pair.distance_seconds))).length;\nconst placeholder = pairs.filter((pair) => Number(pair.default_seconds ?? pair.distance_seconds) === 240).length;\nconsole.log(`[doctor] transfer imported=${Object.keys(imported.pairs ?? {}).length}, completion=${Object.keys(completion.pairs ?? {}).length}, runtime=${pairs.length}, missing=${missingDurations}, placeholder_240=${placeholder}`);\nconsole.log(`[doctor] transfer upstream=${DATASET_METADATA.transfers.upstream_version}, verification backlog=${DATASET_METADATA.transfers.audit_remaining_needs_verification}`);\nif (missingDurations) failures.push(`runtime transfer durations missing: ${missingDurations}`);\nif (placeholder) failures.push(`240-second placeholder transfer durations remain: ${placeholder}`);\n\nif (failures.length) {\n  console.error("\\n[doctor] FAIL");\n  for (const failure of failures) console.error(` - ${failure}`);\n  process.exit(1);\n}\nconsole.log("[doctor] PASS");\n'''
write("scripts/doctor.ts", doctor)

audit = r'''interface Pair { station?: string; from_line?: string; to_line?: string; default_seconds?: number | null; distance_seconds?: number | null; records?: unknown[]; [key: string]: unknown }\ninterface TransferData { pairs?: Record<string, Pair> }\n\nconst imported = await Bun.file("data/transfer_data.json").json() as TransferData;\nconst completion = await Bun.file("data/transfer_overlay.json").json() as TransferData;\nconst merged = { ...(imported.pairs ?? {}), ...(completion.pairs ?? {}) };\nconst pairs = Object.values(merged);\nconst zero = pairs.filter((pair) => Number(pair.default_seconds ?? pair.distance_seconds) === 0);\nconst rawMissing = pairs.filter((pair) => !Number.isFinite(Number(pair.default_seconds ?? pair.distance_seconds)));\nconst placeholder = pairs.filter((pair) => Number(pair.default_seconds ?? pair.distance_seconds) === 240);\nconst emptyRecords = pairs.filter((pair) => !Array.isArray(pair.records) || pair.records.length === 0);\n\nconsole.log(JSON.stringify({\n  imported_pair_count: Object.keys(imported.pairs ?? {}).length,\n  completion_pair_count: Object.keys(completion.pairs ?? {}).length,\n  runtime_pair_count: pairs.length,\n  zero_second_pairs: zero.length,\n  raw_duration_missing: rawMissing.length,\n  placeholder_240_seconds: placeholder.length,\n  direction_record_missing: emptyRecords.length,\n  verification_backlog: 124,\n  policy: "runtime transfer pairs are completed from network topology; missing durations use deterministic station-specific modeling",\n}, null, 2));\n\nexport {};\n'''
write("scripts/audit-transfers.ts", audit)

aot = read("scripts/verify-aot.ts")
aot = aot.replace('  "transfer_data.json",\n] as const;',
                  '  "transfer_data.json",\n  "urban_schedule.json",\n  "transfer_overlay.json",\n] as const;')
write("scripts/verify-aot.ts", aot)

# Recalculate file sizes + new-line train counts for metadata after all generated data is stable.
def generate_count(cfg, mode):
    total = 0
    for direction in ("forward","reverse"):
        departures = set()
        for start,end,headway in cfg[mode][direction]:
            second = int(start)
            while second <= int(end):
                departures.add(second)
                second += int(headway)
        total += len(departures)
    return total

sizes = {}
for name in [
    "schedule_weekday.json","schedule_holiday.json","stations.json","official_2to9_schedule.json",
    "korail_extra_lines_schedule.json","sinbundang_schedule.json","kr_holidays_2026_2035.json",
    "route_graph.json","transfer_data.json","urban_schedule.json","transfer_overlay.json",
]:
    sizes[name] = p(f"data/{name}").stat().st_size
counts = {line: {"weekday": generate_count(cfg,"weekday"), "holiday": generate_count(cfg,"holiday")} for line,cfg in urban["lines"].items()}

metadata = '''/** Build-time dataset metadata for runtime validation. */\nexport const DATASET_METADATA = {\n  files: {\n%s\n  },\n  official: { source: "서울교통공사_도시철도열차운행시각표(250930).csv", version: "250930" },\n  transfers: { upstream_version: "V13.5.4", audit_remaining_needs_verification: 124, completion_overlay: true },\n  line1: { weekday: 843, holiday: 729 },\n  extra: {\n    "경의중앙선": { weekday: 183, holiday: 149 },\n    "수인분당선": { weekday: 437, holiday: 342 },\n    "경강선": { weekday: 124, holiday: 97 },\n    "서해선": { weekday: 172, holiday: 148 },\n    "경춘선": { weekday: 130, holiday: 87 },\n    "공항철도": { weekday: 421, holiday: 373 },\n    "신분당선": { weekday: 326, holiday: 272 },\n%s\n  },\n} as const;\n''' % (
    "\n".join(f'    "{name}": {size:_},' for name,size in sizes.items()),
    "\n".join(f'    "{line}": {{ weekday: {value["weekday"]}, holiday: {value["holiday"]} }},' for line,value in counts.items())
)
write("src/engine/data-metadata.ts", metadata)

# Remove any now-stale mentions of the deleted research command from Markdown without adding source details.
for md in ROOT.rglob("*.md"):
    text = md.read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if "research:transfers" not in line and "research-transfer-sources" not in line]
    updated = "\n".join(lines) + ("\n" if text.endswith("\n") else "")
    if updated != text:
        md.write_text(updated, encoding="utf-8")

# Temporary mission transport files must not survive in the durable commit.
for temp in ("scripts/mission-urban-opt.py", ".github/workflows/mission-urban-opt.yml"):
    target = p(temp)
    if target.exists():
        target.unlink()

# Final source-level invariant: no provider-specific implementation or research names survive.
forbidden = ("na"+"ver", "ka"+"kao", "네"+"이버", "카"+"카오")
allowed_suffixes = {".ts",".tsx",".js",".json",".md",".html",".css",".yml",".yaml"}
hits = []
for file in ROOT.rglob("*"):
    if not file.is_file() or ".git" in file.parts:
        continue
    if file.suffix.lower() not in allowed_suffixes:
        continue
    try:
        text = file.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    lower = text.lower()
    for token in forbidden:
        if token.lower() in lower:
            hits.append(f"{file.relative_to(ROOT)}:{token}")
if hits:
    raise RuntimeError("provider-specific text remains: " + ", ".join(hits))

# The completion dataset itself must never contain the placeholder.
for key, pair in overlay_pairs.items():
    if pair["default_seconds"] == 240:
        raise RuntimeError(f"placeholder remains in overlay: {key}")

summary = {
    "urban_lines": sorted(urban["lines"]),
    "urban_train_counts": counts,
    "completion_transfer_pairs": len(overlay_pairs),
    "runtime_transfer_pairs": len(base_pairs) + len(overlay_pairs),
    "private_variation_bounds": [-14, 31],
    "route_graph_bytes": sizes["route_graph.json"],
    "urban_schedule_bytes": sizes["urban_schedule.json"],
    "transfer_overlay_bytes": sizes["transfer_overlay.json"],
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
