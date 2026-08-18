import { describe, expect, test } from "bun:test";

describe("service worker production URL contract", () => {
  test("transpiles a worker that uses stable shell URLs and an offline fallback", async () => {
    const source = await Bun.file("src/client/sw.ts").text();
    expect(source).toContain('const REQUIRED_SHELL = ["/"]');
    expect(source).not.toContain('cache.put("/index.html"');
    expect(source).not.toContain('caches.match("/index.html"');
    expect(source).toContain('new Response("오프라인 상태로 이 리소스를 불러올 수 없습니다."');
    expect(source).toContain('scope.registration.showNotification');
    expect(source).toContain('url.origin !== scope.location.origin');
    expect(source).toContain('response.ok && response.type === "basic"');
    expect(source).toContain('event.waitUntil(runtimeResponse.then(() => undefined))');
    expect(source).toMatch(/const CACHE_NAME = "jigeumta-shell-v\d+"/);
    expect(source).not.toContain('const LEGACY_EVENT_API');
    const html = await Bun.file("src/client/index.html").text();
    expect(html).toContain('<link rel="apple-touch-icon" href="./icons/icon-192.png" />');
    expect(html).not.toContain('<link rel="apple-touch-icon" href="./jigeumta_logo_140.png" />');
    const build = await Bun.build({ entrypoints: ["src/client/sw.ts"], target: "browser", format: "esm", minify: false });
    expect(build.success).toBe(true);
  });

  test("returns plain 503 asset misses and preserves unrelated origin caches", async () => {
    type FetchHarness = {
      request: Request;
      respondWith(promise: Promise<Response>): void;
      waitUntil(promise: Promise<unknown>): void;
    };
    type FetchListener = (event: FetchHarness) => void;
    type ActivateListener = (event: { waitUntil(promise: Promise<unknown>): void }) => void;
    type PushListener = (event: { data?: { json(): unknown }; waitUntil(promise: Promise<unknown>): void }) => void;
    const listeners = new Map<string, unknown>();
    const source = await Bun.file("src/client/sw.ts").text();
    const currentCacheName = source.match(/const CACHE_NAME = "([^"]+)"/)?.[1];
    expect(currentCacheName).toBeDefined();
    const deletedCaches: string[] = [];
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    const fakeScope = {
      addEventListener: (type: string, listener: unknown): void => { listeners.set(type, listener); },
      clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => null },
      location: { origin: "https://jigeumta.example" },
      registration: { showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); } },
      skipWaiting: async () => undefined,
    };
    const fakeCaches = {
      delete: async (key: string) => { deletedCaches.push(key); return true; },
      keys: async () => ["jigeumta-shell-obsolete", currentCacheName!, "other-app-shell-v9"],
      match: async (request: RequestInfo | URL) => typeof request === "string" && request === "/"
        ? new Response("<!doctype html><title>cached shell</title>", { headers: { "Content-Type": "text/html" } })
        : undefined,
      open: async () => ({ add: async () => undefined, addAll: async () => undefined, put: async () => undefined }),
    };
    const descriptors = {
      caches: Object.getOwnPropertyDescriptor(globalThis, "caches"),
      fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
      self: Object.getOwnPropertyDescriptor(globalThis, "self"),
    };
    const restore = (name: "caches" | "fetch" | "self", descriptor: PropertyDescriptor | undefined): void => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    };
    try {
      Object.defineProperty(globalThis, "self", { configurable: true, value: fakeScope });
      Object.defineProperty(globalThis, "caches", { configurable: true, value: fakeCaches });
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { throw new TypeError("offline"); } });
      const transpiled = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
      new Function(transpiled)();
      let activateLifetime: Promise<unknown> | undefined;
      (listeners.get("activate") as ActivateListener | undefined)?.({ waitUntil: (promise) => { activateLifetime = promise; } });
      expect(activateLifetime).toBeDefined();
      await activateLifetime;
      expect(deletedCaches).toEqual(["jigeumta-shell-obsolete"]);
      const listener = listeners.get("fetch") as FetchListener | undefined;
      expect(listener).toBeDefined();
      let navigationResponse: Promise<Response> | undefined;
      listener?.({
        request: new Request("https://jigeumta.example/"),
        respondWith: (promise) => { navigationResponse = promise; },
        waitUntil: () => undefined,
      });
      expect(await (await navigationResponse!).text()).toContain("cached shell");
      for (const path of ["/assets/app.js", "/assets/app.css", "/icons/offline.png"]) {
        let responsePromise: Promise<Response> | undefined;
        let lifetimePromise: Promise<unknown> | undefined;
        listener?.({
          request: new Request(`https://jigeumta.example${path}`),
          respondWith: (promise) => { responsePromise = promise; },
          waitUntil: (promise) => { lifetimePromise = promise; },
        });
        expect(responsePromise).toBeDefined();
        expect(lifetimePromise).toBeDefined();
        const response = await responsePromise!;
        await lifetimePromise;
        expect(response.status).toBe(503);
        expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(await response.text()).not.toContain("cached shell");
      }
      const pushListener = listeners.get("push") as PushListener | undefined;
      let pushLifetime: Promise<unknown> | undefined;
      pushListener?.({ data: { json: () => ({ alert_id: "alert-123", title: "도착 임박" }) }, waitUntil: (promise) => { pushLifetime = promise; } });
      await pushLifetime;
      expect(notifications.at(-1)?.options?.tag).toBe("alert-123");
      pushListener?.({ data: { json: () => ({ alert_id: "alert-123", tag: "arrival-alert-123" }) }, waitUntil: (promise) => { pushLifetime = promise; } });
      await pushLifetime;
      expect(notifications.at(-1)?.options?.tag).toBe("arrival-alert-123");
      pushListener?.({ waitUntil: (promise) => { pushLifetime = promise; } });
      await pushLifetime;
      expect(notifications.at(-1)?.options?.tag).toBe("jigeumta-arrival-alert");
    } finally {
      restore("self", descriptors.self);
      restore("caches", descriptors.caches);
      restore("fetch", descriptors.fetch);
    }
  });
});
