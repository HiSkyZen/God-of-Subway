import { describe, expect, test } from "bun:test";

const clientRoot = "src/client";
const architectureFiles = [
  "app.tsx",
  "components.tsx",
  "storage.ts",
  "use-journey-search.ts",
  "use-live-journey.ts",
  "use-push-pwa.ts",
] as const;

async function localDependencies(file: string): Promise<string[]> {
  const source = await Bun.file(`${clientRoot}/${file}`).text();
  const dependencies: string[] = [];
  for (const match of source.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
    const requested = match[1];
    const candidates = [`${requested}.ts`, `${requested}.tsx`];
    for (const candidate of candidates) {
      if (architectureFiles.includes(candidate as typeof architectureFiles[number])) dependencies.push(candidate);
    }
  }
  return dependencies;
}

describe("React client architecture boundaries", () => {
  test("keeps app.tsx as a composition facade", async () => {
    const source = await Bun.file(`${clientRoot}/app.tsx`).text();
    expect(source.split(/\r?\n/).length).toBeLessThan(180);
    expect(source).toContain('from "./use-journey-search"');
    expect(source).toContain('from "./use-live-journey"');
    expect(source).toContain('from "./use-push-pwa"');
    expect(source).toContain('from "./components"');
    expect(source).not.toContain("setInterval(");
    expect(source).not.toContain("serviceWorker.register(");
    expect(source).not.toContain("tripUpdate(");
    expect(source).not.toContain("pushAlertStatus(");
  });

  test("has no circular dependency among extracted feature boundaries", async () => {
    const graph = new Map<string, string[]>();
    await Promise.all(architectureFiles.map(async (file) => graph.set(file, await localDependencies(file))));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (file: string): void => {
      if (visiting.has(file)) throw new Error(`circular client dependency at ${file}`);
      if (visited.has(file)) return;
      visiting.add(file);
      for (const dependency of graph.get(file) || []) visit(dependency);
      visiting.delete(file);
      visited.add(file);
    };
    for (const file of architectureFiles) visit(file);
    expect(visited.size).toBe(architectureFiles.length);
  });

  test("owns lifecycle listeners and timers in cleanup-aware controllers", async () => {
    const push = await Bun.file(`${clientRoot}/use-push-pwa.ts`).text();
    const live = await Bun.file(`${clientRoot}/use-live-journey.ts`).text();
    expect(push).toContain('removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt)');
    expect(push).toContain('removeEventListener("controllerchange", handleControllerChange)');
    expect(push).toContain('removeEventListener("visibilitychange", handleVisibility)');
    expect(live).toContain("window.clearInterval(timer)");
    expect(live).toContain("liveTripRef.current");
    expect(live).toContain("optionsRef.current");
  });
});
