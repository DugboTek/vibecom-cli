import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { appServerSessionUsages } from "./appServerBridge";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-app-server-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("Codex app-server snapshots keep the latest documented total and no message text", () => {
  const file = path.join(dir, "usage.jsonl");
  fs.writeFileSync(
    file,
    [
      {
        version: 1,
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        cwd: "/private/project",
        model: "gpt-5.6",
        timestamp: 1_000,
        inputTokens: 20,
        outputTokens: 3,
        cacheReadTokens: 80,
        cacheCreationTokens: 2,
        prompt: "must never survive parsing",
      },
      {
        version: 1,
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-2",
        cwd: "/private/project",
        model: "gpt-5.6",
        timestamp: 2_000,
        inputTokens: 30,
        outputTokens: 5,
        cacheReadTokens: 90,
        cacheCreationTokens: 4,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
  const [usage] = appServerSessionUsages(file);
  assert.equal(usage.tool, "codex");
  assert.equal(usage.sessionId, "thread-1");
  assert.equal(usage.inputTokens, 30);
  assert.equal(usage.cacheReadTokens, 90);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.turns, 2);
  assert.equal(usage.startedAtMs, 1_000);
  assert.equal(usage.endedAtMs, 2_000);
  assert.doesNotMatch(JSON.stringify(usage), /must never survive parsing/);
});
