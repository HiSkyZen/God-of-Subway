Bun.env.PORT = "0";
// The generated AOT bundle intentionally has no checked-in declaration file.
// @ts-expect-error generated dist module is validated by this script at runtime
const module = await import("../dist/server/server.js");
const server = module.startServer();
try {
  const checks: Array<[string, number, string?]> = [
    ["/", 200, "text/html"],
    ["/api/health", 200, "application/json"],
    ["/manifest.webmanifest", 200, "application/manifest+json"],
    ["/sw.js", 200, "application/javascript"],
    ["/icons/icon-192.png", 200, "image/png"],
    ["/icons/icon-512.png", 200, "image/png"],
    ["/icons/icon-maskable-512.png", 200, "image/png"],
    ["/.env", 404],
    ["/server/server.js", 404],
    ["/src/engine/index.ts", 404],
  ];
  for (const [path, status, mime] of checks) {
    const response = await fetch(new URL(path, server.url));
    if (response.status !== status) throw new Error(`${path}: expected ${status}, got ${response.status}`);
    if (mime && !(response.headers.get("content-type") || "").includes(mime)) throw new Error(`${path}: unexpected MIME`);
    if (path === "/") {
      const html = await response.clone().text();
      for (const match of html.matchAll(/(?:src|href)="\.\.\/([^"?]+)"/g)) {
        const asset = await fetch(new URL(`/${match[1]}`, server.url));
        if (asset.status !== 200) throw new Error(`HTML asset failed: ${match[1]} (${asset.status})`);
      }
    }
  }
  for (const path of ["/.env", "/.env.local", "/%2e%2e/.env", "/%2e%2e%5c.env", "/engine.py"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(new URL(path, server.url), { method });
      if (response.status !== 404 || (await response.text()) !== "") throw new Error(`Secret/source path exposed: ${method} ${path}`);
    }
  }
  console.log("AOT HTTP asset/API contract verified");
} finally {
  server.stop(true);
}
export {};
