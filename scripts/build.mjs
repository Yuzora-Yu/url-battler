import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const out = resolve(dist, "games/url-battler");
await rm(dist, { recursive:true, force:true });
await mkdir(out, { recursive:true });
for (const file of ["index.html","styles.css","app.js","config.js"]) {
  await cp(resolve(root,file), resolve(out,file));
}
await cp(resolve(root,"assets"), resolve(out,"assets"), { recursive:true });
console.log(`Built ${out}`);
