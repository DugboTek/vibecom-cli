<div align="center">

<pre>
██╗   ██╗██╗██████╗ ███████╗ ██████╗ ██████╗ ███╗   ███╗
██║   ██║██║██╔══██╗██╔════╝██╔════╝██╔═══██╗████╗ ████║
██║   ██║██║██████╔╝█████╗  ██║     ██║   ██║██╔████╔██║
╚██╗ ██╔╝██║██╔══██╗██╔══╝  ██║     ██║   ██║██║╚██╔╝██║
 ╚████╔╝ ██║██████╔╝███████╗╚██████╗╚██████╔╝██║ ╚═╝ ██║
  ╚═══╝  ╚═╝╚═════╝ ╚══════╝ ╚═════╝ ╚═════╝ ╚═╝     ╚═╝
</pre>

**The command-line collector for [vibecom](https://vibecom.build) — the community for AI builders.**

It reads the session transcripts your coding tools already write to disk,
adds up the numbers, and sends counters. Nothing else.

Automatic collection syncs at most once a day so the database can sleep between
uploads. `vibecom scan` refreshes immediately. The collector disables its own
continuous Claude/Codex exporters and keeps their credentials for archive uploads;
already running tool sessions pick up this change on their next restart.

[![ci](https://github.com/DugboTek/vibecom-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/DugboTek/vibecom-cli/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)
[![reproducible build](https://img.shields.io/badge/build-reproducible-brightgreen)](#reproduce-the-bundle-you-are-running)
[![collected](https://img.shields.io/badge/collected-10%20fields-orange)](./COLLECTION.md)

[What it collects](./COLLECTION.md) · [Install](#install) · [Commands](#commands) ·
[Verify it yourself](#verify-it-yourself) · [How it works](#how-it-works)

</div>

---

> [!NOTE]
> This repository is published automatically from `cli/` in the vibecom
> application repo. The CLI and the server share a wire protocol — a new field
> changes the sender and the receiver in one commit — so they are developed
> together and mirrored here on every merge. **Issues and pull requests are
> welcome; a PR against this repo will be applied upstream rather than merged
> here, since this branch is replaced on each publish.**

## Why this repo is public

Telemetry tools ask for a lot of trust. This one reads your coding sessions, so
"trust us" is not good enough — you should be able to check.

**[COLLECTION.md](./COLLECTION.md) is the complete list of what leaves your
machine.** Ten fields. It is not maintained by good intentions: a test parses the
real sending function and **fails the build** if the code ever puts a field on
the wire that the document does not list — or if the document claims one the
code never sends.

> [!IMPORTANT]
> Installing and signing in collect nothing. Guided setup recommends only
> personal repositories it can identify safely. Collection begins only after
> you confirm, and applies only to those repositories.

---

## Install

```bash
npm install --global vibecom-cli
vibecom
```

Or use the one-line installer:

```bash
curl -fsSL https://vibecom.build/setup.sh | bash
```

---

## See the work, not just the counter

The CLI gives your existing coding activity a public, verified home: a live
podium for the builders currently shipping.

<p align="center">
  <strong>Live weekly podium</strong><br/><br/>
  <a href="https://www.vibecom.build/"><img src="https://www.vibecom.build/leaderboard/opengraph-image?v=podium-v2" alt="vibecom weekly builder leaderboard podium" width="100%" /></a>
</p>

<p align="center"><a href="https://www.vibecom.build/">See the live leaderboard</a> · <a href="https://www.vibecom.build/cli">How the collector works</a></p>

<details>
<summary><b>Rather not pipe a script into bash?</b></summary>

<br>

Build from this source and install the binary yourself:

```bash
git clone https://github.com/DugboTek/vibecom-cli
cd vibecom-cli
npm install
npm run build
install -m 755 dist/cli.js ~/.local/bin/vibecom
```

Or read the installer first — it is a plain shell script:

```bash
curl -fsSL https://vibecom.build/setup.sh | less
```

</details>

---

## Commands

Run `vibecom` with no arguments and it walks you through everything.

```
─ just run this ────────────────────────────────────────────
  │  vibecom         sign in, connect projects, change anything

─ or jump straight to one ──────────────────────────────────
  │  login           sign in only
  │  link [dir]      connect projects under a directory
  │  preview         show exactly what leaves this repo
  │  status          linked projects and trusted owners
  │  sync            cover worktrees created since linking
  │  scan            import usage from running + past sessions
  │  update          pull the newest CLI from your server
  │  unlink          stop collecting from this repo
  │  trust <owner>   allow repos under an org you control
  │  logout          remove stored credentials

─ tiers ────────────────────────────────────────────────────
  │  ●○○  counters — tokens, cost, lines, turns per session
  │  ●●○  session shape — tool categories, rework ratio
  │  ●●●  named stack — tool, MCP, and skill names

  Nothing is collected until you connect a repository.
```

The one to run first is **`vibecom preview`** — it prints the exact JSON that
would be sent for the current repository, the tier it is linked at, and the
policy the server will enforce. No guessing.

---

## Verify it yourself

### The two tests that matter

```bash
npm test
```

**`transcripts.test.ts` → "no transcript content survives parsing, from any
tool"** plants a secret string in a fixture transcript for every supported tool,
parses it, serialises the result, and fails if that string appears anywhere in
the output. It is the structural proof that the parsers cannot exfiltrate your
code or your prompts.

**`collection.test.ts`** parses the real `sendScanned()` and diffs it against
[COLLECTION.md](./COLLECTION.md) in both directions, so the document cannot
drift away from the code.

### Reproduce the bundle you are running

The build is byte-reproducible. `vibecom --version` prints both the release and
the build stamp baked into your installed copy — for example
`vibecom 1.0.0 (build 2026-08-03T21:00:00Z)`. Check out that release and pass the
stamp back in, and you get that exact artifact:

```bash
git checkout cli-v1.0.0   # the release your copy reports
VIBECOM_BUILD_STAMP=$(vibecom --version | grep -oE '[0-9-]{10}T[0-9:]{8}Z') npm run build
shasum -a 256 dist/cli.js
curl -fsSL https://vibecom.build/cli.js | shasum -a 256
```

Matching hashes mean the binary you are running was built from this source, with
nothing slipped in on the way. CI re-proves reproducibility on every commit, so
the claim cannot quietly rot.

---

## How it works

### Your repository path is never sent

Projects are identified by a salted hash, truncated to 32 characters:

```
projectId = sha256("<machine-local-salt>:<repo-root-path>").slice(0, 32)
```

The salt is generated once per machine and **never leaves it**. A global salt
would be reversible by anyone who could guess a path like
`/Users/alice/work/secret-startup`; a per-machine salt makes the hash meaningless
to everyone else, including us. The friendly label you see in Settings is one you
typed yourself at `link` time.

### The server does not trust this CLI

Consent tiers are bound to the token when you link, and enforced **server-side on
every request**. A tampered or out-of-date CLI cannot widen its own scope — rows
outside the token's tier are dropped before they are stored.

### Account tokens cannot send telemetry

`vibecom login` alone is not enough to ingest anything. The account token exists
only to mint project tokens; the ingest endpoints reject it with `403`. That is
what makes per-project consent meaningful rather than decorative.

### Never collected

There is no code path that reads any of these:

| | |
|---|---|
| ✗ Source code or diffs | ✗ Prompts or model responses |
| ✗ File paths or names | ✗ Repository contents |
| ✗ Shell commands or output | ✗ Environment variables or secrets |

---

## Supported tools

Each tool has its own parser in [`src/transcripts.ts`](./src/transcripts.ts) —
the most useful file to read if you want to know exactly what is pulled off disk.

| Tool | Read from |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex | `~/.codex/sessions/**/*.jsonl` |
| Kimi | `~/.kimi/**/wire.jsonl` |
| OpenCode | OTLP export |

### Historical Claude Code activity

`vibecom rescan` can import only the Claude Code transcripts that are still on
your machine. It does not fetch conversation history from your Anthropic
account, and it cannot include Claude web or desktop activity.

Claude Code keeps its local transcripts in `~/.claude/projects/` for 30 days by
default (configurable through Claude Code's `cleanupPeriodDays` setting). If
older transcripts were pruned, moved during a migration, or live only in an old
machine or backup, their activity cannot be backfilled until that archive is
available locally. See [Anthropic's data-retention documentation](https://code.claude.com/docs/en/data-usage).

---

## Stopping

```bash
vibecom unlink     # stop collecting for this repository
vibecom logout     # remove this machine's credentials
```

Revoking a project token in Settings stops that project's ingest immediately —
the server rejects it on the very next request.

---

<div align="center">

MIT licensed · [LICENSE](./LICENSE)

</div>
