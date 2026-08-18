const CACHE_NAME = "jigeumta-shell-v18";
const CACHE_PREFIX = "jigeumta-";
const REQUIRED_SHELL = ["/"];
const OPTIONAL_SHELL = ["/manifest.webmanifest", "/jigeumta_logo_140.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"];
const OFFLINE_RESOURCE_RESPONSE = (): Response => new Response("오프라인 상태로 이 리소스를 불러올 수 없습니다.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });

interface ExtendableLike { waitUntil(promise: Promise<unknown>): void; }
interface FetchLike extends ExtendableLike { request: Request; respondWith(promise: Promise<Response>): void; }
interface PushLike extends ExtendableLike { data?: { json(): unknown }; }
interface NotificationLike extends ExtendableLike { notification: { close(): void; data?: { url?: unknown } }; }
interface WorkerWindowClient { url: string; focus(): Promise<WorkerWindowClient>; navigate(url: string): Promise<WorkerWindowClient>; }
interface WorkerClients { claim(): Promise<void>; matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WorkerWindowClient[]>; openWindow(url: string): Promise<WorkerWindowClient | null>; }
interface ServiceWorkerScopeLike {
  addEventListener(type: "install" | "activate", listener: (event: ExtendableLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchLike) => void): void;
  addEventListener(type: "push", listener: (event: PushLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationLike) => void): void;
  skipWaiting(): Promise<void>;
  clients: WorkerClients;
  registration: ServiceWorkerRegistration;
  location: { origin: string };
}
const scope = self as unknown as ServiceWorkerScopeLike;

async function installShell(): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch("/", { cache: "no-store" });
  if (!response.ok) throw new Error(`PWA shell request failed: ${response.status}`);
  const html = await response.clone().text();
  await cache.put("/", response);
  const discovered = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], scope.location.origin);
      if (url.origin === scope.location.origin && /\.(?:js|css)(?:$|\?)/.test(url.pathname + url.search)) discovered.add(url.pathname + url.search);
    } catch { /* ignore malformed markup */ }
  }
  await Promise.all([...OPTIONAL_SHELL, ...discovered].map(async (url) => {
    try {
      const asset = await fetch(url, { cache: "no-store" });
      if (asset.ok) await cache.put(url, asset);
    } catch { /* keep installation usable when an optional asset is transiently unavailable */ }
  }));
}

scope.addEventListener("install", (event: ExtendableLike) => {
  event.waitUntil(installShell().then(() => scope.skipWaiting()));
});

scope.addEventListener("activate", (event: ExtendableLike) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => scope.clients.claim()));
});

scope.addEventListener("fetch", (event: FetchLike) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== scope.location.origin || url.pathname.startsWith("/api/")) return;
  const isNavigation = event.request.mode === "navigate" || url.pathname === "/";
  if (isNavigation) {
    const navigationResponse = fetch(event.request).then(async (response) => {
      if (response.ok && response.type === "basic") await caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone()));
      return response;
    }).catch(() => caches.match("/").then((fallback) => fallback || OFFLINE_RESOURCE_RESPONSE()));
    event.respondWith(navigationResponse);
    return;
  }
  const runtimeResponse = caches.match(event.request).then((cached) => {
    if (cached) return cached;
    return fetch(event.request).then(async (response) => {
      if (response.ok && response.type === "basic") await caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => OFFLINE_RESOURCE_RESPONSE());
  });
  event.respondWith(runtimeResponse);
});

scope.addEventListener("push", (event: PushLike) => {
  let data: { title?: string; body?: string; url?: string; alert_id?: string; tag?: string } | undefined;
  try { data = event.data?.json() as { title?: string; body?: string; url?: string; alert_id?: string; tag?: string } | undefined; } catch { data = undefined; }
  const tag = typeof data?.tag === "string" && data.tag.trim() ? data.tag : typeof data?.alert_id === "string" && data.alert_id.trim() ? data.alert_id : "jigeumta-arrival-alert";
  event.waitUntil(scope.registration.showNotification(data?.title || "지금타 도착 알림", { body: data?.body || "내릴 역에 도착하기 전에 알려드려요.", tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: data?.url || "/" } }));
});

scope.addEventListener("notificationclick", (event: NotificationLike) => {
  event.notification.close();
  const rawTarget = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  let target = "/";
  try {
    const parsed = new URL(rawTarget, scope.location.origin);
    if (parsed.origin === scope.location.origin) target = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { target = "/"; }
  event.waitUntil(scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const targetClient = clients.find((client) => { try { const parsed = new URL(client.url); return `${parsed.pathname}${parsed.search}${parsed.hash}` === target; } catch { return false; } });
    if (!targetClient) return scope.clients.openWindow(target);
    await targetClient.navigate(target);
    return targetClient.focus();
  }).then(() => undefined));
});
