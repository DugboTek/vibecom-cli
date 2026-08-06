import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  RANKS,
  bar,
  compact,
  nextRank,
  progressTo,
  rankFor,
  sparkline,
  streakFrom,
} from "./rank";
import {
  ApiError,
  BUILD,
  VERSION,
  selfUpdate,
  type ConsentInfo,
  type Credentials,
  type Discovered,
  type ProjectSlot,
  clearCredentials,
  copyToClipboard,
  deleteSlot,
  discoverRepos,
  ensureExcluded,
  ensureGitignored,
  listWorktrees,
  projectRoot,
  readProjectToken,
  CANONICAL_ORIGIN,
  GLOBAL_SETTINGS_FILE,
  readGlobalToken,
  GLOBAL_SLOT_ROOT,
  globalTrackingOn,
  removeGlobalSettings,
  writeGlobalSettings,
  recommendedRepos,
  readScanMarks,
  sendRepoStats,
  sendScanned,
  uncoveredWorktrees,
  writeScanMarks,
  fetchAllTiers,
  fetchConsent,
  isTrusted,
  listSlots,
  mintProjectToken,
  newSalt,
  openBrowser,
  pollDeviceToken,
  prepareProjectSettings,
  projectIdFor,
  readCredentials,
  readSlot,
  readTrusted,
  removeProjectSettings,
  resolveOrigin,
  revokeProjectToken,
  sha256,
  settingsPathFor,
  startDeviceFlow,
  trustOwner,
  untrustOwner,
  writeCredentials,
  writeProjectSettings,
  writeSlot,
} from "./core";
import {
  groupBySession,
  kimiWorkdirs,
  transcriptSources,
  type SessionUsage,
} from "./transcripts";
import { collectRepoStats } from "./gitStats";
import { playReel, reelFrames } from "./reel";
import { runDemo } from "./demo";
/* Status glyphs come from clack — its log helpers and spinner.stop prefix
   their own, so only bare console.log lines need one from us. */
import {
  bad,
  banner,
  bigCode,
  bullet,
  canAnimate,
  gradient,
  minus,
  plus,
  pulse,
  rule,
  tierSwatch,
} from "./ui";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Tier = 1 | 2 | 3;

function die(message: string): never {
  p.log.error(message);
  p.outro(pc.dim("nothing was changed"));
  process.exit(1);
}

/** clack returns a cancel symbol on Ctrl-C; treat it as "abort cleanly". */
function orExit<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled. Nothing was changed.");
    process.exit(0);
  }
  return value as T;
}

function requireLogin(): Credentials {
  const cred = readCredentials();
  if (!cred?.token) die("not signed in — run " + pc.bold("vibecom"));
  return cred;
}

function consentNote(consent: ConsentInfo, title: string) {
  p.note(
    [
      ...consent.collects.map((c) => plus(c)),
      "",
      pc.dim("never collected, at any tier:"),
      ...consent.neverCollects.map((c) => minus(c)),
    ].join("\n"),
    title
  );
}

/* ============================================================== sign in === */

async function runLogin(origin: string): Promise<Credentials> {
  const flow = await pulse(
    `contacting ${pc.underline(origin)}`,
    startDeviceFlow(origin)
  ).catch((e) => die(e instanceof ApiError ? e.message : String(e)));

  const copied = copyToClipboard(flow.userCode);
  const approveUrl = `${origin}/device?code=${flow.userCode}`;
  const opened = openBrowser(approveUrl);

  p.log.step(opened ? "Finish signing in in your browser" : "Approve this device");
  console.log();
  console.log(bigCode(flow.userCode));
  console.log(
    copied
      ? `  ${pc.green("✔")} ${pc.dim("copied to your clipboard")}`
      : `  ${pc.dim("type the code above")}`
  );
  console.log();
  console.log(bullet(`${opened ? "opened" : "open"} ${pc.cyan(pc.underline(approveUrl))}`));
  console.log(bullet(pc.dim("the code is prefilled — just press Approve")));
  console.log();

  const spin = p.spinner();
  spin.start("waiting for approval");
  const deadline = Date.now() + 15 * 60_000;
  let result: { access_token: string; username: string } | null = null;
  while (Date.now() < deadline && !result) {
    await sleep(2500);
    try {
      result = await pollDeviceToken(origin, flow.deviceCode);
    } catch {
      /* authorization_pending — keep waiting */
    }
  }
  if (!result) {
    spin.stop(bad("timed out"));
    die("no approval within 15 minutes");
  }
  spin.stop(`signed in as ${pc.bold(result.username)}`);

  const cred: Credentials = {
    token: result.access_token,
    username: result.username,
    origin,
  };
  writeCredentials(cred);
  await repairOriginDrift(cred);
  return cred;
}

/**
 * Re-point tracking at the host you just signed in to.
 *
 * Signing in writes a credential and nothing else, but the exporter endpoint
 * and its bearer token live in settings files written at link time. After a
 * host change those still name the old one, so every upload leaves for an
 * address the new account does not own — and the local checks all pass, because
 * locally everything agrees with itself.
 *
 * Worse, there was no way back: the menu offers whole-machine tracking only
 * while it is off, so a machine already tracking the wrong host had no route to
 * the right one. Doing it here means the fix is the command that doctor already
 * tells people to run.
 */
async function repairOriginDrift(cred: Credentials): Promise<void> {
  const stale = listSlots().filter((slot) => slot.origin !== cred.origin);
  if (stale.length === 0) return;

  const globalSlot = stale.find((slot) => slot.root === GLOBAL_SLOT_ROOT);
  if (globalSlot) {
    p.log.step(
      `moving tracking from ${pc.dim(globalSlot.origin)} to ${pc.cyan(cred.origin)}`
    );
    /* Revoke first: the old token stays valid on the old host otherwise, and
       a bearer token nobody is watching is worth nothing to keep. */
    await revokeProjectToken(globalSlot.origin, cred.token, globalSlot.projectId)
      .catch(() => undefined);
    deleteSlot(GLOBAL_SLOT_ROOT);
    removeGlobalSettings();
    await linkGlobal(cred, cred.origin);
  }

  const projects = stale.filter((slot) => slot.root !== GLOBAL_SLOT_ROOT);
  for (const slot of projects) {
    p.log.warn(
      `${pc.bold(slot.label)} still reports to ${pc.dim(slot.origin)} — ` +
        `choose "Stop collecting from a project" to drop it`
    );
  }
}

/** Sign in if needed; otherwise return the stored credentials untouched. */
async function ensureLogin(): Promise<Credentials> {
  const existing = readCredentials();
  if (existing?.token) return existing;
  return runLogin(resolveOrigin());
}

/* ================================================================= link === */

function repoHint(repo: Discovered, username: string): string {
  if (repo.linked) return pc.yellow(`linked · tier ${repo.linked.tier}`);
  if (!repo.owner) return pc.dim("no remote");
  if (repo.owner.toLowerCase() === username.toLowerCase())
    return pc.green(`${repo.owner} · yours`);
  if (isTrusted(repo.owner)) return pc.green(`${repo.owner} · trusted`);
  return pc.yellow(`${repo.owner} · needs review`);
}

async function stepPickProjects(
  repos: Discovered[],
  cred: Credentials,
  initial: string[]
): Promise<Discovered[]> {
  const picked = orExit(
    await p.multiselect({
      message: `Which projects should report telemetry? ${pc.dim("(space to select)")}`,
      options: repos.map((r) => ({
        value: r.root,
        label: r.label,
        hint: repoHint(r, cred.username),
      })),
      initialValues: initial.filter((v) => repos.some((r) => r.root === v)),
      required: true,
    })
  );
  return repos.filter((r) => (picked as string[]).includes(r.root));
}

type TierOption = { id: number; name: string; unlocks: string };

async function stepPickTier(
  options: TierOption[],
  initial: Tier
): Promise<Tier> {
  return orExit(
    await p.select({
      message: "How much should vibecom see?",
      options: options.map((t) => ({
        value: t.id as Tier,
        label: `${tierSwatch(t.id)}  ${pc.bold(t.name)}`,
        hint: t.unlocks,
      })),
      initialValue: initial,
    })
  );
}

/**
 * Everything is reversible up to this point — nothing has been written and no
 * token has been minted, so "change my mind" is just another loop iteration.
 */
async function stepReview(
  selected: Discovered[],
  tier: Tier,
  consent: ConsentInfo,
  origin: string
): Promise<"apply" | "projects" | "tier" | "cancel"> {
  p.note(
    [
      ...selected.map((r) => `  ${pc.green("›")} ${pc.bold(r.label)} ${pc.dim(r.root)}`),
      "",
      `${tierSwatch(tier)}  tier ${tier} — ${pc.bold(consent.name)}`,
      pc.dim(`reporting to ${origin}`),
    ].join("\n"),
    "about to link"
  );

  return orExit(
    await p.select({
      message: "Ready?",
      options: [
        { value: "apply" as const, label: `${pc.green("Yes, link them")}` },
        { value: "projects" as const, label: "Change which projects" },
        { value: "tier" as const, label: "Change what's shared" },
        { value: "cancel" as const, label: pc.dim("Cancel") },
      ],
      initialValue: "apply" as const,
    })
  );
}

/** Ownership review, once per unknown owner. Returns false if the user backs out. */
async function reviewOwnership(
  selected: Discovered[],
  cred: Credentials,
  origin: string
): Promise<boolean> {
  for (const repo of selected) {
    const unknown =
      repo.owner &&
      repo.owner.toLowerCase() !== cred.username.toLowerCase() &&
      !isTrusted(repo.owner);
    if (!unknown) continue;

    p.log.warn(
      `${pc.bold(repo.label)} belongs to ${pc.bold(repo.owner!)}, not you`
    );
    console.log(bullet(pc.dim(repo.remote ?? "")));
    console.log(
      bullet(
        `${pc.red("Employer or client code?")} Do not link it — telemetry goes to ${origin}.`
      )
    );
    const trust = orExit(
      await p.confirm({
        message: `Do you control ${pc.bold(repo.owner!)}?`,
        initialValue: false,
      })
    );
    if (!trust) {
      p.log.error(`skipping ${repo.label}`);
      return false;
    }
    trustOwner(repo.owner!);
    p.log.success(`trusted ${repo.owner} — you won't be asked again`);
  }
  return true;
}

async function applyLinks(
  cred: Credentials,
  origin: string,
  selected: Discovered[],
  tier: Tier
): Promise<number> {
  const spin = p.spinner();
  let count = 0;
  for (const repo of selected) {
    spin.start(`linking ${repo.label}`);
    const salt = repo.linked?.salt ?? newSalt();
    const projectId = projectIdFor(salt, repo.root);
    const trees = listWorktrees(repo.root);
    let added = false;
    try {
      // Establish and verify ignore protection before the server creates a
      // bearer token or any checkout receives it.
      added = ensureGitignored(repo.root);
      ensureExcluded(repo.root);
      for (const tree of trees) prepareProjectSettings(tree);
    } catch (error) {
      spin.stop(
        bad(`${repo.label}: ${error instanceof Error ? error.message : error}`)
      );
      continue;
    }
    let token: string;
    try {
      token = (
        await mintProjectToken(origin, cred.token, {
          projectId,
          projectLabel: repo.label,
          tier,
        })
      ).access_token;
    } catch (e) {
      spin.stop(bad(`${repo.label}: ${e instanceof Error ? e.message : e}`));
      continue;
    }
    /* Every checkout gets the config, not just the one we are standing in.
       A worktree starts with no .claude/settings.local.json — the file is
       gitignored, so `git worktree add` never copies it — and agent tools do
       all their work in worktrees. Covering only the main checkout would mean
       tracking almost nothing, silently. */
    try {
      for (const tree of trees) writeProjectSettings(tree, origin, token);
    } catch (error) {
      await revokeProjectToken(origin, cred.token, projectId).catch(() => undefined);
      spin.stop(
        bad(`${repo.label}: ${error instanceof Error ? error.message : error}`)
      );
      continue;
    }
    writeSlot({
      root: repo.root,
      salt,
      projectId,
      tier,
      label: repo.label,
      origin,
      linkedAt: new Date().toISOString(),
    });
    const extra = trees.length - 1;
    spin.stop(
      `${pc.bold(repo.label)} ${pc.dim("→")} ${projectId.slice(0, 12)}…` +
        (extra > 0 ? pc.dim(`  +${extra} worktree${extra === 1 ? "" : "s"}`) : "") +
        (added ? pc.dim("  (+.gitignore)") : "")
    );
    count++;
  }
  return count;
}

/** The link wizard. Steps loop until the review step is accepted. */
async function runLink(cred: Credentials, searchDir: string): Promise<number> {
  const origin = cred.origin || resolveOrigin();
  const repos = await pulse(
    `scanning ${pc.dim(searchDir)}`,
    Promise.resolve(discoverRepos(searchDir))
  );
  if (repos.length === 0) {
    p.log.error(`no git repositories found under ${searchDir}`);
    return 0;
  }

  const tierOptions = (
    await pulse("loading permission tiers", fetchAllTiers(origin))
  ).tiers;

  const here = projectRoot();
  let selected: Discovered[] = [];
  let tier: Tier = 1;
  let consent: ConsentInfo | null = null;
  let stage: "projects" | "tier" | "review" = "projects";
  /* Preselect through the same predicate that decides what is safe to choose
     automatically, rather than "whatever repo I'm standing in". Those differed:
     quickStart would refuse an employer's repo, then hand off to this chooser
     with that exact repo already ticked — telling the person we would not guess
     while a guess sat on screen, pre-made. An unsafe repo now starts unticked
     and requires a deliberate keystroke. */
  let initialSelection = recommendedRepos(repos, cred.username, here).map(
    (repo) => repo.root
  );

  /* Nothing is written and no token is minted until the review step is
     accepted, so backing up is just another turn of this loop. Selections and
     the chosen tier persist across it — going back never costs you your place. */
  for (;;) {
    if (stage === "projects") {
      selected = await stepPickProjects(repos, cred, initialSelection);
      initialSelection = selected.map((r) => r.root);
      stage = "tier";
      continue;
    }
    if (stage === "tier") {
      tier = await stepPickTier(tierOptions, tier);
      if (!consent || consent.tier !== tier) {
        consent = await fetchConsent(origin, tier);
      }
      consentNote(consent, `tier ${tier} — ${consent.name}`);
      stage = "review";
      continue;
    }
    if (!consent) consent = await fetchConsent(origin, tier);
    const action = await stepReview(selected, tier, consent, origin);
    if (action === "projects" || action === "tier") {
      stage = action;
      continue;
    }
    if (action === "cancel") {
      p.log.warn("Cancelled. Nothing was changed.");
      return 0;
    }
    break;
  }

  if (!(await reviewOwnership(selected, cred, origin))) return 0;
  const count = await applyLinks(cred, origin, selected, tier);
  if (count > 0) {
    p.note(
      [
        `Reporting to ${pc.bold(origin)} at tier ${tier}.`,
        "",
        pc.dim("Restart Claude Code inside these projects — env is read at"),
        pc.dim("session start, so a running session won't pick it up."),
      ].join("\n"),
      `linked ${count}`
    );
  }
  return count;
}

/**
 * Track every project on this machine, now and in future, with one decision.
 *
 * Per-repository linking put an administrative step between a person and the
 * work they sat down to do, in a directory they had usually just created — and
 * skipping it was silent. No warning, no empty state, just months of sessions
 * that were never counted. Whole-machine tracking is the behaviour people
 * already assume they are getting.
 */
async function linkGlobal(cred: Credentials, origin: string): Promise<boolean> {
  const existing = readSlot(GLOBAL_SLOT_ROOT);
  const salt = existing?.salt ?? newSalt();
  const projectId = projectIdFor(salt, GLOBAL_SLOT_ROOT);
  const spin = p.spinner();
  spin.start("turning on tracking for this machine");
  let token: string;
  try {
    token = (
      await mintProjectToken(origin, cred.token, {
        projectId,
        projectLabel: "all projects",
        tier: 1,
      })
    ).access_token;
  } catch (error) {
    spin.stop(bad(error instanceof Error ? error.message : String(error)));
    return false;
  }
  try {
    writeGlobalSettings(origin, token);
  } catch (error) {
    await revokeProjectToken(origin, cred.token, projectId).catch(() => undefined);
    spin.stop(bad(error instanceof Error ? error.message : String(error)));
    return false;
  }
  writeSlot({
    root: GLOBAL_SLOT_ROOT,
    salt,
    projectId,
    tier: 1,
    label: "everything on this machine",
    origin,
    linkedAt: new Date().toISOString(),
  });
  spin.stop(`${pc.green("✔")} tracking every project on this machine`);
  return true;
}

/**
 * First run: turn on tracking for the whole machine, in one keystroke.
 *
 * The old flow discovered repositories, proposed a subset, and connected those
 * — which meant every project created afterwards was silently uncounted until
 * somebody remembered to come back and link it. Nobody remembers. Default to
 * the machine and let people carve pieces back out.
 */
async function quickStart(cred: Credentials, searchDir: string): Promise<number> {
  const origin = cred.origin || resolveOrigin();
  const tools = await pulse(
    "looking for your coding tools",
    Promise.resolve(
      transcriptSources()
        .filter((source) => source.files.length > 0)
        .map((source) =>
          source.tool === "claude-code"
            ? "Claude Code"
            : source.tool === "codex"
              ? "Codex"
              : "Kimi"
        )
    )
  );

  p.note(
    [
      `${pc.bold("Tracking")}  every project on this computer`,
      `${pc.bold("Found")}     ${
        tools.length > 0
          ? tools.join(" + ")
          : "no past sessions yet — new ones will be counted"
      }`,
      "",
      "New projects count automatically — no setup per repository,",
      "and worktrees are covered too.",
      "",
      pc.dim("Activity totals only. Never your code or prompts."),
      pc.dim("Exclude any project later with vibecom."),
    ].join("\n"),
    "ready to connect"
  );

  const proceed = orExit(
    await p.confirm({
      message: "Track my token usage everywhere?",
      initialValue: true,
    })
  );
  if (!proceed) {
    p.log.info("Skipped. Nothing was changed or collected.");
    return 0;
  }

  if (!(await linkGlobal(cred, origin))) {
    p.log.warn(
      "Nothing was connected, and nothing is being collected. " +
        "Fix the problem above, then run vibecom again."
    );
    return 0;
  }
  const count = 1;
  void searchDir;

  /* The reel covers the scan, which is real waiting — thousands of transcripts
     off disk and a round trip per batch. Both run together, so the story costs
     nothing and the wait stops feeling like one. */
  const scanning = runScan();
  await playReel(cred.username);
  const scan = await pulse("importing your token history", scanning);
  for (const failure of scan.failed) p.log.warn(failure);
  if (scan.tokens > 0) {
    p.note(
      rankCard(scan.tokens, scan.days, `${origin}/u/${cred.username}`),
      pc.bold(gradient("  your rank  "))
    );
  }
  /* showState draws a fuller "you're live" immediately after this, so a second
     box under the same title read as a stutter — two success panels claiming
     the same thing. Report only what the import did; the state screen owns the
     summary. */
  if (scan.sessions > 0) {
    p.log.success(
      `Imported ${scan.sessions} coding session${scan.sessions === 1 ? "" : "s"}.`
    );
  }
  return count;
}

/**
 * Cover worktrees added since a project was linked.
 *
 * No git hook fires on `git worktree add`, and agent tools create them
 * constantly, so the only reliable moment to heal is the next time the CLI
 * runs. Reuses the existing token — this is not a new grant, it is the same
 * consent reaching a checkout that git skipped.
 */
function syncWorktrees(): { project: string; covered: string[] }[] {
  const healed: { project: string; covered: string[] }[] = [];
  for (const slot of listSlots()) {
    const token = readProjectToken(slot.root);
    if (!token) continue; // main checkout gone or unlinked by hand
    const missing = uncoveredWorktrees(slot.root);
    if (missing.length === 0) continue;
    for (const tree of missing) writeProjectSettings(tree, slot.origin, token);
    ensureExcluded(slot.root);
    healed.push({ project: slot.label, covered: missing });
  }
  return healed;
}

function reportSync(healed: ReturnType<typeof syncWorktrees>) {
  for (const { project, covered } of healed) {
    p.log.success(
      `${pc.bold(project)}: covered ${covered.length} new worktree${covered.length === 1 ? "" : "s"}`
    );
    for (const tree of covered) console.log(bullet(pc.dim(tree)));
  }
}

/* ================================================================ scan === */

/**
 * Derive usage from transcripts the tools have already written to disk.
 *
 * This is the only way to cover a session that is already running: OTLP env
 * vars are read once at process start, so an agent mid-flight can never be
 * made to export. It also supplies the user-turn count, which the live metrics
 * stream does not carry — and therefore the only basis for verified one-shot.
 *
 * A session is only sent if its working directory belongs to a project you
 * have linked. Everything else on disk is ignored.
 */
/**
 * Every changed session is restated so counters and duration buckets stay one
 * coherent snapshot. `full` bypasses the unchanged-session marks as well,
 * which backfills historical sessions whose old rows predate event timing.
 */
async function runScan(
  full = false,
  progress?: { label: string }
): Promise<{
  sent: number;
  sessions: number;
  skipped: number;
  byTool: Record<string, number>;
  failed: string[];
  repos: number;
  /* Totals for the rank card. The scan already walks every session; deriving
     these here costs nothing and avoids a second pass or a server round-trip
     just to tell somebody what they earned. */
  tokens: number;
  days: string[];
}> {
  const slots = listSlots();
  if (slots.length === 0)
    return {
      sent: 0,
      sessions: 0,
      skipped: 0,
      byTool: {},
      failed: [],
      repos: 0,
      tokens: 0,
      days: [],
    };

  const marks = readScanMarks();
  let tokens = 0;
  const days = new Set<string>();
  const kimiDirs = kimiWorkdirs();

  const allFiles = transcriptSources().flatMap((source) =>
    source.files.map((file) => ({ source, file }))
  );
  const parsed: SessionUsage[] = [];
  let read = 0;
  for (const { source, file } of allFiles) {
    read += 1;
    if (progress && read % 40 === 0) {
      progress.label = `reading transcripts — ${read}/${allFiles.length}`;
      /* Hand the loop back so the spinner can paint. Scanning is synchronous
         file I/O across thousands of transcripts and would otherwise hold the
         event loop for the whole run, which is why it looked frozen. */
      await new Promise((resolve) => setImmediate(resolve));
    }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      let usage: SessionUsage | null = null;
      try {
        usage = source.parse(file, 0);
      } catch {
        continue;
      }
      if (!usage) continue;
      usage.mtimeMs = stat.mtimeMs;

      parsed.push(usage);
  }

  /* Claude resumes replay records with stable message ids, while Claude/Kimi
     child agents write separate wires that are real additional work. The
     transcript module knows those formats and merges each execution tree
     without either multiplying replays or dropping child-agent usage. */
  const grouped = groupBySession(parsed);

  const byProject = new Map<string, { usage: SessionUsage; key: string }[]>();
  let skipped = 0;
  const byTool: Record<string, number> = {};

  for (const usage of grouped) {
    const key = `${usage.tool}:${usage.sessionId}`;
    const mark = full ? undefined : marks[key];
    if (
      !full &&
      mark &&
      mark.activityVersion === 1 &&
      mark.scanVersion === 2 &&
      mark.file === usage.file &&
      mark.lines === usage.lines &&
      mark.mtimeMs === usage.mtimeMs
    ) {
      continue; // unchanged since last scan
    }

    if (!usage.model && mark?.model) usage.model = mark.model;
    const cwd = usage.cwd ?? kimiDirs.get(usage.sessionId) ?? null;
    const root = cwd ? projectRoot(cwd) : null;
    /* The machine-wide slot has no directory of its own, so it can never win
       a path comparison. Without it as the fallback every session lands in
       "unlinked projects — ignored" and the import quietly does nothing while
       live telemetry keeps flowing. A specific project still wins when one
       matches, so mixed setups keep their per-project tiers. */
    const globalSlot = slots.find((s) => s.root === GLOBAL_SLOT_ROOT);
    const slot =
      (root
        ? slots.find((s) => s.root === root)
        : usage.workspaceHash
          ? slots.find((s) => sha256(s.root).startsWith(usage.workspaceHash!))
          : mark?.root
            ? slots.find((s) => s.root === mark.root)
            : undefined) ?? globalSlot;

    if (!slot) {
      skipped++;
      continue;
    }

    /* Duration-aware imports restate the whole changed session. That lets the
       server replace both counters and hour buckets together, instead of
       trying to subtract an evolving time histogram on the client. */
    const total =
      usage.turns +
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheCreationTokens +
      usage.costUsd +
      usage.activity.reduce((sum, bucket) => sum + bucket.seconds, 0);
    if (total === 0) {
      marks[key] = markFor(usage, slot.root, mark?.model);
      continue;
    }
    byProject.set(slot.root, [
      ...(byProject.get(slot.root) ?? []),
      { usage, key },
    ]);
    byTool[usage.tool] = (byTool[usage.tool] ?? 0) + 1;
    tokens +=
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheCreationTokens;
    for (const bucket of usage.activity) {
      days.add(new Date(bucket.bucketAtMs).toISOString().slice(0, 10));
    }
  }

  let sent = 0;
  let sessions = 0;
  const failed = new Set<string>();

  for (const [root, list] of byProject) {
    const slot = slots.find((s) => s.root === root)!;
    const token =
      slot.root === GLOBAL_SLOT_ROOT
        ? readGlobalToken()
        : readProjectToken(slot.root);
    if (!token) continue;
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i + 50);
      try {
        const res = await sendScanned(
          slot.origin,
          token,
          batch.map((b) => ({
            tool: b.usage.tool,
            sessionId: b.usage.sessionId,
            model: b.usage.model,
            turns: b.usage.turns,
            inputTokens: b.usage.inputTokens,
            outputTokens: b.usage.outputTokens,
            cacheReadTokens: b.usage.cacheReadTokens,
            cacheCreationTokens: b.usage.cacheCreationTokens,
            costUsd: b.usage.costUsd,
            unpricedTokens: b.usage.unpricedTokens,
            modelUsage: b.usage.modelUsage,
            startedAtMs: b.usage.startedAtMs ?? undefined,
            endedAtMs: b.usage.endedAtMs ?? b.usage.mtimeMs,
            activity: b.usage.activity,
          }))
        );
        sent += res.accepted;
        sessions += batch.length;
        for (const b of batch) marks[b.key] = markFor(b.usage, slot.root);
      } catch (e) {
        // one line per project, not per batch
        failed.add(`${slot.label}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  writeScanMarks(marks);

  /* A second pass over every linked project, not just the ones with changed
     sessions. Commits land without a transcript all the time — a rebase, a
     merge, work done outside any AI tool — so gating this on transcript
     activity would leave the counters permanently stale. */
  const repos = await sendGitStats(slots, failed);

  return {
    sent,
    sessions,
    skipped,
    byTool,
    failed: [...failed],
    repos,
    tokens,
    days: [...days].sort(),
  };
}

/**
 * Read git counters for each linked project and restate them.
 *
 * Totals are cumulative over the linked repository's full shipped history,
 * rather than deltas, and every scan
 * sends the whole figure again. That is what makes `rescan` a repair: the
 * server replaces the previous copy instead of adding to it, so a corrected
 * count converges rather than compounding.
 */
async function sendGitStats(
  slots: ProjectSlot[],
  failed: Set<string>
): Promise<number> {
  let sent = 0;
  for (const slot of slots) {
    const token = readProjectToken(slot.root);
    if (!token) continue;

    /* Transcript rescans import historical work, so the craft counters beside
       them must use the same lifetime scope. Applying linkedAt here made a
       profile compare years of token history with only days of git history. */
    const stats = collectRepoStats(slot.root, null);
    /* Null means the directory is not a repository, git is unavailable, or
       nothing has been committed yet. None of those are "zero work" — sending
       zeros would overwrite a real count with a wrong one. */
    if (!stats) {
      failed.add(
        `${slot.label}: git stats unavailable (check repository history and user.email)`
      );
      continue;
    }

    try {
      await sendRepoStats(slot.origin, token, [stats]);
      sent += 1;
    } catch (e) {
      failed.add(`${slot.label}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return sent;
}

/** Record the session totals now known to be on the server. */
function markFor(u: SessionUsage, root: string, model?: string | null) {
  return {
    turns: u.turns,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    costUsd: u.costUsd,
    unpricedTokens: u.unpricedTokens,
    file: u.file,
    lines: u.lines,
    mtimeMs: u.mtimeMs,
    root,
    model: u.model ?? model ?? null,
    activityVersion: 1 as const,
    scanVersion: 2 as const,
  };
}

/* =============================================================== wizard === */

function slotChoices(slots: ProjectSlot[]) {
  return slots.map((s) => ({
    value: s.root,
    label: `${tierSwatch(s.tier)}  ${s.label}`,
    hint: s.origin,
  }));
}

async function menu(cred: Credentials): Promise<boolean> {
  const slots = listSlots();
  const ready = slots.length > 0;
  const action = orExit(
    await p.select({
      /* The prompt used to be "What next?" with an action preselected, which
         asks a finished person to pick more work and makes leaving look like
         abandoning something. When projects are connected there is nothing
         left to do, so say so and default to Done — the highlighted row is the
         strongest signifier on the screen and it should point at the intended
         end of the flow, not away from it. */
      /* "Nothing else is needed" is only true once the machine is covered.
         While it is not, the useful default is the thing that covers it. */
      message: !globalTrackingOn()
        ? "Want everything on this computer counted?"
        : ready
          ? "Nothing else is needed. Anything you want to change?"
          : "What next?",
      initialValue: !globalTrackingOn() ? "global" : ready ? "done" : "link",
      options: [
        ...(ready && globalTrackingOn()
          ? [
              {
                value: "done" as const,
                label: `${pc.green("Done")} ${pc.dim("— start building")}`,
              },
            ]
          : []),
        /* Without this there is no route back to whole-machine tracking:
           declining it at setup, or having linked projects before it existed,
           both leave a menu that can only ever add one repository at a time.
           Offered only while it is off, so it never reads as a duplicate. */
        ...(globalTrackingOn()
          ? []
          : [
              {
                value: "global" as const,
                label: "Track every project on this computer",
                hint: "new projects count automatically",
              },
            ]),
        {
          value: "link",
          // "more" is a claim about state. Offering it with nothing linked —
          // which is exactly what a failed first run leaves behind — tells the
          // person something was connected when nothing was.
          label: ready ? "Connect more projects" : "Connect a project",
        },
        {
          value: "tier",
          label: "Change what a project shares",
          hint: "switch tier",
        },
        {
          value: "scan",
          label: "Import from running + past sessions",
          hint: "no restart needed",
        },
        { value: "preview", label: "See exactly what gets sent" },
        { value: "unlink", label: "Stop collecting from a project" },
        { value: "logout", label: pc.dim("Sign out") },
        // Done is promoted to the top once there is nothing left to set up, so
        // it only belongs down here while setup is still incomplete.
        ...(ready && globalTrackingOn()
          ? []
          : [{ value: "done", label: pc.dim("Done") }]),
      ].filter(
        (o) =>
          slots.length > 0 ||
          !["tier", "preview", "unlink", "scan"].includes(o.value)
      ),
    })
  );

  switch (action) {
    case "global": {
      if (await linkGlobal(cred, cred.origin || resolveOrigin())) {
        const scan = await pulse("importing your token history", runScan());
        for (const failure of scan.failed) p.log.warn(failure);
        if (scan.tokens > 0) {
          p.note(
            rankCard(
              scan.tokens,
              scan.days,
              `${cred.origin}/u/${cred.username}`
            ),
            pc.bold(gradient("  your rank  "))
          );
        }
      }
      return true;
    }
    case "link": {
      const here = projectRoot();
      await runLink(cred, here ? path.dirname(here) : process.cwd());
      return true;
    }
    case "tier": {
      const root = orExit(
        await p.select({
          message: "Which project?",
          options: slotChoices(slots),
        })
      );
      const slot = readSlot(root)!;
      const opts = (
        await pulse("loading permission tiers", fetchAllTiers(slot.origin))
      ).tiers;
      const tier = await stepPickTier(opts, slot.tier);
      const consent = await fetchConsent(slot.origin, tier);
      consentNote(consent, `tier ${tier} — ${consent.name}`);
      const go = orExit(
        await p.confirm({
          message: `Change ${pc.bold(slot.label)} to tier ${tier}?`,
          initialValue: true,
        })
      );
      if (go) {
        await applyLinks(
          cred,
          slot.origin,
          [
            {
              root: slot.root,
              label: slot.label,
              owner: null,
              remote: null,
              linked: slot,
              worktrees: listWorktrees(slot.root),
            },
          ],
          tier
        );
      }
      return true;
    }
    case "scan": {
      const r = await pulse("reading transcripts on disk", runScan());
      p.log.success(
        r.sessions === 0
          ? "nothing new since the last scan"
          : `${r.sessions} session(s) imported — ${r.sent} rows`
      );
      return true;
    }
    case "preview": {
      const root = orExit(
        await p.select({
          message: "Which project?",
          options: slotChoices(slots),
        })
      );
      await showPreview(readSlot(root)!);
      return true;
    }
    case "unlink": {
      const root = orExit(
        await p.select({
          message: "Which project?",
          options: slotChoices(slots),
        })
      );
      await doUnlink(cred, readSlot(root)!);
      return true;
    }
    case "logout":
      clearCredentials();
      p.log.success("signed out");
      return false;
    default:
      return false;
  }
}

/**
 * The reward screen: rank, distance to the next one, and the streak.
 *
 * All of this already existed on the server and none of it reached the
 * terminal, which is where people are sitting while the numbers move. A flat
 * "connected" gives no reason to run the command twice. Showing the ladder,
 * how far along the current rung you are, and what the next one is called
 * turns the same data into a reason to come back — the progress is real, so
 * the only thing that was missing was saying it out loud.
 *
 * Named ranks stay unabbreviated: "Senior Vibe Engineer" is the payoff, and
 * truncating it to fit a box would be throwing away the reward to save eight
 * columns.
 */
function rankCard(tokens: number, days: readonly string[], profile: string) {
  const rank = rankFor(tokens);
  const next = nextRank(rank);
  const fraction = progressTo(tokens, rank);
  const streak = streakFrom(days, new Date());
  const recent = days.slice(-14);
  const perDay = recent.map(() => 1);

  const lines = [
    `${gradient("  ▲  ")} ${pc.bold(rank.name)}  ${pc.dim(`lv ${rank.level}/${RANKS.length}`)}`,
    "",
    `  ${gradient(bar(fraction))}  ${pc.bold(`${Math.round(fraction * 100)}%`)}`,
    next
      ? `  ${pc.dim(`${compact(Math.max(0, next.minTokens - tokens))} tokens to `)}${pc.bold(next.short)}`
      : `  ${pc.green("top of the ladder — nothing left to climb")}`,
    "",
    `  ${pc.bold(compact(tokens))} ${pc.dim("tokens")}   ${pc.bold(
      String(days.length)
    )} ${pc.dim("active day" + (days.length === 1 ? "" : "s"))}`,
  ];

  if (streak > 0) {
    lines.push(
      `  ${pc.yellow("🔥")} ${pc.bold(`${streak} day streak`)}${
        recent.length > 1 ? `  ${pc.dim(sparkline(perDay))}` : ""
      }`
    );
  }
  lines.push("", pc.dim(`  ${profile}`));
  return lines.join("\n");
}

/**
 * Say what is true right now, before offering anything to change.
 *
 * Answers the three questions a person arrives at this screen holding: am I
 * set up, what is being collected, and where does it show up. Each line is a
 * fact with a visible marker, so the state is readable at a glance rather
 * than inferred from which menu items happen to be present.
 */
function showState(cred: Credentials) {
  const slots = listSlots();
  const tools = transcriptSources()
    .filter((source) => source.files.length > 0)
    .map((source) =>
      source.tool === "claude-code"
        ? "Claude Code"
        : source.tool === "codex"
          ? "Codex"
          : "Kimi"
    );
  const worktrees = slots.reduce(
    (total, slot) => total + Math.max(0, listWorktrees(slot.root).length - 1),
    0
  );

  if (slots.length === 0) {
    p.note(
      [
        `${pc.yellow("○")} Signed in as ${pc.bold(cred.username)}.`,
        `${pc.yellow("○")} No projects connected — nothing is being collected.`,
        "",
        pc.dim(
          globalTrackingOn()
            ? "Choose Connect a project below to start."
            : "Track everything, or connect one project — both are below."
        ),
      ].join("\n"),
      "where you are"
    );
    return;
  }

  p.note(
    [
      `${pc.green("✔")} Signed in as ${pc.bold(cred.username)}`,
      globalTrackingOn()
        ? `${pc.green("✔")} Collecting from ${pc.bold(
            "every project on this computer"
          )}${pc.dim(" — new ones count automatically")}`
        : `${pc.green("✔")} Collecting from ${pc.bold(
            `${slots.length} project${slots.length === 1 ? "" : "s"}`
          )}${worktrees > 0 ? pc.dim(`  +${worktrees} worktree${worktrees === 1 ? "" : "s"}`) : ""}`,
      ...(globalTrackingOn()
        ? []
        : slots.map((slot) => `    ${pc.dim("·")} ${slot.label}`)),
      tools.length > 0
        ? `${pc.green("✔")} Reading ${pc.bold(tools.join(" + "))}`
        : `${pc.yellow("○")} No coding sessions found yet — new ones will count`,
      "",
      /* Claiming "set up" while only some projects are covered is the same
         mistake as the old "Found supported session files": the screen states
         a completeness the configuration does not have, and the person has no
         reason to look for the option that would fix it. */
      ...(globalTrackingOn()
        ? [
            `${pc.bold("You're set up.")} Just code — activity uploads on its own.`,
            pc.dim(`Your profile: ${cred.origin}/u/${cred.username}`),
            "",
            pc.dim("Nothing else is required. Choose Done to exit."),
          ]
        : [
            `${pc.yellow("Only these projects count.")} Anything you build`,
            `elsewhere on this computer is ${pc.bold("not")} being tracked.`,
            pc.dim(`Your profile: ${cred.origin}/u/${cred.username}`),
            "",
            `${pc.bold("Track every project on this computer")} ${pc.dim(
              "— first option below"
            )}`,
          ]),
    ].join("\n"),
    pc.green("you're live")
  );
}

/** `vibecom` with no arguments: sign in if needed, connect, then stay open. */
async function wizard() {
  await banner("the community for AI builders");
  const existing = readCredentials();
  p.intro(gradient(existing ? "  vibecom  " : "  welcome  "));

  const cred = await ensureLogin();
  if (!existing) {
    p.note(
      [
        `Signed in as ${pc.bold(cred.username)} on ${pc.bold(cred.origin)}.`,
        "",
        `${pc.green("Nothing is being collected yet.")} Your shell profile,`,
        pc.dim("Claude Code settings, and Codex config were not touched."),
      ].join("\n"),
      "you're in"
    );
  }

  reportSync(syncWorktrees());

  // First run with nothing linked goes straight into connecting.
  if (listSlots().length === 0) {
    const here = projectRoot();
    await quickStart(cred, here ? path.dirname(here) : process.cwd());
  }

  /* Setup used to end by dropping straight into "What next?" with an action
     preselected. Nothing said the work had finished, nothing said what was now
     true, and the highlighted row proposed more work — so a person who was
     actually done had no way to tell that they were. State the outcome before
     offering the menu. */
  showState(cred);

  while (await menu(cred));
  p.outro(
    `${pc.dim("run")} ${pc.bold("vibecom")} ${pc.dim("anytime to change this")}`
  );
}

/* ============================================================= commands === */

async function showPreview(slot: ProjectSlot) {
  const consent = await pulse(
    "fetching the policy this server enforces",
    fetchConsent(slot.origin, slot.tier)
  );
  p.log.step(`${pc.bold(slot.label)} ${pc.dim(slot.root)}`);
  console.log(bullet(`tier    ${tierSwatch(slot.tier)} ${consent.name}`));
  console.log(bullet(`sent to ${pc.cyan(slot.origin)}`));
  console.log(bullet(`sent as ${pc.dim(slot.projectId)}`));
  console.log();
  consentNote(consent, "collection policy");
  p.note(
    JSON.stringify(
      {
        userId: readCredentials()?.username ?? "you",
        source: "claude-code",
        metricType: "session.turns",
        value: 1,
        model: "claude-opus-5",
        sessionId: "a1b2c3d4-…",
        projectId: slot.projectId,
      },
      null,
      2
    )
      .split("\n")
      .map((l) => pc.dim(l))
      .join("\n"),
    "every row that leaves looks like this"
  );
}

async function doUnlink(cred: Credentials, slot: ProjectSlot) {
  const confirmed = orExit(
    await p.confirm({
      message: `Stop collecting from ${pc.bold(slot.label)}?`,
      initialValue: true,
    })
  );
  if (!confirmed) {
    p.log.warn("left as-is");
    return;
  }
  await pulse(
    "revoking the token",
    revokeProjectToken(slot.origin, cred.token, slot.projectId).catch(() => {
      p.log.warn(`could not reach ${slot.origin}; removing local config anyway`);
      return { ok: false };
    })
  );
  let checkouts = 0;
  if (slot.root === GLOBAL_SLOT_ROOT) {
    /* Nothing on disk belongs to a repository here — the exporter lives in
       Claude Code's user-level settings, so leaving it behind would keep
       pointing every project at a token that was just revoked. */
    removeGlobalSettings();
  } else {
    // strip every checkout, or a stale worktree keeps a now-revoked token on disk
    const trees = listWorktrees(slot.root);
    for (const tree of trees) removeProjectSettings(tree);
    checkouts = trees.length;
  }
  deleteSlot(slot.root);
  p.log.success(
    `unlinked ${slot.label}${checkouts > 1 ? pc.dim(` (${checkouts} checkouts)`) : ""}`
  );
  p.note(
    [
      "Token revoked server-side and the local salt deleted, so this",
      "project's past rows can never be re-associated with a new link.",
      "",
      pc.dim(
        `cleaned ${
          slot.root === GLOBAL_SLOT_ROOT
            ? GLOBAL_SETTINGS_FILE
            : settingsPathFor(slot.root)
        }`
      ),
    ].join("\n"),
    "done"
  );
}

function slotHere(): ProjectSlot {
  const root = projectRoot();
  if (!root) die("not inside a git repository");
  const slot = readSlot(root);
  if (!slot) die("this project is not linked — run " + pc.bold("vibecom"));
  return slot;
}

/**
 * Answer "is it actually tracking me?" without a support thread.
 *
 * Every part of this could be checked by hand — read the settings file, find
 * the token, post to the ingest endpoint, look at the response — and every
 * part of it was, repeatedly, because the pieces live in four places and a
 * silent failure looks exactly like a working install. The whole point is that
 * it ends on a yes or a no.
 */
async function doctor() {
  p.intro(gradient("  doctor  "));
  const problems: string[] = [];
  const say = (ok: boolean, good: string, bad_: string, fix?: string) => {
    console.log(bullet(`${ok ? pc.green("✔") : pc.red("✖")} ${ok ? good : bad_}`));
    if (!ok && fix) problems.push(fix);
  };

  const cred = readCredentials();
  say(
    Boolean(cred),
    `signed in as ${pc.bold(cred?.username ?? "")}`,
    "not signed in",
    "vibecom login"
  );

  const machineWide = globalTrackingOn();
  const slots = listSlots();
  say(
    machineWide || slots.length > 0,
    machineWide
      ? "tracking every project on this computer"
      : `tracking ${slots.length} linked project${slots.length === 1 ? "" : "s"}`,
    "nothing is being tracked",
    "vibecom  (choose Track every project on this computer)"
  );

  /* A token pointing at a host that no longer issues it is the failure mode
     that looks most like success: the file is present, the exporter is
     configured, and every upload is refused. */
  const token = machineWide
    ? readGlobalToken()
    : (slots.map((slot) => readProjectToken(slot.root)).find(Boolean) ?? null);
  say(
    Boolean(token),
    "found the ingest token",
    "no ingest token on disk",
    "vibecom"
  );

  /* Comparing the link against the credential catches a half-migrated setup,
     but not one where both were written against a host that has since moved —
     which passes every local check and fails every upload. Name the canonical
     host as well. */
  const origin = cred?.origin ?? resolveOrigin();
  for (const slotOrigin of new Set(slots.map((slot) => slot.origin))) {
    if (slotOrigin !== origin) {
      say(
        false,
        "",
        `a link points at ${pc.cyan(slotOrigin)} but you are signed in to ${pc.cyan(origin)}`,
        "vibecom  (unlink the stale project, then track this computer)"
      );
    } else if (slotOrigin !== CANONICAL_ORIGIN) {
      say(
        false,
        "",
        `still reporting to ${pc.cyan(slotOrigin)}, which is not ${pc.cyan(CANONICAL_ORIGIN)}`,
        `VIBECOM_ORIGIN=${CANONICAL_ORIGIN} vibecom login` +
          pc.dim("   (re-points tracking at the same time)")
      );
    } else {
      say(true, `reporting to ${pc.cyan(slotOrigin)}`, "");
    }
  }

  if (token) {
    const reachable = await pulse(
      "checking the server accepts this token",
      sendScanned(origin, token, []).then(
        () => true,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
    );
    say(
      reachable === true,
      "the server accepts your token",
      typeof reachable === "string" ? reachable : "the server rejected your token",
      "vibecom login"
    );
  }

  const tools = transcriptSources().filter((source) => source.files.length > 0);
  say(
    tools.length > 0,
    `found sessions from ${tools
      .map((source) => source.tool)
      .join(", ")}`,
    "no Claude Code, Codex or Kimi sessions on this machine yet",
    undefined
  );

  console.log();
  if (problems.length === 0) {
    p.outro(
      `${pc.green("Everything is working.")} ${pc.dim(
        "Code as normal — activity uploads on its own."
      )}`
    );
    return;
  }
  p.note(problems.map((fix) => `  ${pc.bold(fix)}`).join("\n"), "run this");
  p.outro(pc.dim("re-run vibecom doctor when you have"));
}

async function status() {
  const cred = readCredentials();
  p.intro(gradient("  status  "));
  if (cred) {
    p.log.success(
      `${pc.bold(cred.username)} ${pc.dim("on")} ${pc.cyan(cred.origin)}`
    );
  } else {
    p.log.warn("not signed in");
  }

  const slots = listSlots();
  console.log();
  console.log(rule("linked projects"));
  if (slots.length === 0) {
    console.log(bullet(pc.dim("none — nothing is being collected")));
  } else {
    for (const s of slots) {
      const trees = listWorktrees(s.root);
      const missing = uncoveredWorktrees(s.root);
      console.log(
        bullet(
          `${tierSwatch(s.tier)} ${pc.bold(s.label.padEnd(18))} ${pc.dim("→")} ${pc.cyan(s.origin)}`
        )
      );
      console.log(bullet(pc.dim(`   ${s.root}`)));
      if (trees.length > 1) {
        const covered = trees.length - missing.length;
        console.log(
          bullet(
            pc.dim(`   ${covered}/${trees.length} checkouts reporting`) +
              (missing.length > 0
                ? pc.yellow(`  — run vibecom to cover ${missing.length}`)
                : "")
          )
        );
      }
    }
  }

  const trusted = readTrusted();
  if (trusted.length > 0) {
    console.log();
    console.log(rule("trusted owners"));
    for (const o of trusted) console.log(bullet(pc.dim(o)));
  }
  p.outro(`${pc.dim("run")} ${pc.bold("vibecom")} ${pc.dim("to change this")}`);
}

async function help() {
  await banner("the community for AI builders");
  console.log(rule("just run this"));
  console.log(
    bullet(
      `${gradient("vibecom".padEnd(15))} ${pc.dim("sign in, connect projects, change anything")}`
    )
  );
  console.log();
  console.log(rule("or jump straight to one"));
  for (const [cmd, desc] of [
    ["login", "sign in only"],
    ["link [dir]", "connect projects under a directory"],
    ["preview", "show exactly what leaves this repo"],
    ["status", "linked projects and trusted owners"],
    ["doctor", "check tracking really works, end to end"],
    ["demo", "play the onboarding as a simulation, changing nothing"],
    ["sync", "cover worktrees created since linking"],
    ["scan", "import token usage from past sessions"],
    ["rescan", "re-import everything, correcting old timestamps"],
    ["update", "pull the newest CLI from your server"],
    ["unlink", "stop collecting from this repo"],
    ["trust <owner>", "allow repos under an org you control"],
    // Implemented since trust existed but never listed, so the only way to undo
    // a trust decision was to know the command already or edit the config file.
    ["untrust <owner>", "undo that, so its repos need review again"],
    ["logout", "remove stored credentials"],
  ] as [string, string][]) {
    console.log(bullet(`${pc.bold(cmd.padEnd(15))} ${pc.dim(desc)}`));
  }
  console.log();
  console.log(rule("tiers"));
  console.log(bullet(`${tierSwatch(1)}  ${pc.dim("counters — tokens, cost, lines, turns per session")}`));
  console.log(bullet(`${tierSwatch(2)}  ${pc.dim("session shape — tool categories, rework ratio")}`));
  console.log(bullet(`${tierSwatch(3)}  ${pc.dim("named stack — tool, MCP, and skill names")}`));
  console.log();
  console.log(pc.dim("  Nothing is collected until you connect a repository."));
  console.log();
}

const COMMANDS: Record<string, (args: string[]) => Promise<unknown>> = {
  login: async () => {
    await banner("the community for AI builders");
    p.intro(gradient("  sign in  "));
    const cred = await runLogin(resolveOrigin());
    p.outro(`signed in as ${pc.bold(cred.username)} — run ${pc.bold("vibecom")} to connect projects`);
  },
  link: async (args) => {
    const cred = requireLogin();
    await banner("connect your projects");
    p.intro(gradient("  link projects  "));
    const here = projectRoot();
    await runLink(
      cred,
      args[0] ? path.resolve(args[0]) : here ? path.dirname(here) : process.cwd()
    );
    p.outro(`${pc.bold("vibecom")} ${pc.dim("to change anything")}`);
  },
  preview: async () => {
    p.intro(gradient("  preview  "));
    await showPreview(slotHere());
    p.outro(pc.dim("no other shape exists"));
  },
  status: () => status(),
  update: async (args = []) => {
    const origin = resolveOrigin();
    const force = args.includes("--force");
    p.intro(gradient("  update  "));
    const r = await pulse(
      `fetching from ${origin}`,
      selfUpdate(origin, { force })
    );
    if (!r.updated) {
      p.log.success(`already on ${VERSION}, the latest release`);
    } else {
      /* Naming the kind of change is the point of having a version: a user who
         sees "major" knows to expect something to behave differently, which a
         build stamp could never tell them. */
      const kind = r.kind === "unknown" ? "" : ` (${r.kind})`;
      p.log.success(`updated ${r.from} → ${r.version}${kind}`);
    }
    p.outro(pc.dim(`vibecom ${r.updated ? r.version : VERSION} · build ${BUILD}`));
  },
  /**
   * Re-import every session from scratch, restating each one rather than
   * adding to it. Needed because early imports dated rows when they were
   * uploaded rather than when the work happened; the server replaces each
   * session it receives here, so running it twice changes nothing.
   */
  rescan: async () => {
    requireLogin();
    p.intro(gradient("  rescan  "));
    p.log.step(
      "re-reading every transcript and restating each session"
    );
    console.log(
      bullet(
        pc.dim("totals are replaced, not added — safe to run more than once")
      )
    );
    const progress = { label: "re-importing full history" };
    const r = await pulse(progress, runScan(true, progress));
    if (r.sessions === 0) {
      p.log.warn("no sessions found — is anything linked?");
    } else {
      p.log.success(
        `${r.sessions} session(s) restated — ${r.sent} rows accepted`
      );
    }
    for (const f of r.failed) p.log.warn(f);
    if (r.repos > 0) {
      console.log(
        bullet(
          pc.dim(
            `${r.repos} repo(s) counted from git — commits, lines and PRs`
          )
        )
      );
    }
    if (r.skipped > 0) {
      console.log(
        bullet(pc.dim(`${r.skipped} session(s) in unlinked projects — ignored`))
      );
    }
    p.outro(pc.dim("your calendar and clock now reflect when you worked"));
  },
  scan: async () => {
    requireLogin();
    p.intro(gradient("  scan  "));
    const progress = { label: "reading transcripts from Claude Code, Codex and Kimi" };
    const r = await pulse(progress, runScan(false, progress));
    if (r.sessions === 0) {
      p.log.success("nothing new since the last scan");
    } else {
      p.log.success(
        `${r.sessions} session(s) from ${Object.entries(r.byTool)
          .map(([t, n]) => `${t} ×${n}`)
          .join(", ")} — ${r.sent} rows accepted`
      );
    }
    for (const f of r.failed) p.log.warn(f);
    if (r.repos > 0) {
      console.log(
        bullet(
          pc.dim(
            `${r.repos} repo(s) counted from git — commits, lines and PRs`
          )
        )
      );
    }
    if (r.skipped > 0) {
      console.log(
        bullet(pc.dim(`${r.skipped} session(s) in unlinked projects — ignored`))
      );
    }
    p.outro(pc.dim("covers sessions already running; no restart needed"));
  },
  sync: async () => {
    p.intro(gradient("  sync  "));
    const healed = syncWorktrees();
    if (healed.length === 0) {
      p.log.success("every checkout is already reporting");
    } else {
      reportSync(healed);
    }
    p.outro(
      pc.dim(
        `${healed.reduce((n, h) => n + h.covered.length, 0)} checkout(s) covered`
      )
    );
  },
  unlink: async () => {
    const cred = requireLogin();
    p.intro(gradient("  unlink  "));
    await doUnlink(cred, slotHere());
    p.outro(pc.dim("nothing from this project will be collected"));
  },
  trust: async (args) => {
    if (args.length === 0) die("usage: vibecom trust <owner>");
    for (const owner of args) trustOwner(owner);
    p.log.success(`trusted ${args.join(", ")}`);
  },
  untrust: async (args) => {
    if (args.length === 0) die("usage: vibecom untrust <owner>");
    for (const owner of args) untrustOwner(owner);
    p.log.success(`untrusted ${args.join(", ")}`);
    p.log.warn("already-linked projects keep collecting — unlink them too");
  },
  logout: async () => {
    clearCredentials();
    p.log.success("signed out");
    p.log.warn("linked projects keep their own tokens — unlink them or revoke at /settings");
  },
  demo: () => runDemo(),
  doctor: () => doctor(),
  reel: async (args: string[]) => {
    const who = readCredentials()?.username;
    if (args.includes("--frames")) {
      for (const frame of reelFrames(who)) console.log(frame + "\n");
      return;
    }
    await playReel(who);
  },
  help: () => help(),
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === undefined) return wizard();
  if (cmd === "--version" || cmd === "version") {
    console.log(`vibecom ${VERSION} (build ${BUILD})`);
    return;
  }
  const handler = COMMANDS[cmd.replace(/^--/, "")];
  if (!handler) {
    console.log(bad(`unknown command: ${cmd}`));
    await help();
    process.exit(1);
  }
  await handler(args);
}

process.on("SIGINT", () => {
  process.stdout.write("\r\x1b[2K");
  p.cancel("Cancelled. Nothing was changed.");
  process.exit(0);
});

main().catch((e) => {
  p.log.error(e instanceof Error ? e.message : String(e));
  if (!canAnimate) console.error(e);
  process.exit(1);
});
