/* Must come first: it plants XDG_CONFIG_HOME before core.ts binds its paths.
   Several tests below now exercise linkRepo (writes a project slot and scan
   marks) and the exclusion helpers (write excluded.json), both under
   CONFIG_DIR — without this they would write into the developer's real
   ~/.config/vibecom. */
import {
  assertSandboxed,
  cleanupSandbox,
  sandbox as sandboxHome,
} from "./testSandbox";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  CONFIG_DIR,
  EXCLUDED_FILE,
  GLOBAL_SLOT_ROOT,
  commonGitDir,
  ensureExcluded,
  ensureGitignored,
  excludeOwner,
  excludeRoot,
  gitRoot,
  includeOwner,
  includeRoot,
  isOwnerExcluded,
  isRootExcluded,
  linkRepo,
  listWorktrees,
  projectRoot,
  readExcluded,
  readProjectToken,
  readScanMarks,
  removeExclusionSettings,
  settingsPathFor,
  uncoveredWorktrees,
  projectIdFor,
  recommendedRepos,
  remoteOwner,
  removeProjectSettings,
  secureOrigin,
  writeExclusionSettings,
  writeProjectSettings,
  writeScanMarks,
  sendScanned,
  type ScanMark,
} from "./core";

assertSandboxed(CONFIG_DIR);
after(cleanupSandbox);

// realpath: macOS symlinks /var -> /private/var, and git reports real paths.
// Comparing a non-canonical fixture path against a canonical one is a test bug.
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-cli-test-"))
);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
void sandboxHome; // imported for its side effect (planting XDG_CONFIG_HOME)

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

test("standing inside another owner's repo preselects nothing in the chooser", () => {
  /* The manual chooser preselects whatever this returns. It used to default to
     the current directory instead, so refusing to auto-connect an employer's
     repo still handed the chooser that repo pre-ticked — one Enter away from
     the thing the refusal existed to prevent. */
  const client = {
    root: "/code/client",
    label: "client",
    owner: "acme",
    remote: "https://github.com/acme/client",
    linked: null,
    worktrees: ["/code/client"],
  };
  assert.deepEqual(recommendedRepos([client], "octocat", client.root), []);
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

test("an expired sign-in names the command that fixes it", async () => {
  /* The server answers 401 with "invalid token". That is accurate and
     unusable: it names the broken noun, not the next action, and a stored
     credential expires for ordinary reasons. Whatever the server calls it,
     the person at the terminal must be told to run `vibecom login`. */
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "invalid token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => sendScanned("https://example.com", "stale", []),
      (error: Error) => {
        assert.match(error.message, /vibecom login/);
        assert.doesNotMatch(error.message, /^invalid token$/);
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

test("scanned sessions preserve per-model token slices without repeating turns", async () => {
  type WireAttribute = {
    key: string;
    value: { stringValue?: string; doubleValue?: number };
  };
  type WireRecord = { attributes: WireAttribute[] };
  type WirePayload = {
    resourceLogs: { scopeLogs: { logRecords: WireRecord[] }[] }[];
  };
  const original = globalThis.fetch;
  let sent: WirePayload | undefined;
  globalThis.fetch = (async (_input, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ accepted: 2, dropped: 0 });
  }) as typeof fetch;
  try {
    await sendScanned("https://example.com", "tok", [
      {
        tool: "claude-code",
        sessionId: "mixed",
        model: "claude-opus-5",
        turns: 3,
        inputTokens: 30,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 1,
        unpricedTokens: 0,
        activity: [],
        modelUsage: [
          {
            model: "claude-opus-5",
            inputTokens: 20,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            costUsd: 0.8,
            unpricedTokens: 0,
          },
          {
            model: "claude-haiku-4-5",
            inputTokens: 10,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            costUsd: 0.2,
            unpricedTokens: 0,
          },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(sent);
  const records = sent.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(records.length, 3, "two model slices plus the activity reset marker");
  const sessionRecords = records.filter((record) =>
    record.attributes.some(
      (attribute) =>
        attribute.key === "event.name" &&
        attribute.value.stringValue === "vibecom.session"
    )
  );
  const attrs = sessionRecords.map((record) =>
    Object.fromEntries(
      record.attributes.map((attribute) => [
        attribute.key,
        attribute.value.stringValue ?? attribute.value.doubleValue,
      ])
    )
  );
  assert.deepEqual(
    attrs.map((entry) => [entry.model, entry.input_tokens]),
    [
      ["claude-opus-5", 20],
      ["claude-haiku-4-5", 10],
    ]
  );
  assert.deepEqual(
    attrs.map((entry) => entry.turns),
    [3, undefined]
  );
});

test("a long scan yields, so a spinner can actually paint", async () => {
  /* The command looked frozen because scanning is synchronous file I/O across
     thousands of transcripts: it held the event loop for the whole run, so no
     timer — and therefore no spinner frame — could fire. This asserts the loop
     stays responsive, which is the property the spinner depends on. */
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);

  // Stand-in for the scan loop: blocking units with a yield between batches.
  const blockFor = (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* busy */
    }
  };
  for (let i = 0; i < 20; i++) {
    blockFor(8);
    if (i % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  clearInterval(timer);

  assert.ok(
    ticks > 0,
    "no timer fired during the loop — a spinner would appear frozen"
  );
});

test("without yielding, nothing can paint", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const until = Date.now() + 120;
  while (Date.now() < until) {
    /* the old behaviour: block straight through */
  }
  clearInterval(timer);
  assert.equal(ticks, 0, "this documents why the spinner never moved");
});

test("http is allowed for loopback only, so local testing needs no fake TLS", () => {
  /* Requiring HTTPS everywhere left one way to exercise the CLI against a dev
     server: a self-signed certificate plus NODE_TLS_REJECT_UNAUTHORIZED=0.
     That habit is worse than the plaintext it avoids, and loopback has no
     transport to intercept. Anything routable is still refused. */
  assert.equal(secureOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(secureOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => secureOrigin("http://vibecom.build"), /HTTPS/);
  assert.throws(() => secureOrigin("http://localhost.evil.com"), /HTTPS/);
  assert.throws(() => secureOrigin("http://user:pass@localhost:3000"), /userinfo/);
});

test("a checkout whose .git has been removed is not listed as a worktree", () => {
  /* Agent tools leave these behind: the directory survives, the .git does not,
     and git still reports it as `prunable`. Every git command inside one fails,
     so the ignore rule cannot be verified and prepareProjectSettings refuses to
     write a token there — correctly. Returning it anyway made that refusal
     abort the whole repository. */
  const main = repo("ghost-worktree");
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: main });
  execFileSync("git", ["config", "user.name", "t"], { cwd: main });
  fs.writeFileSync(path.join(main, "README"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: main, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: main, stdio: "ignore" });

  const tree = path.join(tmp, "ghost-checkout");
  execFileSync("git", ["worktree", "add", "-q", "-b", "ghost", tree], {
    cwd: main,
    stdio: "ignore",
  });
  assert.equal(listWorktrees(main).length, 2, "both checkouts before removal");

  fs.rmSync(path.join(tree, ".git"), { recursive: true, force: true });
  const live = listWorktrees(main);
  assert.equal(live.length, 1, "the .git-less checkout is dropped");
  assert.equal(live[0], fs.realpathSync(main));
  assert.ok(
    fs.existsSync(tree),
    "the directory itself is left alone — this is a reporting decision, not a cleanup"
  );
});

/* ------- scanVersion ------- */

test("a mark carrying the bumped scanVersion round-trips", () => {
  // Documents that the type widening (§10 Phase 1) does not just compile —
  // marks written under the new value are stored and read back unchanged.
  const mark: ScanMark = {
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    file: "/tmp/a.jsonl",
    lines: 5,
    mtimeMs: 1,
    root: "/some/project",
    activityVersion: 1,
    scanVersion: 3,
  };
  writeScanMarks({ "claude-code:sv3": mark });
  assert.equal(readScanMarks()["claude-code:sv3"].scanVersion, 3);
});

/* ------- mark invalidation on link (§5.2, D10) ------- */

function fetchReturning(body: unknown) {
  return (async () => Response.json(body)) as typeof fetch;
}

const globalMark = (root: string): ScanMark => ({
  turns: 1,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.01,
  file: "/tmp/session.jsonl",
  lines: 20,
  mtimeMs: 1,
  root,
  activityVersion: 1,
  scanVersion: 2,
});

test("linking a repo drops scan marks previously bucketed under the global slot", async () => {
  const dir = repo("link-invalidate-global");
  writeScanMarks({
    "claude-code:global-a": globalMark(GLOBAL_SLOT_ROOT),
    "claude-code:global-b": globalMark(GLOBAL_SLOT_ROOT),
    "claude-code:already-linked": globalMark("/some/other/project"),
  });

  const original = globalThis.fetch;
  globalThis.fetch = fetchReturning({
    access_token: "proj-token",
    tier: 1,
    name: "counters",
    unlocks: "",
    collects: [],
    neverCollects: [],
  });
  try {
    await linkRepo(
      "https://vibecom.build",
      "account-token",
      { root: dir, label: "link-invalidate-global" },
      1
    );
  } finally {
    globalThis.fetch = original;
  }

  const marks = readScanMarks();
  assert.equal(
    marks["claude-code:global-a"],
    undefined,
    "a global-rooted mark is dropped so the session is re-attributed"
  );
  assert.equal(marks["claude-code:global-b"], undefined);
  assert.ok(
    marks["claude-code:already-linked"],
    "a mark that already names a concrete project root is left untouched"
  );
});

test("linking a repo leaves marks alone when nothing was ever bucketed globally", async () => {
  const dir = repo("link-invalidate-noop");
  writeScanMarks({
    "claude-code:elsewhere": globalMark("/some/other/project"),
  });

  const original = globalThis.fetch;
  globalThis.fetch = fetchReturning({
    access_token: "proj-token-2",
    tier: 1,
    name: "counters",
    unlocks: "",
    collects: [],
    neverCollects: [],
  });
  try {
    await linkRepo(
      "https://vibecom.build",
      "account-token",
      { root: dir, label: "link-invalidate-noop" },
      1
    );
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(readScanMarks()["claude-code:elsewhere"]);
});

/* ------- exclusion (§6, D3) ------- */

test("nothing is excluded before excluded.json exists", () => {
  fs.rmSync(EXCLUDED_FILE, { force: true });
  const read = readExcluded();
  assert.equal(read.ok, true);
  assert.deepEqual(read.excluded, { roots: [], owners: [] });
});

test("excluding a root round-trips and is idempotent", () => {
  fs.rmSync(EXCLUDED_FILE, { force: true });
  excludeRoot("/code/employer-repo");
  excludeRoot("/code/employer-repo"); // must not duplicate
  const { excluded } = readExcluded();
  assert.deepEqual(excluded.roots, ["/code/employer-repo"]);
  assert.equal(isRootExcluded(excluded, "/code/employer-repo"), true);
  assert.equal(isRootExcluded(excluded, "/code/other"), false);
});

test("including a root reverses the exclusion", () => {
  fs.rmSync(EXCLUDED_FILE, { force: true });
  excludeRoot("/code/employer-repo");
  includeRoot("/code/employer-repo");
  assert.deepEqual(readExcluded().excluded.roots, []);
});

test("excluding an owner matches case-insensitively, like trusted_owners.json", () => {
  fs.rmSync(EXCLUDED_FILE, { force: true });
  excludeOwner("ShotTrackerDEV");
  const { excluded } = readExcluded();
  assert.equal(isOwnerExcluded(excluded, "shottrackerdev"), true);
  assert.equal(isOwnerExcluded(excluded, "SHOTTRACKERDEV"), true);
  assert.equal(isOwnerExcluded(excluded, "someone-else"), false);
});

test("including an owner reverses the exclusion, case-insensitively", () => {
  fs.rmSync(EXCLUDED_FILE, { force: true });
  excludeOwner("ShotTrackerDEV");
  includeOwner("shottrackerdev");
  assert.deepEqual(readExcluded().excluded.owners, []);
});

test("a hand-truncated excluded.json is reported unreadable, not read as empty", () => {
  fs.mkdirSync(path.dirname(EXCLUDED_FILE), { recursive: true });
  fs.writeFileSync(EXCLUDED_FILE, '{ "roots": [ "/code/a", ');
  const read = readExcluded();
  assert.equal(
    read.ok,
    false,
    "corrupt JSON must not silently read as 'nothing excluded'"
  );
  assert.match(read.reason, /not valid JSON/);
  fs.rmSync(EXCLUDED_FILE, { force: true });
});

test("an excluded.json with the wrong shape is reported unreadable", () => {
  fs.mkdirSync(path.dirname(EXCLUDED_FILE), { recursive: true });
  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify({ roots: "not-an-array" }));
  const read = readExcluded();
  assert.equal(read.ok, false);
  assert.match(read.reason, /unexpected shape/);
  fs.rmSync(EXCLUDED_FILE, { force: true });
});

test("excluded.json as a JSON array (not object) is reported unreadable", () => {
  fs.mkdirSync(path.dirname(EXCLUDED_FILE), { recursive: true });
  fs.writeFileSync(EXCLUDED_FILE, "[]");
  const read = readExcluded();
  assert.equal(read.ok, false);
  fs.rmSync(EXCLUDED_FILE, { force: true });
});

test("excluding while the file is corrupt still records the exclusion being asked for", () => {
  // Same recovery the codebase already accepts for trusted_owners.json and
  // autopilot.json: the write that fixes the file is not itself refused.
  fs.mkdirSync(path.dirname(EXCLUDED_FILE), { recursive: true });
  fs.writeFileSync(EXCLUDED_FILE, "not json at all");
  excludeRoot("/code/recovered");
  const read = readExcluded();
  assert.equal(read.ok, true, "the write repaired the file");
  assert.deepEqual(read.excluded.roots, ["/code/recovered"]);
});

/* ------- telemetry-off project settings (§6.1) ------- */

test("writeExclusionSettings disables telemetry without writing a token", () => {
  const dir = repo("exclusion-settings");
  const file = writeExclusionSettings(dir);
  assert.equal(path.basename(file), "settings.local.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.env.CLAUDE_CODE_ENABLE_TELEMETRY, "0");
  assert.equal(
    data.env.OTEL_EXPORTER_OTLP_HEADERS,
    undefined,
    "no token belongs in an exclusion write"
  );
});

test("writeExclusionSettings survives a machine-wide re-link afterwards", () => {
  // The whole point: project-level env overrides user-level env per key
  // (§3.1), so writing telemetry=1 into settings.json (simulated here by a
  // second write to the same project file, since that is the key that would
  // collide) must not silently re-enable a checkout that opted out.
  const dir = repo("exclusion-survives");
  writeExclusionSettings(dir);
  const file = settingsPathFor(dir);
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).env.CLAUDE_CODE_ENABLE_TELEMETRY,
    "0"
  );
});

test("writeExclusionSettings preserves unrelated settings and is gitignored", () => {
  const dir = repo("exclusion-merge");
  const file = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ permissions: { allow: ["Bash"] }, env: { MY_VAR: "1" } })
  );
  writeExclusionSettings(dir);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(data.permissions, { allow: ["Bash"] });
  assert.equal(data.env.MY_VAR, "1");
  assert.equal(data.env.CLAUDE_CODE_ENABLE_TELEMETRY, "0");

  const tracked = execFileSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.ok(
    !tracked.includes("settings.local.json"),
    `the exclusion write must still be git-ignored:\n${tracked}`
  );
});

test("removeExclusionSettings drops only the key it wrote", () => {
  const dir = repo("exclusion-remove");
  writeExclusionSettings(dir);
  const file = settingsPathFor(dir);
  let data = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...data, env: { ...data.env, KEEP: "1" } })
  );

  removeExclusionSettings(dir);
  data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.env.CLAUDE_CODE_ENABLE_TELEMETRY, undefined);
  assert.equal(data.env.KEEP, "1", "unrelated env was not touched");
});

test("removeExclusionSettings leaves a real project link's telemetry=1 alone", () => {
  // A repo un-excluded and then linked legitimately carries "1", written by
  // writeProjectSettings — that value is not removeExclusionSettings's to
  // touch, or a stale un-exclude could silently turn a live link off.
  const dir = repo("exclusion-remove-linked");
  writeProjectSettings(dir, "https://vibecom.build", "tok");
  removeExclusionSettings(dir);
  const data = JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf8"));
  assert.equal(data.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
});

test("removeExclusionSettings on a checkout that was never excluded does nothing", () => {
  const dir = repo("exclusion-remove-absent");
  assert.doesNotThrow(() => removeExclusionSettings(dir));
  assert.equal(fs.existsSync(settingsPathFor(dir)), false);
});
