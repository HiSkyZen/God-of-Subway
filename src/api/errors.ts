import type { HttpErrorBody } from "./types";
import { setSecurityHeaders } from "./security";

export const errorBody = (message: string): HttpErrorBody => ({
  ok: false,
  error: message,
});

export const jsonResponse = (
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  setSecurityHeaders(responseHeaders);
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
};

export const internalErrorResponse = (): Response =>
  jsonResponse(errorBody("서버 내부 오류가 발생했습니다."), 500);

export const invalidRequestResponse = (message = "Invalid request"): Response =>
  jsonResponse(errorBody(message), 422);
