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

test("claude code: cost is derived per message from the model that served it", () => {
  /* Transcripts carry no cost field — only usage and a model — so the figure
     is computed from list prices. Pricing per message rather than per session
     is what keeps a session that switched models from billing all of its
     tokens at whichever model happened to speak first. */
  const file = jsonl("cc-cost.jsonl", [
    { type: "user", sessionId: "s-cost", cwd: "/code/app", message: { content: SECRET } },
    {
      type: "assistant",
      message: {
        model: "claude-opus-5", // $5/M in, $25/M out
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-haiku-4-5", // $1/M in, $5/M out
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      },
    },
  ]);
  const u = parserFor("claude-code")(file, 0)!;
  assert.equal(u.costUsd, 36, "30 at Opus rates plus 6 at Haiku rates");
  assert.equal(u.unpricedTokens, 0);
});

test("claude code: cache writes are billed by their TTL", () => {
  const file = jsonl("cc-ttl.jsonl", [
    { type: "user", sessionId: "s-ttl", cwd: "/code/app", message: { content: SECRET } },
    {
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: {
          cache_creation_input_tokens: 1_000_000,
          cache_creation: {
            ephemeral_1h_input_tokens: 1_000_000,
            ephemeral_5m_input_tokens: 0,
          },
        },
      },
    },
  ]);
  const u = parserFor("claude-code")(file, 0)!;
  // The hour tier is 2x input, against 1.25x for five minutes.
  assert.equal(u.costUsd, 10);
  assert.equal(u.cacheCreationTokens, 1_000_000, "the wire total is unchanged");
});

test("claude code: a record without the TTL breakdown still prices its writes", () => {
  // Older records state only the total. Taking the remainder as five-minute
  // conserves it rather than silently dropping the tokens from the bill.
  const file = jsonl("cc-nottl.jsonl", [
    { type: "user", sessionId: "s-nottl", cwd: "/code/app", message: { content: SECRET } },
    {
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { cache_creation_input_tokens: 1_000_000 },
      },
    },
  ]);
  assert.equal(parserFor("claude-code")(file, 0)!.costUsd, 6.25);
});

test("claude code: an unrated model is counted, not quietly priced at zero", () => {
  const file = jsonl("cc-unrated.jsonl", [
    { type: "user", sessionId: "s-un", cwd: "/code/app", message: { content: SECRET } },
    {
      type: "assistant",
      message: {
        model: "claude-something-unreleased",
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { output_tokens: 1_000_000 },
      },
    },
  ]);
  const u = parserFor("claude-code")(file, 0)!;
  assert.equal(u.costUsd, 25, "the rated message still bills normally");
  assert.equal(u.unpricedTokens, 35, "and the unrated one is reported as a gap");
});

test("claude code: synthetic messages are free without denting coverage", () => {
  const file = jsonl("cc-synth.jsonl", [
    { type: "user", sessionId: "s-syn", cwd: "/code/app", message: { content: SECRET } },
    {
      type: "assistant",
      message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } },
    },
  ]);
  const u = parserFor("claude-code")(file, 0)!;
  assert.equal(u.costUsd, 0);
  assert.equal(u.unpricedTokens, 0, "never billable, so not a pricing gap");
  assert.deepEqual(u.modelUsage, [], "a zero-token synthetic is not a model used");
});

test("claude code: re-parsing a transcript yields the same cost", () => {
  /* `vibecom rescan` restates each session in full and the server replaces the
     prior copy. That only converges if parsing is deterministic — a cost that
     drifted between scans would silently rewrite history on every run. */
  const file = jsonl("cc-idem.jsonl", [
    { type: "user", sessionId: "s-idem", cwd: "/code/app", message: { content: SECRET } },
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 1_234,
          output_tokens: 567,
          cache_read_input_tokens: 89,
          cache_creation_input_tokens: 42,
        },
      },
    },
  ]);
  const first = parserFor("claude-code")(file, 0)!;
  const second = parserFor("claude-code")(file, 0)!;
  assert.ok(first.costUsd > 0, "the fixture actually prices to something");
  assert.equal(first.costUsd, second.costUsd);
  assert.equal(first.unpricedTokens, second.unpricedTokens);
});

test("claude code: streamed content blocks count one API message once", () => {
  const file = jsonl("cc-stream.jsonl", [
    {
      type: "user",
      uuid: "turn-1",
      sessionId: "s-stream",
      cwd: "/code/app",
      message: { content: "go" },
    },
    {
      type: "assistant",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        usage: ccUsage(100, 5),
      },
    },
    {
      type: "assistant",
      message: {
        id: "msg-1",
        model: "claude-opus-5",
        usage: ccUsage(100, 12),
      },
    },
  ]);
  const parsed = parserFor("claude-code")(file, 0)!;
  assert.equal(parsed.inputTokens, 100, "invariant input is not repeated");
  assert.equal(parsed.outputTokens, 12, "the final streamed output wins");
  assert.equal(parsed.cacheReadTokens, 5);
});

test("claude code: resumes dedupe replays while child-agent messages remain", () => {
  const first = jsonl("cc-tree/first.jsonl", [
    {
      type: "user",
      uuid: "human-1",
      sessionId: "tree",
      cwd: "/code/app",
      message: { content: "build" },
    },
    {
      type: "assistant",
      sessionId: "tree",
      message: { id: "m1", model: "claude-opus-5", usage: ccUsage(100, 5) },
    },
  ]);
  const resumed = jsonl("cc-tree/resumed.jsonl", [
    {
      type: "user",
      uuid: "human-1",
      sessionId: "tree",
      cwd: "/code/app",
      message: { content: "build" },
    },
    {
      type: "assistant",
      sessionId: "tree",
      message: { id: "m1", model: "claude-opus-5", usage: ccUsage(100, 9) },
    },
    {
      type: "assistant",
      sessionId: "tree",
      message: { id: "m2", model: "claude-haiku-4-5", usage: ccUsage(40, 3) },
    },
  ]);
  const child = jsonl("cc-tree/subagent.jsonl", [
    {
      type: "user",
      uuid: "agent-prompt",
      sessionId: "tree",
      cwd: "/code/app",
      agentId: "agent-1",
      isSidechain: true,
      message: { content: "research" },
    },
    {
      type: "assistant",
      sessionId: "tree",
      agentId: "agent-1",
      isSidechain: true,
      message: { id: "m3", model: "claude-opus-5", usage: ccUsage(60, 4) },
    },
  ]);

  const [merged] = groupBySession(
    [first, resumed, child].map((file) => parserFor("claude-code")(file, 0)!)
  );
  assert.equal(merged.turns, 1, "replayed and agent prompts are not human turns");
  assert.equal(merged.inputTokens, 200, "m1 + m2 + child m3 exactly once");
  assert.equal(merged.outputTokens, 16);
  assert.deepEqual(
    merged.modelUsage?.map((slice) => [slice.model, slice.inputTokens]),
    [
      ["claude-opus-5", 160],
      ["claude-haiku-4-5", 40],
    ]
  );
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

test("codex: cached input is subtracted from the input total, not added to it", () => {
  /* `input_tokens` is the whole input and `cached_input_tokens` is a subset of
     it — the transcript's own `total_tokens` equals input plus output.
     Treating them as siblings counted every cached token twice; on one real
     machine that turned 8.5M fresh input tokens into 1.09B reported. */
  const file = jsonl("cx-cached.jsonl", [
    { type: "session_meta", payload: { session_id: "cx-c", cwd: "/code/app" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 900,
            cache_write_input_tokens: 20,
            output_tokens: 100,
            total_tokens: 1_100,
          },
        },
      },
    },
  ]);
  const u = parserFor("codex")(file, 0)!;
  assert.equal(u.inputTokens, 100, "fresh input only");
  assert.equal(u.cacheReadTokens, 900);
  assert.equal(u.cacheCreationTokens, 20);
  assert.equal(
    u.inputTokens + u.cacheReadTokens + u.outputTokens,
    1_100,
    "reconstructs the transcript's own total_tokens"
  );
});

test("codex: cost is derived from the session totals", () => {
  const file = jsonl("cx-cost.jsonl", [
    { type: "session_meta", payload: { session_id: "cx-p", cwd: "/code/app" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
        },
      },
    },
  ]);
  const u = parserFor("codex")(file, 0)!;
  // Current gpt-5.6-sol is $4/M in, $20/M out. These are session totals.
  assert.equal(u.costUsd, 24);
  assert.equal(u.unpricedTokens, 0);
});

test("codex: an unrated model reports tokens as unpriced, never as $0", () => {
  const file = jsonl("cx-unrated.jsonl", [
    { type: "session_meta", payload: { session_id: "cx-u", cwd: "/code/app" } },
    { type: "turn_context", payload: { model: "gpt-5.3-codex-spark" } },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 500,
            cached_input_tokens: 100,
            output_tokens: 200,
          },
        },
      },
    },
  ]);
  const u = parserFor("codex")(file, 0)!;
  assert.equal(u.costUsd, 0);
  assert.equal(
    u.unpricedTokens,
    700,
    "400 fresh input + 100 cache read + 200 output"
  );
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
  ]);
  assert.equal(
    parserFor("codex")(file, 0)!.model,
    "gpt-5.1",
    "session_meta is the fallback when turn_context is absent"
  );
});

test("codex: repeated cumulative tuples are ignored and resets are new requests", () => {
  const tokenCount = (total: number, last: number) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total },
        last_token_usage: { input_tokens: last },
      },
    },
  });
  const file = jsonl("cx-requests.jsonl", [
    { type: "session_meta", payload: { session_id: "cx-requests" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    tokenCount(100, 100),
    tokenCount(100, 100),
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    tokenCount(100, 100),
    tokenCount(40, 40),
  ]);
  const parsed = parserFor("codex")(file, 0)!;
  assert.equal(parsed.inputTokens, 140);
  assert.deepEqual(
    parsed.modelUsage?.map((slice) => [slice.model, slice.inputTokens]),
    [
      ["gpt-5.6-sol", 100],
      ["gpt-5.6-terra", 40],
    ],
    "an unchanged replay after a model switch does not move the prior request"
  );
});

test("codex: long-context pricing is decided per request, not per session", () => {
  const file = jsonl("cx-context-price.jsonl", [
    { type: "session_meta", payload: { session_id: "cx-context" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 150_000 },
          last_token_usage: { input_tokens: 150_000 },
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 300_000 },
          last_token_usage: { input_tokens: 150_000 },
        },
      },
    },
  ]);
  const parsed = parserFor("codex")(file, 0)!;
  assert.equal(parsed.inputTokens, 300_000);
  assert.equal(parsed.costUsd, 1.2, "two 150K requests remain at the base rate");
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

test("kimi: every agent wire contributes usage but only main prompts are turns", () => {
  const main = jsonl(
    "wd_tree_0123456789ab/session_tree/agents/main/wire.jsonl",
    [
      { type: "turn.prompt" },
      { type: "usage.record", model: "kimi-code/k3", usage: { inputOther: 10 } },
    ]
  );
  const child = jsonl(
    "wd_tree_0123456789ab/session_tree/agents/child-1/wire.jsonl",
    [
      { type: "turn.prompt" },
      { type: "usage.record", model: "kimi-code/k3", usage: { inputOther: 20 } },
    ]
  );
  const [merged] = groupBySession(
    [main, child].map((file) => parserFor("kimi")(file, 0)!)
  );
  assert.equal(merged.turns, 1);
  assert.equal(merged.inputTokens, 30);
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
  unpricedTokens: 0,
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
