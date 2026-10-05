import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

/* Whole-machine tracking writes into Claude Code's user-level settings — a
   file the person did not create for us, which already holds their
   permissions, hooks and model choices. Every test here is a way that write
   could damage something that was not ours to damage. The module reads
   os.homedir() at import time, so each case runs in a child process with HOME
   pointed at a fixture. */

/* Resolved from this file, not from process.cwd(). Deriving it from the
   working directory meant the suite only passed when it was started from the
   repository root: run from `cli/` — which is what `cli/package.json`'s own
   test script does, and what the release workflow runs before publishing —
   the path became `cli/cli/src/core.ts`, every case failed to import, and the
   CLI silently stopped being released. */
const coreModule = path.resolve(__dirname, "core.ts");
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-global-test-"))
);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let caseNumber = 0;

/** Run `body` with HOME set to a fresh fixture; returns stdout. */
function inHome(setup: (home: string) => void, body: string): string {
  const home = path.join(tmp, `home-${++caseNumber}`);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  setup(home);
  const script = `
    const core = await import(${JSON.stringify(coreModule)});
    const fs = await import("node:fs");
    const settings = ${JSON.stringify(path.join(home, ".claude", "settings.json"))};
    ${body}
  `;
  /* A real file, not `-e`: tsx's loader does not resolve a .ts import from an
     eval'd module, and returns a stub whose every export is undefined. */
  const runner = path.join(tmp, `case-${caseNumber}.mts`);
  fs.writeFileSync(runner, script);
  return execFileSync(process.execPath, ["--import", "tsx", runner], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    cwd: path.dirname(coreModule),
  });
}

test("a settings file that does not parse is never overwritten", () => {
  /* Merging into {} when JSON.parse fails means silently replacing the file.
     One stray comma in somebody's config would cost them every permission and
     hook they had set — and they would find out later, not now. */
  const broken = '{"permissions":{"allow":["Bash"]},,,BROKEN';
  const out = inHome(
    (home) =>
      fs.writeFileSync(path.join(home, ".claude", "settings.json"), broken),
    `try { core.writeGlobalSettings("https://example.com", "tok"); console.log("WROTE"); }
     catch (e) { console.log("REFUSED:" + e.message); }
     console.log("CONTENT:" + fs.readFileSync(settings, "utf8"));`
  );
  assert.match(out, /REFUSED:.*not valid JSON/);
  assert.match(out, /CONTENT:\{"permissions".*BROKEN/);
  assert.doesNotMatch(out, /WROTE/);
});

test("a symlinked settings file is refused, not swapped for a real one", () => {
  /* The atomic rename replaces the link with a regular file. The token never
     reaches the link target, so nothing leaks into a dotfiles repository — but
     the symlink is gone and the real settings stop applying, silently. */
  const out = inHome(
    (home) => {
      const target = path.join(home, "dotfiles-settings.json");
      fs.writeFileSync(target, '{"model":"opus"}');
      fs.rmSync(path.join(home, ".claude", "settings.json"), { force: true });
      fs.symlinkSync(target, path.join(home, ".claude", "settings.json"));
    },
    `try { core.writeGlobalSettings("https://example.com", "tok"); console.log("WROTE"); }
     catch (e) { console.log("REFUSED:" + e.message); }
     console.log("STILL_LINK:" + fs.lstatSync(settings).isSymbolicLink());
     console.log("TARGET:" + fs.readFileSync(settings, "utf8"));`
  );
  assert.match(out, /REFUSED:.*symlink/);
  assert.match(out, /STILL_LINK:true/);
  assert.match(out, /TARGET:\{"model":"opus"\}/);
});

test("unrelated settings survive both the write and the removal", () => {
  const out = inHome(
    (home) =>
      fs.writeFileSync(
        path.join(home, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Bash"] }, model: "opus" })
      ),
    `core.writeGlobalSettings("https://example.com", "tok");
     console.log("ON:" + core.globalTrackingOn());
     console.log("TOKEN:" + core.readGlobalToken());
     core.removeGlobalSettings();
     console.log("OFF:" + core.globalTrackingOn());
     const after = JSON.parse(fs.readFileSync(settings, "utf8"));
     console.log("KEPT:" + JSON.stringify(after.permissions) + "|" + after.model);
     console.log("ENV_GONE:" + (after.env === undefined));`
  );
  assert.match(out, /ON:true/);
  assert.match(out, /TOKEN:tok/);
  assert.match(out, /OFF:false/);
  assert.match(out, /KEPT:\{"allow":\["Bash"\]\}\|opus/);
  assert.match(out, /ENV_GONE:true/);
});

test("the token file is not world-readable", () => {
  const out = inHome(
    () => undefined,
    `core.writeGlobalSettings("https://example.com", "tok");
     console.log("MODE:" + (fs.statSync(settings).mode & 0o777).toString(8));`
  );
  assert.match(out, /MODE:600/);
});

test("removal on a machine that was never tracked is a no-op, not a crash", () => {
  const out = inHome(
    () => undefined,
    `console.log("ON:" + core.globalTrackingOn());
     console.log("TOKEN:" + core.readGlobalToken());
     console.log("REMOVED:" + core.removeGlobalSettings());`
  );
  assert.match(out, /ON:false/);
  assert.match(out, /TOKEN:null/);
  assert.match(out, /REMOVED:false/);
});

test("turning tracking on twice replaces the token rather than duplicating it", () => {
  const out = inHome(
    () => undefined,
    `core.writeGlobalSettings("https://example.com", "first");
     core.writeGlobalSettings("https://example.com", "second");
     console.log("TOKEN:" + core.readGlobalToken());
     const raw = fs.readFileSync(settings, "utf8");
     console.log("COUNT:" + (raw.match(/Bearer/g) || []).length);`
  );
  assert.match(out, /TOKEN:second/);
  assert.match(out, /COUNT:1/);
});

test("an http origin is still refused for whole-machine tracking", () => {
  const out = inHome(
    () => undefined,
    `try { core.writeGlobalSettings("http://evil.example.com", "tok"); console.log("WROTE"); }
     catch (e) { console.log("REFUSED:" + e.message); }`
  );
  assert.match(out, /REFUSED:.*HTTPS/);
  assert.doesNotMatch(out, /WROTE/);
});

test("archive collection preserves tokens and unrelated settings while disabling only our exporter", () => {
  const out = inHome((home) => {
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.com/api", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer retained",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1", EXTRA: "keep" } }));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n[otel]\nexporter = { otlp-http = { endpoint = "https://example.com/api/v1/logs", protocol = "json", headers = { "Authorization" = "Bearer retained" } } }\n');
  }, `core.enableArchiveCollection("https://example.com");
      console.log("TOKEN:" + core.readGlobalToken());
      const config = JSON.parse(fs.readFileSync(settings, "utf8"));
      console.log("STATE:" + config.env.CLAUDE_CODE_ENABLE_TELEMETRY + "|" + config.env.OTEL_METRICS_EXPORTER + "|" + config.env.EXTRA + "|" + config.model);
      console.log("CODEX:" + fs.readFileSync(core.CODEX_CONFIG_FILE, "utf8"));`);
  assert.match(out, /TOKEN:retained/);
  assert.match(out, /STATE:0\|none\|keep\|opus/);
  assert.match(out, /model = "gpt-5"/);
  assert.doesNotMatch(out, /exporter =/);
});

test("archive migration leaves another provider's telemetry untouched", () => {
  const out = inHome((home) => {
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://other.example/api", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer other",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1" } }));
  }, `const before = fs.readFileSync(settings, "utf8"); core.enableArchiveCollection("https://example.com");
      console.log("UNCHANGED:" + (before === fs.readFileSync(settings, "utf8")));`);
  assert.match(out, /UNCHANGED:true/);
});
