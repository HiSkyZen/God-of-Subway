import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const copy = async (source: string, destination: string): Promise<void> => {
  if (!(await Bun.file(source).exists())) throw new Error(`Missing build asset: ${source}`);
  await Bun.write(destination, Bun.file(source));
};
const workspaceRoot = resolve(import.meta.dir, "..");
const serverRoot = resolve(workspaceRoot, "dist/server");
const safeRemoveServerChild = async (relative: string): Promise<void> => {
  const target = resolve(serverRoot, relative);
  if (dirname(target).toLowerCase() !== serverRoot.toLowerCase() && relative !== "client") throw new Error(`Refusing to remove unexpected build path: ${relative}`);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Refusing to remove linked build path: ${relative}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(target, { recursive: relative === "client", force: true });
};

await mkdir("dist/public/icons", { recursive: true });
const bundledHtml = await Bun.file("dist/server/client/index.html").text();
const canonicalHtml = bundledHtml.replace(
  /\.\.\/icon-(192|512|maskable-512)-[a-z0-9]+\.png/gi,
  (_match, name: string) => `/icons/icon-${name}.png`,
).replace(/\.\.\/manifest-[a-z0-9]+\.webmanifest/gi, "/manifest.webmanifest")
  .replace(/\.\.\/jigeumta_logo_140-[a-z0-9]+\.png/gi, "/jigeumta_logo_140.png");
await Bun.write("dist/public/index.html", canonicalHtml);
for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  if (!(await Bun.file(`dist/public/icons/${icon}`).exists())) throw new Error(`Missing PWA icon: ${icon}`);
}
await copy("src/client/jigeumta_logo_140.png", "dist/public/jigeumta_logo_140.png");
// Bun's HTML import emits hashed JS/CSS and duplicate hashed PWA assets beside
// server.js. Publish only the JS/CSS; HTML is normalized to the stable
// manifest/icon/logo URLs copied above, avoiding byte-identical duplicates.
for await (const path of new Bun.Glob("index-*.{js,css}").scan({ cwd: "dist/server", onlyFiles: true })) {
  await copy(`dist/server/${path}`, `dist/public/${path}`);
}
await safeRemoveServerChild("client");
for (const pattern of ["index-*.js", "index-*.css", "manifest-*.webmanifest", "jigeumta_logo_*-*.png", "icon-*-*.png"]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: "dist/server", onlyFiles: true })) {
    await safeRemoveServerChild(path);
  }
}
console.log("Promoted static output to dist/public; dist/server remains private");
