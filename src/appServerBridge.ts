import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { priceUsage, totalTokens } from "./pricing";
import {
  activityFromTimestamps,
  type SessionUsage,
} from "./transcripts";

type Json = Record<string, unknown>;

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export const appServerUsagePath = (home = os.homedir()): string =>
  path.join(home, ".config", "vibecom", "app-server-usage.jsonl");

type UsageRecord = {
  version: 1;
  provider: "codex";
  threadId: string;
  turnId: string | null;
  cwd: string | null;
  model: string | null;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

function safelyAppend(record: UsageRecord, file = appServerUsagePath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    /* Tracking must never interrupt the app-server protocol. */
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseUsage(
  message: Json,
  contexts: Map<string, { cwd: string | null; model: string | null }>
): UsageRecord | null {
  if (message.method !== "thread/tokenUsage/updated") return null;
  const params = message.params as Json | undefined;
  if (!params) return null;
  const threadId = asString(params.threadId);
  if (!threadId) return null;
  const tokenUsage = params.tokenUsage as Json | undefined;
  const total = tokenUsage?.total as Json | undefined;
  if (!total) return null;
  const wholeInput = number(total.inputTokens);
  const cacheReadTokens = Math.min(number(total.cachedInputTokens), wholeInput);
  const context = contexts.get(threadId);
  return {
    version: 1,
    provider: "codex",
    threadId,
    turnId: asString(params.turnId),
    cwd: context?.cwd ?? null,
    model: context?.model ?? null,
    timestamp: Date.now(),
    inputTokens: wholeInput - cacheReadTokens,
    outputTokens: number(total.outputTokens),
    cacheReadTokens,
    cacheCreationTokens: number(total.cacheWriteInputTokens),
  };
}

/**
 * Proxy a Codex app-server without changing a byte of its JSON-RPC traffic.
 * It examines only the documented `thread/tokenUsage/updated` notification
 * and the thread's cwd/model metadata, then persists a derived numeric
 * snapshot. Prompts, tool calls, and model messages pass through untouched and
 * are never written to the Vibecom log.
 */
export function runCodexAppServerProxy(real: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(real, args, { stdio: ["pipe", "pipe", "pipe"] });
    const requestContexts = new Map<string, { cwd: string | null; model: string | null }>();
    const threadContexts = new Map<string, { cwd: string | null; model: string | null }>();
    let inputRemainder = "";
    let outputRemainder = "";

    const inspectInput = (chunk: Buffer) => {
      inputRemainder += chunk.toString("utf8");
      const lines = inputRemainder.split("\n");
      inputRemainder = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Json;
          if (message.method !== "thread/start" && message.method !== "thread/resume") continue;
          const params = message.params as Json | undefined;
          const context = {
            cwd: asString(params?.cwd),
            model: asString(params?.model),
          };
          const knownThread = asString(params?.threadId);
          if (knownThread) threadContexts.set(knownThread, context);
          if (message.id !== undefined) requestContexts.set(String(message.id), context);
        } catch {
          // Partial/malformed input remains the provider's concern, not ours.
        }
      }
    };

    const inspectOutput = (chunk: Buffer) => {
      outputRemainder += chunk.toString("utf8");
      const lines = outputRemainder.split("\n");
      outputRemainder = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Json;
          const result = message.result as Json | undefined;
          const resultThread = result?.thread as Json | undefined;
          const openedThread = asString(resultThread?.id) ?? asString(result?.id);
          if (openedThread && message.id !== undefined) {
            const context = requestContexts.get(String(message.id));
            if (context) threadContexts.set(openedThread, context);
          }
          const usage = parseUsage(message, threadContexts);
          if (usage) safelyAppend(usage);
        } catch {
          // Never let a telemetry parse failure affect the proxied protocol.
        }
      }
    };

    process.stdin.on("data", inspectInput);
    process.stdin.pipe(child.stdin);
    child.stdout.on("data", (chunk: Buffer) => {
      inspectOutput(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Read back only the numeric snapshots created by the bridge. */
export function appServerSessionUsages(
  file = appServerUsagePath()
): SessionUsage[] {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const grouped = new Map<string, { latest: UsageRecord; timestamps: number[]; turns: Set<string> }>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as UsageRecord;
      if (record.version !== 1 || record.provider !== "codex" || !record.threadId) continue;
      const current = grouped.get(record.threadId);
      if (!current) {
        grouped.set(record.threadId, {
          latest: record,
          timestamps: [record.timestamp],
          turns: new Set(record.turnId ? [record.turnId] : []),
        });
      } else {
        current.timestamps.push(record.timestamp);
        if (record.turnId) current.turns.add(record.turnId);
        if (record.timestamp >= current.latest.timestamp) current.latest = record;
      }
    } catch {
      // A partially appended live line will be complete on the next scan.
    }
  }
  return [...grouped.values()].map(({ latest, timestamps, turns }) => {
    const price = priceUsage(latest.model, {
      inputTokens: latest.inputTokens,
      outputTokens: latest.outputTokens,
      cacheReadTokens: latest.cacheReadTokens,
      cacheWrite5mTokens: latest.cacheCreationTokens,
      cacheWrite1hTokens: 0,
    }, false);
    return {
      tool: "codex",
      sessionId: latest.threadId,
      cwd: latest.cwd,
      model: latest.model,
      inputTokens: latest.inputTokens,
      outputTokens: latest.outputTokens,
      cacheReadTokens: latest.cacheReadTokens,
      cacheCreationTokens: latest.cacheCreationTokens,
      costUsd: price ?? 0,
      unpricedTokens: price === null
        ? totalTokens({
            inputTokens: latest.inputTokens,
            outputTokens: latest.outputTokens,
            cacheReadTokens: latest.cacheReadTokens,
            cacheWrite5mTokens: latest.cacheCreationTokens,
            cacheWrite1hTokens: 0,
          })
        : 0,
      turns: turns.size,
      startedAtMs: Math.min(...timestamps),
      endedAtMs: Math.max(...timestamps),
      activity: activityFromTimestamps(timestamps),
      lines: timestamps.length,
      mtimeMs,
      file,
    };
  });
}
