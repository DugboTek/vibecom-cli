import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  ACTIVE_GAP_MS,
  activityFromTimestamps,
  groupBySession,
  kimiWorkspaceHash,
  transcriptSources,
  type SessionUsage,
} from "./transcripts";

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-transcript-test-"))
);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function jsonl(name: string, records: unknown[]): string {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

const parserFor = (tool: string) =>
  transcriptSources().find((s) => s.tool === tool)!.parse;

const SECRET = "MY SECRET PROMPT AND PROPRIETARY SOURCE CODE";

/* ------- claude code ------- */

const ccUsage = (i: number, o: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 3,
});

test("claude code: human turns are counted, tool results are not", () => {
  const file = jsonl("cc.jsonl", [
    { type: "user", sessionId: "s1", cwd: "/code/app", message: { content: SECRET } },
    { type: "assistant", message: { model: "claude-opus-5", usage: ccUsage(100, 50) } },
    // tool results are also `user` records — counting them would inflate turns
    { type: "user", message: { content: [{ type: "tool_result", content: SECRET }] } },
    { type: "assistant", message: { model: "claude-opus-5", usage: ccUsage(200, 80) } },
    { type: "user", message: { content: [{ type: "tool_result", content: "x" }] } },
  ]);
  const u = parserFor("claude-code")(file, 0)!;
  assert.equal(u.turns, 1, "one human prompt == one-shot");
  assert.equal(u.inputTokens, 300);
  assert.equal(u.outputTokens, 130);
  assert.equal(u.cacheReadTokens, 10);
  assert.equal(u.sessionId, "s1");
  assert.equal(u.cwd, "/code/app");
  assert.equal(u.model, "claude-opus-5");
});

test("claude code: transcript timestamps define the real session span", () => {
  const file = jsonl("cc-time.jsonl", [
    {
      type: "user",
      sessionId: "timed",
      cwd: "/code/app",
      timestamp: "2026-08-03T14:05:00.000Z",
      message: { content: "start" },
    },
    {
      type: "assistant",
      timestamp: "2026-08-03T14:25:00.000Z",
      message: { usage: ccUsage(10, 2) },
    },
  ]);
  const u = parserFor("claude-code")(file, 0)!;
  assert.equal(u.startedAtMs, Date.parse("2026-08-03T14:05:00.000Z"));
  assert.ok((u.endedAtMs ?? 0) >= Date.parse("2026-08-03T14:25:00.000Z"));
  assert.equal(
    u.activity.reduce((sum, bucket) => sum + bucket.seconds, 0),
    ACTIVE_GAP_MS / 1000,
    "a twenty-minute silence is capped at the fifteen-minute activity window"
  );
});

test("active time is split across the clock hours it actually occupied", () => {
  const start = Date.parse("2026-08-03T14:55:00.000Z");
  const buckets = activityFromTimestamps([start, start + 10 * 60 * 1000]);
  assert.deepEqual(
    buckets.map((bucket) => bucket.seconds),
    [300, 300]
  );
  assert.deepEqual(
    buckets.map((bucket) => new Date(bucket.bucketAtMs).toISOString()),
    ["2026-08-03T14:00:00.000Z", "2026-08-03T15:00:00.000Z"]
  );
});

test("no transcript content survives parsing, from any tool", () => {
  const files = [
    jsonl("leak-cc.jsonl", [
      { type: "user", sessionId: "s", cwd: "/c", message: { content: SECRET } },
      { type: "assistant", message: { model: "m", usage: ccUsage(1, 1) } },
    ]),
    jsonl("leak-cx.jsonl", [
      { type: "session_meta", payload: { session_id: "s", cwd: "/c" } },
      { type: "event_msg", payload: { type: "user_message", message: SECRET } },
      {
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9 } } },
      },
    ]),
    jsonl("wd_x_aaaaaaaaaaaa/session_1/agents/main/wire.jsonl", [
      { type: "turn.prompt", text: SECRET },
      { type: "usage.record", usage: { inputOther: 4, output: 2 } },
    ]),
  ];
  const tools = ["claude-code", "codex", "kimi"];
  for (const [i, file] of files.entries()) {
    const u = parserFor(tools[i])(file, 0)!;
    const serialized = JSON.stringify({ ...u, file: "" });
    assert.ok(
      !serialized.includes("SECRET"),
      `${tools[i]} leaked transcript content: ${serialized}`
    );
  }
});

/* ------- codex ------- */

test("codex: user_message counts as a turn, totals are not summed twice", () => {
  const file = jsonl("cx.jsonl", [
    { type: "session_meta", payload: { session_id: "cx1", cwd: "/code/app" } },
    { type: "event_msg", payload: { type: "user_message" } },
    // token_count carries a running total; summing snapshots would multiply it
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 40 } },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 250, output_tokens: 90 } },
      },
    },
  ]);
  const u = parserFor("codex")(file, 0)!;
  assert.equal(u.turns, 1);
  assert.equal(u.inputTokens, 250, "must take the last total, not the sum");
  assert.equal(u.outputTokens, 90);
  assert.equal(u.cwd, "/code/app");
});

test("codex: the model comes from turn_context, not session_meta", () => {
  // Current rollouts put model_provider on session_meta and the actual model
  // on turn_context. Reading only session_meta left every Codex session
  // unattributed, so its tokens counted but no model ever appeared.
  const file = jsonl("cx-model.jsonl", [
    {
      type: "session_meta",
      payload: { session_id: "cx2", cwd: "/code/app", model_provider: "openai" },
    },
    { type: "turn_context", payload: { cwd: "/code/app", model: "gpt-5.6-sol" } },
    { type: "event_msg", payload: { type: "user_message" } },
  ]);
  assert.equal(parserFor("codex")(file, 0)!.model, "gpt-5.6-sol");
});

test("codex: an older rollout with the model on session_meta still works", () => {
  const file = jsonl("cx-legacy.jsonl", [
    { type: "session_meta", payload: { session_id: "cx3", model: "gpt-5.1" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
  ]);
  assert.equal(
    parserFor("codex")(file, 0)!.model,
    "gpt-5.1",
    "session_meta wins when both are present — it names the session"
  );
});

/* ------- kimi ------- */

test("kimi: turn.prompt counts, usage.record accumulates", () => {
  const file = jsonl("wd_demo_0123456789ab/session_abc/agents/main/wire.jsonl", [
    { type: "turn.prompt" },
    { type: "usage.record", usage: { inputOther: 10, output: 4, inputCacheRead: 2 } },
    { type: "turn.prompt" },
    { type: "usage.record", usage: { inputOther: 30, output: 6, inputCacheCreation: 1 } },
  ]);
  const u = parserFor("kimi")(file, 0)!;
  assert.equal(u.turns, 2);
  assert.equal(u.inputTokens, 40);
  assert.equal(u.outputTokens, 10);
  assert.equal(u.sessionId, "abc");
  assert.equal(u.workspaceHash, "0123456789ab");
});

test("kimi workspace hash is read from the directory name", () => {
  assert.equal(
    kimiWorkspaceHash("/x/sessions/wd_shiloah_aa4d0bb6144a/session_1/w.jsonl"),
    "aa4d0bb6144a"
  );
  assert.equal(kimiWorkspaceHash("/x/sessions/plain/session_1/w.jsonl"), null);
});

/* ------- incremental scanning ------- */

test("re-scanning from a watermark does not double-count", () => {
  const records = [
    { type: "user", sessionId: "s", cwd: "/c", message: { content: "one" } },
    { type: "assistant", message: { usage: ccUsage(100, 10) } },
  ];
  const file = jsonl("incr.jsonl", records);
  const first = parserFor("claude-code")(file, 0)!;
  assert.equal(first.turns, 1);
  assert.equal(first.inputTokens, 100);

  // the session keeps running and appends more
  fs.appendFileSync(
    file,
    JSON.stringify({ type: "user", message: { content: "two" } }) +
      "\n" +
      JSON.stringify({ type: "assistant", message: { usage: ccUsage(70, 5) } }) +
      "\n"
  );

  const second = parserFor("claude-code")(file, first.lines)!;
  assert.equal(second.turns, 1, "only the newly appended turn");
  assert.equal(second.inputTokens, 70, "only the newly appended tokens");
});

test("a partially written line is skipped, not fatal", () => {
  const file = path.join(tmp, "partial.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "user", sessionId: "s", cwd: "/c", message: { content: "hi" } }) +
      "\n" +
      '{"type":"assistant","message":{"usage":{"input_tok'
  );
  const u = parserFor("claude-code")(file, 0)!;
  assert.equal(u.turns, 1);
  assert.equal(u.inputTokens, 0);
});

/* ------- session dedup ------- */

const usage = (o: Partial<SessionUsage>): SessionUsage => ({
  tool: "claude-code",
  sessionId: "s",
  cwd: "/c",
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turns: 0,
  startedAtMs: null,
  endedAtMs: null,
  activity: [],
  lines: 0,
  mtimeMs: 0,
  file: "f",
  ...o,
});

test("a resumed session collapses to its most complete transcript", () => {
  // Claude Code replays history into each new file, so these are supersets,
  // not separate work. Summing them inflated one real session by 21x.
  const replays = [
    usage({ file: "a", lines: 7, turns: 1, inputTokens: 100 }),
    usage({ file: "b", lines: 812, turns: 1, inputTokens: 9_000 }),
    usage({ file: "c", lines: 6827, turns: 399, inputTokens: 745_000 }),
  ];
  const [only] = groupBySession(replays);
  assert.equal(groupBySession(replays).length, 1);
  assert.equal(only.inputTokens, 745_000, "must take the largest, not the sum");
  assert.equal(only.turns, 399);
});

test("ties are broken by recency", () => {
  const [only] = groupBySession([
    usage({ file: "old", lines: 10, mtimeMs: 1, inputTokens: 5 }),
    usage({ file: "new", lines: 10, mtimeMs: 2, inputTokens: 9 }),
  ]);
  assert.equal(only.file, "new");
});

test("different sessions and different tools stay separate", () => {
  const out = groupBySession([
    usage({ sessionId: "a", lines: 5 }),
    usage({ sessionId: "b", lines: 5 }),
    usage({ sessionId: "a", tool: "codex", lines: 5 }),
  ]);
  assert.equal(out.length, 3, "a codex session must not collapse into claude");
});

test("codex: a continuing session keeps its model past the watermark", () => {
  // turn_context sits near the top of the rollout, so an incremental re-read
  // starts past it. Without the remembered model, every scan after the first
  // would report the session as unattributed.
  const file = jsonl("cx-resume.jsonl", [
    { type: "session_meta", payload: { session_id: "cx4", cwd: "/code/app" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    { type: "event_msg", payload: { type: "user_message" } },
    { type: "event_msg", payload: { type: "user_message" } },
  ]);
  const first = parserFor("codex")(file, 0)!;
  assert.equal(first.model, "gpt-5.6-sol");

  // Re-read from a watermark past the header: the parser alone cannot see it.
  const resumed = parserFor("codex")(file, 2)!;
  assert.equal(resumed.model, null, "the header is genuinely out of range");
  assert.equal(resumed.turns, 2, "but the later turns are still counted");
});
