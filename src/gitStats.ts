import { execFileSync } from "node:child_process";

/**
 * Read commit, line and pull-request counts out of a repository's own history.
 *
 * These four counters used to arrive in Claude Code's OTLP metric stream. The
 * installer stopped enabling that export — it is a global setting, so turning
 * it on aimed telemetry at every repository on the machine — and unlike token
 * counts there is nothing in a transcript to rebuild them from. Git has them,
 * exactly and without inference, which makes it both the more accurate source
 * and the more private one: nothing here reads a prompt, a tool argument, or a
 * file's contents.
 *
 * What leaves this module is four integers. Commit messages, file paths, branch
 * names and author addresses are read to compute them and then dropped. Paths
 * in particular never leave the process — they exist only to decide whether a
 * line is real work or a regenerated lockfile.
 */

/** The four counters, and the evidence needed to explain them. */
export type RepoStats = {
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  prs: number;
  /** Churn dropped by the exclusion rules, kept so the CLI can say so. */
  excludedLines: number;
};

export const emptyRepoStats = (): RepoStats => ({
  commits: 0,
  linesAdded: 0,
  linesRemoved: 0,
  prs: 0,
  excludedLines: 0,
});

/**
 * Paths whose churn is machine-generated rather than written.
 *
 * How much this catches varies enormously by project: measured across 19 real
 * repositories it removed 4.6% of churn overall, but the per-repository range
 * runs 0% to 86%, and on this repository it is 26%. A single `npm install`
 * rewrites more of `package-lock.json` than a day of real work touches, so the
 * rules earn their place — but they are a first pass, not the whole defence.
 * The caps below are what hold when a project stores generated content
 * somewhere no pattern list anticipated.
 *
 * The list follows GitHub Linguist's `vendor.yml` and `generated.rb`, which are
 * the closest thing to a canonical answer, trimmed to the path rules — its
 * content heuristics need to read blobs, which this deliberately never does.
 */
const EXCLUDED_FILE = [
  // Dependency lockfiles: regenerated wholesale, never hand-edited.
  /(^|\/)package-lock\.json$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)gradle\.lockfile$/,
  /(^|\/)packages\.lock\.json$/,
  /(^|\/)Package\.resolved$/,
  /(^|\/)flake\.lock$/,
  // Minified or compiled artefacts, source maps, and test snapshots.
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  // Common code-generator output.
  /\.pb\.(go|cc)$/,
  /_pb2\.pyi?$/,
  /\.generated\.[A-Za-z0-9]+$/,
  /\.designer\.cs$/,
  /\.(g|freezed)\.dart$/,
];

/** Directories that are checked in but not authored. */
const EXCLUDED_DIR =
  /(^|\/)(node_modules|bower_components|vendor|third_party|dist|build|out|target|coverage|__snapshots__|__pycache__|\.next|\.nuxt|\.svelte-kit|\.terraform|\.venv|venv|Pods|DerivedData|gradle\/wrapper)\//;

/**
 * Resolve the path numstat prints for a renamed file.
 *
 * With rename detection on, git compresses a move into one field —
 * `src/{old.ts => new.ts}` or the whole-path `old.ts => new.ts`. Matched
 * literally, a file moved into `node_modules/` would slip past every exclusion
 * above, so the destination is recovered before the patterns are applied.
 */
export function renameDestination(file: string): string {
  const braced = file.match(/^(.*)\{(?:.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[2]}${braced[3]}`.replace(/\/{2,}/g, "/");
  const whole = file.match(/^(?:.+) => (.+)$/);
  if (whole) return whole[1];
  return file;
}

export const isGeneratedPath = (file: string): boolean => {
  const path = renameDestination(file);
  return EXCLUDED_DIR.test(path) || EXCLUDED_FILE.some((re) => re.test(path));
};

/**
 * Most churn one file may contribute to one commit.
 *
 * A backstop for generated content the patterns cannot know about — a committed
 * data dump, a fixture regenerated wholesale, an unlisted vendor drop. The
 * threshold is set from the shape of real history rather than taste: across
 * this repository the median file touch is 27 lines and the 99th percentile is
 * 738, so 2,000 sits far outside anything hand-written. It changes 2 of 397
 * file touches here — and those two, both rewrites of a committed metrics
 * dump, were half of all measured churn.
 *
 * Capped rather than dropped: the commit still counts, the file still counts,
 * and the surplus is reported as excluded rather than silently vanishing.
 */
export const PER_FILE_LINE_CAP = 2000;

/**
 * Most churn one commit may contribute.
 *
 * The per-file cap alone is not enough: the largest commit across this
 * machine's repositories is 1,317,539 lines spread over 86 checked-in JSON
 * snapshot files — 41% of all churn in every repository combined, and not one
 * line of it matched any exclusion pattern, because that project keeps them in
 * a bare `snapshots/` directory rather than Jest's `__snapshots__`. Capping per
 * file would still let it contribute 172,000.
 *
 * No path list can enumerate every convention; a commit-level ceiling is the
 * only rule that holds against the one nobody thought of.
 *
 * Set high deliberately. An earlier 5,000 was shaping the numbers rather than
 * guarding them — on this repository it clipped a real 5,948-line commit and,
 * before the store below was declared generated, it was discarding 48% of
 * additions and 77% of removals. Exclusions are what should do the work; this
 * only has to stop an undeclared dump from dwarfing everything, so it sits
 * above anything a person plausibly writes in one commit (the largest here is
 * 5,948) and well below a generated one.
 */
export const PER_COMMIT_LINE_CAP = 25_000;

/**
 * Pull-request references in a commit subject.
 *
 * A local clone has no concept of a pull request, but every forge writes its
 * number into the commit it creates when one lands. That is enough to count
 * them without asking the user to authenticate anything, which is the whole
 * point — a GitHub token would be a far larger ask than these four numbers
 * justify. Measured against `gh pr list` on a real repository, subject matching
 * found 22 of 22 with nothing spurious.
 *
 * The number is captured rather than just matched so the same pull request
 * cannot be counted twice when a repository holds both its merge commit and a
 * later squashed copy.
 */
const PR_PATTERNS = [
  /* Deliberately not requiring `from` after the number. The widely-copied
     `Merge pull request #\d+ from ` misses the colon form GitHub writes when a
     pull request has a title — six of this repository's own merges. */
  /\bMerge pull request #(\d+)\b/,
  // Bitbucket: "Merged in feature/x (pull request #12)"
  /\bpull request #(\d+)\)/,
  // GitHub squash or rebase merge: subject ends "... (#12)"
  /\(#(\d+)\)/,
  // Custom squash subjects such as "release feature (PR #80)".
  /\bPR #(\d+)\b/i,
  // GitLab: "See merge request group/project!12"
  /\bSee merge request [^\s!]*!(\d+)\b/,
];

export function pullRequestRef(subject: string): string | null {
  for (const pattern of PR_PATTERNS) {
    const found = subject.match(pattern);
    if (found) return found[1];
  }
  return null;
}

/* Separators chosen from the C0 control range because none can occur in an
   email, a path, an ISO timestamp, or a commit subject — so no amount of
   creative commit-message punctuation can desync the parse. */
const RECORD = "\x1e";
const UNIT = "\x1f";
const TRAILER = "\x1d";

/**
 * Every email address that counts as this user.
 *
 * A set rather than a single value, because one human routinely has several:
 * `user.email` is overridden per repository to keep work and personal
 * identities apart, and GitHub's noreply format gained a numeric prefix at one
 * point, so a single contributor fragments across addresses over time. This
 * repository's history shows exactly that — one collaborator appears under
 * three addresses.
 *
 * `--get-all` returns the value from every scope rather than just the winning
 * one, which is what makes the set complete.
 */
export function gitIdentities(cwd: string): Set<string> {
  const emails = new Set<string>();
  const raw = runGit(["config", "--get-all", "user.email"], cwd) ?? "";
  for (const line of raw.split("\n")) {
    const email = line.trim().toLowerCase();
    if (!email) continue;
    emails.add(email);
    /* `git log --use-mailmap` canonicalizes historical aliases. Canonicalize
       the configured identities too, while retaining the raw form, so a
       repository's own mailmap cannot accidentally hide its owner's commits. */
    const canonical = runGit(["check-mailmap", `<${email}>`], cwd) ?? "";
    for (const mapped of canonical.matchAll(/<([^>]+)>/g)) {
      if (mapped[1]) emails.add(mapped[1].trim().toLowerCase());
    }
  }
  return emails;
}

function shippedRef(root: string): string {
  /* A working tree may be checked out on a months-old feature branch. Prefer
     the fetched default branch as the stable definition of shipped work, with
     HEAD as the honest fallback for local-only repositories. */
  const remoteDefault = (
    runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], root) ?? ""
  ).trim();
  if (
    remoteDefault &&
    runGit(["rev-parse", "--verify", "--quiet", remoteDefault], root)
  ) {
    return remoteDefault;
  }
  return "HEAD";
}

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      /* A full history walk runs to megabytes and Node's default cap is 1 MiB.
         Overflowing it throws, which would be read as "no commits" — a silent
         zero on exactly the busy repositories worth measuring. */
      maxBuffer: 64 * 1024 * 1024,
      timeout: 90_000,
    });
  } catch {
    return null;
  }
}

/**
 * Ask the repository which of these paths it considers generated.
 *
 * A pattern list can only know about ecosystems it has heard of. `.gitattributes`
 * is how a repository declares its own — `linguist-generated` and
 * `linguist-vendored` are the attributes GitHub already reads to keep such files
 * out of language statistics and diffs, so honouring them costs a user nothing
 * they have not already done.
 *
 * One batched call over every path in the history; querying per file would be
 * thousands of subprocesses.
 */
export function declaredGeneratedPaths(
  root: string,
  paths: readonly string[]
): Set<string> {
  const generated = new Set<string>();
  if (paths.length === 0) return generated;
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["check-attr", "--stdin", "linguist-generated", "linguist-vendored"],
      {
        cwd: root,
        encoding: "utf8",
        input: paths.join("\n"),
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 90_000,
      }
    );
  } catch {
    /* An old git, or a path it refuses to classify. The pattern list still
       applies; this only ever adds to it. */
    return generated;
  }
  for (const line of raw.split("\n")) {
    /* "<path>: <attribute>: <value>" — but a path may itself contain ": ", so
       the two known suffixes are stripped from the end rather than split on.

       Both spellings count. A bare `linguist-generated` reports as "set", while
       the `linguist-generated=true` form — the one GitHub's own documentation
       uses, and therefore the one most repositories write — reports as "true".
       Accepting only "set" made the whole mechanism a silent no-op on exactly
       the repositories that had bothered to declare anything. */
    const match = line.match(/^(.*): (?:linguist-generated|linguist-vendored): (.*)$/);
    if (match && (match[2] === "set" || match[2] === "true")) {
      generated.add(match[1]);
    }
  }
  return generated;
}

/**
 * Addresses that identify an agent rather than a person.
 *
 * A commit made through a coding agent is often authored as the agent and
 * committed by the human who ran it. On this machine 76 commits are authored
 * `Claude <noreply@anthropic.com>`; in one repository that is 28 of 31 commits,
 * with no `Co-authored-by:` trailer to fall back on, so identity matching alone
 * reported a tenth of the work. For a tool that exists to measure AI-assisted
 * building, discarding exactly the AI-assisted commits is the wrong answer.
 *
 * Credited only when the committer is the user, which is what distinguishes
 * their agent's work from a colleague's.
 */
const AGENT_AUTHORS = new Set(["noreply@anthropic.com"]);

/** Addresses inside `Co-authored-by:` trailer values, which read "Name <a@b>". */
function trailerEmails(raw: string): string[] {
  return [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim().toLowerCase());
}

/**
 * Parse `git log --numstat` output into counters.
 *
 * Exported for tests: building a repository with a known history is easy, but
 * asserting against fixed text is what pins the parser down.
 */
export function parseGitLog(
  raw: string,
  identities: ReadonlySet<string>,
  since: Date | null,
  /** Paths the repository itself declares generated or vendored. */
  declaredGenerated: ReadonlySet<string> = new Set()
): RepoStats {
  const stats = emptyRepoStats();
  const seenCommits = new Set<string>();
  const seenPrs = new Set<string>();
  const cutoff = since && Number.isFinite(since.getTime()) ? since.getTime() : null;
  const mine = identities.size > 0;

  for (const record of raw.split(RECORD)) {
    if (!record.trim()) continue;
    const newline = record.indexOf("\n");
    const header = newline === -1 ? record : record.slice(0, newline);
    const [hash, email, committer, authored, parents, coauthors, subject = ""] =
      header.split(UNIT);
    if (!hash) continue;

    /* Commits by other people are read and discarded. A shared repository is
       the normal case, not the exception — and a co-author trailer counts,
       since that is how pair-programmed and agent-assisted work is credited. */
    if (mine) {
      const author = (email ?? "").trim().toLowerCase();
      const committedBy = (committer ?? "").trim().toLowerCase();
      const credited =
        identities.has(author) ||
        trailerEmails(coauthors ?? "").some((c) => identities.has(c)) ||
        /* Work done through an agent: authored by the agent, committed by the
           person who ran it. Gated on the committer so a colleague's agent
           commits stay theirs. */
        (AGENT_AUTHORS.has(author) && identities.has(committedBy));
      if (!credited) continue;
    }

    /* Filtered here rather than with `--since`, which is not the flag it looks
       like: it compares the COMMITTER date while displaying the author date,
       and it stops traversal at the first commit older than the cutoff rather
       than skipping it. A single rebased or imported commit at HEAD carrying an
       old committer date therefore returns nothing at all. Verified: a two
       commit repository where one was genuinely authored inside the window
       reported zero. Author date, compared here, is the honest boundary. */
    if (cutoff !== null) {
      const when = Date.parse(authored ?? "");
      if (!Number.isFinite(when) || when < cutoff) continue;
    }

    /* The same commit reachable from several branches, or replayed into a
       worktree, must still count once. */
    if (seenCommits.has(hash)) continue;
    seenCommits.add(hash);

    const isMerge = (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1;

    /* A pull request can appear twice in one history — once as the merge commit
       and again as a squashed copy on the trunk — so they are counted by
       number, not by occurrence. */
    const pr = pullRequestRef(subject);
    if (pr) seenPrs.add(pr);

    /* A merge commit introduces no work of its own; its diff is the sum of the
       commits it brings in, every one of which is already counted. Git omits a
       merge's numstat by default, so this mainly keeps the commit tally clean —
       and it is why `--first-parent` must never be added, since that switches
       the merge diff back on and attributes a whole branch to whoever merged. */
    if (isMerge) continue;
    stats.commits += 1;

    if (newline === -1) continue;
    let commitAdded = 0;
    let commitRemoved = 0;
    for (const line of record.slice(newline + 1).split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, file] = line.split("\t");
      if (file === undefined) continue;
      /* numstat writes "-" for both counts on a binary file. There are no
         lines to count, and pretending otherwise would reward committing a
         video. */
      if (added === "-" || removed === "-") continue;
      const plus = Number(added);
      const minus = Number(removed);
      if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
      if (isGeneratedPath(file) || declaredGenerated.has(renameDestination(file))) {
        stats.excludedLines += plus + minus;
        continue;
      }
      /* Scaled to the cap rather than dropped, and proportionally so a
         rewrite that is mostly deletions is not recorded as mostly additions. */
      const churn = plus + minus;
      if (churn > PER_FILE_LINE_CAP) {
        /* Derive one side from the other so the pair sums to exactly the cap;
           rounding both independently drifts by a line. */
        const cappedPlus = Math.round(plus * (PER_FILE_LINE_CAP / churn));
        const cappedMinus = Math.max(0, PER_FILE_LINE_CAP - cappedPlus);
        stats.excludedLines += churn - cappedPlus - cappedMinus;
        commitAdded += cappedPlus;
        commitRemoved += cappedMinus;
        continue;
      }
      commitAdded += plus;
      commitRemoved += minus;
    }

    /* The commit-level ceiling, applied after the per-file one. A commit can
       stay under every file cap and still be a bulk import if it touches
       enough files — the largest on this machine spread 1.3M lines across 86
       of them. */
    const commitChurn = commitAdded + commitRemoved;
    if (commitChurn > PER_COMMIT_LINE_CAP) {
      const scaledAdded = Math.round(
        commitAdded * (PER_COMMIT_LINE_CAP / commitChurn)
      );
      const scaledRemoved = Math.max(0, PER_COMMIT_LINE_CAP - scaledAdded);
      stats.excludedLines += commitChurn - scaledAdded - scaledRemoved;
      commitAdded = scaledAdded;
      commitRemoved = scaledRemoved;
    }
    stats.linesAdded += commitAdded;
    stats.linesRemoved += commitRemoved;
  }

  stats.prs = seenPrs.size;
  return stats;
}

/**
 * Count a repository's contribution since a given moment.
 *
 * Bounded by `since` — normally the moment the project was linked — so that
 * connecting a repository with ten years of history does not retroactively
 * credit a decade of work, and so these counters cover the same window as the
 * token counters they sit beside.
 *
 * Walks the fetched remote-default branch (or `HEAD` for a local-only repo)
 * rather than every ref. The broader `--branches --remotes --tags`
 * sees more, but it also sees both halves of a squash-merge — the original
 * branch commits and the single squashed copy on the trunk — and counts the
 * work twice. From HEAD a squashed pull request is reachable exactly once. The
 * cost is that work on a branch not yet merged is not counted until it lands,
 * which is late rather than wrong. (`--all` would additionally pull in
 * `refs/stash`, where a single stash invents three commits.)
 */
export function collectRepoStats(
  root: string,
  since: Date | null
): RepoStats | null {
  const identities = gitIdentities(root);
  /* With no identity there is no honest way to distinguish this builder's
     work from collaborators'. Returning null keeps "unknown" from becoming
     "credit every author in the repository". */
  if (identities.size === 0) return null;
  const raw = runGit(
    [
      "log",
      shippedRef(root),
      `--format=${RECORD}%H${UNIT}%aE${UNIT}%cE${UNIT}%aI${UNIT}%P${UNIT}%(trailers:key=Co-authored-by,valueonly,separator=${TRAILER})${UNIT}%s`,
      "--numstat",
      /* Follow content through renames and copies rather than scoring a moved
         file as a wholesale delete and rewrite. Rename detection is on by
         default; copy detection is not. */
      "-M",
      "-C",
      /* Collapses a contributor's several addresses onto one identity where the
         repository declares a .mailmap. Not implied outside `git log`. */
      "--use-mailmap",
      "--no-color",
    ],
    root
  );
  /* Null means git failed, was absent, or the repository has no commits yet —
     all of which are "nothing to report", never "zero work done". The caller
     must be able to tell those apart, so it gets null rather than an empty
     tally. */
  if (raw === null) return null;

  /* Pull requests are counted in their own pass, over every branch rather than
     just this one. Merge commits routinely sit outside HEAD's ancestry, and
     measured across 22 real repositories a HEAD-only walk found 0 of 12, 0 of
     16, and 5 of 68 — under-reporting by 30% to 100%. The line and commit walk
     stays on HEAD, where a squash-merged branch is reachable exactly once; this
     pass asks for no diff at all, which is why it can afford the wider view
     (0.6s across every repository on this machine, against 65s with --numstat).

     `--branches --remotes --tags` rather than `--all`, which would drag in
     refs/stash — where a single stash invents three commits. */
  const prRaw = runGit(
    [
      "log",
      "--branches",
      "--remotes",
      "--tags",
      `--format=${RECORD}%H${UNIT}%aE${UNIT}%cE${UNIT}%aI${UNIT}%P${UNIT}%(trailers:key=Co-authored-by,valueonly,separator=${TRAILER})${UNIT}%s`,
      "--use-mailmap",
      "--no-color",
    ],
    root
  );

  /* Every path the history touches, asked about once. Collected from the
     numstat rows rather than the working tree so files deleted long ago are
     still classified by whatever the repository declared about them. */
  const paths = new Set<string>();
  for (const line of raw.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 3 && parts[2]) paths.add(renameDestination(parts[2]));
  }

  const stats = parseGitLog(
    raw,
    identities,
    since,
    declaredGeneratedPaths(root, [...paths])
  );
  if (prRaw !== null) {
    stats.prs = parseGitLog(prRaw, identities, since).prs;
  }
  return stats;
}
