import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONFIG_DIR,
  type Credentials,
  type ProjectSlot,
  ensureExcluded,
  gitRemote,
  isTrusted,
  linkRepo,
  listWorktrees,
  projectRoot,
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
  enabled: false,
  tier: 1,
  autoLink: true,
  scan: true,
  scanIntervalMinutes: 15,
};

const asTier = (value: unknown): 1 | 2 | 3 =>
  value === 2 ? 2 : value === 3 ? 3 : 1;

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/**
 * Read the config defensively.
 *
 * This file decides whether an unattended process may mint credentials, so a
 * hand-edited or truncated copy must degrade to the most conservative reading
 * rather than to whatever `undefined` happens to coerce to.
 */
export function readAutopilot(): AutopilotConfig {
  const raw = readJson<Partial<AutopilotConfig>>(AUTOPILOT_FILE, {});
  const interval = Number(raw.scanIntervalMinutes);
  return {
    enabled: asBool(raw.enabled, DEFAULT_AUTOPILOT.enabled),
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

/* ------- the decision ------- */

export type AutopilotAction =
  | { kind: "idle" }
  /** a linked project had checkouts the config had never reached */
  | { kind: "covered"; label: string; worktrees: string[] }
  /** an unlinked repository under a trusted owner was connected */
  | { kind: "linked"; label: string; owner: string | null; worktrees: number }
  /** deliberately left alone, with the reason worth surfacing */
  | { kind: "skipped"; label: string; owner: string | null; reason: string };

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

  const slot = readSlot(root);
  if (slot) return coverWorktrees(slot);

  if (!config.autoLink) return { kind: "idle" };

  const owner = remoteOwner(gitRemote(root));
  const label = path.basename(root);
  /* A repository with no readable remote owner is never linked unattended.
     Ownership is the only evidence available here that the work is the
     builder's to report, and `vibecom link` remains one command away. */
  if (!owner) {
    return { kind: "skipped", label, owner: null, reason: "no remote owner" };
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
