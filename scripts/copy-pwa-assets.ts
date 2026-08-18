import { mkdir } from "node:fs/promises";

const target = "dist/public/icons";
await mkdir(target, { recursive: true });
if (!(await Bun.file("src/client/manifest.webmanifest").exists())) throw new Error("Missing PWA manifest");
await Bun.write("dist/public/manifest.webmanifest", Bun.file("src/client/manifest.webmanifest"));
for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  const source = `src/client/icons/${name}`;
  if (!(await Bun.file(source).exists())) throw new Error(`Missing PWA icon: ${source}`);
  await Bun.write(`${target}/${name}`, Bun.file(source));
}
console.log(`Copied PWA icons to ${target}`);
