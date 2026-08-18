export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/** A request payload accepted by the timetable engine. */
export type EnginePayload = Record<string, unknown>;

/**
 * Public engine boundary.  The HTTP layer deliberately depends on this small
 * contract instead of importing timetable internals.
 */
export interface EnginePort {
  nowKst: () => unknown;
  healthSnapshot: () => unknown | Promise<unknown>;
  stationsByLine: Record<string, unknown>;
  calculateRoute: (payload: EnginePayload) => unknown | Promise<unknown>;
  calculateAutoRoute: (payload: EnginePayload) => unknown | Promise<unknown>;
  calculateLiveTrip: (payload: EnginePayload) => unknown | Promise<unknown>;
}

export interface HttpErrorBody {
  ok: false;
  error: string;
}

export type EngineResult = JsonObject & { ok?: boolean };
