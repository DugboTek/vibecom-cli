import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  ApiError,
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
  uncoveredWorktrees,
  fetchAllTiers,
  fetchConsent,
  isTrusted,
  listSlots,
  mintProjectToken,
  newSalt,
  pollDeviceToken,
  projectIdFor,
  readCredentials,
  readSlot,
  readTrusted,
  removeProjectSettings,
  resolveOrigin,
  revokeProjectToken,
  settingsPathFor,
  startDeviceFlow,
  trustOwner,
  untrustOwner,
  writeCredentials,
  writeProjectSettings,
  writeSlot,
} from "./core";
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
  if (!cred?.token) die("not signed in — run " + pc.bold("vibeland"));
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

  p.log.step("Approve this device:");
  console.log();
  console.log(bigCode(flow.userCode));
  console.log(
    copied
      ? `  ${pc.green("✔")} ${pc.dim("copied to your clipboard")}`
      : `  ${pc.dim("type the code above")}`
  );
  console.log();
  console.log(bullet(`open ${pc.cyan(pc.underline(approveUrl))}`));
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
  return cred;
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
      message: "How much should vibeland see?",
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
    const trees = listWorktrees(repo.root);
    for (const tree of trees) writeProjectSettings(tree, origin, token);
    const added = ensureGitignored(repo.root);
    ensureExcluded(repo.root);
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
  let initialSelection = [here ?? repos[0].root];

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
  const action = orExit(
    await p.select({
      message: "What next?",
      options: [
        { value: "link", label: "Connect more projects" },
        {
          value: "tier",
          label: "Change what a project shares",
          hint: "switch tier",
        },
        { value: "preview", label: "See exactly what gets sent" },
        { value: "unlink", label: "Stop collecting from a project" },
        { value: "logout", label: pc.dim("Sign out") },
        { value: "done", label: pc.dim("Done") },
      ].filter(
        (o) =>
          slots.length > 0 || !["tier", "preview", "unlink"].includes(o.value)
      ),
    })
  );

  switch (action) {
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

/** `vibeland` with no arguments: sign in if needed, connect, then stay open. */
async function wizard() {
  await banner("telemetry for AI-built software");
  const existing = readCredentials();
  p.intro(gradient(existing ? "  vibeland  " : "  welcome  "));

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
    await runLink(cred, here ? path.dirname(here) : process.cwd());
  }

  while (await menu(cred));
  p.outro(
    `${pc.dim("run")} ${pc.bold("vibeland")} ${pc.dim("anytime to change this")}`
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
  // strip every checkout, or a stale worktree keeps a now-revoked token on disk
  const trees = listWorktrees(slot.root);
  for (const tree of trees) removeProjectSettings(tree);
  deleteSlot(slot.root);
  p.log.success(
    `unlinked ${slot.label}${trees.length > 1 ? pc.dim(` (${trees.length} checkouts)`) : ""}`
  );
  p.note(
    [
      "Token revoked server-side and the local salt deleted, so this",
      "project's past rows can never be re-associated with a new link.",
      "",
      pc.dim(`cleaned ${settingsPathFor(slot.root)}`),
    ].join("\n"),
    "done"
  );
}

function slotHere(): ProjectSlot {
  const root = projectRoot();
  if (!root) die("not inside a git repository");
  const slot = readSlot(root);
  if (!slot) die("this project is not linked — run " + pc.bold("vibeland"));
  return slot;
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
                ? pc.yellow(`  — run vibeland to cover ${missing.length}`)
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
  p.outro(`${pc.dim("run")} ${pc.bold("vibeland")} ${pc.dim("to change this")}`);
}

async function help() {
  await banner("telemetry for AI-built software");
  console.log(rule("just run this"));
  console.log(
    bullet(
      `${gradient("vibeland".padEnd(15))} ${pc.dim("sign in, connect projects, change anything")}`
    )
  );
  console.log();
  console.log(rule("or jump straight to one"));
  for (const [cmd, desc] of [
    ["login", "sign in only"],
    ["link [dir]", "connect projects under a directory"],
    ["preview", "show exactly what leaves this repo"],
    ["status", "linked projects and trusted owners"],
    ["sync", "cover worktrees created since linking"],
    ["unlink", "stop collecting from this repo"],
    ["trust <owner>", "allow repos under an org you control"],
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
    await banner("telemetry for AI-built software");
    p.intro(gradient("  sign in  "));
    const cred = await runLogin(resolveOrigin());
    p.outro(`signed in as ${pc.bold(cred.username)} — run ${pc.bold("vibeland")} to connect projects`);
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
    p.outro(`${pc.bold("vibeland")} ${pc.dim("to change anything")}`);
  },
  preview: async () => {
    p.intro(gradient("  preview  "));
    await showPreview(slotHere());
    p.outro(pc.dim("no other shape exists"));
  },
  status: () => status(),
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
    if (args.length === 0) die("usage: vibeland trust <owner>");
    for (const owner of args) trustOwner(owner);
    p.log.success(`trusted ${args.join(", ")}`);
  },
  untrust: async (args) => {
    if (args.length === 0) die("usage: vibeland untrust <owner>");
    for (const owner of args) untrustOwner(owner);
    p.log.success(`untrusted ${args.join(", ")}`);
    p.log.warn("already-linked projects keep collecting — unlink them too");
  },
  logout: async () => {
    clearCredentials();
    p.log.success("signed out");
    p.log.warn("linked projects keep their own tokens — unlink them or revoke at /settings");
  },
  help: () => help(),
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === undefined) return wizard();
  if (cmd === "--version" || cmd === "version") {
    console.log(`vibeland ${process.env.VIBELAND_VERSION ?? "3.1.0"}`);
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
