// Copies the built Meet interceptor next to the harness page.
// Run from extension/ after `npm run build`:  node tests/interceptor-harness/prepare.mjs
import { copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "..", "dist", "assets");
const built = readdirSync(assets).find((f) => /^meet-interceptor.*\.js$/.test(f));
if (!built) {
  console.error("No built interceptor in dist/assets — run `npm run build` first.");
  process.exit(1);
}
copyFileSync(join(assets, built), join(here, "interceptor.js"));
console.log(`Copied ${built} -> tests/interceptor-harness/interceptor.js`);
