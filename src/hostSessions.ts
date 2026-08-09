import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appServerSessionUsages } from "./appServerBridge";
import { activityFromTimestamps, type SessionUsage, type Tool } from "./transcripts";

/**
 * Session-host adapters.
 *
 * Some desktop products host Codex or Claude themselves instead of letting the
 * underlying CLI write its normal transcript archive. An adapter may read only
 * metadata the host exposes: session identity, provider/model, workspace,
 * timestamps, and a count of human turns. It must never select message text.
 *
 * Token and cost counters remain zero unless the host exposes actual counters.
 * Estimating them from chat text would be inaccurate and violate COLLECTION.md.
 */

type ConductorRow = {
  sessionId: string;
  agentType: string;
  model: string;
  workspace: string;
  timestamps: number[];
  humanTurns: number;
};

const conductorDb = () =>
  process.env.VIBECOM_CONDUCTOR_DB ||
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.conductor.app",
    "conductor.db"
  );

/** A narrow metadata-only query. `content` and `full_message` never appear. */
const CONDUCTOR_QUERY = `
  SELECT
    s.id,
    COALESCE(s.agent_type, ''),
    COALESCE(s.model, ''),
    COALESCE(NULLIF(w.workspace_path, ''), NULLIF(r.root_path, ''), ''),
    GROUP_CONCAT(COALESCE(
      strftime('%Y-%m-%dT%H:%M:%fZ', m.sent_at),
      strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at),
      strftime('%Y-%m-%dT%H:%M:%fZ', s.updated_at)
    ), ','),
    SUM(CASE WHEN m.role = 'user' AND m.cancelled_at IS NULL THEN 1 ELSE 0 END)
  FROM sessions AS s
  LEFT JOIN workspaces AS w ON w.id = s.workspace_id
  LEFT JOIN repos AS r ON r.id = w.repository_id
  LEFT JOIN session_messages AS m ON m.session_id = s.id
  WHERE COALESCE(s.is_hidden, 0) = 0
  GROUP BY s.id
  ORDER BY s.id
`;

function underlyingTool(agentType: string, model: string): Tool | null {
  const agent = agentType.toLowerCase();
  const namedModel = model.toLowerCase();
  if (agent === "claude" || /claude|opus|sonnet|haiku/.test(namedModel)) {
    return "claude-code";
  }
  if (agent === "codex" || /codex|gpt-|^o[1-9](?:$|[-_])/.test(namedModel)) {
    return "codex";
  }
  /* A host that names neither provider is ignored, not misattributed. Adding
     a provider is a small adapter change once its own metadata contract is
     known; it is never guessed from message content. */
  return null;
}

export function parseConductorRows(
  rows: readonly ConductorRow[],
  file = "host:conductor"
): SessionUsage[] {
  const sessions = new Map<string, SessionUsage & { timestamps: number[] }>();

  for (const row of rows) {
    const tool = underlyingTool(row.agentType, row.model);
    if (!tool || !row.sessionId) continue;
    const key = `${tool}:${row.sessionId}`;
    let usage = sessions.get(key);
    if (!usage) {
      usage = {
        tool,
        /* Namespace the host ID so it cannot collide with a direct transcript
           for the same provider. */
        sessionId: `conductor:${row.sessionId}`,
        cwd: row.workspace || null,
        model: row.model || null,
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
        file: `${file}:${row.sessionId}`,
        timestamps: [],
      };
      sessions.set(key, usage);
    }
    usage.lines += 1;
    usage.turns += row.humanTurns;
    for (const timestamp of row.timestamps) {
      usage.timestamps.push(timestamp);
      usage.mtimeMs = Math.max(usage.mtimeMs, timestamp);
    }
  }

  return [...sessions.values()].map(({ timestamps, ...usage }) => {
    const ordered = [...new Set(timestamps)].sort((a, b) => a - b);
    const fallback = usage.mtimeMs || Date.now();
    usage.startedAtMs = ordered[0] ?? fallback;
    usage.endedAtMs = ordered.at(-1) ?? fallback;
    usage.mtimeMs = usage.endedAtMs;
    usage.activity = activityFromTimestamps(ordered);
    return usage;
  });
}

function parseTsv(raw: string): ConductorRow[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((cells) => cells.length >= 6)
    .map(([sessionId, agentType, model, workspace, timestamps, humanTurns]) => ({
      sessionId,
      agentType,
      model,
      workspace,
      timestamps: timestamps
        .split(",")
        .map((timestamp) => Date.parse(timestamp))
        .filter((timestamp) => Number.isFinite(timestamp)),
      humanTurns: Number(humanTurns) || 0,
    }));
}

/** Read Conductor's metadata through SQLite in read-only mode when installed. */
export function hostedSessionUsages(): SessionUsage[] {
  const appServer = appServerSessionUsages();
  const database = conductorDb();
  if (!fs.existsSync(database)) return appServer;
  try {
    const output = execFileSync(
      "/usr/bin/sqlite3",
      ["-readonly", "-noheader", "-separator", "\t", database, CONDUCTOR_QUERY],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        /* A long-lived chat can have several megabytes of timestamp rows. The
           Node default is 1 MiB, which silently made a healthy Conductor DB
           look empty once someone had actually used it. This remains bounded
           and carries metadata only. */
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15_000,
      }
    );
    return [
      ...appServer,
      ...parseConductorRows(parseTsv(output), `host:conductor:${database}`),
    ];
  } catch {
    /* A host may be upgrading or have a locked/missing schema. It must never
       prevent direct Codex/Claude archives from being scanned. */
    return appServer;
  }
}
