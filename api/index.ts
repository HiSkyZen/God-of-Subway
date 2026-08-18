import { fetchHandler } from "../src/server";

const vercelFetch = (request: Request): Response | Promise<Response> => {
  const url = new URL(request.url);
  // vercel.json's `/api/:path* -> /api` rewrite preserves named wildcard
  // parameters as `?path=...`. If the platform already routed the original
  // pathname, this branch is a no-op.
  const forwardedPath = url.pathname === "/api" ? url.searchParams.get("path") : null;
  if (!forwardedPath) return fetchHandler(request);
  const safePath = forwardedPath.replace(/^\/+/, "");
  url.pathname = `/api/${safePath}`;
  url.searchParams.delete("path");
  return fetchHandler(new Request(url, request));
};

/** Vercel Bun Function adapter; no listener is opened in the Function runtime. */
export default {
  fetch: vercelFetch,
};
