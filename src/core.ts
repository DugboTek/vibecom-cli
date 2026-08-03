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

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
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

/** Only use origins on a transport that cannot disclose bearer credentials. */
export function secureOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ApiError("origin must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new ApiError("origin must be an HTTPS origin without userinfo or a path");
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
export function resolveOrigin(): string {
  if (process.env.VIBECOM_ORIGIN) return secureOrigin(process.env.VIBECOM_ORIGIN);
  if (process.env.VIBELAND_ORIGIN) return secureOrigin(process.env.VIBELAND_ORIGIN);
  const cred = readCredentials();
  if (cred?.origin) return secureOrigin(cred.origin);
  let savedOrigin: string;
  try {
    savedOrigin = fs.readFileSync(ORIGIN_FILE, "utf8").trim();
  } catch {
    // Must be the host that serves directly — a redirecting origin
    // would strip the Authorization header off every request.
    return "https://www.vibecom.build";
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
  /** the most complete transcript seen for this session */
  file: string;
  lines: number;
  mtimeMs: number;
  root?: string;
  /** Same reasoning as `root`: Codex names the model on turn_context, near the
      top of the file. An incremental re-read starts past it, so a continuing
      session would lose its model on every scan after the first. */
  model?: string | null;
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
  }[]
): Promise<{ accepted: number; dropped: number }> {
  const attr = (key: string, value: string | number) => ({
    key,
    value:
      typeof value === "number"
        ? { doubleValue: value }
        : { stringValue: value },
  });

  const logRecords = sessions.map((s) => ({
    attributes: [
      attr("event.name", "vibecom.session"),
      attr("tool", s.tool),
      attr("session.id", s.sessionId),
      ...(s.model ? [attr("model", s.model)] : []),
      attr("turns", s.turns),
      attr("input_tokens", s.inputTokens),
      attr("output_tokens", s.outputTokens),
      attr("cache_read_tokens", s.cacheReadTokens),
      attr("cache_creation_tokens", s.cacheCreationTokens),
      attr("cost_usd", s.costUsd),
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

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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
    .map(realpath);
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

declare const __VIBECOM_BUILD__: string;

/** Build stamp injected by scripts/build-cli.mjs. */
export const BUILD: string =
  typeof __VIBECOM_BUILD__ === "string" ? __VIBECOM_BUILD__ : "dev";

/**
 * Replace this binary with the copy the server is serving.
 *
 * A CLI installed by `curl | bash` has no package manager behind it, so
 * without this the only signal that your install predates a feature is the
 * command not existing. Writes to a temp file in the same directory and
 * renames, so an interrupted download cannot leave a broken executable.
 */
export async function selfUpdate(
  origin: string
): Promise<{ updated: boolean; build: string }> {
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
  const stamp = body.match(/__VIBECOM_BUILD__|"(\d{4}-\d{2}-\d{2}T[\d:]+Z)"/);
  const remoteBuild = stamp?.[1] ?? "unknown";
  if (body.includes(`"${BUILD}"`) && BUILD !== "dev") {
    return { updated: false, build: BUILD };
  }

  const tmp = target + ".new";
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, target);
  return { updated: true, build: remoteBuild };
}
