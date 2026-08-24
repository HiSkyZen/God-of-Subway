import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DB = resolve(ROOT, "data/transit.sqlite");
const PENDING = resolve(ROOT, "data/transit.pending.sqlite");
const CANDIDATE = resolve(ROOT, "data/transit.deploy-candidate.sqlite");
const FAILURE_MARKER = resolve(ROOT, "data/transit-refresh-failure.json");

type FailureMarker = {
  pending_candidate?: boolean;
  failed_timetable_units?: unknown[];
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

function cleanupPendingBundleInput(): void {
  rmSync(PENDING, { force: true });
  rmSync(`${PENDING}-wal`, { force: true });
  rmSync(`${PENDING}-shm`, { force: true });
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
    console.warn("[deploy:data] scheduled transit.sqlite is missing; building deterministic fixture fallback");
    if (!await buildFixtureFallback()) throw new Error("deploy transit fixture fallback build failed");
  } else {
    console.log("[deploy:data] using scheduled validated transit.sqlite");
  }
  cleanupPendingBundleInput();
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
  marker.pending_candidate === true
  && existsSync(PENDING)
  && failedUnits.length > 0
  && Bun.env.KRIC_API_KEY?.trim()
) {
  cleanupCandidate();
  copyFileSync(PENDING, CANDIDATE);
  console.log(`[deploy:data] CI produced a partial live SQLite; retrying only ${failedUnits.length} failed KRIC timetable units inside this deployment`);
  const repairEnv = {
    TRANSIT_DB_PATH: "data/transit.deploy-candidate.sqlite",
    TRANSIT_FAILURE_MARKER: "data/transit-refresh-failure.json",
    TRANSIT_BUILD_HTTP_TIMEOUT_MS: "30000",
    TRANSIT_BUILD_KRIC_RETRIES: "10",
    TRANSIT_BUILD_KRIC_HTTP_CONCURRENCY: "16",
    TRANSIT_DEPLOY_REPAIR_CONCURRENCY: "8",
  };
  const repaired = await run(["bun", "run", "scripts/repair-transit-pending.ts"], repairEnv);
  if (repaired && await validate("data/transit.deploy-candidate.sqlite", true)) {
    rmSync(DB, { force: true });
    renameSync(CANDIDATE, DB);
    rmSync(FAILURE_MARKER, { force: true });
    cleanupPendingBundleInput();
    console.log("[deploy:data] targeted deploy-time KRIC recovery succeeded; repaired live SQLite promoted");
    process.exit(0);
  }
  cleanupCandidate();
  console.warn("[deploy:data] targeted deploy-time KRIC recovery still has failures after 10 retries; falling back to validated LKG/fixture data");
} else if (marker.pending_candidate === true && failedUnits.length > 0 && !Bun.env.KRIC_API_KEY?.trim()) {
  console.warn("[deploy:data] KRIC_API_KEY is unavailable at deploy; cannot retry CI partial failures, using LKG/fixture data");
} else {
  console.warn("[deploy:data] no retryable partial live candidate is available; using LKG/fixture data");
}

cleanupPendingBundleInput();

if (existsSync(DB)) {
  if (!await validate("data/transit.sqlite", false)) throw new Error("existing LKG/fallback transit SQLite failed validation");
  console.log("[deploy:data] validated LKG/fallback SQLite ready");
  process.exit(0);
}

console.warn("[deploy:data] no LKG SQLite exists; building deterministic fixture fallback");
if (!await buildFixtureFallback()) throw new Error("deploy transit fixture fallback build failed");
console.log("[deploy:data] deterministic fixture fallback SQLite ready");
