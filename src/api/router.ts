import { handleClientLog, handleEnginePost, handleHealth, handleStations, methodNotAllowed } from "./handlers";
import { invalidRequestResponse, jsonResponse } from "./errors";
import { handlePushPublicKey, handlePushAlertDelete, handlePushAlertPost, handlePushAlertStatus, handlePushDispatch, handlePushSubscriptionDelete, handlePushSubscriptionPost, handlePushTest } from "./push";
import type { EnginePort } from "./types";
import { withSecurityHeaders } from "./security";

export type AssetProvider = { index: () => Response | Promise<Response>; logo: () => Response | Promise<Response>; serviceWorker: () => Response | Promise<Response>; manifest: () => Response | Promise<Response>; icon: (name: "icon-192.png" | "icon-512.png" | "icon-maskable-512.png") => Response | Promise<Response>; frontend?: (name: string) => Response | Promise<Response>; };
const notFound = (pathname: string): Response => { let decoded = pathname; try { decoded = decodeURIComponent(pathname); } catch {} if (/\/\.env(?:$|[./])/i.test(decoded) || /\.(?:py|ts|tsx|js)$/i.test(decoded) || decoded.includes("\\") || decoded.includes("..")) return withSecurityHeaders(new Response(null, { status: 404 })); return jsonResponse({ ok: false, error: "요청한 경로를 찾을 수 없습니다." }, 404); };
const staticResponse = async (request: Request, provider: () => Response | Promise<Response>): Promise<Response> => { const response = withSecurityHeaders(await provider()); if (request.method === "HEAD") return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }); return response; };

export const createFetchHandler = (engine: EnginePort, assets: AssetProvider): ((request: Request) => Response | Promise<Response>) => async (request) => {
  const url = new URL(request.url); const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/" || pathname === "/index.html") { if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(); return staticResponse(request, assets.index); }
  if (pathname === "/logo" || pathname === "/jigeumta_logo_140.png") { if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(); return staticResponse(request, assets.logo); }
  if (pathname === "/sw.js") { if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(); return staticResponse(request, assets.serviceWorker); }
  if (pathname === "/manifest.webmanifest") { if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(); return staticResponse(request, assets.manifest); }
  const iconMatch = pathname.match(/^\/icons\/(icon-(?:192|512|maskable-512)\.png)$/); if (iconMatch) { if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(); return staticResponse(request, () => assets.icon(iconMatch[1] as "icon-192.png" | "icon-512.png" | "icon-maskable-512.png")); }
  const frontendMatch = pathname.match(/^\/(index-[a-z0-9]+\.(?:js|css))$/i); if (frontendMatch && assets.frontend) { if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(); return staticResponse(request, () => assets.frontend!(frontendMatch[1])); }
  if (pathname === "/api/health") { if (request.method !== "GET") return methodNotAllowed(); return handleHealth(engine); }
  if (pathname === "/api/stations") { if (request.method !== "GET") return methodNotAllowed(); return handleStations(engine); }
  if (pathname === "/api/log") { if (request.method !== "POST") return methodNotAllowed(); return handleClientLog(request); }
  if (pathname === "/api/push/public-key") { if (request.method !== "GET") return methodNotAllowed(); return handlePushPublicKey(); }
  if (pathname === "/api/push/subscriptions") { if (request.method === "POST") return handlePushSubscriptionPost(request); if (request.method === "DELETE") return handlePushSubscriptionDelete(request); return methodNotAllowed(); }
  if (pathname === "/api/push/alerts") { if (request.method === "POST") return handlePushAlertPost(request, engine.calculateLiveTrip); if (request.method === "DELETE") return handlePushAlertDelete(request); return methodNotAllowed(); }
  if (pathname === "/api/push/alerts/status") { if (request.method !== "POST") return methodNotAllowed(); return handlePushAlertStatus(request); }
  if (pathname === "/api/push/dispatch") { if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(); return handlePushDispatch(request, engine.calculateLiveTrip); }
  if (pathname === "/api/push/test") { if (request.method !== "POST") return methodNotAllowed(); return handlePushTest(request); }
  if (pathname === "/api/route" || pathname === "/api/auto_route" || pathname === "/api/trip_update") { if (request.method !== "POST") return methodNotAllowed(); const operation = pathname.slice("/api/".length) as "route" | "auto_route" | "trip_update"; return handleEnginePost(engine, operation, request); }
  return notFound(pathname);
};
export const invalidContentType = (): Response => invalidRequestResponse("Content-Type must be application/json");
