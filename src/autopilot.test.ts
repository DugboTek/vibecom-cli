/* Must come first: it plants XDG_CONFIG_HOME before core.ts binds its paths. */
import {
  assertSandboxed,
  cleanupSandbox,
  configHome,
  sandbox as tmp,
} from "./testSandbox";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import {
  AUTOPILOT_FILE,
  DEFAULT_AUTOPILOT,
  claudeSettingsPath,
  describeAction,
  installSessionHook,
  readAutopilot,
  removeSessionHook,
  runAutopilot,
  scanDue,
  sessionHookInstalled,
  writeAutopilot,
} from "./autopilot";
import {
  CONFIG_DIR,
  readProjectToken,
  writeProjectSettings,
  writeSlot,
} from "./core";

assertSandboxed(CONFIG_DIR);
after(cleanupSandbox);

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, stdio: "ignore" });

let made = 0;
function repo(remote?: string): string {
  const dir = path.join(tmp, `repo-${made++}`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main", "."], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  fs.writeFileSync(path.join(dir, "README"), "x\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
  if (remote) git(["remote", "add", "origin", remote], dir);
  return fs.realpathSync(dir);
}

function worktree(root: string, name: string): string {
  const dir = path.join(tmp, `wt-${made++}-${name}`);
  git(["worktree", "add", "-q", "-b", name, dir], root);
  return fs.realpathSync(dir);
}

const CRED = {
  token: "account-token",
  username: "DugboTek",
  origin: "https://example.test",
};

const config = (over: Partial<typeof DEFAULT_AUTOPILOT> = {}) => ({
  ...DEFAULT_AUTOPILOT,
  enabled: true,
  ...over,
});

/** A link stub that records the call instead of reaching the network. */
function spyLink() {
  const calls: { root: string; label: string; tier: number }[] = [];
  const link = async (
    origin: string,
    _accountToken: string,
    repoArg: { root: string; label: string; salt?: string },
    tier: 1 | 2 | 3
  ) => {
    calls.push({ root: repoArg.root, label: repoArg.label, tier });
    return {
      slot: {
        root: repoArg.root,
        salt: "s",
        projectId: "p",
        tier,
        label: repoArg.label,
        origin,
        linkedAt: new Date().toISOString(),
      },
      worktrees: [repoArg.root],
      gitignoreAdded: false,
    };
  };
  return { calls, link };
}

/* ------- configuration ------- */

test("a missing config reads as the conservative default", () => {
  fs.rmSync(AUTOPILOT_FILE, { force: true });
  assert.deepEqual(readAutopilot(), DEFAULT_AUTOPILOT);
  assert.equal(readAutopilot().enabled, false);
});

test("a hand-edited config cannot widen collection past a real tier", () => {
  fs.mkdirSync(path.dirname(AUTOPILOT_FILE), { recursive: true });
  fs.writeFileSync(
    AUTOPILOT_FILE,
    JSON.stringify({ enabled: "yes", tier: 9, scanIntervalMinutes: -5 })
  );
  const parsed = readAutopilot();
  assert.equal(parsed.tier, 1, "an out-of-range tier falls back to the lowest");
  assert.equal(parsed.enabled, false, "a non-boolean is not truthy-coerced");
  assert.equal(parsed.scanIntervalMinutes, DEFAULT_AUTOPILOT.scanIntervalMinutes);
  fs.rmSync(AUTOPILOT_FILE, { force: true });
});

test("a written config round-trips", () => {
  writeAutopilot(config({ tier: 3, scanIntervalMinutes: 30 }));
  const parsed = readAutopilot();
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.tier, 3);
  assert.equal(parsed.scanIntervalMinutes, 30);
  fs.rmSync(AUTOPILOT_FILE, { force: true });
});

/* ------- who may be linked without a prompt ------- */

test("a disabled autopilot links nothing", async () => {
  const root = repo("git@github.com:DugboTek/mine.git");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config({ enabled: false }),
    link: spy.link,
  });
  assert.equal(action.kind, "idle");
  assert.equal(spy.calls.length, 0);
});

test("signed out links nothing", async () => {
  const root = repo("git@github.com:DugboTek/mine.git");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: null,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "idle");
  assert.equal(spy.calls.length, 0);
});

test("a directory that is not a repository links nothing", async () => {
  const plain = path.join(tmp, "not-a-repo");
  fs.mkdirSync(plain, { recursive: true });
  const spy = spyLink();
  const action = await runAutopilot(plain, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "idle");
  assert.equal(spy.calls.length, 0);
});

test("a repository with no remote owner is never linked unattended", async () => {
  const root = repo();
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "skipped");
  assert.equal(
    action.kind === "skipped" ? action.reason : "",
    "no remote owner"
  );
  assert.equal(spy.calls.length, 0, "no token may be minted without ownership");
});

test("an untrusted owner is skipped, not linked", async () => {
  const root = repo("git@github.com:SomeoneElse/theirs.git");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "skipped");
  assert.match(
    action.kind === "skipped" ? action.reason : "",
    /SomeoneElse is not trusted/
  );
  assert.equal(spy.calls.length, 0);
});

test("your own repository links, matching owner case-insensitively", async () => {
  const root = repo("git@github.com:dugbotek/mine.git");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config({ tier: 2 }),
    link: spy.link,
  });
  assert.equal(action.kind, "linked");
  assert.deepEqual(spy.calls, [
    { root, label: path.basename(root), tier: 2 },
  ]);
});

test("a trusted owner's repository links at the configured tier", async () => {
  fs.writeFileSync(
    path.join(configHome, "vibecom", "trusted_owners.json"),
    JSON.stringify(["ShotTrackerDEV"])
  );
  const root = repo("git@bitbucket.org:ShotTrackerDEV/shottracker-va.git");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config({ tier: 3 }),
    link: spy.link,
  });
  assert.equal(action.kind, "linked");
  assert.equal(action.kind === "linked" ? action.owner : null, "ShotTrackerDEV");
  assert.equal(spy.calls[0].tier, 3);
});

test("autoLink off leaves an eligible repository alone", async () => {
  const root = repo("git@github.com:DugboTek/mine.git");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config({ autoLink: false }),
    link: spy.link,
  });
  assert.equal(action.kind, "idle");
  assert.equal(spy.calls.length, 0);
});

/* ------- covering checkouts of a project already linked ------- */

test("a worktree created after linking is covered from the existing token", async () => {
  const root = repo("git@github.com:DugboTek/covered.git");
  writeProjectSettings(root, CRED.origin, "project-token");
  writeSlot({
    root,
    salt: "s",
    projectId: "p",
    tier: 1,
    label: "covered",
    origin: CRED.origin,
    linkedAt: new Date().toISOString(),
  });
  const tree = worktree(root, "feature");
  assert.equal(readProjectToken(tree), null, "worktree starts uncovered");

  const spy = spyLink();
  const action = await runAutopilot(tree, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });

  assert.equal(action.kind, "covered");
  assert.equal(
    readProjectToken(tree),
    "project-token",
    "the same grant reaches the checkout git skipped"
  );
  assert.equal(spy.calls.length, 0, "covering is not a new grant");
});

test("standing in a worktree resolves to the project, not a new repository", async () => {
  const root = repo("git@github.com:SomeoneElse/theirs.git");
  writeProjectSettings(root, CRED.origin, "project-token");
  writeSlot({
    root,
    salt: "s",
    projectId: "p",
    tier: 1,
    label: "theirs",
    origin: CRED.origin,
    linkedAt: new Date().toISOString(),
  });
  const tree = worktree(root, "wt");
  const spy = spyLink();
  const action = await runAutopilot(tree, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  // Untrusted owner, yet already linked by hand: coverage still applies.
  assert.equal(action.kind, "covered");
  assert.equal(spy.calls.length, 0);
});

test("a fully covered project is idle", async () => {
  const root = repo("git@github.com:DugboTek/quiet.git");
  writeProjectSettings(root, CRED.origin, "project-token");
  writeSlot({
    root,
    salt: "s",
    projectId: "p",
    tier: 1,
    label: "quiet",
    origin: CRED.origin,
    linkedAt: new Date().toISOString(),
  });
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spyLink().link,
  });
  assert.equal(action.kind, "idle");
  assert.equal(describeAction(action), null, "silence when nothing changed");
});

test("a linked project whose token was removed by hand is left alone", async () => {
  const root = repo("git@github.com:DugboTek/stripped.git");
  writeSlot({
    root,
    salt: "s",
    projectId: "p",
    tier: 1,
    label: "stripped",
    origin: CRED.origin,
    linkedAt: new Date().toISOString(),
  });
  worktree(root, "orphan");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "idle");
  assert.equal(spy.calls.length, 0, "an unlinked-by-hand project stays that way");
});

/* ------- the background-scan throttle ------- */

test("scans are due when none has ever run, then throttled", () => {
  const cfg = config({ scanIntervalMinutes: 15 });
  assert.equal(scanDue(cfg, 1_000_000, {}), true);
  const justNow = new Date(1_000_000).toISOString();
  assert.equal(scanDue(cfg, 1_000_000, { lastScanAt: justNow }), false);
  assert.equal(
    scanDue(cfg, 1_000_000 + 15 * 60_000, { lastScanAt: justNow }),
    true
  );
});

test("an unparseable watermark does not wedge scanning off", () => {
  const cfg = config();
  assert.equal(scanDue(cfg, 1_000_000, { lastScanAt: "not a date" }), true);
});

test("scanning off means never due", () => {
  const cfg = config({ scan: false });
  assert.equal(scanDue(cfg, 1_000_000, {}), false);
});

/* ------- the session hook in Claude Code settings ------- */

const settingsFile = () => path.join(tmp, `claude-${made++}.json`);

test("installing creates the settings file with a SessionStart entry", () => {
  const file = settingsFile();
  installSessionHook("/usr/local/bin/vibecom", file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = data.hooks.SessionStart[0].hooks[0];
  assert.equal(entry.command, "/usr/local/bin/vibecom");
  assert.deepEqual(entry.args, ["hook"]);
  assert.equal(entry.type, "command");
  assert.equal(sessionHookInstalled(file), true);
});

test("installing preserves unrelated settings and other SessionStart hooks", () => {
  const file = settingsFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      model: "opus",
      env: { FOO: "1" },
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "other-tool", args: ["go"] }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "beep" }] }],
      },
    })
  );
  installSessionHook("/usr/local/bin/vibecom", file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.model, "opus");
  assert.deepEqual(data.env, { FOO: "1" });
  assert.equal(data.hooks.Stop[0].hooks[0].command, "beep");
  const commands = data.hooks.SessionStart.flatMap((g: any) =>
    g.hooks.map((h: any) => h.command)
  );
  assert.deepEqual(commands, ["other-tool", "/usr/local/bin/vibecom"]);
});

test("installing twice leaves exactly one entry", () => {
  const file = settingsFile();
  installSessionHook("/usr/local/bin/vibecom", file);
  installSessionHook("/opt/vibecom", file);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const ours = data.hooks.SessionStart.flatMap((g: any) =>
    g.hooks.filter((h: any) => h.args?.[0] === "hook")
  );
  assert.equal(ours.length, 1);
  assert.equal(ours[0].command, "/opt/vibecom", "reinstall repoints the entry");
});

test("installing backs the original up once, and never rewrites the backup", () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({ model: "original" }));
  const first = installSessionHook("/usr/local/bin/vibecom", file);
  assert.ok(first.backup);
  assert.match(fs.readFileSync(first.backup!, "utf8"), /original/);
  installSessionHook("/usr/local/bin/vibecom", file);
  assert.match(
    fs.readFileSync(first.backup!, "utf8"),
    /original/,
    "the pre-vibecom copy is the one worth keeping"
  );
});

test("installing refuses to overwrite settings it cannot parse", () => {
  const file = settingsFile();
  fs.writeFileSync(file, "{ this is not json");
  assert.throws(
    () => installSessionHook("/usr/local/bin/vibecom", file),
    /not valid JSON/
  );
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "{ this is not json",
    "a config that cannot be read is never replaced"
  );
});

test("removing takes only our entry", () => {
  const file = settingsFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "other-tool", args: ["go"] }] },
        ],
      },
    })
  );
  installSessionHook("/usr/local/bin/vibecom", file);
  assert.equal(removeSessionHook(file), true);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    data.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    ["other-tool"]
  );
  assert.equal(sessionHookInstalled(file), false);
});

test("removing the last hook prunes the empty containers", () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({ model: "opus" }));
  installSessionHook("/usr/local/bin/vibecom", file);
  assert.equal(removeSessionHook(file), true);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.hooks, undefined, "no empty hooks object left behind");
  assert.equal(data.model, "opus");
});

test("removing when we were never installed reports nothing done", () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({ model: "opus" }));
  assert.equal(removeSessionHook(file), false);
  assert.equal(removeSessionHook(path.join(tmp, "absent.json")), false);
});

test("the settings path is the user-level Claude Code config", () => {
  assert.equal(
    claudeSettingsPath("/home/someone"),
    path.join("/home/someone", ".claude", "settings.json")
  );
});

test("a link is announced, because a silent grant is not consent", () => {
  const line = describeAction({
    kind: "linked",
    label: "shottracker-va",
    owner: "ShotTrackerDEV",
    worktrees: 3,
  });
  assert.match(line ?? "", /shottracker-va/);
  assert.match(line ?? "", /ShotTrackerDEV/);
  assert.match(line ?? "", /unlink/, "the way out is on screen with the grant");
});
