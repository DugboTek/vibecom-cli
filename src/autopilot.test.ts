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
  clearSlotStale,
  describeAction,
  installSessionHook,
  isSlotStale,
  listStaleSlots,
  markSlotStale,
  readAutopilot,
  removeSessionHook,
  runAutopilot,
  scanAgentPath,
  scanAgentPlist,
  scanDue,
  sessionHookInstalled,
  staleReason,
  writeAutopilot,
} from "./autopilot";
import {
  CONFIG_DIR,
  EXCLUDED_FILE,
  GLOBAL_SLOT_ROOT,
  excludeOwner,
  excludeRoot,
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

test("the all-provider collector invokes only the installed CLI in quiet scan mode", () => {
  const plist = scanAgentPlist("/Users/example/.local/bin/vibecom", 5);
  assert.match(plist, /<string>\/Users\/example\/.local\/bin\/vibecom<\/string>/);
  assert.match(plist, /<string>scan<\/string><string>--quiet<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(
    scanAgentPath("/Users/example"),
    /\/Users\/example\/Library\/LaunchAgents\/build\.vibecom\.collect\.plist$/
  );
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

/* ------- exclusion gates auto-link (§6, D3) ------- */

test("an excluded root is never auto-linked", async () => {
  fs.rmSync(EXCLUDED_FILE, { force: true });
  const root = repo("git@github.com:DugboTek/mine.git");
  excludeRoot(root);
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "skipped");
  assert.equal(action.kind === "skipped" ? action.reason : "", "excluded");
  assert.equal(spy.calls.length, 0);
  fs.rmSync(EXCLUDED_FILE, { force: true });
});

test("an excluded owner's repository is never auto-linked, even though it would otherwise be trusted", async () => {
  fs.rmSync(EXCLUDED_FILE, { force: true });
  const root = repo("git@github.com:dugbotek/mine.git");
  excludeOwner("dugbotek");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "skipped");
  assert.match(action.kind === "skipped" ? action.reason : "", /excluded/);
  assert.equal(spy.calls.length, 0);
  fs.rmSync(EXCLUDED_FILE, { force: true });
});

test("an unreadable excluded.json refuses to auto-link rather than assume nothing is excluded", async () => {
  fs.mkdirSync(path.dirname(EXCLUDED_FILE), { recursive: true });
  fs.writeFileSync(EXCLUDED_FILE, "{ not json");
  const root = repo("git@github.com:DugboTek/mine.git");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "skipped");
  assert.match(
    action.kind === "skipped" ? action.reason : "",
    /unreadable/
  );
  assert.equal(spy.calls.length, 0, "an unverifiable exclusion list must not link");
  fs.rmSync(EXCLUDED_FILE, { force: true });
});

/* ------- never re-mint after a server-side revocation (§4.3, D8) ------- */

test("a stale project is left alone entirely — no cover, no re-link, no describeAction noise beyond the revocation line", async () => {
  const root = repo("git@github.com:DugboTek/revoked.git");
  writeProjectSettings(root, CRED.origin, "now-revoked-token");
  writeSlot({
    root,
    salt: "s",
    projectId: "p",
    tier: 1,
    label: "revoked",
    origin: CRED.origin,
    linkedAt: new Date().toISOString(),
  });
  markSlotStale(root, "revoked");

  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "stale");
  assert.equal(spy.calls.length, 0, "a stale slot is never re-minted");
  const line = describeAction(action);
  assert.match(line ?? "", /revoked/);
  assert.match(line ?? "", /relink or unlink/);
});

test("a stale repository that was never linked locally is still refused, not auto-linked as if new", async () => {
  // The scenario §4.3 exists for: the local slot may already be gone (hand
  // unlink after revocation, or a future flow that clears it), but staleness
  // must still block a fresh auto-link from minting a brand new grant.
  const root = repo("git@github.com:DugboTek/never-locally-linked.git");
  markSlotStale(root, "revoked");
  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "stale");
  assert.equal(spy.calls.length, 0);
});

test("markSlotStale does not reset staleSince on a second revocation", () => {
  const root = "/code/repeat-offender";
  markSlotStale(root, "revoked");
  const first = listStaleSlots().find((s) => s.root === root)!;
  markSlotStale(root, "revoked again");
  const second = listStaleSlots().find((s) => s.root === root)!;
  assert.equal(second.staleSince, first.staleSince);
  assert.equal(staleReason(root), "revoked", "the first reason is kept");
  clearSlotStale(root);
});

test("clearSlotStale is the only way back — after it, autopilot behaves normally again", async () => {
  const root = repo("git@github.com:DugboTek/healed.git");
  markSlotStale(root);
  assert.equal(isSlotStale(root), true);

  clearSlotStale(root);
  assert.equal(isSlotStale(root), false);
  assert.equal(staleReason(root), null);

  const spy = spyLink();
  const action = await runAutopilot(root, {
    credentials: CRED,
    config: config(),
    link: spy.link,
  });
  assert.equal(action.kind, "linked", "a cleared slot is eligible again");
});

test("clearing a slot that was never stale is a no-op", () => {
  assert.doesNotThrow(() => clearSlotStale("/code/never-stale"));
});

test("the global slot can be marked and queried like any other root", () => {
  // GLOBAL_SLOT_ROOT is just a string key here — a revoked machine-wide
  // token uses the same storage, per §4.3's "the same rule applies to the
  // global token".
  markSlotStale(GLOBAL_SLOT_ROOT, "revoked");
  assert.equal(isSlotStale(GLOBAL_SLOT_ROOT), true);
  clearSlotStale(GLOBAL_SLOT_ROOT);
  assert.equal(isSlotStale(GLOBAL_SLOT_ROOT), false);
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
