import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConductorRows } from "./hostSessions";

test("Conductor adapter reads only session metadata and maps the underlying tool", () => {
  const secret = "do not read this prompt";
  const usages = parseConductorRows([
    {
      sessionId: "claude-session",
      agentType: "claude",
      model: "opus",
      workspace: "/code/shottracker",
      timestamps: [
        Date.parse("2026-08-09T14:00:00.000Z"),
        Date.parse("2026-08-09T14:10:00.000Z"),
      ],
      humanTurns: 1,
    },
    {
      sessionId: "codex-session",
      agentType: "codex",
      model: "gpt-5.6-sol",
      workspace: "/code/pulse-plus",
      timestamps: [Date.parse("2026-08-09T15:00:00.000Z")],
      humanTurns: 1,
    },
    {
      sessionId: "unknown-session",
      agentType: "other",
      model: "mystery-model",
      workspace: secret,
      timestamps: [Date.parse("2026-08-09T15:01:00.000Z")],
      humanTurns: 1,
    },
  ]);

  assert.equal(usages.length, 2);
  assert.deepEqual(
    usages.map((usage) => [usage.tool, usage.sessionId, usage.turns]),
    [
      ["claude-code", "conductor:claude-session", 1],
      ["codex", "conductor:codex-session", 1],
    ]
  );
  assert.equal(usages[0].inputTokens, 0);
  assert.equal(usages[0].activity.reduce((sum, bucket) => sum + bucket.seconds, 0), 600);
  assert.ok(!JSON.stringify(usages).includes(secret));
});
