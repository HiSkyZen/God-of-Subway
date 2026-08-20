const vercel = await Bun.file("vercel.json").json() as { functions?: Record<string, { includeFiles?: string }> };
const includeFiles = vercel.functions?.["api/index.ts"]?.includeFiles || "";
for (const required of [
  "schedule_weekday.json",
  "schedule_holiday.json",
  "stations.json",
  "official_2to9_schedule.json",
  "korail_extra_lines_schedule.json",
  "sinbundang_schedule.json",
  "kr_holidays_2026_2035.json",
  "route_graph.json",
  "transfer_data.json",
]) {
  if (!includeFiles.includes(required)) throw new Error(`Vercel function is missing required runtime data: ${required}`);
}

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
      const assets = [...html.matchAll(/(?:src|href)="([^"?]+)(?:\?[^\"]*)?"/g)].map((match) => match[1]).filter((value) => value.startsWith("/") || value.startsWith("../"));
      if (!assets.some((value) => /\.js$/.test(value)) || !assets.some((value) => /\.css$/.test(value))) throw new Error("Built HTML must reference bundled JS and CSS assets");
      for (const value of assets) {
        const normalized = value.startsWith("../") ? `/${value.slice(3)}` : value;
        const asset = await fetch(new URL(normalized, server.url));
        if (asset.status !== 200) throw new Error(`HTML asset failed: ${normalized} (${asset.status})`);
      }
    }
    if (path === "/manifest.webmanifest") {
      const manifest = await response.clone().json() as { start_url?: string; scope?: string; display?: string; icons?: unknown[] };
      if (manifest.start_url !== "/" || manifest.scope !== "/" || manifest.display !== "standalone" || !Array.isArray(manifest.icons) || manifest.icons.length < 2) throw new Error("PWA manifest contract is incomplete");
    }
    if (path === "/sw.js") {
      const source = await response.clone().text();
      if (!source.includes("jigeumta-shell-v18") || !source.includes("manifest.webmanifest")) throw new Error("Service worker shell cache contract is stale");
    }
  }
  for (const path of ["/.env", "/.env.local", "/%2e%2e/.env", "/%2e%2e%5c.env", "/engine.py"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(new URL(path, server.url), { method });
      if (response.status !== 404 || (await response.text()) !== "") throw new Error(`Secret/source path exposed: ${method} ${path}`);
    }
  }
  console.log("AOT HTTP, Vercel runtime-data, and PWA contracts verified");
} finally {
  server.stop(true);
}
export {};
