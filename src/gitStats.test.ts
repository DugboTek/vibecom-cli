import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  collectRepoStats,
  gitIdentities,
  isGeneratedPath,
  parseGitLog,
  PER_COMMIT_LINE_CAP,
  PER_FILE_LINE_CAP,
  pullRequestRef,
  renameDestination,
} from "./gitStats";

/* realpath because macOS symlinks /tmp to /private/tmp and git reports the
   resolved path back. */
const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-git-test-"))
);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const RECORD = "\x1e";
const UNIT = "\x1f";

/** Build one `git log --numstat` record the way the real format emits it. */
function record(
  hash: string,
  email: string,
  parents: string,
  subject: string,
  files: [number | "-", number | "-", string][] = [],
  opts: { authored?: string; coauthors?: string; committer?: string } = {}
): string {
  const authored = opts.authored ?? "2026-01-01T00:00:00+00:00";
  const co = opts.coauthors ?? "";
  // Committer defaults to the author, which is what an ordinary commit has.
  const committer = opts.committer ?? email;
  const head =
    `${RECORD}${hash}${UNIT}${email}${UNIT}${committer}${UNIT}${authored}${UNIT}` +
    `${parents}${UNIT}${co}${UNIT}${subject}`;
  const body = files.map(([a, r, f]) => `${a}\t${r}\t${f}`).join("\n");
  return files.length > 0 ? `${head}\n${body}\n` : `${head}\n`;
}

const ME = "me@example.com";

/* ------- parsing ------- */

test("commits and lines are counted for the configured identity", () => {
  const log =
    record("a1", ME, "p0", "first", [[10, 2, "src/app.ts"]]) +
    record("a2", ME, "a1", "second", [
      [5, 1, "src/lib.ts"],
      [3, 0, "README.md"],
    ]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.commits, 2);
  assert.equal(stats.linesAdded, 18);
  assert.equal(stats.linesRemoved, 3);
});

test("another person's commits are read and discarded", () => {
  /* A shared repository is the normal case. This repo's own recent history is
     54 commits by its owner and 12 by a collaborator — counting everything
     would hand one builder another's work. */
  const log =
    record("a1", ME, "p0", "mine", [[10, 0, "src/app.ts"]]) +
    record("a2", "someone@else.com", "a1", "theirs", [[999, 999, "src/x.ts"]]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.commits, 1);
  assert.equal(stats.linesAdded, 10);
  assert.equal(stats.linesRemoved, 0);
});

test("identity matching ignores case", () => {
  const log = record("a1", "Me@Example.COM", "p0", "mine", [[4, 0, "a.ts"]]);
  assert.equal(parseGitLog(log, new Set([ME]), null).commits, 1);
});

test("a merge commit is not a commit and contributes no lines", () => {
  /* A merge's diff is the sum of the commits it brings in, every one of which
     is counted already. Counting it would double the whole branch. */
  const log =
    record("a1", ME, "p0", "work", [[10, 0, "src/app.ts"]]) +
    record("m1", ME, "a1 b1", "Merge branch 'feature' into main", [
      [10, 0, "src/app.ts"],
    ]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.commits, 1, "the merge is not itself work");
  assert.equal(stats.linesAdded, 10, "and its diff is not counted twice");
});

test("the same commit reachable twice is counted once", () => {
  const log =
    record("a1", ME, "p0", "work", [[10, 0, "a.ts"]]) +
    record("a1", ME, "p0", "work", [[10, 0, "a.ts"]]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.commits, 1);
  assert.equal(stats.linesAdded, 10);
});

test("binary files contribute no lines", () => {
  // numstat writes "-" for both counts on a binary; committing a video is not
  // ten thousand lines of work.
  const log = record("a1", ME, "p0", "add art", [
    ["-", "-", "logo.png"],
    [4, 0, "src/app.ts"],
  ]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.linesAdded, 4);
  assert.equal(stats.linesRemoved, 0);
});

test("generated churn is excluded and reported separately", () => {
  const log = record("a1", ME, "p0", "bump deps", [
    [8, 3, "src/app.ts"],
    [4000, 3800, "package-lock.json"],
    [120, 0, "node_modules/left-pad/index.js"],
  ]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.linesAdded, 8, "only authored lines count");
  assert.equal(stats.linesRemoved, 3);
  assert.equal(stats.excludedLines, 4000 + 3800 + 120);
});

test("a commit of nothing but generated files still counts as a commit", () => {
  // It happened; it just was not writing.
  const log = record("a1", ME, "p0", "lockfile", [[900, 900, "yarn.lock"]]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.commits, 1);
  assert.equal(stats.linesAdded, 0);
});

test("a subject containing the separators cannot desync the parse", () => {
  const log =
    record("a1", ME, "p0", "fix: handle \t tabs and | pipes", [[2, 0, "a.ts"]]) +
    record("a2", ME, "a1", "next", [[3, 0, "b.ts"]]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.commits, 2);
  assert.equal(stats.linesAdded, 5);
});

test("with no resolvable identity every commit counts", () => {
  // Better to over-report on a repo with no configured email than to report
  // zero and look broken.
  const log =
    record("a1", "a@b.c", "p0", "one", [[1, 0, "a.ts"]]) +
    record("a2", "d@e.f", "a1", "two", [[1, 0, "b.ts"]]);
  assert.equal(parseGitLog(log, new Set(), null).commits, 2);
});

test("a co-author is credited, because that is how assisted work is attributed", () => {
  const log = record(
    "a1",
    "someone@else.com",
    "p0",
    "paired",
    [[7, 0, "a.ts"]],
    { coauthors: `Me <${ME}>` }
  );
  assert.equal(parseGitLog(log, new Set([ME]), null).commits, 1);
});

test("work done through an agent is still your work", () => {
  /* A coding agent commits as itself and leaves the human as committer. On one
     real repository that is 28 of 31 commits with no co-author trailer to fall
     back on, so matching the author alone reported a tenth of the work — in a
     tool whose entire subject is AI-assisted building. */
  const log = record(
    "a1",
    "noreply@anthropic.com",
    "p0",
    "implement the thing",
    [[40, 5, "src/app.ts"]],
    { committer: ME }
  );
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.commits, 1);
  assert.equal(stats.linesAdded, 40);
});

test("a colleague's agent commits stay theirs", () => {
  // The committer gate is what separates my agent's work from someone else's.
  const log = record(
    "a1",
    "noreply@anthropic.com",
    "p0",
    "their work",
    [[40, 5, "src/app.ts"]],
    { committer: "someone@else.com" }
  );
  assert.equal(parseGitLog(log, new Set([ME]), null).commits, 0);
});

test("one human's several addresses all count", () => {
  /* GitHub's noreply format gained a numeric prefix at one point, so a single
     contributor fragments across addresses over time. This repository's own
     history shows one collaborator under three. */
  const identities = new Set([ME, "12345+me@users.noreply.github.com"]);
  const log =
    record("a1", ME, "p0", "one", [[1, 0, "a.ts"]]) +
    record("a2", "12345+me@users.noreply.github.com", "a1", "two", [
      [2, 0, "b.ts"],
    ]);
  assert.equal(parseGitLog(log, identities, null).commits, 2);
});

test("the window is applied to the author date, not the committer date", () => {
  /* Filtered in code rather than with `--since`, which compares the committer
     date while displaying the author date, and halts traversal at the first
     commit older than the cutoff instead of skipping it — so one rebased
     commit at HEAD can silently return an empty history. */
  const cutoff = new Date("2026-06-01T00:00:00Z");
  const log =
    record("old", ME, "p0", "before", [[100, 0, "a.ts"]], {
      authored: "2020-01-01T00:00:00+00:00",
    }) +
    record("new", ME, "old", "after", [[5, 0, "b.ts"]], {
      authored: "2026-07-01T00:00:00+00:00",
    });
  const stats = parseGitLog(log, new Set([ME]), cutoff);
  assert.equal(stats.commits, 1, "only the commit authored inside the window");
  assert.equal(stats.linesAdded, 5);
});

test("an old commit later in the log does not truncate the walk", () => {
  // The failure `--since` would produce: an old commit first, stopping there.
  const cutoff = new Date("2026-06-01T00:00:00Z");
  const log =
    record("old", ME, "p0", "before", [[100, 0, "a.ts"]], {
      authored: "2020-01-01T00:00:00+00:00",
    }) +
    record("new", ME, "old", "after", [[5, 0, "b.ts"]], {
      authored: "2026-07-01T00:00:00+00:00",
    }) +
    record("new2", ME, "new", "after again", [[6, 0, "c.ts"]], {
      authored: "2026-07-02T00:00:00+00:00",
    });
  assert.equal(parseGitLog(log, new Set([ME]), cutoff).commits, 2);
});

test("a renamed file is classified by where it landed", () => {
  /* With rename detection on, git compresses a move into one field. Matched
     literally, a file moved into node_modules/ would slip past the rules. */
  assert.equal(renameDestination("src/{old.ts => new.ts}"), "src/new.ts");
  assert.equal(renameDestination("old.ts => new.ts"), "new.ts");
  assert.equal(renameDestination("src/{ => nested}/a.ts"), "src/nested/a.ts");
  assert.equal(renameDestination("plain.ts"), "plain.ts");

  assert.ok(isGeneratedPath("src/{app.ts => node_modules/app.ts}"));
  assert.ok(!isGeneratedPath("{node_modules/a.ts => src/a.ts}"));
});

test("one enormous file cannot dominate the whole count", () => {
  /* The backstop for generated content no pattern knows about. In this repo a
     committed metrics dump rewrote 18,122 lines in a single touch — half of all
     measured churn — against a median touch of 27 lines. */
  const log = record("a1", ME, "p0", "regenerate fixtures", [
    [18000, 122, "data/metrics.json"],
    [12, 4, "src/app.ts"],
  ]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(
    stats.linesAdded + stats.linesRemoved - 16,
    PER_FILE_LINE_CAP,
    "the dump is capped, the hand-written file is untouched"
  );
  assert.equal(stats.linesAdded > stats.linesRemoved, true, "kept in proportion");
  assert.equal(stats.commits, 1, "the commit still happened");
  assert.ok(stats.excludedLines > 16000, "and the surplus is reported");
});

test("an ordinary large commit is left alone", () => {
  // 500 lines across two files is real work, not a data drop.
  const log = record("a1", ME, "p0", "big feature", [
    [300, 20, "src/a.ts"],
    [180, 0, "src/b.ts"],
  ]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.linesAdded, 480);
  assert.equal(stats.linesRemoved, 20);
  assert.equal(stats.excludedLines, 0);
});

test("a repository can declare its own generated files", () => {
  /* A pattern list only knows ecosystems it has heard of; `.gitattributes` is
     how a repository declares the rest, and GitHub already reads the same
     attributes. */
  const log = record("a1", ME, "p0", "regen", [
    [900, 0, "schema/api.ts"],
    [40, 2, "src/app.ts"],
  ]);
  const declared = new Set(["schema/api.ts"]);
  const stats = parseGitLog(log, new Set([ME]), null, declared);
  assert.equal(stats.linesAdded, 40);
  assert.equal(stats.excludedLines, 900);
});

/* ------- pull requests ------- */

test("pull request numbers are recognised across forges", () => {
  assert.equal(pullRequestRef("Merge pull request #42 from me/feature"), "42");
  assert.equal(pullRequestRef("Add the thing (#123)"), "123");
  assert.equal(pullRequestRef("Merged in feat (pull request #7)"), "7");
  assert.equal(pullRequestRef("See merge request group/proj!99"), "99");
});

test("an ordinary subject is not a pull request", () => {
  assert.equal(pullRequestRef("Fix issue #12 in the parser"), null);
  assert.equal(pullRequestRef("Merge branch 'main' into feature"), null);
  assert.equal(pullRequestRef("Refactor the store"), null);
});

test("one pull request counted once even when it lands twice", () => {
  /* A history can hold both the merge commit and a squashed copy of the same
     pull request, so they are counted by number rather than by occurrence. */
  const log =
    record("m1", ME, "a1 b1", "Merge pull request #42 from me/feature") +
    record("s1", ME, "m1", "Add the feature (#42)", [[5, 0, "a.ts"]]);
  assert.equal(parseGitLog(log, new Set([ME]), null).prs, 1);
});

test("distinct pull requests are counted separately", () => {
  const log =
    record("m1", ME, "a1 b1", "Merge pull request #1 from me/a") +
    record("m2", ME, "m1 c1", "Merge pull request #2 from me/b");
  assert.equal(parseGitLog(log, new Set([ME]), null).prs, 2);
});

test("a pull request merged by someone else is not yours", () => {
  const log = record(
    "m1",
    "someone@else.com",
    "a1 b1",
    "Merge pull request #9 from them/x"
  );
  assert.equal(parseGitLog(log, new Set([ME]), null).prs, 0);
});

/* ------- path classification ------- */

test("lockfiles and build output are generated, source is not", () => {
  for (const generated of [
    "package-lock.json",
    "app/yarn.lock",
    "go.sum",
    "Cargo.lock",
    "flake.lock",
    "node_modules/react/index.js",
    "dist/bundle.js",
    ".next/static/chunk.js",
    "vendor/github.com/x/y.go",
    "web/static/app.min.js",
    "app.js.map",
    "api/service.pb.go",
    "models/user.freezed.dart",
  ]) {
    assert.ok(isGeneratedPath(generated), `${generated} should be excluded`);
  }

  for (const authored of [
    "src/app.ts",
    "README.md",
    "package.json",
    "src/lockfile-parser.ts",
    "docs/distribution.md",
    "src/components/Build.tsx",
  ]) {
    assert.ok(!isGeneratedPath(authored), `${authored} should count`);
  }
});

/* ------- against a real repository ------- */

function repo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", "."], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", ME], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Me"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function commit(
  dir: string,
  files: Record<string, string>,
  subject: string,
  email = ME
): void {
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", `user.email=${email}`, "-c", "user.name=X", "commit", "-qm", subject],
    { cwd: dir, stdio: "ignore" }
  );
}

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

test("a real repository is measured end to end", () => {
  const dir = repo("real");
  commit(dir, { "src/app.ts": lines(10) }, "first");
  commit(dir, { "src/app.ts": lines(14) }, "second");
  commit(dir, { "package-lock.json": lines(500) }, "bump deps");

  const stats = collectRepoStats(dir, null)!;
  assert.ok(stats, "stats were produced");
  assert.equal(stats.commits, 3);
  assert.equal(stats.linesAdded, 14, "10 then 4 more; the lockfile is excluded");
  assert.equal(stats.excludedLines, 500);
  assert.equal(stats.prs, 0);
});

test("a real repository attributes only the configured identity", () => {
  const dir = repo("shared");
  commit(dir, { "a.ts": lines(5) }, "mine");
  commit(dir, { "b.ts": lines(50) }, "theirs", "other@example.com");

  const stats = collectRepoStats(dir, null)!;
  assert.equal(stats.commits, 1);
  assert.equal(stats.linesAdded, 5);
});

test("the identity set comes from the repository's own config", () => {
  const dir = repo("identity");
  assert.ok(gitIdentities(dir).has(ME));
});

test("since bounds the window", () => {
  /* Linking a repository with years of history must not retroactively credit
     a decade of work, so collection starts when the project was linked. */
  const dir = repo("windowed");
  commit(dir, { "old.ts": lines(9) }, "old");
  const cutoff = new Date(Date.now() + 1000);
  const stats = collectRepoStats(dir, cutoff)!;
  assert.equal(stats.commits, 0, "everything predates the cutoff");
  assert.equal(stats.linesAdded, 0);
});

test("a directory that is not a repository reports nothing, not zero", () => {
  /* Null and zero mean different things: "we could not look" must stay
     distinguishable from "we looked and found no work". */
  const plain = path.join(tmp, "not-a-repo");
  fs.mkdirSync(plain, { recursive: true });
  assert.equal(collectRepoStats(plain, null), null);
});

test("a repository with no commits reports nothing rather than zero", () => {
  const dir = repo("empty");
  assert.equal(collectRepoStats(dir, null), null);
});

test("renames are followed rather than scored as a rewrite", () => {
  const dir = repo("renamed");
  commit(dir, { "old.ts": lines(20) }, "add");
  fs.renameSync(path.join(dir, "old.ts"), path.join(dir, "new.ts"));
  commit(dir, {}, "rename");

  const stats = collectRepoStats(dir, null)!;
  assert.equal(
    stats.linesAdded,
    20,
    "a pure rename adds no lines beyond the original"
  );
  assert.equal(stats.linesRemoved, 0);
});

test("a real merge commit does not double-count its branch", () => {
  const dir = repo("merged");
  commit(dir, { "base.ts": lines(5) }, "base");
  execFileSync("git", ["checkout", "-q", "-b", "feature"], {
    cwd: dir,
    stdio: "ignore",
  });
  commit(dir, { "feature.ts": lines(30) }, "feature work");
  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      `user.email=${ME}`,
      "-c",
      "user.name=X",
      "merge",
      "--no-ff",
      "-q",
      "-m",
      "Merge pull request #7 from me/feature",
      "feature",
    ],
    { cwd: dir, stdio: "ignore" }
  );

  const stats = collectRepoStats(dir, null)!;
  assert.equal(stats.commits, 2, "base and feature, not the merge");
  assert.equal(stats.linesAdded, 35, "the branch is counted once");
  assert.equal(stats.prs, 1, "and the merge still yields its pull request");
});

test("a bulk import spread across many files is capped at the commit", () => {
  /* The per-file cap alone is not enough. The largest commit on this machine
     is 1,317,539 lines across 86 checked-in JSON snapshots — 41% of all churn
     in every repository combined, matching no exclusion pattern because that
     project uses a bare `snapshots/` directory. Capped per file it would still
     contribute 172,000. */
  const files: [number, number, string][] = Array.from(
    { length: 86 },
    (_, i) => [15000, 300, `snapshots/case-${i}.json`]
  );
  const log = record("a1", ME, "p0", "regenerate snapshots", files);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(
    stats.linesAdded + stats.linesRemoved,
    PER_COMMIT_LINE_CAP,
    "the whole commit is bounded, not just each file"
  );
  assert.equal(stats.commits, 1, "the commit still happened");
});

test("an ordinary busy commit is under the commit cap untouched", () => {
  const log = record("a1", ME, "p0", "a real feature", [
    [900, 120, "src/a.ts"],
    [600, 40, "src/b.ts"],
  ]);
  const stats = parseGitLog(log, new Set([ME]), null);
  assert.equal(stats.linesAdded, 1500);
  assert.equal(stats.linesRemoved, 160);
  assert.equal(stats.excludedLines, 0);
});

test("no repository content survives collection", () => {
  /* The git counterpart of the transcript secrecy test. A repository is full of
     things that must never leave the machine — commit messages naming a
     customer, branch names revealing a roadmap, file paths revealing an
     employer's architecture. All of it is read to compute the counters and then
     has to be gone. This plants each kind and fails if any of it survives into
     the collected result. */
  const dir = repo("secrets");
  const SECRET = "ACME-CORP-MIGRATION-Q3-CONFIDENTIAL";
  execFileSync("git", ["checkout", "-q", "-b", `feat/${SECRET}`], {
    cwd: dir,
    stdio: "ignore",
  });
  commit(
    dir,
    { [`src/${SECRET}.ts`]: lines(12) },
    `refactor ${SECRET} billing pipeline`
  );

  const stats = collectRepoStats(dir, null)!;
  assert.equal(stats.commits, 1, "the commit was genuinely read");
  assert.equal(stats.linesAdded, 12, "and its lines counted");

  const serialised = JSON.stringify(stats);
  assert.ok(
    !serialised.includes(SECRET),
    `repository content leaked into the counters: ${serialised}`
  );
  assert.ok(
    !/[A-Za-z]{4}/.test(serialised.replace(/"[a-zA-Z]+":/g, "")),
    "nothing but field names and numbers may appear"
  );
});
