import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  commonGitDir,
  ensureExcluded,
  ensureGitignored,
  gitRoot,
  listWorktrees,
  projectRoot,
  readProjectToken,
  uncoveredWorktrees,
  projectIdFor,
  recommendedRepos,
  remoteOwner,
  removeProjectSettings,
  settingsPathFor,
  secureOrigin,
  writeProjectSettings,
  sendScanned,
} from "./core";

// realpath: macOS symlinks /var -> /private/var, and git reports real paths.
// Comparing a non-canonical fixture path against a canonical one is a test bug.
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-cli-test-"))
);
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

test("onboarding recommends the current personal repo without extra choices", () => {
  const current = {
    root: "/code/mine",
    label: "mine",
    owner: "octocat",
    remote: "https://github.com/octocat/mine",
    linked: null,
    worktrees: ["/code/mine"],
  };
  const client = { ...current, root: "/code/client", label: "client", owner: "acme" };
  assert.deepEqual(recommendedRepos([current, client], "OctoCat", current.root), [current]);
});

test("onboarding never auto-selects another owner's repository", () => {
  const client = {
    root: "/code/client",
    label: "client",
    owner: "acme",
    remote: "https://github.com/acme/client",
    linked: null,
    worktrees: ["/code/client"],
  };
  assert.deepEqual(recommendedRepos([client], "octocat", null), []);
});

/* ------- project settings ------- */

test("settings are written to settings.local.json, never settings.json", () => {
  const dir = repo("scoped");
  const file = writeProjectSettings(dir, "https://vibecom.build", "tok_abc");

  assert.equal(path.basename(file), "settings.local.json");
  assert.ok(!fs.existsSync(path.join(dir, ".claude", "settings.json")));

  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(
    data.env.OTEL_EXPORTER_OTLP_HEADERS,
    "Authorization=Bearer tok_abc"
  );
  assert.equal(data.env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://vibecom.build/api");
  // prompt bodies must never be exported, at any tier
  assert.equal(data.env.OTEL_LOG_USER_PROMPTS, "0");
});

test("the token file is not world-readable", () => {
  const dir = repo("perms");
  const file = writeProjectSettings(dir, "https://vibecom.build", "tok_secret");
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("an existing permissive token file is replaced with mode 0600", () => {
  const dir = repo("perms-existing");
  const file = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}");
  fs.chmodSync(file, 0o644);

  writeProjectSettings(dir, "https://vibecom.build", "tok_secret");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("credential-bearing configuration rejects HTTP origins and URL userinfo", () => {
  const dir = repo("origin");
  assert.throws(
    () => writeProjectSettings(dir, "http://vibecom.build", "tok"),
    /HTTPS/
  );
  assert.throws(() => secureOrigin("https://user:pass@vibecom.build"), /userinfo/);
});

test("existing unrelated settings survive linking and unlinking", () => {
  const dir = repo("merge");
  const file = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ permissions: { allow: ["Bash"] }, env: { MY_VAR: "1" } })
  );

  writeProjectSettings(dir, "https://vibecom.build", "tok");
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
  writeProjectSettings(dir, "https://vibecom.build", "tok");
  removeProjectSettings(dir);
  const data = JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf8"));
  assert.equal(data.env, undefined);
});

test("corrupt settings.local.json does not throw or lose the link", () => {
  const dir = repo("corrupt");
  const file = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json");
  writeProjectSettings(dir, "https://vibecom.build", "tok");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
});

test("settings writes refuse symlinked paths", () => {
  const dir = repo("settings-symlink");
  const outside = path.join(tmp, "outside-settings.json");
  fs.writeFileSync(outside, '{"outside":true}');
  const claude = path.join(dir, ".claude");
  fs.mkdirSync(claude);
  fs.symlinkSync(outside, path.join(claude, "settings.local.json"));

  assert.throws(() => writeProjectSettings(dir, "https://vibecom.build", "tok"), /regular/);
  assert.equal(fs.readFileSync(outside, "utf8"), '{"outside":true}');
});

test("settings writes refuse a symlinked .claude directory", () => {
  const dir = repo("claude-directory-symlink");
  const outside = path.join(tmp, "outside-claude");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dir, ".claude"));

  assert.throws(() => writeProjectSettings(dir, "https://vibecom.build", "tok"), /non-directory/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("tracked settings files never receive credentials", () => {
  const dir = repo("tracked-settings");
  const file = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}");
  execFileSync("git", ["add", "-f", ".claude/settings.local.json"], {
    cwd: dir,
    stdio: "ignore",
  });

  assert.throws(() => writeProjectSettings(dir, "https://vibecom.build", "tok"), /Git-tracked/);
  assert.equal(fs.readFileSync(file, "utf8"), "{}");
});

/* ------- gitignore ------- */

test("the token file is gitignored, and git agrees", () => {
  const dir = repo("ignored");
  writeProjectSettings(dir, "https://vibecom.build", "tok");
  assert.equal(ensureGitignored(dir), true, "should add the tracked guard too");

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

test("gitignore symlinks are not followed", () => {
  const dir = repo("gitignore-symlink");
  const outside = path.join(tmp, "outside-gitignore");
  fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, path.join(dir, ".gitignore"));

  assert.throws(() => ensureGitignored(dir), /non-regular/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});

test("a hostile gitignore fails before any token file is written", () => {
  const dir = repo("gitignore-preflight");
  const outside = path.join(tmp, "outside-preflight");
  fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, path.join(dir, ".gitignore"));

  assert.throws(
    () => writeProjectSettings(dir, "https://vibecom.build", "tok"),
    /non-regular/
  );
  assert.equal(fs.existsSync(settingsPathFor(dir)), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});

/* ------- git worktrees ------- */

function worktree(main: string, name: string): string {
  const dir = path.join(path.dirname(main), name);
  execFileSync("git", ["worktree", "add", "-q", "-b", name, dir], {
    cwd: main,
    stdio: "ignore",
  });
  return dir;
}

function commit(dir: string) {
  fs.writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-qm", "init"], { cwd: dir, stdio: "ignore" });
}

test("a worktree resolves to its main project, not a new one", () => {
  const main = repo("wt-main");
  commit(main);
  const tree = worktree(main, "wt-feature");

  // Agent tools (Conductor, super.engineer) run entirely inside worktrees.
  // Standing in one must identify the project it belongs to.
  assert.equal(projectRoot(tree), main);
  assert.equal(projectRoot(main), main);
  assert.notEqual(gitRoot(tree), main, "sanity: the checkout root does differ");
});

test("the same project id is produced from any checkout", () => {
  const main = repo("wt-id");
  commit(main);
  const tree = worktree(main, "wt-id-feature");
  const salt = "fixed-salt";
  assert.equal(
    projectIdFor(salt, projectRoot(tree)!),
    projectIdFor(salt, projectRoot(main)!),
    "a worktree must not report as a separate project"
  );
});

test("worktrees are enumerated from any checkout", () => {
  const main = repo("wt-list");
  commit(main);
  const tree = worktree(main, "wt-list-feature");
  for (const from of [main, tree]) {
    const trees = listWorktrees(from);
    assert.equal(trees.length, 2, `from ${from}`);
    assert.ok(trees.includes(main));
    assert.ok(trees.includes(tree));
  }
});

test("a worktree created after linking is reported as uncovered", () => {
  const main = repo("wt-cover");
  commit(main);
  writeProjectSettings(main, "https://vibecom.build", "tok");
  assert.deepEqual(uncoveredWorktrees(main), [], "main is covered");

  // `git worktree add` does not copy the gitignored settings file
  const tree = worktree(main, "wt-cover-feature");
  assert.equal(
    fs.existsSync(settingsPathFor(tree)),
    false,
    "settings must not have been copied — that is the whole bug"
  );
  assert.deepEqual(uncoveredWorktrees(main), [tree]);

  // healing it uses the token already on disk, not a new grant
  writeProjectSettings(tree, "https://vibecom.build", readProjectToken(main)!);
  assert.deepEqual(uncoveredWorktrees(main), []);
  assert.equal(readProjectToken(tree), "tok");
});

test("info/exclude covers every worktree without needing a commit", () => {
  const main = repo("wt-exclude");
  commit(main);
  ensureExcluded(main);
  const tree = worktree(main, "wt-exclude-feature");
  writeProjectSettings(tree, "https://vibecom.build", "tok");

  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: tree,
    encoding: "utf8",
  });
  assert.ok(
    !dirty.includes("settings.local.json"),
    `git can see the token file inside the worktree:\n${dirty}`
  );
});

test("info/exclude symlinks are not followed", () => {
  const dir = repo("exclude-symlink");
  const outside = path.join(tmp, "outside-exclude");
  fs.writeFileSync(outside, "keep");
  const exclude = path.join(commonGitDir(dir)!, "info", "exclude");
  fs.rmSync(exclude, { force: true });
  fs.symlinkSync(outside, exclude);

  ensureExcluded(dir);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});

test("a cross-origin redirect is reported, not silently followed", async () => {
  /* apex -> www is a different origin, so fetch strips Authorization on the
     way through. Following it would turn every authenticated call into
     "missing Bearer token", which reads as a bad credential rather than a
     misconfigured host. */
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 308,
      headers: { location: "https://www.example.com/api/v1/logs" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => sendScanned("https://example.com", "tok", []),
      (error: Error) => {
        assert.match(error.message, /redirects to https:\/\/www\.example\.com/);
        assert.match(error.message, /VIBECOM_ORIGIN=https:\/\/www\.example\.com/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a same-origin redirect is still refused rather than looped", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "/somewhere-else" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => sendScanned("https://example.com", "tok", []),
      /unexpected redirect/
    );
  } finally {
    globalThis.fetch = original;
  }
});
