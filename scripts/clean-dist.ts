import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const expectedRoot = normalize(workspaceRoot).toLowerCase();
const target = resolve(workspaceRoot, "dist");
const targetParent = normalize(dirname(target)).toLowerCase();
if (targetParent !== expectedRoot || normalize(target).toLowerCase() === expectedRoot) {
  throw new Error("Refusing to clean an unexpected dist path");
}
try {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing to clean a non-directory or link");
  const resolvedTarget = normalize(await realpath(target)).toLowerCase();
  if (resolvedTarget !== normalize(target).toLowerCase()) throw new Error("Refusing to clean a redirected dist path");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await rm(target, { recursive: true, force: true });
