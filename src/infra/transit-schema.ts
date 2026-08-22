export const TRANSIT_SCHEMA_VERSION = 1;

export const TRANSIT_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_registry (
  source_id TEXT PRIMARY KEY,
  logical_line TEXT NOT NULL,
  operator_code TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  line_code TEXT NOT NULL,
  source_line_name TEXT NOT NULL,
  realtime INTEGER NOT NULL DEFAULT 0 CHECK (realtime IN (0, 1)),
  timetable INTEGER NOT NULL DEFAULT 1 CHECK (timetable IN (0, 1)),
  section TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  UNIQUE (logical_line, operator_code, line_code, section)
);

CREATE TABLE IF NOT EXISTS station (
  station_id INTEGER PRIMARY KEY,
  station_key TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  latitude REAL,
  longitude REAL
);
CREATE INDEX IF NOT EXISTS station_canonical_idx ON station(canonical_name);

CREATE TABLE IF NOT EXISTS station_source (
  source_id TEXT NOT NULL REFERENCES source_registry(source_id) ON DELETE CASCADE,
  station_code TEXT NOT NULL,
  station_id INTEGER NOT NULL REFERENCES station(station_id) ON DELETE CASCADE,
  source_station_name TEXT NOT NULL,
  sequence_hint INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, station_code)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS station_source_station_idx ON station_source(station_id);

CREATE TABLE IF NOT EXISTS trip (
  trip_id INTEGER PRIMARY KEY,
  logical_line TEXT NOT NULL,
  service_day TEXT NOT NULL CHECK (service_day IN ('DAY', 'SAT', 'END')),
  train_no TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT '',
  service_kind TEXT NOT NULL DEFAULT 'local',
  service_priority INTEGER NOT NULL DEFAULT 0,
  origin_station_id INTEGER REFERENCES station(station_id),
  destination_station_id INTEGER REFERENCES station(station_id),
  UNIQUE (logical_line, service_day, train_no)
);
CREATE INDEX IF NOT EXISTS trip_line_day_idx ON trip(logical_line, service_day);
CREATE INDEX IF NOT EXISTS trip_train_no_idx ON trip(train_no);

CREATE TABLE IF NOT EXISTS trip_source (
  trip_id INTEGER NOT NULL REFERENCES trip(trip_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_registry(source_id) ON DELETE CASCADE,
  PRIMARY KEY (trip_id, source_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stop_time (
  trip_id INTEGER NOT NULL REFERENCES trip(trip_id) ON DELETE CASCADE,
  stop_sequence INTEGER NOT NULL,
  station_id INTEGER NOT NULL REFERENCES station(station_id),
  arrival_sec INTEGER,
  departure_sec INTEGER,
  callable INTEGER NOT NULL DEFAULT 1 CHECK (callable IN (0, 1)),
  source_station_code TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (trip_id, stop_sequence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stop_time_station_idx ON stop_time(station_id, trip_id);

CREATE TABLE IF NOT EXISTS ride_edge (
  service_day TEXT NOT NULL CHECK (service_day IN ('DAY', 'SAT', 'END')),
  logical_line TEXT NOT NULL,
  from_station_id INTEGER NOT NULL REFERENCES station(station_id),
  to_station_id INTEGER NOT NULL REFERENCES station(station_id),
  seconds INTEGER NOT NULL CHECK (seconds >= 0),
  service_kind TEXT NOT NULL DEFAULT 'all',
  sample_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (service_day, logical_line, from_station_id, to_station_id, service_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ride_edge_route_idx ON ride_edge(service_day, logical_line, from_station_id, to_station_id);

CREATE TABLE IF NOT EXISTS transfer_pair (
  station_id INTEGER NOT NULL REFERENCES station(station_id),
  from_line TEXT NOT NULL,
  to_line TEXT NOT NULL,
  distance_m REAL,
  seconds INTEGER,
  source TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (station_id, from_line, to_line)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS transfer_detail (
  detail_id INTEGER PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES station(station_id),
  from_line TEXT NOT NULL,
  to_line TEXT NOT NULL,
  from_direction TEXT NOT NULL DEFAULT '',
  to_direction TEXT NOT NULL DEFAULT '',
  alight_car TEXT NOT NULL DEFAULT '',
  alight_door TEXT NOT NULL DEFAULT '',
  board_car TEXT NOT NULL DEFAULT '',
  board_door TEXT NOT NULL DEFAULT '',
  seconds INTEGER,
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS transfer_detail_pair_idx ON transfer_detail(station_id, from_line, to_line);

CREATE TABLE IF NOT EXISTS holiday (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  substitute INTEGER NOT NULL DEFAULT 0 CHECK (substitute IN (0, 1)),
  source TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS build_source (
  source_name TEXT PRIMARY KEY,
  source_uri TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;
`;

export type TransitServiceDay = "DAY" | "SAT" | "END";
export const TRANSIT_SERVICE_DAYS: readonly TransitServiceDay[] = ["DAY", "SAT", "END"];
