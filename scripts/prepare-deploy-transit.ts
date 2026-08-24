import { existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "data/transit.sqlite");
const PENDING = resolve(ROOT, "data/transit.pending.sqlite");
const CANDIDATE = resolve(ROOT, "data/transit.deploy-candidate.sqlite");
const FAILURE_MARKER = resolve(ROOT, "data/transit-refresh-failure.json");

type FailureMarker = {
  failed_timetable_units?: unknown[];
  [key: string]: unknown;
};

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

async function buildFixtureFallback(): Promise<boolean> {
  cleanupCandidate();
  const env = {
    TRANSIT_DATA_MODE: "fixture",
    TRANSIT_DB_PATH: "data/transit.deploy-candidate.sqlite",
  };
  if (!await run(["bun", "run", "scripts/build-transit-db.ts"], env)) return false;
  if (!existsSync(CANDIDATE)) return false;
  if (!await validate("data/transit.deploy-candidate.sqlite", false)) return false;
  rmSync(DB, { force: true });
  renameSync(CANDIDATE, DB);
  return true;
}

if (!existsSync(FAILURE_MARKER)) {
  if (!existsSync(DB)) {
    console.warn("[deploy:data] scheduled transit.sqlite is missing; building deterministic fallback SQLite");
    if (!await buildFixtureFallback()) throw new Error("deploy transit fallback build failed");
  } else {
    console.log("[deploy:data] using scheduled validated transit.sqlite");
  }
  process.exit(0);
}

let marker: FailureMarker = {};
try {
  marker = await Bun.file(FAILURE_MARKER).json() as FailureMarker;
} catch (error) {
  console.warn(`[deploy:data] could not parse transit failure marker: ${error instanceof Error ? error.message : String(error)}`);
}
const failedUnits = Array.isArray(marker.failed_timetable_units) ? marker.failed_timetable_units : [];

if (
  existsSync(PENDING)
  && failedUnits.length > 0
  && Bun.env.KRIC_API_KEY?.trim()
) {
  console.log(`[deploy:data] retrying only ${failedUnits.length} KRIC timetable units that remained unresolved in CI`);
  const repairEnv = {
    TRANSIT_DB_PATH: "data/transit.pending.sqlite",
    TRANSIT_FAILURE_MARKER: "data/transit-refresh-failure.json",
    TRANSIT_BUILD_KRIC_RETRIES: "10",
    TRANSIT_BUILD_HTTP_TIMEOUT_MS: "30000",
    TRANSIT_BUILD_KRIC_HTTP_CONCURRENCY: "12",
    TRANSIT_DEPLOY_REPAIR_CONCURRENCY: "8",
  };
  const repaired = await run(["bun", "run", "scripts/repair-transit-pending.ts"], repairEnv);
  if (repaired && await validate("data/transit.pending.sqlite", true)) {
    rmSync(DB, { force: true });
    renameSync(PENDING, DB);
    rmSync(FAILURE_MARKER, { force: true });
    console.log("[deploy:data] deploy-time targeted KRIC repair succeeded; pending live SQLite promoted");
    process.exit(0);
  }
  console.warn("[deploy:data] unresolved KRIC units remain after deploy-time 10-retry recovery; preserving fallback/LKG SQLite");
} else if (failedUnits.length > 0 && !Bun.env.KRIC_API_KEY?.trim()) {
  console.warn("[deploy:data] KRIC_API_KEY is unavailable at deploy; preserving fallback/LKG SQLite");
} else {
  console.warn("[deploy:data] no retryable pending KRIC units are available; preserving fallback/LKG SQLite");
}

if (existsSync(DB)) {
  if (!await validate("data/transit.sqlite", false)) throw new Error("existing fallback/LKG transit SQLite failed validation");
  console.log("[deploy:data] fallback/LKG SQLite ready");
  process.exit(0);
}

console.warn("[deploy:data] no fallback/LKG SQLite exists; building deterministic fallback data");
if (!await buildFixtureFallback()) throw new Error("deploy transit fallback build failed");
console.log("[deploy:data] fallback SQLite ready");
