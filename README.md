# vibecom CLI

The command-line collector for [vibecom](https://vibecom.build). It reads the
session transcripts your coding tools already write to disk, adds up the
counters in them, and sends those numbers — nothing else.

This repository exists so you do not have to take that on faith.

**→ [COLLECTION.md](./COLLECTION.md) is the complete list of what leaves your
machine.** It is enforced by a test, not by good intentions: if the code ever
sends a field the document does not list, the build fails.

## Install

```bash
curl -fsSL https://vibecom.build/setup.sh | bash
```

The installer collects nothing. It does not modify your shell profile and it
does not enable telemetry anywhere. Collection starts only when you run
`vibecom link` inside a specific repository, and applies only to that
repository.

Prefer not to pipe a script into bash? Build it yourself:

```bash
git clone https://github.com/chrismicah/vibecom-cli
cd vibecom-cli && npm install && npm run build
install -m 755 dist/cli.js ~/.local/bin/vibecom
```

## Commands

| Command | What it does |
|---|---|
| `vibecom login` | Device-code sign-in. Mints an account token that **cannot ingest telemetry** — it only mints project tokens |
| `vibecom link` | Opt this repository in. Pick a consent tier with `--tier` |
| `vibecom scan` | Read transcripts for linked repos and send the counters |
| `vibecom preview` | Print the live collection policy from the server |
| `vibecom tier` | Show what the current project is linked at |
| `vibecom unlink` | Stop collecting for this repository |
| `vibecom logout` | Revoke this machine's account token |

## Verify what it does

```bash
npm test        # includes the leak test and the COLLECTION.md drift guard
npm run verify  # test, build, and print the bundle checksum
```

Two tests are worth reading before anything else:

- **`transcripts.test.ts` → "no transcript content survives parsing, from any
  tool"** plants a secret string in a fixture transcript for every supported
  tool, parses it, and fails if that string appears anywhere in the output.
- **`collection.test.ts`** parses the real `sendScanned()` and fails if it emits
  any attribute that `COLLECTION.md` does not document — and vice versa.

### Reproducing the published bundle

The build is byte-reproducible. `vibecom --version` prints the build stamp
embedded in your installed copy; pass it back in to rebuild that exact artifact:

```bash
VIBECOM_BUILD_STAMP=$(vibecom --version) npm run build
shasum -a 256 dist/cli.js
curl -fsSL https://vibecom.build/cli.js | shasum -a 256
```

Matching hashes mean the bundle you are running is built from this source.

## Design notes

**Your repo path is never sent.** Projects are identified by
`sha256("<machine-local-salt>:<repo-root>")`, truncated to 32 characters. The
salt is generated once per machine and never leaves it, so the hash is
meaningless to anyone else — including us. A global salt would be reversible by
anyone who could guess a path.

**The server does not trust this CLI.** Consent tiers are bound to the token at
`link` time and enforced on every request server-side. A tampered or out-of-date
CLI cannot widen its own scope.

**Account tokens cannot send telemetry.** `vibecom login` alone is not enough to
ingest anything; the server rejects account tokens on the ingest endpoints with
`403`. That is what makes per-project consent meaningful.

## Supported tools

Claude Code, Codex, Kimi, and OpenCode. Each has its own transcript format and
its own parser in [`src/transcripts.ts`](./src/transcripts.ts) — the most useful
file to read if you want to know exactly what is pulled off disk.

## Licence

MIT — see [LICENSE](./LICENSE).
