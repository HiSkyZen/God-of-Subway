import * as engineModule from "../engine/index";
import type { EnginePort } from "./types";

/**
 * The only import of engine implementation exports in the HTTP layer.
 * Keeping this adapter explicit makes an engine rewrite independently
 * testable and prevents API handlers from depending on timetable internals.
 */
export const enginePort: EnginePort = {
  nowKst: engineModule.nowKst,
  healthSnapshot: engineModule.healthSnapshot,
  stationsByLine: engineModule.stationsByLine,
  calculateRoute: engineModule.calculateRoute,
  calculateAutoRoute: engineModule.calculateAutoRoute,
  calculateLiveTrip: engineModule.calculateLiveTrip,
};
