import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------- paths ------- */

const CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
export const CONFIG_DIR = path.join(CONFIG_HOME, "vibecom");
const LEGACY_CONFIG_DIR = path.join(CONFIG_HOME, "vibeland");
const LEGACY_MIGRATION_MARKER = path.join(
  CONFIG_DIR,
  ".migrated-from-vibeland"
);

/* Keep every existing link and credential across the rename. The old folder is
   left in place as a recoverable backup; all future writes use vibecom. */
let legacyChecked = false;
function migrateLegacyConfig() {
  if (legacyChecked) return;
  legacyChecked = true;
  if (fs.existsSync(LEGACY_MIGRATION_MARKER)) return;
  if (!fs.existsSync(LEGACY_CONFIG_DIR)) return;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(LEGACY_CONFIG_DIR)) {
    const target = path.join(CONFIG_DIR, entry);
    if (fs.existsSync(target)) continue;
    fs.cpSync(path.join(LEGACY_CONFIG_DIR, entry), target, { recursive: true });
  }
  fs.writeFileSync(LEGACY_MIGRATION_MARKER, new Date().toISOString() + "\n", {
    mode: 0o600,
  });
}
const CRED_FILE = path.join(CONFIG_DIR, "credentials.json");
const PROJECTS_DIR = path.join(CONFIG_DIR, "projects");
const TRUST_FILE = path.join(CONFIG_DIR, "trusted_owners.json");
const ORIGIN_FILE = path.join(CONFIG_DIR, "origin");

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown) {
  ensureDir(path.dirname(file));
  writePrivateFile(file, JSON.stringify(value, null, 2) + "\n");
}

/** Replace a file atomically without following the destination entry. */
function writeAtomicFile(file: string, body: string, mode: number) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode, flag: "wx" });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, mode);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Preserve the original error; failure to clean a private temp file is
      // not more actionable here.
    }
    throw error;
  }
}

/** Write sensitive configuration without ever leaving a partial/public file. */
function writePrivateFile(file: string, body: string) {
  writeAtomicFile(file, body, 0o600);
}

/**
 * Loopback never reaches a network, so there is no transport to eavesdrop on.
 * Requiring TLS here would only mean a self-signed certificate and a disabled
 * verifier, which is strictly worse: it teaches the habit of turning checks off
 * to get work done. Everything routable still has to be HTTPS.
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Only use origins on a transport that cannot disclose bearer credentials. */
export function secureOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ApiError("origin must be an absolute HTTPS URL");
  }
  const transportIsSafe =
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopback(url.hostname));
  if (
    !transportIsSafe ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      "origin must be an HTTPS origin without userinfo or a path " +
        "(http is allowed only for localhost)"
    );
  }
  return url.origin;
}

/* ------- credentials ------- */

export type Credentials = { token: string; username: string; origin: string };

export const readCredentials = (): Credentials | null => {
  migrateLegacyConfig();
  return readJson<Credentials | null>(CRED_FILE, null);
};

export const writeCredentials = (c: Credentials) =>
  writeJson(CRED_FILE, { ...c, origin: secureOrigin(c.origin) });
export const clearCredentials = () => fs.rmSync(CRED_FILE, { force: true });

/**
 * A token is only valid on the host that issued it, so every command after
 * login talks to the host you logged into — never wherever the CLI was
 * downloaded from. Explicit env var always wins.
 */
/**
 * The host that serves directly.
 *
 * A redirecting origin strips the Authorization header off every request, so
 * this must never be the apex — vibecom.build 308s to www.
 */
export const CANONICAL_ORIGIN = "https://www.vibecom.build";

export function resolveOrigin(): string {
  if (process.env.VIBECOM_ORIGIN) return secureOrigin(process.env.VIBECOM_ORIGIN);
  if (process.env.VIBELAND_ORIGIN) return secureOrigin(process.env.VIBELAND_ORIGIN);
  const cred = readCredentials();
  if (cred?.origin) return secureOrigin(cred.origin);
  let savedOrigin: string;
  try {
    savedOrigin = fs.readFileSync(ORIGIN_FILE, "utf8").trim();
  } catch {
    return CANONICAL_ORIGIN;
  }
  return secureOrigin(savedOrigin);
}

/* ------- trusted repo owners ------- */

export const readTrusted = (): string[] => {
  migrateLegacyConfig();
  return readJson<string[]>(TRUST_FILE, []);
};

export function isTrusted(owner: string): boolean {
  const needle = owner.toLowerCase();
  return readTrusted().some((o) => o.toLowerCase() === needle);
}

export function trustOwner(owner: string) {
  if (isTrusted(owner)) return;
  writeJson(TRUST_FILE, [...readTrusted(), owner]);
}

export function untrustOwner(owner: string) {
  const needle = owner.toLowerCase();
  writeJson(
    TRUST_FILE,
    readTrusted().filter((o) => o.toLowerCase() !== needle)
  );
}

/* ------- linked projects ------- */

export type ProjectSlot = {
  root: string;
  salt: string;
  projectId: string;
  tier: 1 | 2 | 3;
  label: string;
  origin: string;
  linkedAt: string;
};

const slotPath = (root: string) =>
  path.join(PROJECTS_DIR, sha256(root) + ".json");

export const readSlot = (root: string): ProjectSlot | null => {
  migrateLegacyConfig();
  return readJson<ProjectSlot | null>(slotPath(root), null);
};

export const writeSlot = (slot: ProjectSlot) =>
  writeJson(slotPath(slot.root), slot);

export const deleteSlot = (root: string) =>
  fs.rmSync(slotPath(root), { force: true });

export function listSlots(): ProjectSlot[] {
  migrateLegacyConfig();
  try {
    return fs
      .readdirSync(PROJECTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<ProjectSlot | null>(path.join(PROJECTS_DIR, f), null))
      .filter((s): s is ProjectSlot => s !== null);
  } catch {
    return [];
  }
}

export const sha256 = (input: string) =>
  createHash("sha256").update(input).digest("hex");

export const newSalt = () => randomBytes(16).toString("hex");

/**
 * The salt never leaves the machine. A global salt would be reversible for
 * common paths via a rainbow table, and stable hashes would let the server
 * correlate two builders working on the same project.
 */
export const projectIdFor = (salt: string, root: string) =>
  sha256(`${salt}:${root}`).slice(0, 32);

/* ------- transcript scan watermarks ------- */

const MARKS_FILE = path.join(CONFIG_DIR, "scan-marks.json");

/**
 * file path -> what we have already consumed from it.
 *
 * `root` and `sessionId` are remembered because a transcript states its cwd and
 * session id only in its opening records. Once those are consumed, an
 * incremental re-read has no idea which project the file belongs to — without
 * this it would look unattributable and every subsequent line from a live
 * session would be silently dropped.
 */
export type ScanMark = {
  /** cumulative totals already sent for this session */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  unpricedTokens?: number;
  /** the most complete transcript seen for this session */
  file: string;
  lines: number;
  mtimeMs: number;
  root?: string;
  /** Same reasoning as `root`: Codex names the model on turn_context, near the
      top of the file. An incremental re-read starts past it, so a continuing
      session would lose its model on every scan after the first. */
  model?: string | null;
  /** Forces one snapshot backfill when duration-aware scanning first ships. */
  activityVersion?: 1;
  /** Parser/rate schema version; a bump forces one corrective full restatement. */
  scanVersion?: 2;
};

/** `tool:sessionId` -> what has already been sent for it. */
export type ScanMarks = Record<string, ScanMark>;

export const readScanMarks = (): ScanMarks => readJson<ScanMarks>(MARKS_FILE, {});
export const writeScanMarks = (m: ScanMarks) => writeJson(MARKS_FILE, m);

/** Send derived session counters through the normal authenticated ingest path. */
export async function sendScanned(
  origin: string,
  token: string,
  sessions: {
    tool: string;
    sessionId: string;
    model: string | null;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    /** Tokens whose model has no published rate, so coverage stays visible. */
    unpricedTokens: number;
    /** Token/cost totals split by the model that actually served requests. */
    modelUsage?: {
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWrite5mTokens: number;
      cacheWrite1hTokens: number;
      costUsd: number;
      unpricedTokens: number;
    }[];
    /** First and last event times read from inside the transcript. */
    startedAtMs?: number;
    endedAtMs?: number;
    /** Conservative active seconds already split into UTC clock hours. */
    activity: { bucketAtMs: number; seconds: number }[];
  }[]
): Promise<{ accepted: number; dropped: number }> {
  const attr = (key: string, value: string | number) => ({
    key,
    value:
      typeof value === "number"
        ? { doubleValue: value }
        : { stringValue: value },
  });

  const sessionRecords = sessions.flatMap((s) => {
    const slices =
      s.modelUsage && s.modelUsage.length > 0
        ? s.modelUsage.map((slice) => ({
            ...slice,
            cacheCreationTokens:
              slice.cacheWrite5mTokens + slice.cacheWrite1hTokens,
          }))
        : [
            {
              model: s.model,
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              cacheReadTokens: s.cacheReadTokens,
              cacheCreationTokens: s.cacheCreationTokens,
              costUsd: s.costUsd,
              unpricedTokens: s.unpricedTokens,
            },
          ];

    return slices.map((slice, index) => ({
      attributes: [
        attr("event.name", "vibecom.session"),
        attr("tool", s.tool),
        attr("session.id", s.sessionId),
        ...(slice.model ? [attr("model", slice.model)] : []),
        /* Session facts belong on one slice only. Token and cost rows belong
           on every slice, which gives the server a truthful model breakdown
           without multiplying turns or elapsed time. */
        ...(index === 0 ? [attr("turns", s.turns)] : []),
        attr("input_tokens", slice.inputTokens),
        attr("output_tokens", slice.outputTokens),
        attr("cache_read_tokens", slice.cacheReadTokens),
        attr("cache_creation_tokens", slice.cacheCreationTokens),
        attr("cost_usd", slice.costUsd),
        attr("unpriced_tokens", slice.unpricedTokens),
        ...(index === 0 && s.startedAtMs && Number.isFinite(s.startedAtMs)
          ? [attr("started_at", new Date(s.startedAtMs).toISOString())]
          : []),
        /* These are event times inside the transcript, not the upload time. */
        ...(s.endedAtMs && Number.isFinite(s.endedAtMs)
          ? [attr("ended_at", new Date(s.endedAtMs).toISOString())]
          : []),
        attr("replace", "true"),
      ],
    }));
  });

  /* A summary row still lands at the session end. These small hourly records
     are what stop a three-hour chat becoming one spike at scan time. They are
     derived locally and contain only a timestamp plus a counter. */
  const activityRecords = sessions.flatMap((s) =>
    (s.activity.length > 0
      ? s.activity
      : [
          {
            bucketAtMs: s.endedAtMs ?? Date.now(),
            seconds: 0,
          },
        ]
    ).map((bucket) => ({
      attributes: [
        attr("event.name", "vibecom.session.activity"),
        attr("tool", s.tool),
        attr("session.id", s.sessionId),
        attr("bucket_at", new Date(bucket.bucketAtMs).toISOString()),
        attr("active_seconds", bucket.seconds),
        attr("replace", "true"),
      ],
    }))
  );
  const logRecords = [...sessionRecords, ...activityRecords];

  return request<{ accepted: number; dropped: number }>(
    origin,
    "/api/v1/logs",
    json({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] }, token)
  );
}

/**
 * Send the counters read out of a linked repository's git history.
 *
 * A separate record from `vibecom.session`, deliberately. A scanned session is
 * a snapshot keyed on its session id, and the server replaces the metric types
 * that snapshot carries — so attaching repository counters to it would let a
 * rescan delete numbers the transcript cannot regenerate. That already happened
 * once; there is a regression test on the server pinning it shut.
 *
 * These totals are cumulative for the window, not deltas, so every scan
 * restates them and the server replaces the previous copy. Recounting from
 * scratch is what makes a rescan a repair rather than a doubling.
 */
export async function sendRepoStats(
  origin: string,
  token: string,
  repos: {
    commits: number;
    linesAdded: number;
    linesRemoved: number;
    prs: number;
    excludedLines: number;
  }[]
): Promise<{ accepted: number; dropped: number }> {
  const attr = (key: string, value: string | number) => ({
    key,
    value:
      typeof value === "number"
        ? { doubleValue: value }
        : { stringValue: value },
  });

  const logRecords = repos.map((repo) => ({
    attributes: [
      attr("event.name", "vibecom.repo"),
      attr("commits", repo.commits),
      attr("lines_added", repo.linesAdded),
      attr("lines_removed", repo.linesRemoved),
      attr("prs", repo.prs),
      attr("excluded_lines", repo.excludedLines),
      attr("replace", "true"),
    ],
  }));

  return request<{ accepted: number; dropped: number }>(
    origin,
    "/api/v1/logs",
    json({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] }, token)
  );
}

/* ------- clipboard ------- */

/** Platform copy commands, tried in order. First one present wins. */
const CLIPBOARD: [string, string[]][] =
  process.platform === "darwin"
    ? [["pbcopy", []]]
    : process.platform === "win32"
      ? [["clip", []]]
      : [
          ["wl-copy", []],
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
          // WSL, where the Windows binary is on PATH
          ["clip.exe", []],
        ];

/** Best-effort — a headless box with no clipboard tool is not an error. */
export function copyToClipboard(text: string): boolean {
  for (const [cmd, args] of CLIPBOARD) {
    try {
      execFileSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
      return true;
    } catch {
      /* not installed, or no display — try the next one */
    }
  }
  return false;
}

/** Best-effort browser launch. The URL is still printed when unavailable. */
export function openBrowser(url: string): boolean {
  const command: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    execFileSync(command[0], command[1], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* ------- git ------- */

/**
 * Resolve symlinks so a path is one canonical string.
 *
 * git reports real paths (`/private/var/…`) while `path.resolve` leaves
 * symlinks alone (`/var/…`). Without this the same repo hashes to two
 * different slot keys — and two different project ids — depending on which
 * way you reached it, which silently splits a project's metrics in half.
 * macOS symlinks /tmp, and symlinked project directories are common.
 */
function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Run git and return stdout, or null if anything at all went wrong.
 *
 * The caps are load-bearing rather than defensive. Every original caller asked
 * git for a path or a short list, so the defaults were never tested against a
 * large answer — but `git log --numstat` over a real history runs to megabytes,
 * and Node's default `maxBuffer` is 1 MiB. Exceeding it throws, the bare catch
 * turns that into null, and the caller reads null as "no commits". The failure
 * would be silent, and worst on exactly the busy repositories most worth
 * measuring. The timeout covers the other end of the same problem: a repo whose
 * history is slow to walk should degrade to a missing number, not a hung scan.
 */
function git(
  args: string[],
  cwd: string,
  limits: { maxBuffer?: number; timeout?: number } = {}
): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: limits.maxBuffer ?? 1024 * 1024,
      timeout: limits.timeout ?? 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/** Root of the checkout you are standing in — a worktree has its own. */
export function gitRoot(cwd = process.cwd()): string | null {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  return root ? realpath(root) : null;
}

/** Absolute path of the shared git dir. Identical from every worktree. */
export function commonGitDir(cwd = process.cwd()): string | null {
  const abs = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd
  );
  // --path-format landed in git 2.31; fall back to resolving by hand
  const raw = abs ?? git(["rev-parse", "--git-common-dir"], cwd);
  return raw ? realpath(path.resolve(cwd, raw)) : null;
}

/**
 * The main worktree's root — the canonical identity of a project.
 *
 * Tools like Conductor and super.engineer run agents inside `git worktree`
 * checkouts in unrelated directories. Keying identity off the shared git dir
 * makes every checkout of a repo the same project, instead of each worktree
 * looking like a brand-new unlinked one.
 */
export function projectRoot(cwd = process.cwd()): string | null {
  const common = commonGitDir(cwd);
  if (!common) return null;
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

/** Every checkout of this repo, main worktree first. */
export function listWorktrees(cwd = process.cwd()): string[] {
  const out = git(["worktree", "list", "--porcelain"], cwd);
  if (!out) {
    const root = gitRoot(cwd);
    return root ? [root] : [];
  }
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter(Boolean)
    .map(realpath)
    /* Git keeps listing a checkout whose .git has been removed — it reports it
       as `prunable` and still hands it to us. Agent tools leave these behind
       constantly. Every git command inside one fails, so the ignore rule can
       never be verified there, and prepareProjectSettings refuses to write a
       token it cannot prove is protected. That refusal is correct, but it was
       aborting the whole repository: five live projects could not be linked or
       re-pointed because of one directory that no longer had a .git in it. A
       checkout without one is not a checkout. */
    .filter((tree) => fs.existsSync(path.join(tree, ".git")));
}

export const gitRemote = (root: string) =>
  git(["remote", "get-url", "origin"], root);

/** Owner segment of a GitHub/GitLab/Bitbucket remote, if one can be read. */
export function remoteOwner(remote: string | null): string | null {
  if (!remote) return null;
  const m = remote.match(
    /(?:github|gitlab|bitbucket)\.(?:com|org)[:/]+([^/]+)\/.+$/i
  );
  return m ? m[1] : null;
}

export type Discovered = {
  /** canonical main-worktree root; slots are keyed by this */
  root: string;
  label: string;
  owner: string | null;
  remote: string | null;
  linked: ProjectSlot | null;
  /** every checkout of this repo, including worktrees elsewhere on disk */
  worktrees: string[];
};

function describe(root: string): Discovered {
  const remote = gitRemote(root);
  return {
    root,
    label: path.basename(root),
    remote,
    owner: remoteOwner(remote),
    linked: readSlot(root),
    worktrees: listWorktrees(root),
  };
}

/**
 * Find git repositories near `dir`, one level deep. Deliberately shallow —
 * walking a whole home directory is slow and surfaces vendored checkouts
 * nobody means to link.
 */
export function discoverRepos(dir: string): Discovered[] {
  const found: string[] = [];
  // canonical root, so standing inside a worktree finds the real project
  const here = projectRoot(dir);
  if (here) found.push(here);

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const child = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(child, ".git"))) continue;
    // a scanned directory may itself be a worktree; fold it into its project
    const canonical = projectRoot(child);
    if (canonical) found.push(canonical);
  }

  return [...new Set(found)].map(describe);
}

/**
 * Choose a safe first-run default without asking a beginner to understand
 * repository ownership. Prefer the repo they intentionally ran from; from a
 * parent directory, include only remotes owned by their signed-in account.
 */
export function recommendedRepos(
  repos: Discovered[],
  username: string,
  currentRoot: string | null
): Discovered[] {
  const available = repos.filter((repo) => !repo.linked);
  const current = currentRoot
    ? available.find((repo) => repo.root === currentRoot)
    : undefined;
  if (
    current &&
    (!current.owner ||
      current.owner.toLowerCase() === username.toLowerCase() ||
      isTrusted(current.owner))
  ) {
    return [current];
  }
  return available.filter(
    (repo) => repo.owner?.toLowerCase() === username.toLowerCase()
  );
}

/* ------- claude code project settings ------- */

const OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_LOG_USER_PROMPTS",
];

export const settingsPathFor = (root: string) =>
  path.join(root, ".claude", "settings.local.json");

/**
 * settings.local.json, never settings.json: this file carries an ingest token
 * and must not be committed.
 */
export function writeProjectSettings(
  root: string,
  origin: string,
  token: string
): string {
  origin = secureOrigin(origin);
  const file = prepareProjectSettings(root);
  const data = readJson<Record<string, unknown>>(file, {});
  const env = (
    typeof data.env === "object" && data.env !== null ? data.env : {}
  ) as Record<string, string>;

  Object.assign(env, {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `${origin}/api`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
    // Explicit: prompt bodies are never exported, at any tier.
    OTEL_LOG_USER_PROMPTS: "0",
  });
  data.env = env;
  writePrivateFile(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

/* ------- global (whole-machine) tracking ------- */

/** Claude Code's user-level settings: applies to every project, everywhere. */
export const GLOBAL_SETTINGS_FILE = path.join(
  os.homedir(),
  ".claude",
  "settings.json"
);

/** The marker slot that records the machine is tracked as a whole. */
export const GLOBAL_SLOT_ROOT = "*";

/**
 * Turn on tracking for every project on this machine at once.
 *
 * Per-repository linking asks a person to remember an administrative step at
 * the exact moment they are trying to start work, in a directory they have
 * usually just created. The step is invisible when skipped: nothing appears,
 * nothing warns, and the sessions are simply gone. Writing the exporter into
 * Claude Code's user-level settings covers whatever you open next, including
 * worktrees, without another decision.
 *
 * The trade is real and belongs to whoever runs this: one token now sees every
 * repository on the machine, employer and client code included. `vibecom
 * exclude` carves individual projects back out, and the tier still governs
 * what any of it may report.
 */
export function writeGlobalSettings(origin: string, token: string): string {
  origin = secureOrigin(origin);
  fs.mkdirSync(path.dirname(GLOBAL_SETTINGS_FILE), {
    recursive: true,
    mode: 0o700,
  });

  /* Refuse a symlink rather than following or replacing it. The atomic rename
     would swap the link for a regular file — the token never reaches the link
     target, so nothing leaks into a dotfiles repository, but the person's
     symlink is silently gone and their real settings stop applying. People who
     symlink this file did it deliberately. */
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(GLOBAL_SETTINGS_FILE);
  } catch {
    existing = null;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(
      `${GLOBAL_SETTINGS_FILE} is a symlink; vibecom will not replace it. ` +
        `Point it at a real file, or link a single project instead.`
    );
  }
  if (existing && !existing.isFile()) {
    throw new Error(`${GLOBAL_SETTINGS_FILE} is not a regular file`);
  }

  /* A settings file that exists but does not parse must not be treated as an
     empty object: merging into {} and writing means silently replacing
     whatever was there. One stray comma in a person's Claude Code config
     would cost them every permission and hook they had set. Stop, and say
     which file to fix. */
  if (existing) {
    const raw = fs.readFileSync(GLOBAL_SETTINGS_FILE, "utf8");
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not a JSON object");
        }
      } catch {
        throw new Error(
          `${GLOBAL_SETTINGS_FILE} is not valid JSON. Fix or move it first — ` +
            `vibecom will not overwrite settings it cannot read.`
        );
      }
    }
  }

  const data = readJson<Record<string, unknown>>(GLOBAL_SETTINGS_FILE, {});
  const env = (
    typeof data.env === "object" && data.env !== null ? data.env : {}
  ) as Record<string, string>;
  Object.assign(env, {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `${origin}/api`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
    // Explicit: prompt bodies are never exported, at any tier.
    OTEL_LOG_USER_PROMPTS: "0",
  });
  data.env = env;
  /* This file is not inside any repository, so the gitignore preflight that
     guards per-project writes does not apply — but it still carries a bearer
     token, so it still gets 0600. */
  writePrivateFile(GLOBAL_SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
  return GLOBAL_SETTINGS_FILE;
}

/**
 * The ingest token behind whole-machine tracking.
 *
 * Per-project scans read the token out of the repository's settings file.
 * The global slot has no repository, so without this the scan finds no token,
 * sends nothing, and reports success — historical import silently does
 * nothing while live telemetry keeps working, which is the hardest kind of
 * bug to notice.
 */
export function readGlobalToken(): string | null {
  const data = readJson<{ env?: Record<string, string> }>(
    GLOBAL_SETTINGS_FILE,
    {}
  );
  const header = data.env?.OTEL_EXPORTER_OTLP_HEADERS ?? "";
  const match = /Authorization=Bearer\s+(\S+)/.exec(header);
  return match?.[1] ?? null;
}

/** Whether whole-machine tracking is currently configured. */
export function globalTrackingOn(): boolean {
  const data = readJson<{ env?: Record<string, string> }>(
    GLOBAL_SETTINGS_FILE,
    {}
  );
  return Boolean(data.env?.OTEL_EXPORTER_OTLP_HEADERS);
}

/** Remove whole-machine tracking, leaving any unrelated settings intact. */
export function removeGlobalSettings(): boolean {
  const data = readJson<Record<string, unknown>>(GLOBAL_SETTINGS_FILE, {});
  const env = (
    typeof data.env === "object" && data.env !== null ? data.env : null
  ) as Record<string, string> | null;
  if (!env) return false;
  let removed = false;
  for (const key of OTEL_KEYS) {
    if (key in env) {
      delete env[key];
      removed = true;
    }
  }
  if (!removed) return false;
  if (Object.keys(env).length === 0) delete data.env;
  else data.env = env;
  writePrivateFile(GLOBAL_SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
  return true;
}

/** Establish and verify ignore/tracking invariants before a token is minted. */
export function prepareProjectSettings(root: string): string {
  const canonicalRoot = realpath(root);
  const file = safeSettingsPath(canonicalRoot, true);
  if (isGitTracked(canonicalRoot, IGNORE_PATTERN)) {
    throw new Error("refusing to write an ingest token to a Git-tracked settings file");
  }
  // A hostile entry must fail preflight even when info/exclude already covers
  // the path; otherwise a later gitignore update could fail after the write.
  inspectGitignore(canonicalRoot);
  ensureExcluded(canonicalRoot);
  if (!isGitIgnored(canonicalRoot, IGNORE_PATTERN)) {
    ensureGitignored(canonicalRoot);
  }
  if (!isGitIgnored(canonicalRoot, IGNORE_PATTERN)) {
    throw new Error("refusing to write an ingest token without a verified Git ignore rule");
  }
  return file;
}

/** The ingest token already written into a checkout, if any. */
export function readProjectToken(root: string): string | null {
  let file: string;
  try {
    file = safeSettingsPath(root, false);
  } catch {
    return null;
  }
  const data = readJson<Record<string, unknown>>(file, {});
  const env = data.env as Record<string, string> | undefined;
  const header = env?.OTEL_EXPORTER_OTLP_HEADERS;
  const match = header?.match(/Bearer\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Checkouts of a linked project that are missing the telemetry config —
 * typically worktrees created after the project was linked.
 */
export function uncoveredWorktrees(root: string): string[] {
  return listWorktrees(root).filter((tree) => !readProjectToken(tree));
}

export function removeProjectSettings(root: string) {
  const file = safeSettingsPath(root, false);
  if (!fs.existsSync(file)) return;
  const data = readJson<Record<string, unknown>>(file, {});
  const env = data.env as Record<string, string> | undefined;
  if (env) {
    for (const key of OTEL_KEYS) delete env[key];
    if (Object.keys(env).length === 0) delete data.env;
  }
  writePrivateFile(file, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Do not follow a repository-controlled link when reading or writing a token.
 * The root itself may be a user-facing symlink, so canonicalize it first; the
 * `.claude` directory and settings file themselves must be ordinary entries.
 */
function safeSettingsPath(root: string, createDirectory: boolean): string {
  const canonicalRoot = realpath(root);
  const claudeDir = path.join(canonicalRoot, ".claude");
  try {
    const stat = fs.lstatSync(claudeDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("refusing to use a non-directory .claude path");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!createDirectory) return path.join(claudeDir, "settings.local.json");
    fs.mkdirSync(claudeDir, { recursive: false, mode: 0o700 });
  }

  const file = path.join(claudeDir, "settings.local.json");
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("refusing to use a non-regular settings.local.json file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

function isGitTracked(root: string, relativePath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function isGitIgnored(root: string, relativePath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", "--", relativePath], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const IGNORE_PATTERN = ".claude/settings.local.json";

/**
 * Also write the rule into the shared `info/exclude`.
 *
 * `.gitignore` is a tracked file, so it only protects a worktree once it has
 * been committed — and a fresh `git worktree add` happens long before that.
 * `info/exclude` lives in the shared git dir, applies to every worktree
 * immediately, and never needs a commit. Belt and braces on the one failure
 * that really hurts: committing an ingest token.
 */
export function ensureExcluded(cwd: string): void {
  const common = commonGitDir(cwd);
  if (!common) return;
  const file = path.join(common, "info", "exclude");
  try {
    const info = path.dirname(file);
    try {
      const stat = fs.lstatSync(info);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      fs.mkdirSync(info, { recursive: true, mode: 0o700 });
    }
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    let current = "";
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      /* no info/exclude yet */
    }
    if (current.split("\n").some((l) => l.trim() === IGNORE_PATTERN)) return;
    writeAtomicFile(
      file,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}# vibecom: contains an ingest token, do not commit\n${IGNORE_PATTERN}\n`,
      0o600
    );
  } catch {
    /* read-only or unusual git dir — .gitignore still covers the common case */
  }
}

/** Returns true when the ignore rule had to be added. */
function inspectGitignore(root: string): {
  file: string;
  current: string;
  mode: number;
} {
  const file = path.join(realpath(root), ".gitignore");
  let current = "";
  let mode = 0o644;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("refusing to update a non-regular .gitignore file");
    }
    mode = stat.mode & 0o777;
    current = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    /* no .gitignore yet */
  }
  return { file, current, mode };
}

/** Returns true when the ignore rule had to be added. */
export function ensureGitignored(root: string): boolean {
  const { file, current, mode } = inspectGitignore(root);
  const pattern = IGNORE_PATTERN;
  if (current.split("\n").some((line) => line.trim() === pattern)) return false;
  writeAtomicFile(
    file,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n# vibecom: contains an ingest token, do not commit\n${pattern}\n`,
    mode
  );
  return true;
}

/* ------- api ------- */

export class ApiError extends Error {}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries 429 and 5xx with backoff.
 *
 * Linking is one request per project, so a machine with two dozen repos issues
 * a burst by design. A transient limit should cost a few seconds, not abandon
 * the project and print a wall of red.
 */
async function request<T>(
  origin: string,
  route: string,
  init: RequestInit = {},
  attempt = 0
): Promise<T> {
  origin = secureOrigin(origin);
  let res: Response;
  try {
    /* Manual redirects, deliberately. A host that redirects to a different
       origin — apex to www being the usual one — makes fetch strip the
       Authorization header on the way, so every authenticated call comes back
       as "missing Bearer token" and looks like a bad credential rather than a
       misconfigured host. Following it silently would send requests somewhere
       the token was never issued for, so name the canonical host instead. */
    res = await fetch(origin + route, { ...init, redirect: "manual" });
  } catch {
    throw new ApiError(`could not reach ${origin}`);
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    let target = "";
    try {
      target = location ? new URL(location, origin).origin : "";
    } catch {
      target = "";
    }
    if (target && target !== origin) {
      throw new ApiError(
        `${origin} redirects to ${target}. Credentials are not carried across ` +
          `a redirect, so point the CLI at the canonical host: ` +
          `VIBECOM_ORIGIN=${target} vibecom login`
      );
    }
    throw new ApiError(`${origin} returned an unexpected redirect`);
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 400 * 2 ** attempt;
    await wait(Math.min(delay, 8000));
    return request<T>(origin, route, init, attempt + 1);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    /* The server says "invalid token", which is true and useless: it names the
       thing that failed, not the thing to do. A stored credential goes stale
       for ordinary reasons — signing out elsewhere, a revoked session — and
       the person reading this cannot act on a noun. Name the one command that
       fixes it, the way the redirect case above does. */
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(
        `your sign-in for ${origin} has expired — run \`vibecom login\` to sign in again`
      );
    }
    /* A 5xx here already survived four retries, so it is the server being
       broken rather than a blip. "HTTP 500" invites the reader to go looking
       for the mistake they made; there isn't one, and nothing they change
       locally will help. Say whose problem it is and that waiting is the
       action. */
    if (res.status >= 500) {
      throw new ApiError(
        `${origin} is failing to respond (HTTP ${res.status}). Nothing is wrong ` +
          `on your machine — wait a few minutes and run the same command again.`
      );
    }
    throw new ApiError(
      typeof body.error === "string" ? body.error : `HTTP ${res.status}`
    );
  }
  return body as T;
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

export const startDeviceFlow = (origin: string) =>
  request<{ deviceCode: string; userCode: string }>(origin, "/api/auth/device", {
    method: "POST",
  });

export const pollDeviceToken = (origin: string, deviceCode: string) =>
  request<{ access_token: string; username: string }>(
    origin,
    "/api/auth/device/token",
    json({ deviceCode })
  );

export type ConsentInfo = {
  tier: number;
  name: string;
  unlocks: string;
  collects: string[];
  neverCollects: string[];
};

export const fetchConsent = (origin: string, tier: number) =>
  request<ConsentInfo>(origin, `/api/consent?tier=${tier}`);

export const fetchAllTiers = (origin: string) =>
  request<{
    tiers: { id: number; name: string; unlocks: string; collects: string[] }[];
    neverCollects: string[];
  }>(origin, "/api/consent");

export const mintProjectToken = (
  origin: string,
  token: string,
  body: { projectId: string; projectLabel: string; tier: number }
) =>
  request<{ access_token: string } & ConsentInfo>(
    origin,
    "/api/tokens/project",
    json(body, token)
  );

export const revokeProjectToken = (
  origin: string,
  token: string,
  projectId: string
) =>
  request<{ ok: boolean }>(
    origin,
    `/api/tokens/project?projectId=${encodeURIComponent(projectId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );

/* ------- self update ------- */

/* Re-exported so existing importers keep working; both now come from one place
   that also owns how two versions compare. */
export { VERSION, BUILD } from "./version";
import {
  VERSION,
  bumpKind,
  compareVersions,
  parseVersion,
  versionFromBundle,
} from "./version";

/**
 * Replace this binary with the copy the server is serving.
 *
 * A CLI installed by `curl | bash` has no package manager behind it, so
 * without this the only signal that your install predates a feature is the
 * command not existing. Writes to a temp file in the same directory and
 * renames, so an interrupted download cannot leave a broken executable.
 */
export async function selfUpdate(
  origin: string,
  options: { force?: boolean } = {}
): Promise<{
  updated: boolean;
  version: string;
  from: string;
  kind: ReturnType<typeof bumpKind> | "unknown";
}> {
  origin = secureOrigin(origin);
  const target = realpath(process.argv[1]);
  let res: Response;
  try {
    res = await fetch(origin + "/cli.js");
  } catch {
    throw new ApiError(`could not reach ${origin}`);
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status} fetching ${origin}/cli.js`);
  const body = await res.text();

  if (!body.startsWith("#!/usr/bin/env node")) {
    throw new ApiError("that does not look like the CLI");
  }

  const remote = versionFromBundle(body);
  const here = parseVersion(VERSION);
  const there = remote ? parseVersion(remote) : null;

  /* Compare releases rather than diffing bytes. The old check asked only
     whether the remote build stamp differed from the local one, which cannot
     tell newer from older — so a rollback, or any host briefly serving an
     earlier bundle, would be installed and reported as an update. Refusing to
     go backwards is the whole point of having a version. */
  if (here && there && !options.force) {
    const order = compareVersions(here, there);
    if (order === 0) {
      return { updated: false, version: VERSION, from: VERSION, kind: "none" };
    }
    if (order > 0) {
      throw new ApiError(
        `${origin} is serving ${remote}, older than the installed ${VERSION}. ` +
          `Re-run with --force to install it anyway.`
      );
    }
  }

  const tmp = target + ".new";
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, target);
  return {
    updated: true,
    version: remote ?? "unknown",
    from: VERSION,
    kind: here && there ? bumpKind(here, there) : "unknown",
  };
}

/* ------- linking ------- */

export type LinkResult = {
  slot: ProjectSlot;
  /** every checkout that received the config, main worktree first */
  worktrees: string[];
  gitignoreAdded: boolean;
};

/**
 * Mint one project's token and write it into every checkout of that project.
 *
 * Shared by the interactive wizard and the session hook so a link established
 * without a prompt is byte-for-byte the same grant as one established with
 * one — same ignore preflight, same worktree coverage, same rollback. Two
 * copies of this sequence would eventually disagree about which protection is
 * mandatory, and the unattended path is the worse one to get wrong.
 */
export async function linkRepo(
  origin: string,
  accountToken: string,
  repo: { root: string; label: string; salt?: string },
  tier: 1 | 2 | 3
): Promise<LinkResult> {
  const salt = repo.salt ?? newSalt();
  const projectId = projectIdFor(salt, repo.root);
  const worktrees = listWorktrees(repo.root);

  // Establish and verify ignore protection before the server creates a bearer
  // token or any checkout receives it.
  const gitignoreAdded = ensureGitignored(repo.root);
  ensureExcluded(repo.root);
  for (const tree of worktrees) prepareProjectSettings(tree);

  const minted = await mintProjectToken(origin, accountToken, {
    projectId,
    projectLabel: repo.label,
    tier,
  });

  try {
    for (const tree of worktrees) {
      writeProjectSettings(tree, origin, minted.access_token);
    }
  } catch (error) {
    /* A token that reached no checkout is a grant nobody asked for. Hand it
       back rather than leave it live on the server. */
    await revokeProjectToken(origin, accountToken, projectId).catch(
      () => undefined
    );
    throw error;
  }

  const slot: ProjectSlot = {
    root: repo.root,
    salt,
    projectId,
    tier,
    label: repo.label,
    origin,
    linkedAt: new Date().toISOString(),
  };
  writeSlot(slot);
  return { slot, worktrees, gitignoreAdded };
}

/* ------- codex whole-machine config ------- */

export const CODEX_CONFIG_FILE = path.join(os.homedir(), ".codex", "config.toml");

/**
 * Point Codex's OTLP exporter at the same place, with the same token.
 *
 * Codex keeps its exporter in its own config file, so the machine-wide token
 * ends up written in two places. Nothing kept them in step: re-minting that
 * token — which `vibecom login` does on any origin change — rewrote Claude
 * Code's settings and left Codex holding a credential the server had already
 * revoked. Codex went on exporting to a 401 and looked configured the whole
 * time, which is the same silent failure as pointing at a host that no longer
 * resolves. Written from the one place the token is issued, so the two cannot
 * drift again.
 *
 * Best-effort by design: Codex may not be installed, and a machine without it
 * is not a broken setup.
 */
export function writeCodexSettings(origin: string, token: string): boolean {
  origin = secureOrigin(origin);
  if (!fs.existsSync(CODEX_CONFIG_FILE)) return false;
  let body: string;
  try {
    body = fs.readFileSync(CODEX_CONFIG_FILE, "utf8");
  } catch {
    return false;
  }
  const exporter =
    `exporter = { otlp-http = { endpoint = "${origin}/api/v1/logs", ` +
    `protocol = "json", headers = { "Authorization" = "Bearer ${token}" } } }`;

  let next: string;
  if (/^\[otel\]/m.test(body)) {
    next = /^exporter = \{ otlp-http = .*$/m.test(body)
      ? body.replace(/^exporter = \{ otlp-http = .*$/m, exporter)
      : body.replace(/^\[otel\]$/m, "[otel]\n" + exporter);
  } else {
    next = body.replace(/\n*$/, "") + "\n\n[otel]\n" + exporter + "\n";
  }
  if (next === body) return false;
  try {
    /* Not writePrivateFile: this is the user's own config, and tightening its
       mode as a side effect of adding a token is not ours to decide. */
    fs.writeFileSync(CODEX_CONFIG_FILE, next);
    return true;
  } catch {
    return false;
  }
}

/** Drop our exporter block, leaving the rest of Codex's config alone. */
export function removeCodexSettings(): boolean {
  if (!fs.existsSync(CODEX_CONFIG_FILE)) return false;
  let body: string;
  try {
    body = fs.readFileSync(CODEX_CONFIG_FILE, "utf8");
  } catch {
    return false;
  }
  const next = body.replace(/\n?\[otel\]\nexporter = \{ otlp-http = .*\n/m, "\n");
  if (next === body) return false;
  try {
    fs.writeFileSync(CODEX_CONFIG_FILE, next);
    return true;
  } catch {
    return false;
  }
}
