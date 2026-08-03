# What the vibecom CLI collects

This is the complete list. It is not a summary — every field the CLI can put on
the wire appears below, and a test (`src/collection.test.ts`) reads the actual
source and fails the build if the code ever sends something this file does not
document. If you find a discrepancy, that is a bug; please open an issue.

## The short version

The CLI reads the session transcripts your coding tools already write to disk,
adds up the numbers in them, and sends **counters only**. It never sends your
code, your prompts, your file names, or your shell history.

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

One summary record per coding session plus one active-time counter for each UTC
hour the session occupied, to `POST /api/v1/logs`:

| Attribute | Type | Meaning |
|---|---|---|
| `event.name` | string | `vibecom.session` for the summary or `vibecom.session.activity` for an hourly active-time counter |
| `tool` | string | `claude-code`, `codex`, `opencode`, or `kimi` |
| `session.id` | string | The tool's own session id, or the transcript filename |
| `model` | string | Model name, e.g. `claude-opus-5`, `gpt-5.6-sol`. Omitted if the transcript does not record one |
| `turns` | number | Count of human prompts in the session |
| `input_tokens` | number | Sum of input tokens |
| `output_tokens` | number | Sum of output tokens |
| `cache_read_tokens` | number | Sum of cache-read tokens |
| `cache_creation_tokens` | number | Sum of cache-write tokens |
| `cost_usd` | number | Cost as reported by the tool itself |
| `replace` | string | `true` when the record restates the session. The server replaces the prior copy, so a growing chat or re-import cannot double totals |
| `started_at` | string | First timestamp recorded inside the transcript (ISO 8601). Omitted when the format does not expose one |
| `ended_at` | string | Last timestamp recorded inside the transcript (ISO 8601), with file modification time used only for older formats that do not timestamp enough records |
| `bucket_at` | string | Start of a UTC hour containing derived active time (ISO 8601). Present only on `vibecom.session.activity` records |
| `active_seconds` | number | Active seconds in that hour. Derived from gaps between transcript events; gaps over 15 minutes contribute at most 15 minutes |

That is the entire payload. See `sendScanned()` in `src/core.ts`.

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

## Re-importing history

Scans restate each changed session in full. The server drops what it already
holds for that session before storing the new figures, so a growing session or
re-import cannot inflate totals. `vibecom rescan` forces this for every linked
historical session, including unchanged sessions.

Use it to backfill the duration-aware clock for old history. Imports made before
session event times existed were stamped only at their upload or end time, so
hours of work could appear as a single busy spike.

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
