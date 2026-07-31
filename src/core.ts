import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------- paths ------- */

export const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "vibeland"
);
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
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

/* ------- credentials ------- */

export type Credentials = { token: string; username: string; origin: string };

export const readCredentials = (): Credentials | null =>
  readJson<Credentials | null>(CRED_FILE, null);

export const writeCredentials = (c: Credentials) => writeJson(CRED_FILE, c);
export const clearCredentials = () => fs.rmSync(CRED_FILE, { force: true });

/**
 * A token is only valid on the host that issued it, so every command after
 * login talks to the host you logged into — never wherever the CLI was
 * downloaded from. Explicit env var always wins.
 */
export function resolveOrigin(): string {
  if (process.env.VIBELAND_ORIGIN) return process.env.VIBELAND_ORIGIN;
  const cred = readCredentials();
  if (cred?.origin) return cred.origin;
  try {
    return fs.readFileSync(ORIGIN_FILE, "utf8").trim();
  } catch {
    return "https://vibeland.dev";
  }
}

/* ------- trusted repo owners ------- */

export const readTrusted = (): string[] => readJson<string[]>(TRUST_FILE, []);

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

export const readSlot = (root: string): ProjectSlot | null =>
  readJson<ProjectSlot | null>(slotPath(root), null);

export const writeSlot = (slot: ProjectSlot) =>
  writeJson(slotPath(slot.root), slot);

export const deleteSlot = (root: string) =>
  fs.rmSync(slotPath(root), { force: true });

export function listSlots(): ProjectSlot[] {
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

export const gitRoot = (cwd = process.cwd()) =>
  git(["rev-parse", "--show-toplevel"], cwd);

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
  root: string;
  label: string;
  owner: string | null;
  remote: string | null;
  linked: ProjectSlot | null;
};

/**
 * Find git repositories near `dir`, one level deep. Deliberately shallow —
 * walking a whole home directory is slow and surfaces vendored checkouts
 * nobody means to link.
 */
export function discoverRepos(dir: string): Discovered[] {
  const found: string[] = [];
  const here = gitRoot(dir);
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
    if (fs.existsSync(path.join(child, ".git"))) found.push(child);
  }

  return [...new Set(found)].map((root) => {
    const remote = gitRemote(root);
    return {
      root,
      label: path.basename(root),
      remote,
      owner: remoteOwner(remote),
      linked: readSlot(root),
    };
  });
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
  const file = settingsPathFor(root);
  ensureDir(path.dirname(file));
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
  writeJson(file, data);
  return file;
}

export function removeProjectSettings(root: string) {
  const file = settingsPathFor(root);
  if (!fs.existsSync(file)) return;
  const data = readJson<Record<string, unknown>>(file, {});
  const env = data.env as Record<string, string> | undefined;
  if (env) {
    for (const key of OTEL_KEYS) delete env[key];
    if (Object.keys(env).length === 0) delete data.env;
  }
  writeJson(file, data);
}

/** Returns true when the ignore rule had to be added. */
export function ensureGitignored(root: string): boolean {
  const file = path.join(root, ".gitignore");
  const pattern = ".claude/settings.local.json";
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (current.split("\n").some((line) => line.trim() === pattern)) return false;
  fs.appendFileSync(
    file,
    `${current && !current.endsWith("\n") ? "\n" : ""}\n# vibeland: contains an ingest token, do not commit\n${pattern}\n`
  );
  return true;
}

/* ------- api ------- */

export class ApiError extends Error {}

async function request<T>(
  origin: string,
  route: string,
  init: RequestInit = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(origin + route, init);
  } catch {
    throw new ApiError(`could not reach ${origin}`);
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
