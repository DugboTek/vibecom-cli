# What the vibecom CLI collects

This is the complete list. It is not a summary — every field the CLI can put on
the wire appears below, and a test (`src/collection.test.ts`) reads the actual
source and fails the build if the code ever sends something this file does not
document. If you find a discrepancy, that is a bug; please open an issue.

## The short version

The CLI reads the session transcripts your coding tools already write to disk,
plus safe session metadata from supported desktop hosts, and sends **counters
only**. It never sends your code, your prompts, your file names, or your shell
history.

## Never collected

These are structural, not policy — there is no code path that reads them:

- Source code, diffs, or file contents
- Prompts, model responses, or any conversation text
- File paths, file names, or repository contents
- Shell commands or their output
- Environment variables, secrets, or credentials

The transcript parsers deliberately read only counter fields out of each record.
There is a test (`transcripts.test.ts` → *"no transcript content survives
parsing, from any tool"*) that plants a secret string in a fixture transcript for
every supported tool, parses it, serialises the result, and fails if the secret
appears anywhere in the output.

## Exactly what is sent

One summary record per model used in a coding session, one active-time counter for each UTC
hour the session occupied, and one record per linked repository, to
`POST /api/v1/logs`:

| Attribute | Type | Meaning |
|---|---|---|
| `event.name` | string | `vibecom.session` for the summary, `vibecom.session.activity` for an hourly active-time counter, or `vibecom.repo` for a repository's git counters |
| `tool` | string | `claude-code`, `codex`, `opencode`, or `kimi` |
| `session.id` | string | The tool's own session id, or the transcript filename |
| `model` | string | Model name, e.g. `claude-opus-5`, `gpt-5.6-sol`. Omitted if the transcript does not record one |
| `turns` | number | Count of human prompts in the session |
| `sessions` | number | Always `1`. Lets a restated session replace the one-row-per-session counter your coding tool's live connection already sent, so re-importing history never leaves a duplicate |
| `input_tokens` | number | Sum of input tokens |
| `output_tokens` | number | Sum of output tokens |
| `cache_read_tokens` | number | Sum of cache-read tokens |
| `cache_creation_tokens` | number | Sum of cache-write tokens |
| `cost_usd` | number | Cost at published list prices, computed on your machine from the token counts above. Not a bill — see "How cost is calculated" |
| `unpriced_tokens` | number | Tokens whose model has no published rate, so a partial `cost_usd` is never mistaken for a complete one |
| `replace` | string | `true` when the record restates the session. The server replaces the prior copy, so a growing chat or re-import cannot double totals |
| `started_at` | string | First timestamp recorded inside the transcript (ISO 8601). Omitted when the format does not expose one |
| `ended_at` | string | Last timestamp recorded inside the transcript (ISO 8601), with file modification time used only for older formats that do not timestamp enough records |
| `bucket_at` | string | Start of a UTC hour containing derived active time (ISO 8601). Present only on `vibecom.session.activity` records |
| `active_seconds` | number | Active seconds in that hour. Derived from gaps between transcript events; gaps over 15 minutes contribute at most 15 minutes |
| `commits` | number | Commits you authored in a linked repository's full shipped history. Present only on `vibecom.repo` records — see "How git counters are collected" |
| `lines_added` | number | Lines added across those commits, excluding lockfiles, vendored directories, build output, and binaries |
| `lines_removed` | number | Lines removed across those commits, with the same exclusions |
| `excluded_lines` | number | Generated, vendored, or capped line churn excluded from the displayed line totals |
| `prs` | number | Distinct pull requests found in the subjects of those commits |

That is the entire payload. See `sendScanned()` in `src/core.ts`.

### How cost is calculated

`cost_usd` is derived here, on your machine, and never read from a network
service. Transcripts record token counts and a model name but no price, so the
CLI multiplies those counts by the published list price for that model
(`src/pricing.ts`) — separate rates for input, output, cache reads, and cache
writes, including the provider's model-specific discounts and TTL premiums.
Claude Code states a
model on every assistant message, Codex records the last request beside each
changed cumulative total, and Kimi records usage in every agent wire. Each
request/record is priced against the model that served it before per-model
session slices are uploaded.

Rates were verified on October 7, 2026 against the official
[OpenAI Standard API pricing](https://developers.openai.com/api/docs/pricing),
[Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing),
and [Kimi API pricing](https://platform.kimi.ai/docs/pricing/chat.md).
Long-context premiums apply to individual requests, including cached input,
when request boundaries are recorded. For older archives with only cumulative
session totals, the collector uses base rates rather than assuming the whole
session was one long request. Kimi's unspecified cache-write TTL uses its
documented five-minute default. Unknown premium variants do not inherit a
cheaper base model's rate. There is no flat per-task charge: a session's cost is
the sum of its recorded token usage at these rates.

It is an API-equivalent figure, not an invoice. A flat monthly subscription
bills the same regardless, so this answers "what would this volume cost at list
price" — the same question the old `claude_code.cost.usage` metric answered
before the installer stopped enabling that export.

Models with no published rate are never silently priced at zero. Their tokens
are counted in `unpriced_tokens` instead, and the profile shows what share of
your volume the figure actually covers.

### How git counters are collected

`commits`, `lines_added`, `lines_removed`, `excluded_lines`, and `prs` are read from the git
history of the repositories you have linked, by running `git log` locally
(`src/gitStats.ts`).

Claude Code also reports its own versions of these through the telemetry export
this CLI configures, but they are no longer stored: the same commit arriving
from two sources would be counted twice, and git is the better source on every
axis — it is the actual record rather than a reported count, it covers every
tool rather than one, and it can be read back over history no exporter was
running for. Unlike token counts, there is nothing in a transcript to rebuild
these from, so git is the only way to have them at all.

This reads no prompt, no tool argument, and no file content — only commit
metadata. Five integers per repository leave your machine. Commit messages,
file paths, branch names, and author addresses are read to compute them and
then dropped.

- **Only your own commits count.** Attribution is by the addresses in
  `user.email` (every scope, not just the winning one, since one person often
  has several), plus any `Co-authored-by:` trailer naming you. A collaborator's
  commits are read and discarded.
- **Work you did through a coding agent counts as yours.** An agent commits
  under its own name and leaves you as the committer; those are credited when
  the committer is you, which is what keeps a colleague's agent work theirs.
- **Full shipped history.** This matches a transcript rescan, which imports the
  builder's historical coding sessions. Keeping git bounded to link time made
  the profile compare lifetime tokens with only recent commits and lines.
- **Generated churn is excluded.** Lockfiles, `node_modules/`, `vendor/`, build
  output, minified bundles, snapshots, and binaries do not count as lines
  written; a single `npm install` would otherwise outweigh a day of real work.
  Anything your repository marks `linguist-generated` or `linguist-vendored` in
  `.gitattributes` is excluded too.
- **Churn is capped at 2,000 lines per file and 25,000 per commit.** A backstop
  for generated content no pattern list anticipates — measured across one
  machine, the largest single commit was 1.3 million lines of checked-in JSON
  snapshots that matched no rule, because that project stores them in a plain
  `snapshots/` directory. The thresholds are set high on purpose. They are there
  to stop an undeclared dump dwarfing everything, not to shape the numbers: on
  this repository neither cap changes the result at all. If a cap is doing real
  work on your repository, the honest fix is to mark the offending files
  generated in `.gitattributes`, not to let the number be reshaped.
- **Merge commits are not counted** as commits, and their diffs are not counted
  as lines, because everything they contain is already counted once.
- **Pull requests are read from commit subjects** — the number a forge writes
  when a pull request lands, deduplicated by number, across every branch and
  tag rather than just the current one. No GitHub token is requested and no
  network call is made. Checked against the GitHub API on seven repositories,
  this matched exactly on six and reached 90% on the seventh.

Known limits, stated rather than papered over. A pull request counts when the
commit that landed it is attributed to you, so one you opened but a teammate
merged is credited to them. A pull request merged by rebase leaves no marker in
the history and cannot be detected locally at all. Commit and line counts use
the fetched remote-default branch when the clone has one, with current `HEAD`
as the fallback for local-only repositories. An unmerged branch contributes
nothing until it lands — late rather than wrong, and it is what keeps a
squash-merge from being counted twice.

`started_at`, `ended_at`, and the hourly active counters come from timestamps
already present on transcript records. They contain no transcript content and
are not tied to a file path. Long idle gaps are capped locally at 15 minutes,
so leaving a chat open overnight does not count the whole night as work.
Without the hourly counters, an imported three-hour session would still be
drawn as one spike at the moment it ended.

Two more values are attached **by the server**, from the token you authenticated
with rather than from anything the CLI claims:

- **Your username** — derived from the token.
- **A project id** — the salted hash bound to the token you minted with
  `vibecom link`.

## How the project id works

Your repository path is never sent. Instead:

```
projectId = sha256("<machine-local-salt>:<repo-root-path>").slice(0, 32)
```

The salt is generated once per machine and stored in your local config. **It
never leaves your machine.** A global salt would make the hash reversible by
anyone who could guess a path like `/Users/alice/work/secret-startup`; a
per-machine salt means the hash is meaningless to anyone else, including us.

The label you see in Settings ("my-app") is one you typed yourself when running
`vibecom link` — it is not derived from the path.

## What is *not* automatic

Installing the CLI collects nothing. It does not touch your shell profile and it
does not enable telemetry anywhere.

Collection begins only when you run `vibecom link` **inside a specific
repository**, and applies only to that repository. An earlier version of the
installer exported OTLP variables globally, which turned collection on for every
repo on the machine including employers'. That was removed; see the note at the
top of the installer.

When you opt into `vibecom autopilot on` on macOS, the CLI also installs a
private per-user LaunchAgent that runs `vibecom scan --quiet` at the configured
interval (once a day by default; shorter legacy intervals upgrade to daily;
`vibecom scan` refreshes immediately). A failed automatic upload preserves local
archive watermarks and retries at the next daily attempt.
The server rejects continuous metrics, traces, and live log deltas before
authenticating against the database. The CLI disables its own continuous exporters while retaining the archive-upload
credentials. This is how **Claude Code, Codex, and Kimi** all stay current when they write their normal local archives, regardless
of which terminal app launched them. It is not a process monitor and it does
not read the screen, terminal scrollback, or a chat transcript beyond the
counter fields described above.

Superconductor's Codex `app-server` is the narrow exception: it deliberately
does not create Codex's ordinary archive. When present, `vibecom autopilot on`
adds an idempotent bridge to Superconductor's managed Codex wrapper. The bridge
passes every JSON-RPC message straight through and saves only Codex's documented
`thread/tokenUsage/updated` numeric totals plus thread id, model, working
directory for local attribution, and timestamp. It does not save or send any
other app-server message. New hosted Codex sessions use that bridge; historic
sessions for which the host never retained counters cannot be reconstructed
truthfully.

`vibecom autopilot off` removes both the Claude SessionStart hook and this
background collector. You can always run `vibecom scan` yourself instead.

## Re-importing history

Scans restate each changed session in full. The server drops what it already
holds for that session before storing the new figures, so a growing session or
re-import cannot inflate totals. `vibecom rescan` forces this for every linked
historical session, including unchanged sessions.

Use it to backfill the duration-aware clock for old history. Imports made before
session event times existed were stamped only at their upload or end time, so
hours of work could appear as a single busy spike.

### Claude Code history is local

A rescan reads only the Claude Code transcript files currently present at
`~/.claude/projects/`; it never retrieves account history from Anthropic. Claude
Code retains those local files for 30 days by default via `cleanupPeriodDays`, so
an old period can be backfilled only if its files remain on disk or are restored
from an older machine or backup. Claude web activity is outside the CLI's
collection scope. See [Anthropic's data-retention documentation](https://code.claude.com/docs/en/data-usage).

### Desktop agent hosts

When a supported desktop app launches Codex or Claude itself, its session may
not appear in `~/.codex/sessions` or `~/.claude/projects`. The CLI also detects
the local Conductor app database on macOS and reads only session metadata:
provider/model, the locally resolved workspace used for attribution, timestamps,
and whether a message was a human turn. It never selects `content`,
`full_message`, prompts, or responses from that database.

Conductor currently does not expose token counters in its local database. Those
sessions therefore contribute verified sessions, turns, and active calendar
days, but **not** an invented token or cost total. If a host exposes native
usage counters later, the adapter may add those documented counters; it will
never estimate them from conversation text. Other hosts are deliberately
ignored until they have an equally narrow metadata contract, rather than being
mislabelled as Codex or Claude.

## Consent tiers

`vibecom link --tier N` binds a tier to that project's token. The tier is stored
with the token and enforced **on the server**, on every request — the CLI is
never trusted to send only what it promised. A tampered or out-of-date CLI
cannot widen its own scope.

| Tier | Name | Collects |
|---|---|---|
| 1 (default) | Counters | The table above |
| 2 | Session shape | Not yet implemented — collects nothing today |
| 3 | Named stack | Not yet implemented — collects nothing today |

Tiers 2 and 3 are declared but ship no fields yet, so **every tier currently
collects exactly the tier-1 set**. When those phases land, the fields will be
listed here first.

Run `vibecom preview` to print the live policy from the server you are pointed
at, and `vibecom tier` to see what a project is currently linked at.

> The CLI talks to the host that issued your credentials, not wherever it was
> downloaded from — a token is only valid where it was minted. If you point it
> at a host that redirects elsewhere it will say so rather than silently fail,
> because credentials are not carried across a redirect.

## Verifying this yourself

```bash
# read the parsers — this is where every field comes from
less src/transcripts.ts       # what is read off disk
less src/core.ts              # what goes on the wire (see sendScanned)

# prove the parsers cannot leak transcript content
npm test

# build the bundle and compare it to the one the installer downloads
npm run build
shasum -a 256 dist/cli.js
curl -fsSL https://vibecom.build/cli.js | shasum -a 256
```

The build is byte-reproducible: pass `VIBECOM_BUILD_STAMP` to match the stamp
embedded in a published bundle (`vibecom --version` prints it).

## Stopping and removing

```bash
vibecom unlink     # stop collecting for this repository
vibecom logout     # revoke this machine's account token
```

Revoking a project token in Settings stops that project's ingest immediately;
the server rejects the token on the next request.
