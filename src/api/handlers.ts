import {
  errorBody,
  internalErrorResponse,
  invalidRequestResponse,
  jsonResponse,
} from "./errors";
import type {
  EnginePayload,
  EnginePort,
  EngineResult,
  JsonObject,
  JsonValue,
} from "./types";
import { pushCapabilities } from "./push-capability";

export const MAX_JSON_BODY_BYTES = 1_048_576;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonObject = (value: unknown): value is JsonObject => isRecord(value);

const isEngineResult = (value: unknown): value is EngineResult =>
  isJsonObject(value);

const hasSecretName = (key: string): boolean =>
  /(api[_-]?key|secret|token|password|authorization|credential)/i.test(key);

/** Remove accidental credentials from a health extension before serialization. */
const redactSecrets = (value: unknown, key = ""): JsonValue | undefined => {
  if (hasSecretName(key) && key !== "api_key_configured") {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const redacted = redactSecrets(entry);
      return redacted === undefined ? [] : [redacted];
    });
  }
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const redacted = redactSecrets(childValue, childKey);
      if (redacted !== undefined) result[childKey] = redacted;
    }
    return result;
  }
  return undefined;
};

export const readJsonPayload = async (request: Request): Promise<EnginePayload> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > MAX_JSON_BODY_BYTES) {
      throw new RequestBodyError("Request body is too large");
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError("JSON body is required");
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      throw new RequestBodyError("Request body is too large");
    }
    chunks.push(next.value);
  }
  if (total === 0) throw new RequestBodyError("JSON body is required");
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestBodyError("Request body must be valid JSON");
  }
  if (!isRecord(parsed)) throw new RequestBodyError("JSON body must be an object");
  return parsed;
};

export class RequestBodyError extends Error {}

const callEngine = async (
  fn: (payload: EnginePayload) => unknown | Promise<unknown>,
  request: Request,
): Promise<Response> => {
  let payload: EnginePayload;
  try {
    payload = await readJsonPayload(request);
  } catch (error) {
    if (error instanceof RequestBodyError) return invalidRequestResponse(error.message);
    return invalidRequestResponse();
  }

  try {
    const result = await fn(payload);
    const response = isEngineResult(result) ? result : { ok: true, result };
    return jsonResponse(response, response.ok === false ? 422 : 200);
  } catch (error) {
    // The domain currently signals user validation with stable Korean
    // messages. Return one safe public contract without exposing raw engine
    // internals; unexpected failures remain a generic 500.
    if (error instanceof Error && /(구간|역|열차번호|탑승|올바르지|입력하세요|필수)/.test(error.message)) {
      return invalidRequestResponse("요청 값이 올바르지 않습니다.");
    }
    return internalErrorResponse();
  }
};

export const handleHealth = async (engine: EnginePort): Promise<Response> => {
  try {
    const snapshot = await engine.healthSnapshot();
    const safeSnapshot = redactSecrets(snapshot);
    const body: JsonObject = isJsonObject(safeSnapshot) ? safeSnapshot : { snapshot: safeSnapshot ?? null };
    body.ok = true;
    body.api_key_configured = Boolean(Bun.env.SEOUL_API_KEY);
    const push = pushCapabilities();
    body.push_capable = push.subscriptionCapable;
    body.push_subscription_capable = push.subscriptionCapable;
    body.arrival_alert_capable = push.arrivalAlertCapable;
    return jsonResponse(body);
  } catch {
    return internalErrorResponse();
  }
};

export const handleStations = (engine: EnginePort): Response =>
  jsonResponse({ ok: true, stations: engine.stationsByLine });

export const handleEnginePost = (
  engine: EnginePort,
  operation: "route" | "auto_route" | "trip_update",
  request: Request,
): Promise<Response> => {
  const method = operation === "route" ? engine.calculateRoute : operation === "auto_route" ? engine.calculateAutoRoute : engine.calculateLiveTrip;
  return callEngine(method.bind(engine), request);
};

export const methodNotAllowed = (): Response =>
  jsonResponse(errorBody("허용되지 않은 메서드입니다."), 405, { allow: "GET, POST" });
