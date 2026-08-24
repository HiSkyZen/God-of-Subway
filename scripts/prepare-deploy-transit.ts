import { existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "data/transit.sqlite");
const CANDIDATE = resolve(ROOT, "data/transit.deploy-candidate.sqlite");
const FAILURE_MARKER = resolve(ROOT, "data/transit-refresh-failure.json");

async function run(command: string[], env: Record<string, string>): Promise<boolean> {
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) === 0;
}

async function build(mode: "live" | "fixture", verifyLive: boolean): Promise<boolean> {
  rmSync(CANDIDATE, { force: true });
  rmSync(`${CANDIDATE}-wal`, { force: true });
  rmSync(`${CANDIDATE}-shm`, { force: true });
  const env = {
    TRANSIT_DATA_MODE: mode,
    TRANSIT_DB_PATH: "data/transit.deploy-candidate.sqlite",
    TRANSIT_BUILD_CONCURRENCY: "96",
    TRANSIT_BUILD_HTTP_TIMEOUT_MS: "15000",
    TRANSIT_BUILD_KRIC_RETRIES: "10",
  };
  if (!await run(["bun", "run", "scripts/build-transit-db.ts"], env)) return false;
  if (verifyLive && !await run(["bun", "run", "scripts/verify-live-transit.ts"], env)) return false;
  if (!existsSync(CANDIDATE)) return false;
  rmSync(DB, { force: true });
  renameSync(CANDIDATE, DB);
  return true;
}

const needsRecovery = !existsSync(DB) || existsSync(FAILURE_MARKER);
if (!needsRecovery) {
  console.log("[deploy:data] using scheduled validated transit.sqlite");
  process.exit(0);
}

console.log("[deploy:data] scheduled live data is missing/stale; retrying KRIC with 96 workers, 10 no-delay retries");
if (Bun.env.KRIC_API_KEY?.trim() && await build("live", true)) {
  rmSync(FAILURE_MARKER, { force: true });
  console.log("[deploy:data] live KRIC recovery succeeded");
  process.exit(0);
}

console.warn("[deploy:data] KRIC recovery failed after 10 retries; building deterministic fallback data");
if (!await build("fixture", false)) throw new Error("deploy transit fallback build failed");
console.log("[deploy:data] fallback SQLite ready");
