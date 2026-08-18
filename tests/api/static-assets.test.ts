import { expect, test } from "bun:test";
import { fetchHandler } from "../../src/server";

const get = (path: string) => fetchHandler(new Request(`http://localhost${path}`));

test("server static allowlist exposes PWA worker and manifest", async () => {
  const worker = await get("/sw.js");
  expect(worker.status).toBe(200);
  expect(worker.headers.get("content-type")).toContain("application/javascript");
  expect(worker.headers.get("service-worker-allowed")).toBe("/");
  const workerText = await worker.text();
  for (const event of ["install", "activate", "fetch", "push", "notificationclick"]) {
    expect(workerText.includes(`addEventListener(\"${event}\"`)).toBe(true);
  }
  expect(() => new Function(workerText)).not.toThrow();

  const manifest = await get("/manifest.webmanifest");
  expect(manifest.status).toBe(200);
  expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
  const body = await manifest.json();
  expect(body.name).toBeTruthy();

  const sourceWorker = await Bun.file("src/client/sw.ts").text();
  const shellBlocks = [
    sourceWorker.match(/const REQUIRED_SHELL = \[(.*?)\];/s)?.[1] || "",
    sourceWorker.match(/const OPTIONAL_SHELL = \[(.*?)\];/s)?.[1] || "",
  ];
  const shell = shellBlocks.flatMap((block) => [...block.matchAll(/\"(\/[^\"]+)\"/g)].map((match) => match[1]));
  for (const path of [...new Set(shell)]) {
    const response = await get(path);
    expect(response.status).toBe(200);
    const type = response.headers.get("content-type") || "";
    if (path.endsWith(".png")) expect(type).toContain("image/png");
    if (path.endsWith(".webmanifest")) expect(type).toContain("application/manifest+json");
  }
  for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    const response = await get(`/icons/${icon}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
  }
});
