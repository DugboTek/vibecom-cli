import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  ensureGitignored,
  projectIdFor,
  remoteOwner,
  removeProjectSettings,
  settingsPathFor,
  writeProjectSettings,
} from "./core";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibeland-cli-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
  return dir;
}

/* ------- project identity ------- */

test("projectId is stable per (salt, path) and 32 hex chars", () => {
  const id = projectIdFor("salt-a", "/code/app");
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(id, projectIdFor("salt-a", "/code/app"));
});

test("the same path under different salts is uncorrelatable", () => {
  // Two builders working on identically-named paths must not collide, or the
  // server could link their activity together.
  assert.notEqual(
    projectIdFor("salt-a", "/code/app"),
    projectIdFor("salt-b", "/code/app")
  );
});

test("remoteOwner parses ssh, https, and .git forms", () => {
  const cases: [string, string | null][] = [
    ["git@github.com:acme/billing.git", "acme"],
    ["https://github.com/acme/billing.git", "acme"],
    ["https://gitlab.com/acme-corp/thing", "acme-corp"],
    ["ssh://git@bitbucket.org/team/repo.git", "team"],
    ["/local/path/only", null],
    ["", null],
  ];
  for (const [remote, expected] of cases) {
    assert.equal(remoteOwner(remote), expected, remote);
  }
});

/* ------- project settings ------- */

test("settings are written to settings.local.json, never settings.json", () => {
  const dir = repo("scoped");
  const file = writeProjectSettings(dir, "https://vibeland.dev", "tok_abc");

  assert.equal(path.basename(file), "settings.local.json");
  assert.ok(!fs.existsSync(path.join(dir, ".claude", "settings.json")));

  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(
    data.env.OTEL_EXPORTER_OTLP_HEADERS,
    "Authorization=Bearer tok_abc"
  );
  assert.equal(data.env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://vibeland.dev/api");
  // prompt bodies must never be exported, at any tier
  assert.equal(data.env.OTEL_LOG_USER_PROMPTS, "0");
});

test("the token file is not world-readable", () => {
  const dir = repo("perms");
  const file = writeProjectSettings(dir, "https://vibeland.dev", "tok_secret");
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("existing unrelated settings survive linking and unlinking", () => {
  const dir = repo("merge");
  const file = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ permissions: { allow: ["Bash"] }, env: { MY_VAR: "1" } })
  );

  writeProjectSettings(dir, "https://vibeland.dev", "tok");
  let data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(data.permissions, { allow: ["Bash"] });
  assert.equal(data.env.MY_VAR, "1");

  removeProjectSettings(dir);
  data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(data.permissions, { allow: ["Bash"] }, "clobbered user config");
  assert.equal(data.env.MY_VAR, "1", "removed a var we did not add");
  assert.equal(data.env.OTEL_EXPORTER_OTLP_HEADERS, undefined);
});

test("unlinking drops the env block entirely when we added all of it", () => {
  const dir = repo("clean");
  writeProjectSettings(dir, "https://vibeland.dev", "tok");
  removeProjectSettings(dir);
  const data = JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf8"));
  assert.equal(data.env, undefined);
});

test("corrupt settings.local.json does not throw or lose the link", () => {
  const dir = repo("corrupt");
  const file = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json");
  writeProjectSettings(dir, "https://vibeland.dev", "tok");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
});

/* ------- gitignore ------- */

test("the token file is gitignored, and git agrees", () => {
  const dir = repo("ignored");
  writeProjectSettings(dir, "https://vibeland.dev", "tok");
  assert.equal(ensureGitignored(dir), true, "should have added the rule");

  const tracked = execFileSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.ok(
    !tracked.includes("settings.local.json"),
    `git can see the token file:\n${tracked}`
  );
});

test("gitignore is not appended to twice", () => {
  const dir = repo("idempotent");
  assert.equal(ensureGitignored(dir), true);
  assert.equal(ensureGitignored(dir), false);
  const body = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.equal(body.match(/settings\.local\.json/g)?.length, 1);
});

test("an existing .gitignore without a trailing newline is not corrupted", () => {
  const dir = repo("nonewline");
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist");
  ensureGitignored(dir);
  const lines = fs
    .readFileSync(path.join(dir, ".gitignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  assert.ok(lines.includes("dist"), "clobbered the existing rule");
  assert.ok(lines.includes(".claude/settings.local.json"));
});
