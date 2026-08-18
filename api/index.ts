import { enginePort } from "../src/api/engine-adapter";
import { createFetchHandler, type AssetProvider } from "../src/api/router";

// Vercel serves dist/public directly. The Function is only responsible for
// /api requests, so keep the server-only HTML import out of its dependency
// graph. This avoids Vercel attempting to parse src/client/index.html as code.
const unavailableAsset = (): Response => new Response(null, { status: 404 });
const functionAssets: AssetProvider = {
  index: unavailableAsset,
  logo: unavailableAsset,
  serviceWorker: unavailableAsset,
  manifest: unavailableAsset,
  icon: () => unavailableAsset(),
};
const fetchHandler = createFetchHandler(enginePort, functionAssets);

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
