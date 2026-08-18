import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const pushDirectory = resolve(workspaceRoot, "src", "api", "push");
const modulePaths = [
  resolve(workspaceRoot, "src", "api", "push.ts"),
  resolve(workspaceRoot, "src", "api", "push-capability.ts"),
  ...(await readdir(pushDirectory))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => resolve(pushDirectory, name)),
];
const moduleSet = new Set(modulePaths);
const graph = new Map<string, string[]>();
const lineCounts = new Map<string, number>();

for (const modulePath of modulePaths) {
  const source = await readFile(modulePath, "utf8");
  lineCounts.set(modulePath, source.split(/\r?\n/).length);
  const dependencies = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const candidate = resolve(dirname(modulePath), specifier.endsWith(".ts") ? specifier : `${specifier}.ts`);
    if (moduleSet.has(candidate)) dependencies.add(candidate);
  }
  graph.set(modulePath, [...dependencies]);
}

const facadePath = resolve(workspaceRoot, "src", "api", "push.ts");
if ((lineCounts.get(facadePath) ?? Number.POSITIVE_INFINITY) > 50) {
  throw new Error("src/api/push.ts must remain a thin facade (maximum 50 lines)");
}
for (const [modulePath, lines] of lineCounts) {
  if (lines > 600) throw new Error(`${relative(workspaceRoot, modulePath)} exceeds the 600-line responsibility limit`);
}

const visiting = new Set<string>();
const visited = new Set<string>();
const stack: string[] = [];
const visit = (modulePath: string): void => {
  if (visited.has(modulePath)) return;
  if (visiting.has(modulePath)) {
    const cycleStart = stack.indexOf(modulePath);
    const cycle = [...stack.slice(cycleStart), modulePath]
      .map((path) => relative(workspaceRoot, path))
      .join(" -> ");
    throw new Error(`Push module import cycle: ${cycle}`);
  }
  visiting.add(modulePath);
  stack.push(modulePath);
  for (const dependency of graph.get(modulePath) ?? []) visit(dependency);
  stack.pop();
  visiting.delete(modulePath);
  visited.add(modulePath);
};
for (const modulePath of modulePaths) visit(modulePath);

const report = modulePaths
  .map((modulePath) => `${relative(workspaceRoot, modulePath)}=${lineCounts.get(modulePath)} lines`)
  .join(", ");
console.log(`Push architecture: ${modulePaths.length} modules, no import cycles. ${report}`);
