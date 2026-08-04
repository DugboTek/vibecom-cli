import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceUsage, totalTokens as pricedTokenTotal } from "./pricing";
import type { TokenUsage } from "./pricing";

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

export type ActivityBucket = {
  /** Start of the UTC hour this activity belongs to. */
  bucketAtMs: number;
  /** Conservative active time inside this hour. */
  seconds: number;
};

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
  /** Derived from published list prices — see ./pricing. Never tool-reported. */
  costUsd: number;
  /**
   * Tokens from models with no published rate, so a $0 that means "we could not
   * price this" stays distinguishable from a $0 that means "this was free".
   */
  unpricedTokens: number;
  /** Token and cost totals split by the model that actually served them. */
  modelUsage?: ModelUsage[];
  /** human turns; 1 means a single prompt produced the whole session */
  turns: number;
  /** First and last timestamp written inside the transcript itself. */
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** Active time distributed into real clock hours, with long idle gaps capped. */
  activity: ActivityBucket[];
  /** kimi only: sha256(workdir)[:12], used when the index has no entry */
  workspaceHash?: string | null;
  /** project this session was attributed to; remembered across incremental reads */
  root?: string;
  /** last line consumed, so a re-scan only reads what is new */
  lines: number;
  mtimeMs: number;
  file: string;
};

export type ModelUsage = TokenUsage & {
  model: string | null;
  costUsd: number;
  unpricedTokens: number;
};

type ClaudeMessage = {
  model: string | null;
  usage: TokenUsage;
  timestamp: number | null;
};

type ClaudeDetails = {
  messages: Map<string, ClaudeMessage>;
  turns: Set<string>;
  timestamps: Set<number>;
  main: boolean;
  /** Replayed transcripts are safe to union only when API/turn ids exist. */
  mergeSafeMessages: boolean;
  mergeSafeTurns: boolean;
};

/* Message and record IDs are needed only while transcript files are merged.
   A WeakMap keeps them private to this module, so SessionUsage still exposes
   derived numbers only and nothing identifying is sent or persisted. */
const CLAUDE_DETAILS = new WeakMap<SessionUsage, ClaudeDetails>();
const KIMI_DETAILS = new WeakMap<
  SessionUsage,
  { timestamps: Set<number>; main: boolean }
>();

const home = os.homedir();
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

/* A chat can stay open overnight. Treating first-to-last as hands-on time would
   turn that idle window into a heroic coding marathon, so any silence longer
   than fifteen minutes contributes at most fifteen minutes. This is the same
   inactivity-window idea used by editors and analytics tools, applied locally
   before any derived counter leaves the machine. */
export const ACTIVE_GAP_MS = 15 * 60 * 1000;

function recordTimeMs(rec: Rec): number | null {
  const raw = rec.timestamp ?? rec.time ?? rec.created_at;
  const parsed =
    typeof raw === "string"
      ? Date.parse(raw)
      : typeof raw === "number"
        ? raw < 10_000_000_000
          ? raw * 1000
          : raw
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Turn timestamped transcript events into conservative active-time buckets.
 * Only gaps between real records count; a long idle gap is capped, and no
 * invented tail is added after the final event.
 */
export function activityFromTimestamps(
  values: readonly number[]
): ActivityBucket[] {
  const timestamps = [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
  const buckets = new Map<number, number>();

  for (let index = 0; index < timestamps.length - 1; index++) {
    let cursor = timestamps[index];
    const next = timestamps[index + 1];
    const activeEnd = cursor + Math.min(next - cursor, ACTIVE_GAP_MS);
    while (cursor < activeEnd) {
      const bucketAtMs = Math.floor(cursor / 3_600_000) * 3_600_000;
      const segmentEnd = Math.min(activeEnd, bucketAtMs + 3_600_000);
      buckets.set(
        bucketAtMs,
        (buckets.get(bucketAtMs) ?? 0) + (segmentEnd - cursor) / 1000
      );
      cursor = segmentEnd;
    }
  }

  return [...buckets.entries()].map(([bucketAtMs, seconds]) => ({
    bucketAtMs,
    seconds,
  }));
}

function finishTiming(u: SessionUsage, timestamps: number[]): SessionUsage {
  /* mtime is a useful last-event fallback for older transcript formats that
     only timestamp their opening record. The idle cap prevents a later file
     touch from inflating focused time by hours or days. */
  const timestamped = [...new Set(timestamps)];
  const points = [...timestamped, ...(timestamped.length < 2 ? [u.mtimeMs] : [])]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  u.startedAtMs = points[0] ?? null;
  u.endedAtMs = points.at(-1) ?? null;
  u.activity = activityFromTimestamps(points);
  return u;
}

function applyModelUsage(
  u: SessionUsage,
  messages: Iterable<ClaudeMessage>,
  allowLongContext = true
) {
  const byModel = new Map<string, ModelUsage>();
  for (const message of messages) {
    const key = message.model ?? "";
    let slice = byModel.get(key);
    if (!slice) {
      slice = {
        model: message.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        costUsd: 0,
        unpricedTokens: 0,
      };
      byModel.set(key, slice);
    }
    slice.inputTokens += message.usage.inputTokens;
    slice.outputTokens += message.usage.outputTokens;
    slice.cacheReadTokens += message.usage.cacheReadTokens;
    slice.cacheWrite5mTokens += message.usage.cacheWrite5mTokens;
    slice.cacheWrite1hTokens += message.usage.cacheWrite1hTokens;
    const cost = priceUsage(message.model, message.usage, allowLongContext);
    if (cost === null) slice.unpricedTokens += pricedTokenTotal(message.usage);
    else slice.costUsd += cost;
  }

  const slices = [...byModel.values()]
    .filter(
      (slice) =>
        pricedTokenTotal(slice) > 0 ||
        slice.costUsd > 0 ||
        slice.unpricedTokens > 0
    )
    .sort((a, b) => pricedTokenTotal(b) - pricedTokenTotal(a));
  u.modelUsage = slices;
  u.inputTokens = slices.reduce((sum, slice) => sum + slice.inputTokens, 0);
  u.outputTokens = slices.reduce((sum, slice) => sum + slice.outputTokens, 0);
  u.cacheReadTokens = slices.reduce(
    (sum, slice) => sum + slice.cacheReadTokens,
    0
  );
  u.cacheCreationTokens = slices.reduce(
    (sum, slice) =>
      sum + slice.cacheWrite5mTokens + slice.cacheWrite1hTokens,
    0
  );
  u.costUsd = slices.reduce((sum, slice) => sum + slice.costUsd, 0);
  u.unpricedTokens = slices.reduce(
    (sum, slice) => sum + slice.unpricedTokens,
    0
  );
  u.model = slices.find((slice) => pricedTokenTotal(slice) > 0)?.model ?? null;
}

/**
 * Price a session from its final totals.
 *
 * Claude Code states usage and model on every assistant message, so it is
 * priced message by message. Codex and Kimi instead report one running total
 * per session against a single model, leaving nothing finer to price against.
 * Cache writes go in the five-minute bucket because neither vendor charges a
 * TTL-dependent write premium; only Anthropic does, and Anthropic never
 * reaches this path.
 */
function priceFromTotals(u: SessionUsage): void {
  applyModelUsage(
    u,
    [
      {
        model: u.model,
        usage: {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWrite5mTokens: u.cacheCreationTokens,
          cacheWrite1hTokens: 0,
        },
        timestamp: null,
      },
    ],
    /* A session aggregate cannot establish whether any individual request
       crossed 272K. Applying the uplift to all of it would be a known
       overcharge, so legacy records without request slices stay at base rate. */
    false
  );
}

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
    unpricedTokens: 0,
    turns: 0,
    startedAtMs: null,
    endedAtMs: null,
    activity: [],
    lines: countLines(file),
    mtimeMs: fs.statSync(file).mtimeMs,
    file,
  };
  const details: ClaudeDetails = {
    messages: new Map(),
    turns: new Set(),
    timestamps: new Set(),
    main: true,
    mergeSafeMessages: true,
    mergeSafeTurns: true,
  };
  let recordIndex = skip;

  for (const raw of readLines(file, skip)) {
    recordIndex++;
    const rec = raw as Rec;
    const timestamp = recordTimeMs(rec);
    if (timestamp !== null) details.timestamps.add(timestamp);
    if (typeof rec.sessionId === "string") u.sessionId ||= rec.sessionId;
    if (typeof rec.cwd === "string") u.cwd ||= rec.cwd;
    if (rec.isSidechain === true || typeof rec.agentId === "string") {
      details.main = false;
    }
    if (
      isHumanTurn(rec) &&
      rec.isSidechain !== true &&
      typeof rec.agentId !== "string"
    ) {
      const id = typeof rec.uuid === "string" ? rec.uuid : null;
      if (!id) details.mergeSafeTurns = false;
      details.turns.add(id ?? `${file}:turn:${recordIndex}`);
    }

    const message = rec.message as Rec | undefined;
    const usage = message?.usage as Rec | undefined;
    if (!usage) continue;

    const inputTokens = num(usage.input_tokens);
    const outputTokens = num(usage.output_tokens);
    const cacheReadTokens = num(usage.cache_read_input_tokens);
    const cacheCreationTokens = num(usage.cache_creation_input_tokens);
    /* Cache writes are billed by TTL, and the hour tier costs 1.6x the
       five-minute one. `cache_creation` states the hour figure; taking the
       rest as five-minute conserves the documented total even on older
       records that omit the breakdown entirely. */
    const split = usage.cache_creation as Rec | undefined;
    const cacheWrite1hTokens = num(split?.ephemeral_1h_input_tokens);
    const cacheWrite5mTokens = Math.max(
      0,
      cacheCreationTokens - cacheWrite1hTokens
    );

    const messageId =
      typeof message?.id === "string"
        ? message.id
        : typeof rec.requestId === "string"
          ? rec.requestId
          : typeof rec.uuid === "string"
            ? rec.uuid
            : null;
    if (!messageId) details.mergeSafeMessages = false;
    const key = messageId ?? `${file}:message:${recordIndex}`;
    const candidate: ClaudeMessage = {
      model: typeof message?.model === "string" ? message.model : null,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
      },
      timestamp,
    };
    const previous = details.messages.get(key);
    /* Claude repeats one assistant message as its content blocks stream. The
       input/cache fields remain invariant while output grows, so only the
       final (largest) output is a billable API response. */
    if (
      !previous ||
      candidate.usage.outputTokens > previous.usage.outputTokens ||
      (candidate.usage.outputTokens === previous.usage.outputTokens &&
        (candidate.timestamp ?? 0) >= (previous.timestamp ?? 0))
    ) {
      details.messages.set(key, candidate);
    }
  }

  u.sessionId ||= path.basename(file, ".jsonl");
  u.turns = details.turns.size;
  applyModelUsage(u, details.messages.values());
  finishTiming(u, [...details.timestamps]);
  CLAUDE_DETAILS.set(u, details);
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
    unpricedTokens: 0,
    turns: 0,
    startedAtMs: null,
    endedAtMs: null,
    activity: [],
    lines: countLines(file),
    mtimeMs: fs.statSync(file).mtimeMs,
    file,
  };
  const timestamps: number[] = [];

  // token_count repeats its running total after non-billable events. A changed
  // cumulative tuple identifies one new request; last_token_usage is that
  // request's usage and preserves the boundary needed for long-context rates.
  let lastTotal: Rec | null = null;
  let previousTuple: string | null = null;
  let sessionModel: string | null = null;
  let activeModel: string | null = null;
  const requests: ClaudeMessage[] = [];

  for (const raw of readLines(file, skip)) {
    const rec = raw as Rec;
    const timestamp = recordTimeMs(rec);
    if (timestamp !== null) timestamps.push(timestamp);
    const payload = (rec.payload ?? {}) as Rec;

    if (rec.type === "session_meta") {
      if (typeof payload.session_id === "string") u.sessionId ||= payload.session_id;
      if (typeof payload.cwd === "string") u.cwd ||= payload.cwd;
      // Older rollouts carried the model here; current ones do not.
      if (typeof payload.model === "string") {
        sessionModel ||= payload.model;
        activeModel ||= payload.model;
      }
    }
    /* Current Codex writes the model on turn_context, not session_meta —
       session_meta only has model_provider. Without this every Codex session
       reports no model, so its tokens land in the totals but never appear in
       any per-model breakdown. */
    if (rec.type === "turn_context" && typeof payload.model === "string") {
      activeModel = payload.model;
    }
    if (payload.type === "user_message") u.turns++;
    if (payload.type === "token_count") {
      const info = (payload.info ?? {}) as Rec;
      const total = info.total_token_usage as Rec | undefined;
      if (total) {
        lastTotal = total;
        const tuple = JSON.stringify([
          num(total.input_tokens),
          num(total.cached_input_tokens),
          num(total.output_tokens),
          num(total.reasoning_output_tokens),
          num(total.cache_write_input_tokens),
        ]);
        if (tuple !== previousTuple) {
          previousTuple = tuple;
          const last = info.last_token_usage as Rec | undefined;
          if (last) {
            const wholeInput = num(last.input_tokens);
            const cacheReadTokens = Math.min(
              num(last.cached_input_tokens),
              wholeInput
            );
            requests.push({
              model: activeModel ?? sessionModel,
              usage: {
                inputTokens: wholeInput - cacheReadTokens,
                outputTokens: num(last.output_tokens),
                cacheReadTokens,
                cacheWrite5mTokens: num(last.cache_write_input_tokens),
                cacheWrite1hTokens: 0,
              },
              timestamp,
            });
          }
        }
      }
    }
  }

  if (requests.length > 0) {
    applyModelUsage(u, requests);
  } else if (lastTotal) {
    /* `input_tokens` is the whole input, with `cached_input_tokens` a subset of
       it — the transcript's own `total_tokens` equals input plus output, so
       cached is already inside that figure. Reading the two as siblings counted
       every cached token twice, which on one real machine turned 8.5M fresh
       input tokens into 1.09B reported. Subtracting leaves what was actually
       charged at the full rate. */
    const wholeInput = num(lastTotal.input_tokens);
    u.cacheReadTokens = Math.min(num(lastTotal.cached_input_tokens), wholeInput);
    u.inputTokens = wholeInput - u.cacheReadTokens;
    u.outputTokens = num(lastTotal.output_tokens);
    u.cacheCreationTokens = num(lastTotal.cache_write_input_tokens);
    u.model = activeModel ?? sessionModel;
    priceFromTotals(u);
  } else {
    u.model = activeModel ?? sessionModel;
  }
  u.sessionId ||= path.basename(file, ".jsonl");
  return finishTiming(u, timestamps);
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
    unpricedTokens: 0,
    turns: 0,
    startedAtMs: null,
    endedAtMs: null,
    activity: [],
    lines: countLines(file),
    mtimeMs: fs.statSync(file).mtimeMs,
    file,
  };
  const timestamps: number[] = [];

  for (const raw of readLines(file, skip)) {
    const rec = raw as Rec;
    const timestamp = recordTimeMs(rec);
    if (timestamp !== null) timestamps.push(timestamp);
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
  priceFromTotals(u);
  finishTiming(u, timestamps);
  const agentIndex = parts.lastIndexOf("agents");
  KIMI_DETAILS.set(u, {
    timestamps: new Set(timestamps),
    main: agentIndex < 0 || parts[agentIndex + 1] === "main",
  });
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

const mostComplete = (usages: SessionUsage[]): SessionUsage =>
  usages.reduce((best, usage) =>
    usage.lines > best.lines ||
    (usage.lines === best.lines && usage.mtimeMs > best.mtimeMs)
      ? usage
      : best
  );

function groupedIdentity(
  representative: SessionUsage,
  usages: SessionUsage[]
): SessionUsage {
  return {
    ...representative,
    /* The scanner watermark must describe the entire execution tree. A stable
       synthetic name plus summed lines/max mtime changes when any child wire
       changes without exposing transcript paths to the server. */
    file: `group:${representative.tool}:${representative.sessionId}`,
    lines: usages.reduce((sum, usage) => sum + usage.lines, 0),
    mtimeMs: Math.max(...usages.map((usage) => usage.mtimeMs)),
  };
}

function mergeClaude(usages: SessionUsage[]): SessionUsage {
  const details = usages.map((usage) => CLAUDE_DETAILS.get(usage));
  if (
    details.some(
      (detail) =>
        !detail || !detail.mergeSafeMessages || !detail.mergeSafeTurns
    )
  ) {
    /* Older transcript formats lack stable ids. For those, longest-file wins
       is conservative: unioning file-local fallback ids would count every
       replay as new work. */
    return mostComplete(usages);
  }

  const typed = details as ClaudeDetails[];
  const main = usages.filter((_, index) => typed[index].main);
  const representative = mostComplete(main.length > 0 ? main : usages);
  const merged = groupedIdentity(representative, usages);
  const messages = new Map<string, ClaudeMessage>();
  const turns = new Set<string>();
  const timestamps = new Set<number>();

  for (const detail of typed) {
    for (const [id, candidate] of detail.messages) {
      const previous = messages.get(id);
      if (
        !previous ||
        candidate.usage.outputTokens > previous.usage.outputTokens ||
        (candidate.usage.outputTokens === previous.usage.outputTokens &&
          (candidate.timestamp ?? 0) >= (previous.timestamp ?? 0))
      ) {
        messages.set(id, candidate);
      }
    }
    for (const turn of detail.turns) turns.add(turn);
    for (const timestamp of detail.timestamps) timestamps.add(timestamp);
  }

  merged.turns = turns.size;
  applyModelUsage(merged, messages.values());
  finishTiming(merged, [...timestamps]);
  CLAUDE_DETAILS.set(merged, {
    messages,
    turns,
    timestamps,
    main: true,
    mergeSafeMessages: true,
    mergeSafeTurns: true,
  });
  return merged;
}

function mergeKimi(usages: SessionUsage[]): SessionUsage {
  const details = usages.map((usage) => KIMI_DETAILS.get(usage));
  if (details.some((detail) => !detail)) return mostComplete(usages);
  const typed = details as NonNullable<ReturnType<typeof KIMI_DETAILS.get>>[];
  const main = usages.filter((_, index) => typed[index].main);
  const representative = mostComplete(main.length > 0 ? main : usages);
  const merged = groupedIdentity(representative, usages);
  const messages: ClaudeMessage[] = [];
  const timestamps = new Set<number>();

  for (const [index, usage] of usages.entries()) {
    for (const slice of usage.modelUsage ?? []) {
      messages.push({ model: slice.model, usage: slice, timestamp: null });
    }
    for (const timestamp of typed[index].timestamps) timestamps.add(timestamp);
  }
  merged.turns = main.reduce((sum, usage) => sum + usage.turns, 0);
  applyModelUsage(merged, messages);
  finishTiming(merged, [...timestamps]);
  KIMI_DETAILS.set(merged, { timestamps, main: true });
  return merged;
}

/** Reduce transcript files to one complete account-level usage per session. */
export function groupBySession(usages: SessionUsage[]): SessionUsage[] {
  const groups = new Map<string, SessionUsage[]>();
  for (const u of usages) {
    const key = `${u.tool}:${u.sessionId}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    if (group[0].tool === "claude-code") return mergeClaude(group);
    if (group[0].tool === "kimi") return mergeKimi(group);
    return mostComplete(group);
  });
}
