import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read what the coding tools already write to disk.
 *
 * OTLP env vars are read once at process start, so a session that is already
 * running can never be made to export — and restarting every agent is not a
 * real answer. But Claude Code, Codex and Kimi all append a transcript to disk
 * as they go, including sessions running right now. Deriving counters from
 * those files covers live sessions, historical ones, and (unlike the OTLP
 * metrics stream) the user-turn count that verified one-shot depends on.
 *
 * Only derived numbers ever leave this module. Prompts, responses, tool
 * arguments and file contents are read to find the counters and then dropped —
 * never returned, never stored, never sent.
 */

export type Tool = "claude-code" | "codex" | "kimi";

export type SessionUsage = {
  tool: Tool;
  sessionId: string;
  /** working directory the session ran in, used to attribute it to a project */
  cwd: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** human turns; 1 means a single prompt produced the whole session */
  turns: number;
  /** kimi only: sha256(workdir)[:12], used when the index has no entry */
  workspaceHash?: string | null;
  /** project this session was attributed to; remembered across incremental reads */
  root?: string;
  /** last line consumed, so a re-scan only reads what is new */
  lines: number;
  mtimeMs: number;
  file: string;
};

const home = os.homedir();
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

/**
 * Split without the phantom element a trailing newline produces.
 *
 * Counting it would advance the watermark one line past the real end, so the
 * first record appended by a live session afterwards would be skipped forever.
 */
function splitLines(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function* readLines(file: string, skip: number): Generator<unknown> {
  const lines = splitLines(file);
  for (let i = skip; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* partial write from a live session — it will be complete next scan */
    }
  }
}

const countLines = (file: string): number => splitLines(file).length;

/* ---------------------------------------------------------- claude code --- */

type Rec = Record<string, unknown>;

/**
 * A human turn is a `user` record whose content is a plain string. Tool results
 * are also `user` records, but their content is an array of tool_result blocks —
 * counting those would inflate turns by an order of magnitude and make every
 * session look nothing like a one-shot.
 */
function isHumanTurn(rec: Rec): boolean {
  if (rec.type !== "user") return false;
  const message = rec.message as Rec | undefined;
  return typeof message?.content === "string";
}

function parseClaudeCode(file: string, skip: number): SessionUsage | null {
  const u: SessionUsage = {
    tool: "claude-code",
    sessionId: "",
    cwd: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    turns: 0,
    lines: countLines(file),
    mtimeMs: fs.statSync(file).mtimeMs,
    file,
  };

  for (const raw of readLines(file, skip)) {
    const rec = raw as Rec;
    if (typeof rec.sessionId === "string") u.sessionId ||= rec.sessionId;
    if (typeof rec.cwd === "string") u.cwd ||= rec.cwd;
    if (isHumanTurn(rec)) u.turns++;

    const message = rec.message as Rec | undefined;
    if (typeof message?.model === "string") u.model ||= message.model;
    const usage = message?.usage as Rec | undefined;
    if (usage) {
      u.inputTokens += num(usage.input_tokens);
      u.outputTokens += num(usage.output_tokens);
      u.cacheReadTokens += num(usage.cache_read_input_tokens);
      u.cacheCreationTokens += num(usage.cache_creation_input_tokens);
    }
    u.costUsd += num(rec.costUSD) || num(rec.cost_usd);
  }

  u.sessionId ||= path.basename(file, ".jsonl");
  return u;
}

/* ---------------------------------------------------------------- codex --- */

function parseCodex(file: string, skip: number): SessionUsage | null {
  const u: SessionUsage = {
    tool: "codex",
    sessionId: "",
    cwd: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    turns: 0,
    lines: countLines(file),
    mtimeMs: fs.statSync(file).mtimeMs,
    file,
  };

  // token_count carries a running total, so take the last one rather than
  // summing — adding every snapshot would multiply the real usage.
  let lastTotal: Rec | null = null;

  for (const raw of readLines(file, skip)) {
    const rec = raw as Rec;
    const payload = (rec.payload ?? {}) as Rec;

    if (rec.type === "session_meta") {
      if (typeof payload.session_id === "string") u.sessionId ||= payload.session_id;
      if (typeof payload.cwd === "string") u.cwd ||= payload.cwd;
      if (typeof payload.model === "string") u.model ||= payload.model;
    }
    if (payload.type === "user_message") u.turns++;
    if (payload.type === "token_count") {
      const info = (payload.info ?? {}) as Rec;
      const total = info.total_token_usage as Rec | undefined;
      if (total) lastTotal = total;
    }
  }

  if (lastTotal) {
    u.inputTokens = num(lastTotal.input_tokens);
    u.outputTokens = num(lastTotal.output_tokens);
    u.cacheReadTokens = num(lastTotal.cached_input_tokens);
  }
  u.sessionId ||= path.basename(file, ".jsonl");
  return u;
}

/* ----------------------------------------------------------------- kimi --- */

function parseKimi(file: string, skip: number): SessionUsage | null {
  const u: SessionUsage = {
    tool: "kimi",
    sessionId: "",
    cwd: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    turns: 0,
    lines: countLines(file),
    mtimeMs: fs.statSync(file).mtimeMs,
    file,
  };

  for (const raw of readLines(file, skip)) {
    const rec = raw as Rec;
    if (rec.type === "turn.prompt") u.turns++;
    if (typeof rec.model === "string") u.model ||= rec.model;
    if (rec.type === "usage.record") {
      const usage = (rec.usage ?? {}) as Rec;
      u.inputTokens += num(usage.inputOther);
      u.outputTokens += num(usage.output);
      u.cacheReadTokens += num(usage.inputCacheRead);
      u.cacheCreationTokens += num(usage.inputCacheCreation);
    }
  }

  // .../sessions/<workspace>/session_<uuid>/agents/main/wire.jsonl
  const parts = file.split(path.sep);
  const sessionDir = parts.find((p) => p.startsWith("session_"));
  u.sessionId ||= sessionDir?.replace("session_", "") ?? path.basename(file);
  u.workspaceHash = kimiWorkspaceHash(file);
  return u;
}

/**
 * Kimi names workspace directories `wd_<label>_<hash>`, where the hash is the
 * first 12 hex of sha256 over the working directory. Its session index only
 * records the most recent session, so this is how older transcripts — and every
 * session running right now — get attributed to the right project.
 */
export function kimiWorkspaceHash(file: string): string | null {
  const dir = file.split(path.sep).find((p) => /^wd_.*_[a-f0-9]{12}$/.test(p));
  return dir ? dir.slice(-12) : null;
}

/* -------------------------------------------------------------- discovery --- */

function walk(dir: string, match: (f: string) => boolean, out: string[] = []) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (match(full)) out.push(full);
  }
  return out;
}

export type Source = {
  tool: Tool;
  files: string[];
  parse: (file: string, skip: number) => SessionUsage | null;
};

export function transcriptSources(): Source[] {
  return [
    {
      tool: "claude-code",
      files: walk(path.join(home, ".claude", "projects"), (f) =>
        f.endsWith(".jsonl")
      ),
      parse: parseClaudeCode,
    },
    {
      tool: "codex",
      files: walk(path.join(home, ".codex", "sessions"), (f) =>
        f.endsWith(".jsonl")
      ),
      parse: parseCodex,
    },
    {
      tool: "kimi",
      files: walk(path.join(home, ".kimi-code", "sessions"), (f) =>
        f.endsWith("wire.jsonl")
      ),
      parse: parseKimi,
    },
  ];
}

/** Kimi keeps the working directory in an index rather than the transcript. */
export function kimiWorkdirs(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(
      path.join(home, ".kimi-code", "session_index.jsonl"),
      "utf8"
    );
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as Rec;
      if (typeof rec.sessionId === "string" && typeof rec.workDir === "string") {
        map.set(rec.sessionId, rec.workDir);
      }
    }
  } catch {
    /* no index yet */
  }
  return map;
}

/**
 * Reduce transcripts to one entry per session, keeping the most complete.
 *
 * Claude Code starts a fresh transcript on every resume and replays the prior
 * history into it, so a single session can span a hundred-plus files each
 * containing a superset of the last. Summing them multiplies real usage — on
 * one real machine by 8x overall and 21x for the worst session. The
 * authoritative record is the longest transcript, with recency breaking ties.
 */
export function groupBySession(usages: SessionUsage[]): SessionUsage[] {
  const best = new Map<string, SessionUsage>();
  for (const u of usages) {
    const key = `${u.tool}:${u.sessionId}`;
    const cur = best.get(key);
    if (
      !cur ||
      u.lines > cur.lines ||
      (u.lines === cur.lines && u.mtimeMs > cur.mtimeMs)
    ) {
      best.set(key, u);
    }
  }
  return [...best.values()];
}
