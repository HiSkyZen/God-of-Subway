import { errorBody, internalErrorResponse, invalidRequestResponse, jsonResponse } from "./errors";
import type { EnginePayload, EnginePort, EngineResult, JsonObject, JsonValue } from "./types";
import { pushCapabilities } from "./push-capability";
import { logEvent, publicError, requestId } from "../infra/observability";

export const MAX_JSON_BODY_BYTES = 1_048_576;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isJsonObject = (value: unknown): value is JsonObject => isRecord(value);
const isEngineResult = (value: unknown): value is EngineResult => isJsonObject(value);
const hasSecretName = (key: string): boolean => /(api[_-]?key|secret|token|password|authorization|credential)/i.test(key);
const redactSecrets = (value: unknown, key = ""): JsonValue | undefined => {
  if (hasSecretName(key) && key !== "api_key_configured") return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.flatMap((entry) => { const redacted = redactSecrets(entry); return redacted === undefined ? [] : [redacted]; });
  if (isRecord(value)) { const result: JsonObject = {}; for (const [childKey, childValue] of Object.entries(value)) { const redacted = redactSecrets(childValue, childKey); if (redacted !== undefined) result[childKey] = redacted; } return result; }
  return undefined;
};

export const readJsonPayload = async (request: Request): Promise<EnginePayload> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) { const parsedLength = Number(contentLength); if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > MAX_JSON_BODY_BYTES) throw new RequestBodyError("Request body is too large"); }
  const chunks: Uint8Array[] = []; let total = 0; const reader = request.body?.getReader(); if (!reader) throw new RequestBodyError("JSON body is required");
  while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > MAX_JSON_BODY_BYTES) { await reader.cancel(); throw new RequestBodyError("Request body is too large"); } chunks.push(next.value); }
  if (total === 0) throw new RequestBodyError("JSON body is required");
  const body = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { throw new RequestBodyError("Request body must be valid JSON"); }
  if (!isRecord(parsed)) throw new RequestBodyError("JSON body must be an object"); return parsed;
};
export class RequestBodyError extends Error {}

const callEngine = async (fn: (payload: EnginePayload) => unknown | Promise<unknown>, operation: string, request: Request): Promise<Response> => {
  const rid = requestId(request); const started = performance.now(); let payload: EnginePayload;
  try { payload = await readJsonPayload(request); }
  catch (error) { logEvent("warn", "api_invalid_body", { request_id: rid, operation, error: error instanceof Error ? error.message : String(error) }); return invalidRequestResponse(error instanceof RequestBodyError ? error.message : "Invalid request", { request_id: rid }); }
  try {
    logEvent("debug", "api_request", { request_id: rid, operation, payload });
    const result = await fn(payload); const response = isEngineResult(result) ? result : { ok: true, result };
    logEvent("info", "api_response", { request_id: rid, operation, ok: response.ok !== false, duration_ms: Math.round(performance.now() - started) });
    return jsonResponse({ ...response, request_id: rid }, response.ok === false ? 422 : 200, { "x-request-id": rid });
  } catch (error) {
    if (error instanceof Error && /(구간|역|열차번호|탑승|올바르지|입력하세요|필수)/.test(error.message)) { logEvent("warn", "engine_validation_error", { request_id: rid, operation, error: error.message }); return invalidRequestResponse("요청 값이 올바르지 않습니다."); }
    const publicInfo = publicError(error); logEvent("error", "engine_exception", { request_id: rid, error_id: publicInfo.error_id, operation, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), duration_ms: Math.round(performance.now() - started) });
    return internalErrorResponse({ request_id: rid, error_id: publicInfo.error_id, ...(publicInfo.detail ? { detail: publicInfo.detail } : {}) });
  }
};

export const handleHealth = async (engine: EnginePort): Promise<Response> => {
  try { const snapshot = await engine.healthSnapshot(); const safeSnapshot = redactSecrets(snapshot); const body: JsonObject = isJsonObject(safeSnapshot) ? safeSnapshot : { snapshot: safeSnapshot ?? null }; body.ok = true; body.api_key_configured = Boolean(Bun.env.SEOUL_API_KEY); const push = pushCapabilities(); body.push_capable = push.subscriptionCapable; body.push_subscription_capable = push.subscriptionCapable; body.arrival_alert_capable = push.arrivalAlertCapable; return jsonResponse(body); }
  catch (error) { const p = publicError(error); logEvent("error", "health_exception", { error_id: p.error_id, error }); return internalErrorResponse({ error_id: p.error_id, ...(p.detail ? { detail: p.detail } : {}) }); }
};
export const handleStations = (engine: EnginePort): Response => jsonResponse({ ok: true, stations: engine.stationsByLine });
export const handleEnginePost = (engine: EnginePort, operation: "route" | "auto_route" | "trip_update", request: Request): Promise<Response> => { const method = operation === "route" ? engine.calculateRoute : operation === "auto_route" ? engine.calculateAutoRoute : engine.calculateLiveTrip; return callEngine(method.bind(engine), operation, request); };
export const handleClientLog = async (request: Request): Promise<Response> => { const rid = requestId(request); try { const payload = await readJsonPayload(request); logEvent("warn", "browser_log", { request_id: rid, ...payload }); return jsonResponse({ ok: true, request_id: rid }, 202, { "x-request-id": rid }); } catch { return invalidRequestResponse("로그 형식이 올바르지 않습니다.", { request_id: rid }); } };
export const methodNotAllowed = (): Response => jsonResponse(errorBody("허용되지 않은 메서드입니다."), 405, { allow: "GET, POST" });
