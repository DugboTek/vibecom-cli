import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

/* Standalone build, byte-identical to the bundle vibecom.build serves.
   Pin the stamp to reproduce a published artifact exactly:
     VIBECOM_BUILD_STAMP=$(vibecom --version) npm run build
     shasum -a 256 dist/cli.js */
const outfile = path.join(process.cwd(), "dist", "cli.js");
mkdirSync(path.dirname(outfile), { recursive: true });

const stamp =
  process.env.VIBECOM_BUILD_STAMP ||
  new Date().toISOString().replace(/\.\d+Z$/, "Z");

await build({
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  define: { __VIBECOM_BUILD__: JSON.stringify(stamp) },
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});

chmodSync(outfile, 0o755);
console.log(`built dist/cli.js (${stamp})`);
