import { resolve } from "node:path";

const sourceIndexPath = "src/client/index.html";
const builtIndexPath = Bun.env.PWA_INDEX_PATH || "dist/public/index.html";

const source = await Bun.file(sourceIndexPath).text();
const builtRoot = builtIndexPath.replace(/[\\/][^\\/]+$/, "");
if (!/<link[^>]+rel=["']manifest["']/i.test(source)) {
  throw new Error(`${sourceIndexPath} does not reference a web app manifest`);
}
const sourceClient = await Bun.file("src/client/app.tsx").text();
if (!/(serviceWorker|service-worker|sw\.js)/i.test(`${source}\n${sourceClient}`)) {
  throw new Error(`${sourceIndexPath} and app.tsx do not reference a service worker registration`);
}
const workerSource = await Bun.file("src/client/sw.ts").text();
if (/(?:["'])(?:\.?\/)[^"']+\.(?:ts|tsx)(?:["'])/i.test(workerSource)) {
  throw new Error("Service-worker precache contains source TypeScript paths; use stable built URLs");
}

if (!(await Bun.file(builtIndexPath).exists())) {
  throw new Error(`Built PWA entrypoint is missing: ${builtIndexPath}. Run bun run build:client first.`);
}
const built = await Bun.file(builtIndexPath).text();
if (!/<link[^>]+rel=["']manifest["']/i.test(built)) {
  throw new Error(`Built PWA entrypoint has no manifest link: ${builtIndexPath}`);
}
const manifestTag = built.match(/<link[^>]+rel=["']manifest["'][^>]*>/i)?.[0]
  ?? built.match(/<link[^>]+href=["'][^"']+\.webmanifest["'][^>]*>/i)?.[0];
const manifestHref = manifestTag?.match(/href=["']([^"']+)["']/i)?.[1];
if (!manifestHref || /^(?:https?:|data:)/i.test(manifestHref)) {
  throw new Error(`Built PWA entrypoint has no same-origin manifest asset: ${builtIndexPath}`);
}
const manifestName = manifestHref.split(/[?#]/, 1)[0].split("/").pop();
if (!manifestName) throw new Error(`Built PWA manifest href is invalid: ${manifestHref}`);
const manifestPath = resolve(builtRoot, manifestName);
if (!(await Bun.file(manifestPath).exists())) throw new Error(`HTML-referenced PWA manifest is missing: ${manifestName}`);
const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
  start_url?: string;
  scope?: string;
  icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>;
};
if (!manifest.start_url || !manifest.scope || !Array.isArray(manifest.icons) || manifest.icons.length < 2) {
  throw new Error("PWA manifest must define start_url, scope, and at least two icons");
}
if (manifest.start_url !== "/" || manifest.scope !== "/") {
  throw new Error("PWA manifest start_url and scope must both be root-relative /");
}
const pngDimensions = async (path: string): Promise<{ width: number; height: number }> => {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error(`PWA icon is not a valid PNG: ${path}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};
const requiredIcons = new Map([
  ["/icons/icon-192.png", { size: "192x192", width: 192, purpose: "any" }],
  ["/icons/icon-512.png", { size: "512x512", width: 512, purpose: "any" }],
  ["/icons/icon-maskable-512.png", { size: "512x512", width: 512, purpose: "maskable" }],
]);
for (const [src, expected] of requiredIcons) {
  const icon = manifest.icons.find((candidate) => candidate.src === src);
  if (!icon || icon.type !== "image/png" || icon.sizes !== expected.size
    || !(icon.purpose || "any").split(/\s+/).includes(expected.purpose)) {
    throw new Error(`PWA manifest icon contract is invalid: ${src}`);
  }
  const iconPath = resolve(builtRoot, src.replace(/^\/+/, ""));
  const dimensions = await pngDimensions(iconPath);
  if (dimensions.width !== expected.width || dimensions.height !== expected.width) {
    throw new Error(`PWA icon dimensions do not match manifest: ${src}`);
  }
}
const referencedAssets = new Set<string>();
for (const match of built.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
  const value = match[1];
  if (!value || value.startsWith("http") || value.startsWith("data:")) continue;
  const publicPath = new URL(value, "https://pwa.invalid/index.html").pathname;
  const name = publicPath.split("/").pop();
  if (name) {
    referencedAssets.add(name);
    const assetPath = resolve(builtRoot, publicPath.replace(/^\/+/, ""));
    if (!(await Bun.file(assetPath).exists())) throw new Error(`Built HTML references missing asset: ${publicPath}`);
  }
}
for await (const path of new Bun.Glob("index-*.{js,css}").scan({ cwd: builtRoot, onlyFiles: true })) {
  if (!referencedAssets.has(path)) throw new Error(`Stale unreferenced hashed asset: ${path}`);
}
for await (const path of new Bun.Glob("manifest-*.webmanifest").scan({ cwd: builtRoot, onlyFiles: true })) {
  if (!referencedAssets.has(path)) throw new Error(`Stale unreferenced hashed manifest: ${path}`);
}
for await (const path of new Bun.Glob("jigeumta_logo_*-*.png").scan({ cwd: builtRoot, onlyFiles: true })) {
  if (!referencedAssets.has(path)) throw new Error(`Stale unreferenced hashed logo: ${path}`);
}
for await (const path of new Bun.Glob("icon-*-*.png").scan({ cwd: builtRoot, onlyFiles: true })) {
  if (!referencedAssets.has(path)) throw new Error(`Stale unreferenced hashed icon: ${path}`);
}
const jsFiles: string[] = [];
for await (const path of new Bun.Glob("index-*.js").scan({ cwd: builtRoot, onlyFiles: true })) jsFiles.push(path);
for (const path of jsFiles) {
  const size = (await Bun.file(`${builtRoot}/${path}`).arrayBuffer()).byteLength;
  if (size > 1_500_000) throw new Error(`Frontend JS exceeds 1.5 MB budget: ${path} (${size} bytes)`);
}
const serviceWorkerFiles: string[] = [];
for await (const path of new Bun.Glob("**/*sw*.{js,ts}").scan({ cwd: builtRoot, onlyFiles: true })) {
  serviceWorkerFiles.push(path);
}
if (serviceWorkerFiles.length === 0) {
  throw new Error(`Built PWA is missing a service-worker asset under ${builtRoot}`);
}
for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  if (!(await Bun.file(`${builtRoot}/icons/${name}`).exists())) throw new Error(`Built PWA icon is missing: ${name}`);
}
console.log(`PWA assets verified: ${sourceIndexPath} -> ${builtIndexPath}`);
export {};
