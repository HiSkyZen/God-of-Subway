import homepage from "./client/index.html";
import { enginePort } from "./api/engine-adapter";
import { createFetchHandler, type AssetProvider } from "./api/router";
import { handlePushDispatch } from "./api/push";
import { withSecurityHeaders } from "./api/security";

const isAotBundle = import.meta.url.includes("/dist/");
const publicFile = (name: string): ReturnType<typeof Bun.file> =>
  Bun.file(new URL(`../public/${name}`, import.meta.url));
const sourceFile = (name: string): ReturnType<typeof Bun.file> =>
  Bun.file(new URL(name, import.meta.url));

// AOT bundles run from dist/server while Vercel serves dist/public as the
// static output. Development keeps the source HTML/assets and Bun's HTML
// import route. The function adapter only needs these providers for API
// requests, so it does not expose the server bundle as a static file.
const indexFile = isAotBundle ? publicFile("index.html") : sourceFile("./client/index.html");
const logoFile = isAotBundle ? publicFile("jigeumta_logo_140.png") : sourceFile("../jigeumta_logo_140.png");
const sourceServiceWorkerFile = Bun.file(new URL("./client/sw.ts", import.meta.url));
const builtServiceWorkerFile = publicFile("sw.js");
const manifestFile = isAotBundle ? publicFile("manifest.webmanifest") : sourceFile("./client/manifest.webmanifest");
const serviceWorkerFile = isAotBundle ? builtServiceWorkerFile : sourceServiceWorkerFile;
const iconFiles = {
  "icon-192.png": isAotBundle ? publicFile("icons/icon-192.png") : sourceFile("./client/icons/icon-192.png"),
  "icon-512.png": isAotBundle ? publicFile("icons/icon-512.png") : sourceFile("./client/icons/icon-512.png"),
  "icon-maskable-512.png": isAotBundle ? publicFile("icons/icon-maskable-512.png") : sourceFile("./client/icons/icon-maskable-512.png"),
} as const;

const assets: AssetProvider = {
  index: () =>
    new Response(indexFile, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  logo: () =>
    new Response(logoFile, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      },
    }),
  serviceWorker: () =>
    (async () => {
      let body: BodyInit;
      if (serviceWorkerFile === sourceServiceWorkerFile) {
        const source = await serviceWorkerFile.text();
        body = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
      } else {
        body = serviceWorkerFile;
      }
      return new Response(body, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "service-worker-allowed": "/",
          "cache-control": "no-cache",
        },
      });
    })(),
  manifest: () =>
    new Response(manifestFile, {
      headers: {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    }),
  icon: (name) =>
    new Response(iconFiles[name], {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      },
    }),
  frontend: (name) => {
    const file = isAotBundle ? publicFile(name) : Bun.file(new URL(`../${name}`, import.meta.url));
    const type = name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".webmanifest") ? "application/manifest+json" : "image/png";
    return new Response(file, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=31536000, immutable" } });
  },
};

/** Shared Web Fetch handler used by Bun.serve and the Vercel adapter. */
export const fetchHandler = createFetchHandler(enginePort, assets);

/**
 * Local/generic Bun entrypoint.  The HTML import is intentionally supplied to
 * Bun.serve so Bun can bundle and expose the frontend assets in AOT builds.
 * Vercel imports `fetchHandler` through `api/index.ts` instead of opening a
 * long-lived listener inside a Function invocation.
 */
export const startServer = (): Bun.Server<unknown> => {
  const baseOptions = {
    port: Number(Bun.env.PORT || 8765),
    development: Bun.env.NODE_ENV !== "production",
    fetch: fetchHandler,
    error(error: Bun.ErrorLike) {
      void error;
      console.error("Request handling failed");
      return withSecurityHeaders(new Response("Internal server error", { status: 500 }));
    },
  };
  // The AOT server serves the canonical public output through fetchHandler;
  // the development server uses Bun's HTML import route for HMR/module
  // resolution. This keeps dist/server private and dist/public deployable.
  const server = isAotBundle
    ? Bun.serve(baseOptions)
    : Bun.serve({ ...baseOptions, routes: { "/": homepage } });
  const intervalSeconds = Number(Bun.env.PUSH_SCHEDULER_INTERVAL_SECONDS || 0);
  const localToken = Bun.env.PUSH_CRON_TOKEN?.trim();
  const productionToken = Bun.env.CRON_SECRET?.trim();
  const enabled = Bun.env.VERCEL !== "1" && Number.isSafeInteger(intervalSeconds) && intervalSeconds >= 60
    && ((Bun.env.NODE_ENV === "production" && Boolean(productionToken)) || (Bun.env.NODE_ENV !== "production" && Bun.env.PUSH_CRON_ENABLED === "1" && Boolean(localToken)));
  if (enabled) {
    const request = Bun.env.NODE_ENV === "production"
      ? new Request("http://localhost/api/push/dispatch", { method: "GET", headers: { authorization: `Bearer ${productionToken!}` } })
      : new Request("http://localhost/api/push/dispatch", { method: "POST", headers: { "x-push-cron-token": localToken! } });
    let running = false;
    const run = async (): Promise<void> => {
      if (running) return;
      running = true;
      try { await handlePushDispatch(request, enginePort.calculateLiveTrip); } catch { /* dispatch returns a safe response; keep interval alive */ }
      finally { running = false; }
    };
    const timer = setInterval(() => { void run(); }, intervalSeconds * 1000);
    (timer as unknown as { unref?: () => void }).unref?.();
    const stop = server.stop.bind(server);
    server.stop = ((closeActiveConnections?: boolean) => {
      clearInterval(timer);
      return stop(closeActiveConnections);
    }) as typeof server.stop;
  }
  return server;
};

if (import.meta.main) {
  const server = startServer();
  console.log(`지금타 Bun server listening on ${server.url}`);
}
