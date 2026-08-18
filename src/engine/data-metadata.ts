/**
 * Small build-time metadata for health/station endpoints. The source JSON byte
 * sizes are checked by DataRepository.validate(), so stale generated counts are
 * detected without parsing the 20 MiB schedule payloads during cold import.
 */
export const DATASET_METADATA = {
  files: {
    "schedule_weekday.json": 2_600_100,
    "schedule_holiday.json": 2_374_538,
    "stations.json": 1_494,
    "official_2to9_schedule.json": 11_405_979,
    "korail_extra_lines_schedule.json": 4_141_427,
    "kr_holidays_2026_2035.json": 19_613,
    "route_graph.json": 158_465,
    "transfer_data.json": 147_060,
  },
  official: {
    source: "서울교통공사_도시철도열차운행시각표(250930).csv",
    version: "250930",
  },
  line1: { weekday: 843, holiday: 729 },
  extra: {
    "경의중앙선": { weekday: 183, holiday: 149 },
    "수인분당선": { weekday: 437, holiday: 342 },
    "경강선": { weekday: 124, holiday: 97 },
    "서해선": { weekday: 172, holiday: 148 },
    "경춘선": { weekday: 130, holiday: 87 },
    "공항철도": { weekday: 421, holiday: 373 },
  },
} as const;
