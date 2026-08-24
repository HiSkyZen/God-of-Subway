import { existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "data/transit.sqlite");
const CANDIDATE = resolve(ROOT, "data/transit.deploy-candidate.sqlite");
const FAILURE_MARKER = resolve(ROOT, "data/transit-refresh-failure.json");

async function run(command: string[], env: Record<string, string> = {}): Promise<boolean> {
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) === 0;
}

function cleanupCandidate(): void {
  rmSync(CANDIDATE, { force: true });
  rmSync(`${CANDIDATE}-wal`, { force: true });
  rmSync(`${CANDIDATE}-shm`, { force: true });
}

async function validate(path: string, requireLive: boolean): Promise<boolean> {
  const env = { TRANSIT_DB_PATH: path };
  if (requireLive && !await run(["bun", "run", "scripts/verify-live-transit.ts"], env)) return false;
  if (!await run(["bun", "run", "scripts/doctor.ts"], env)) return false;
  if (!await run(["bun", "run", "scripts/audit-transfers.ts"], env)) return false;
  return true;
}

async function build(mode: "live" | "fixture", requireLive: boolean): Promise<boolean> {
  cleanupCandidate();
  const env: Record<string, string> = {
    TRANSIT_DATA_MODE: mode,
    TRANSIT_DB_PATH: "data/transit.deploy-candidate.sqlite",
  };
  if (mode === "live") {
    env.TRANSIT_BUILD_CONCURRENCY = "96";
    env.TRANSIT_BUILD_HTTP_TIMEOUT_MS = "30000";
    env.TRANSIT_BUILD_KRIC_RETRIES = "10";
  }
  if (!await run(["bun", "run", "scripts/build-transit-db.ts"], env)) return false;
  if (!existsSync(CANDIDATE)) return false;
  if (!await validate("data/transit.deploy-candidate.sqlite", requireLive)) return false;
  return true;
}

const needsRetrigger = !existsSync(DB) || existsSync(FAILURE_MARKER);
if (!needsRetrigger) {
  console.log("[deploy:data] using scheduled validated transit.sqlite");
  process.exit(0);
}

if (Bun.env.KRIC_API_KEY?.trim()) {
  console.log("[deploy:data] scheduled live refresh is missing/stale; retriggering one complete KRIC-first live build");
  if (await build("live", true)) {
    rmSync(DB, { force: true });
    renameSync(CANDIDATE, DB);
    rmSync(FAILURE_MARKER, { force: true });
    console.log("[deploy:data] complete deploy-time KRIC retrigger succeeded");
    process.exit(0);
  }
  cleanupCandidate();
  console.warn("[deploy:data] complete deploy-time KRIC retrigger failed after per-request retries; using validated LKG/fallback data");
} else {
  console.warn("[deploy:data] KRIC_API_KEY unavailable at deploy; using validated LKG/fallback data");
}

if (existsSync(DB)) {
  if (!await validate("data/transit.sqlite", false)) throw new Error("existing LKG/fallback transit SQLite failed validation");
  console.log("[deploy:data] validated LKG/fallback SQLite ready");
  process.exit(0);
}

console.warn("[deploy:data] no LKG SQLite exists; building deterministic fixture fallback");
if (!await build("fixture", false)) throw new Error("deploy transit fixture fallback build failed");
rmSync(DB, { force: true });
renameSync(CANDIDATE, DB);
console.log("[deploy:data] deterministic fixture fallback SQLite ready");
