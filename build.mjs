import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/* Standalone build, byte-identical to the bundle vibecom.build serves.
   Pin the stamp to reproduce a published artifact exactly:
     VIBECOM_BUILD_STAMP=$(vibecom --version | grep -oE '[0-9-]{10}T[0-9:]{8}Z') npm run build
     shasum -a 256 dist/cli.js */
const outfile = path.join(process.cwd(), "dist", "cli.js");
mkdirSync(path.dirname(outfile), { recursive: true });

const stamp =
  process.env.VIBECOM_BUILD_STAMP ||
  new Date().toISOString().replace(/\.\d+Z$/, "Z");

/* The release number, read from package.json so there is exactly one place a
   version is declared. It used to be hand-written in two files that disagreed:
   `--version` said 3.2.0 while package.json said 0.1.0, so the number a user
   quoted in a bug report described nothing. */
const version = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8")
).version;

await build({
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  define: {
    __VIBECOM_BUILD__: JSON.stringify(stamp),
    __VIBECOM_VERSION__: JSON.stringify(version),
  },
  /* The version must survive minification as a literal, greppable string.
     esbuild turns `vibecom ${VERSION}` into a runtime concatenation, so the
     bundle contained no readable version at all and `versionFromBundle` always
     returned null — which silently disabled the downgrade guard in
     `selfUpdate`, the one thing standing between users and a host serving an
     older CLI. A banner comment is not minified away. */
  banner: {
    js: `#!/usr/bin/env node\n// vibecom ${version} build ${stamp}`,
  },
  legalComments: "none",
});

chmodSync(outfile, 0o755);
console.log(`built dist/cli.js (v${version}, ${stamp})`);
