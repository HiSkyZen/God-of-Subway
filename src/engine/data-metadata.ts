import { repository } from "./data-repository";

/** Runtime metadata comes from the generated SQLite database, never hard-coded JSON file sizes. */
export function datasetMetadata(): Record<string, unknown> {
  const validation = repository.validate();
  return {
    storage: "sqlite",
    schema_version: validation.schemaVersion,
    build_mode: validation.buildMode,
    station_lines: validation.stationLines,
    stations: validation.stations,
    trips: validation.trips,
    stop_times: validation.stopTimes,
    transfers: validation.transfers,
    service_modes: validation.graphModes,
  };
}

/** Compatibility export for modules that display build metadata. */
export const DATASET_METADATA = {
  storage: "sqlite",
  get runtime(): Record<string, unknown> { return datasetMetadata(); },
} as const;
