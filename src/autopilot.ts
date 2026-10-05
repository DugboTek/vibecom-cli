import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONFIG_DIR,
  type Credentials,
  type ProjectSlot,
  ensureExcluded,
  gitRemote,
  isOwnerExcluded,
  isRootExcluded,
  isTrusted,
  linkRepo,
  listWorktrees,
  projectRoot,
  readExcluded,
  readJson,
  readProjectToken,
  readSlot,
  remoteOwner,
  uncoveredWorktrees,
  writeJson,
  writeProjectSettings,
} from "./core";

/**
 * Autopilot — keep reporting correct without anyone remembering to run the CLI.
 *
 * Two gaps make a manual CLI lose real work, and both are silent. A worktree
 * created after its project was linked starts with no settings file, because
 * the file is gitignored and `git worktree add` never copies it. And a
 * repository that discovery never walked to is simply never linked at all —
 * `discoverRepos` is one level deep on purpose, so a checkout nested two deep
 * is invisible no matter how much work happens inside it.
 *
 * Opening a coding session in a directory is the one event that reliably
 * coincides with both. That is the trigger this module exists to serve.
 */

/* ------- configuration ------- */

export type AutopilotConfig = {
  enabled: boolean;
  /** consent tier applied to a repository linked without a prompt */
  tier: 1 | 2 | 3;
  /** link an unlinked repository whose owner is already trusted */
  autoLink: boolean;
  /** kick an incremental transcript scan in the background */
  scan: boolean;
  /** minimum minutes between background scans */
  scanIntervalMinutes: number;
};

export const AUTOPILOT_FILE = path.join(CONFIG_DIR, "autopilot.json");
const STATE_FILE = path.join(CONFIG_DIR, "autopilot-state.json");

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  /* Tracking is opt-out: a first-time setup turns it on, and `autopilot off`
     remains the explicit, durable way to stop unattended collection. */
  enabled: true,
  tier: 1,
  autoLink: true,
  scan: true,
  /* Archive snapshots retain every token without a continuous database wakeup.
     Thirty-minute batching gives a small serverless database room to sleep.
     Manual `scan` remains available for an immediate refresh. */
  scanIntervalMinutes: 30,
};

const asTier = (value: unknown): 1 | 2 | 3 =>
  value === 2 ? 2 : value === 3 ? 3 : 1;

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/**
 * Read the config defensively.
 *
 * A missing file means the builder has never made a choice, so use the
 * opt-out default. A malformed existing file is different: retain the safe
 * fail-closed behaviour rather than treating corruption as permission.
 */
export function readAutopilot(): AutopilotConfig {
  const hasConfig = fs.existsSync(AUTOPILOT_FILE);
  const raw = readJson<Partial<AutopilotConfig>>(AUTOPILOT_FILE, {});
  const interval = Number(raw.scanIntervalMinutes);
  return {
    enabled: asBool(raw.enabled, hasConfig ? false : DEFAULT_AUTOPILOT.enabled),
    tier: asTier(raw.tier),
    autoLink: asBool(raw.autoLink, DEFAULT_AUTOPILOT.autoLink),
    scan: asBool(raw.scan, DEFAULT_AUTOPILOT.scan),
    scanIntervalMinutes:
      Number.isFinite(interval) && interval >= 0
        ? interval
        : DEFAULT_AUTOPILOT.scanIntervalMinutes,
  };
}

export function writeAutopilot(config: AutopilotConfig): void {
  writeJson(AUTOPILOT_FILE, config);
}

type AutopilotState = { lastScanAt?: string };

const readState = (): AutopilotState => readJson<AutopilotState>(STATE_FILE, {});

/**
 * Whether enough time has passed to kick another background scan.
 *
 * Opening four sessions at once must not start four scans. This is a throttle
 * rather than a lock on purpose: a lock has to survive a killed process, and
 * the failure it would prevent is benign — scans are idempotent, both against
 * the local watermarks and against the server's deterministic snapshot ids.
 */
export function scanDue(
  config: AutopilotConfig,
  now = Date.now(),
  state = readState()
): boolean {
  if (!config.scan) return false;
  const last = Date.parse(state.lastScanAt ?? "");
  if (!Number.isFinite(last)) return true;
  return now - last >= config.scanIntervalMinutes * 60_000;
}

export function markScanned(now = Date.now()): void {
  writeJson(STATE_FILE, { lastScanAt: new Date(now).toISOString() });
}

/* ------- stale (server-revoked) slots ------- */

const STALE_FILE = path.join(CONFIG_DIR, "stale-slots.json");

/** `root` (or `GLOBAL_SLOT_ROOT` for the machine-wide token) -> when and why
 *  the server refused it. */
type StaleSlots = Record<string, { staleSince: string; reason: string }>;

const readStaleSlots = (): StaleSlots => readJson<StaleSlots>(STALE_FILE, {});

export function isSlotStale(root: string): boolean {
  return root in readStaleSlots();
}

/**
 * Record that a project's (or the global slot's) token was refused by the
 * server with 401/403.
 *
 * Revocation — from the settings page, or by rotating credentials — is the
 * one signal a user has that unambiguously means "stop this" without the CLI
 * having initiated it. Auto-healing a *missing* settings file is the right
 * call (that is what `coverWorktrees` below does, and what the branch this
 * module came from was built for); auto-healing a *revoked* token would
 * silently override an explicit act of consent withdrawal. Once a slot is
 * marked, `runAutopilot` backs off from it entirely — no worktree coverage,
 * no re-link, no re-mint — until a person runs the CLI and either relinks
 * (reusing the stored salt, so the project id and its history reattach) or
 * unlinks. `clearSlotStale` is that resolution; nothing else may call it.
 *
 * First revocation wins: a second 401 on an already-stale slot must not
 * reset `staleSince`, or "how long has this been broken" becomes unreadable.
 */
export function markSlotStale(root: string, reason = "revoked"): void {
  const stale = readStaleSlots();
  if (stale[root]) return;
  stale[root] = { staleSince: new Date().toISOString(), reason };
  writeJson(STALE_FILE, stale);
}

/** The only way staleness is cleared — an explicit, interactive relink or
 *  unlink, never anything unattended. */
export function clearSlotStale(root: string): void {
  const stale = readStaleSlots();
  if (!(root in stale)) return;
  delete stale[root];
  writeJson(STALE_FILE, stale);
}

export function staleReason(root: string): string | null {
  return readStaleSlots()[root]?.reason ?? null;
}

/** Every stale slot, for `status`/`doctor` to list. */
export function listStaleSlots(): { root: string; staleSince: string; reason: string }[] {
  return Object.entries(readStaleSlots()).map(([root, v]) => ({ root, ...v }));
}

/* ------- the decision ------- */

export type AutopilotAction =
  | { kind: "idle" }
  /** a linked project had checkouts the config had never reached */
  | { kind: "covered"; label: string; worktrees: string[] }
  /** an unlinked repository under a trusted owner was connected */
  | { kind: "linked"; label: string; owner: string | null; worktrees: number }
  /** deliberately left alone, with the reason worth surfacing */
  | { kind: "skipped"; label: string; owner: string | null; reason: string }
  /** the server revoked this project's token; autopilot will not touch it
      again until a person relinks or unlinks (§4.3, D8) */
  | { kind: "stale"; label: string };

export type AutopilotDeps = {
  credentials: Credentials | null;
  config: AutopilotConfig;
  /** injected so tests can assert the grant without reaching the network */
  link?: typeof linkRepo;
};

/**
 * Decide and apply what this session's directory needs.
 *
 * Never throws for an ordinary miss — a directory that is not a repository, a
 * repository nobody trusts, a missing login. The caller runs inside a session
 * hook, where a non-zero exit is a visible error on a screen the builder is
 * trying to work on.
 */
export async function runAutopilot(
  cwd: string,
  deps: AutopilotDeps
): Promise<AutopilotAction> {
  const { credentials, config } = deps;
  const link = deps.link ?? linkRepo;
  if (!config.enabled || !credentials) return { kind: "idle" };

  const root = projectRoot(cwd);
  if (!root) return { kind: "idle" };

  /* A revoked token is consent withdrawn, not a gap to heal. This gate sits
     ahead of everything else so it protects both branches below alike: a
     slot that still exists locally (coverWorktrees would otherwise happily
     copy the now-dead token into a new worktree) and a slot that is gone
     (the auto-link branch would otherwise see a clean unlinked repository
     and mint a fresh grant nobody asked for). */
  if (isSlotStale(root)) {
    return { kind: "stale", label: path.basename(root) };
  }

  const slot = readSlot(root);
  if (slot) return coverWorktrees(slot);

  if (!config.autoLink) return { kind: "idle" };

  const label = path.basename(root);

  /* Same posture as an unreadable autopilot config: a person cannot rely on
     "declining an owner excludes them" (D3) if the file that remembers the
     decline cannot be read, so an untrustworthy `excluded.json` refuses to
     link rather than assume the coast is clear. */
  const excludedRead = readExcluded();
  if (!excludedRead.ok) {
    return {
      kind: "skipped",
      label,
      owner: null,
      reason: "exclusion list unreadable — run `vibecom doctor`",
    };
  }
  if (isRootExcluded(excludedRead.excluded, root)) {
    return { kind: "skipped", label, owner: null, reason: "excluded" };
  }

  const owner = remoteOwner(gitRemote(root));
  /* A repository with no readable remote owner is never linked unattended.
     Ownership is the only evidence available here that the work is the
     builder's to report, and `vibecom link` remains one command away. */
  if (!owner) {
    return { kind: "skipped", label, owner: null, reason: "no remote owner" };
  }
  if (isOwnerExcluded(excludedRead.excluded, owner)) {
    return { kind: "skipped", label, owner, reason: `${owner} is excluded` };
  }
  const mine = owner.toLowerCase() === credentials.username.toLowerCase();
  if (!mine && !isTrusted(owner)) {
    return { kind: "skipped", label, owner, reason: `${owner} is not trusted` };
  }

  const result = await link(
    credentials.origin,
    credentials.token,
    { root, label },
    config.tier
  );
  return {
    kind: "linked",
    label,
    owner,
    worktrees: result.worktrees.length,
  };
}

/**
 * Write the existing token into checkouts that never received it.
 *
 * Reuses the project's own token rather than minting one: this is not a new
 * grant, it is the same consent reaching a checkout that git skipped.
 */
function coverWorktrees(slot: ProjectSlot): AutopilotAction {
  const token = readProjectToken(slot.root);
  // Main checkout gone, or unlinked by hand — nothing to copy from.
  if (!token) return { kind: "idle" };
  const missing = uncoveredWorktrees(slot.root);
  if (missing.length === 0) return { kind: "idle" };
  const covered: string[] = [];
  for (const tree of missing) {
    try {
      writeProjectSettings(tree, slot.origin, token);
      covered.push(tree);
    } catch {
      // A checkout that refuses the ignore preflight is skipped, not fatal.
    }
  }
  if (covered.length === 0) return { kind: "idle" };
  ensureExcluded(slot.root);
  return { kind: "covered", label: slot.label, worktrees: covered };
}

/** One line worth showing a builder mid-session, or nothing at all. */
export function describeAction(action: AutopilotAction): string | null {
  switch (action.kind) {
    case "covered":
      return `vibecom: now reporting from ${action.worktrees.length} new checkout${
        action.worktrees.length === 1 ? "" : "s"
      } of ${action.label}`;
    case "linked":
      return `vibecom: connected ${action.label} (${action.owner}) — ${action.worktrees} checkout${
        action.worktrees === 1 ? "" : "s"
      }. Run \`vibecom unlink\` to stop.`;
    case "stale":
      return `vibecom: token for ${action.label} was revoked — run \`vibecom\` to relink or unlink`;
    default:
      return null;
  }
}

/* ------- the SessionStart hook ------- */

export const claudeSettingsPath = (home = os.homedir()): string =>
  path.join(home, ".claude", "settings.json");

type HookEntry = { type?: string; command?: string; args?: string[] };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };

const isOurs = (entry: HookEntry): boolean =>
  entry?.type === "command" &&
  Array.isArray(entry.args) &&
  entry.args[0] === "hook" &&
  path.basename(entry.command ?? "").replace(/\.[^.]+$/, "") === "vibecom";

/**
 * Add the SessionStart hook to the user's Claude Code settings.
 *
 * Exec form with `args`, not a shell string: the resolved binary path is
 * written verbatim, so a home directory containing a space cannot turn into
 * two arguments. Idempotent — a second install replaces our own entry and
 * leaves every other hook, and every unrelated setting, untouched.
 */
export function installSessionHook(
  binary: string,
  file = claudeSettingsPath()
): { file: string; backup: string | null } {
  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8")
    : null;
  /* Refuse rather than overwrite. This file holds the builder's entire Claude
     Code configuration; silently replacing an unparseable copy with a fresh
     one would discard all of it. */
  let data: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    try {
      data = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new Error(
        `${file} is not valid JSON — fix or move it, then run this again`
      );
    }
  }

  let backup: string | null = null;
  if (existing !== null) {
    backup = `${file}.vibecom-backup`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, existing);
  }

  const hooks = (
    typeof data.hooks === "object" && data.hooks !== null ? data.hooks : {}
  ) as Record<string, HookGroup[]>;
  const groups = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];

  const kept = groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).filter((entry) => !isOurs(entry)),
    }))
    .filter((group) => (group.hooks ?? []).length > 0);

  kept.push({
    hooks: [
      {
        type: "command",
        command: binary,
        args: ["hook"],
        timeout: 20,
      } as HookEntry,
    ],
  });

  hooks.SessionStart = kept;
  data.hooks = hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return { file, backup };
}

/** Remove only our entry, leaving any other SessionStart hooks in place. */
export function removeSessionHook(file = claudeSettingsPath()): boolean {
  if (!fs.existsSync(file)) return false;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const hooks = data.hooks as Record<string, HookGroup[]> | undefined;
  const groups = hooks?.SessionStart;
  if (!hooks || !Array.isArray(groups)) return false;

  let removed = false;
  const kept = groups
    .map((group) => {
      const entries = group.hooks ?? [];
      const filtered = entries.filter((entry) => !isOurs(entry));
      if (filtered.length !== entries.length) removed = true;
      return { ...group, hooks: filtered };
    })
    .filter((group) => (group.hooks ?? []).length > 0);
  if (!removed) return false;

  if (kept.length > 0) hooks.SessionStart = kept;
  else delete hooks.SessionStart;
  if (Object.keys(hooks).length === 0) delete data.hooks;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return true;
}

export function sessionHookInstalled(file = claudeSettingsPath()): boolean {
  const data = readJson<{ hooks?: Record<string, HookGroup[]> }>(file, {});
  const groups = data.hooks?.SessionStart;
  return Array.isArray(groups)
    ? groups.some((group) => (group.hooks ?? []).some(isOurs))
    : false;
}

/** Every checkout of every linked project that is still missing the config. */
export function uncoveredEverywhere(
  slots: ProjectSlot[]
): { label: string; missing: string[] }[] {
  return slots
    .map((slot) => ({ label: slot.label, missing: uncoveredWorktrees(slot.root) }))
    .filter((entry) => entry.missing.length > 0);
}

export const worktreeCount = (root: string): number => listWorktrees(root).length;

/* ------- provider-neutral background collection ------- */

const SCAN_AGENT_LABEL = "build.vibecom.collect";

/**
 * Claude's SessionStart hook is useful for auto-linking a new checkout, but it
 * cannot observe a Codex app-server process or a Kimi session that starts
 * elsewhere. macOS LaunchAgents give all three providers the same collector:
 * each run reads their own local counter archives and uploads only the derived
 * totals already documented in COLLECTION.md.
 */
export const scanAgentPath = (home = os.homedir()): string =>
  path.join(home, "Library", "LaunchAgents", `${SCAN_AGENT_LABEL}.plist`);

const launchDomain = (): string => `gui/${process.getuid?.() ?? 0}`;

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function scanAgentPlist(
  binary: string,
  intervalMinutes: number,
  nodeBinary = process.execPath
): string {
  if (!path.isAbsolute(binary) || !path.isAbsolute(nodeBinary)) {
    throw new Error("collector and Node binaries must be absolute paths");
  }
  const intervalSeconds = Math.max(60, Math.round(intervalMinutes * 60));
  const log = path.join(CONFIG_DIR, "collector.log");
  // launchd never sources the shell's NVM/Homebrew setup. Execute the Node
  // that installed us directly, and give child git processes a bounded PATH.
  const collectorPath = [...new Set([
    path.dirname(nodeBinary), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
  ])].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SCAN_AGENT_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodeBinary)}</string>
    <string>${xml(binary)}</string><string>scan</string><string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(collectorPath)}</string>
  </dict>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

/** Install (or replace) the private per-user launch agent on macOS. */
export function installScanAgent(
  binary: string,
  intervalMinutes: number,
  home = os.homedir(),
  platform = process.platform
): { path: string; installed: boolean } {
  const file = scanAgentPath(home);
  if (platform !== "darwin") return { path: file, installed: false };
  if (!path.isAbsolute(binary)) {
    throw new Error("collector binary must be an absolute path");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, scanAgentPlist(binary, intervalMinutes), {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);

  /* `bootstrap` replaces the old launchd definition immediately. A new login
     also loads the plist normally, so a transient launchctl failure is not a
     reason to discard a correctly written schedule. */
  try {
    execFileSync("/bin/launchctl", ["bootout", launchDomain(), file], {
      stdio: "ignore",
    });
  } catch {
    // Not loaded yet is the usual first-install case.
  }
  try {
    execFileSync("/bin/launchctl", ["bootstrap", launchDomain(), file], {
      stdio: "ignore",
    });
  } catch {
    // launchd will load it next login; the schedule still persists safely.
  }
  return { path: file, installed: true };
}

export function removeScanAgent(
  home = os.homedir(),
  platform = process.platform
): boolean {
  const file = scanAgentPath(home);
  if (platform !== "darwin") return false;
  try {
    execFileSync("/bin/launchctl", ["bootout", launchDomain(), file], {
      stdio: "ignore",
    });
  } catch {
    // It can be absent from launchd even while the on-disk definition exists.
  }
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** A legacy env-node plist exists on disk but cannot run under launchd. */
export function scanAgentInstalled(home = os.homedir(), nodeBinary = process.execPath): boolean {
  try {
    const file = scanAgentPath(home);
    if (!fs.lstatSync(file).isFile()) return false;
    const plist = fs.readFileSync(file, "utf8");
    return plist.includes(`<string>${xml(nodeBinary)}</string>`) &&
      plist.includes("<key>PATH</key>") &&
      plist.includes("<string>scan</string>") &&
      plist.includes("<string>--quiet</string>");
  } catch {
    return false;
  }
}

/** A correct plist on disk does not mean launchd has loaded its schedule. */
export function scanAgentLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("/bin/launchctl", ["print", `${launchDomain()}/${SCAN_AGENT_LABEL}`], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
