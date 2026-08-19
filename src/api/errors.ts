import type { HttpErrorBody } from "./types";
import { setSecurityHeaders } from "./security";

export const errorBody = (message: string, fields: Record<string, unknown> = {}): HttpErrorBody & Record<string, unknown> => ({ ok: false, error: message, ...fields });
export const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit): Response => { const responseHeaders = new Headers(headers); responseHeaders.set("content-type", "application/json; charset=utf-8"); responseHeaders.set("cache-control", "no-store"); setSecurityHeaders(responseHeaders); return new Response(JSON.stringify(body), { status, headers: responseHeaders }); };
export const internalErrorResponse = (fields: Record<string, unknown> = {}): Response => jsonResponse(errorBody("서버 내부 오류가 발생했습니다.", fields), 500);
export const invalidRequestResponse = (message = "Invalid request", fields: Record<string, unknown> = {}): Response => jsonResponse(errorBody(message, fields), 422);
