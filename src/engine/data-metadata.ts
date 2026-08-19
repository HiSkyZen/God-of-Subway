/** Build-time dataset metadata: timetable base + upstream V13.5.4 transfer patch. */
export const DATASET_METADATA = {
  files: {
    "schedule_weekday.json": 2_601_226,
    "schedule_holiday.json": 2_375_426,
    "stations.json": 1_067,
    "official_2to9_schedule.json": 11_405_979,
    "korail_extra_lines_schedule.json": 4_142_164,
    "sinbundang_schedule.json": 697_921,
    "kr_holidays_2026_2035.json": 18_750,
    "route_graph.json": 166_764,
    "transfer_data.json": 337_143,
  },
  official: { source: "서울교통공사_도시철도열차운행시각표(250930).csv", version: "250930" },
  transfers: { upstream_version: "V13.5.4", fallback_seconds: 180, audit_remaining_needs_verification: 124 },
  line1: { weekday: 843, holiday: 729 },
  extra: {
    "경의중앙선": { weekday: 183, holiday: 149 },
    "수인분당선": { weekday: 437, holiday: 342 },
    "경강선": { weekday: 124, holiday: 97 },
    "서해선": { weekday: 172, holiday: 148 },
    "경춘선": { weekday: 130, holiday: 87 },
    "공항철도": { weekday: 421, holiday: 373 },
    "신분당선": { weekday: 326, holiday: 272 },
  },
} as const;
