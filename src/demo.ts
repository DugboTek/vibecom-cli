import * as p from "@clack/prompts";
import pc from "picocolors";

import { RANKS, bar, compact, nextRank, progressTo, rankFor, sparkline } from "./rank";
import { playReel } from "./reel";
import { banner, bullet, canAnimate, gradient, rule } from "./ui";

/**
 * The onboarding, acted out.
 *
 * Recording the real flow means a real account, a real browser round trip and
 * a real machine whose config you then have to put back — and the interesting
 * screens are exactly the ones a fresh install cannot reach, because by the
 * time there is a rank to show there is no onboarding left to film. This
 * performs the whole arc against nothing: no network, no credentials read or
 * written, no settings touched, no project linked.
 *
 * It is a performance and says so at both ends, so nobody mistakes it for
 * their own state.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Type a line out at a human-ish rate; instant when animation is off. */
async function type(text: string, speedMs = 34): Promise<void> {
  if (!canAnimate) {
    console.log(text);
    return;
  }
  process.stdout.write("  ");
  for (const char of text) {
    process.stdout.write(char);
    // Punctuation gets a beat, which is most of what makes typing read as
    // typing rather than as a progress bar for text.
    await sleep(",.:".includes(char) ? speedMs * 5 : speedMs);
  }
  process.stdout.write("\n");
}

async function beat(ms = 620): Promise<void> {
  if (canAnimate) await sleep(ms);
}

/** A spinner that always succeeds, for steps that are being mimed. */
async function step(label: string, done: string, ms = 1100): Promise<void> {
  const spin = p.spinner();
  spin.start(label);
  await beat(ms);
  spin.stop(`${pc.green("✔")} ${done}`);
}

export async function runDemo(): Promise<void> {
  console.log();
  console.log(
    bullet(
      pc.dim("simulation — nothing is installed, connected, or sent")
    )
  );
  await beat(900);

  await banner("the community for AI builders");
  p.intro(gradient("  welcome  "));

  await type(pc.dim("$ curl -fsSL https://www.vibecom.build/setup.sh | bash"), 26);
  await beat();

  await step("downloading the CLI", "installed to ~/.local/bin/vibecom", 900);
  await step("opening your browser", "signed in as chrismicah", 1400);

  p.note(
    [
      `${pc.bold("Tracking")}  every project on this computer`,
      `${pc.bold("Found")}     Claude Code + Codex`,
      "",
      "New projects count automatically — no setup per repository,",
      "and worktrees are covered too.",
      "",
      pc.dim("Activity totals only. Never your code or prompts."),
    ].join("\n"),
    "ready to connect"
  );
  await beat(800);

  console.log(`${pc.dim("│")}`);
  console.log(`${pc.green("◆")}  Track my token usage everywhere?`);
  console.log(`${pc.dim("│")}  ${pc.green("●")} Yes ${pc.dim("/ ○ No")}`);
  await beat(1000);

  await step(
    "turning on tracking for this machine",
    "tracking every project on this machine",
    1200
  );

  await playReel("chrismicah");

  await step("importing your token history", "imported 143 coding sessions", 1500);

  /* Numbers chosen to land mid-ladder: a rank with a name worth reading, and a
     bar far enough along to look earned but not finished. */
  const tokens = 6_300_000;
  const rank = rankFor(tokens);
  const next = nextRank(rank);
  const fraction = progressTo(tokens, rank);

  p.note(
    [
      `${gradient("  ▲  ")} ${pc.bold(rank.name)}  ${pc.dim(
        `lv ${rank.level}/${RANKS.length}`
      )}`,
      "",
      `  ${gradient(bar(fraction))}  ${pc.bold(`${Math.round(fraction * 100)}%`)}`,
      `  ${pc.dim(
        `${compact(Math.max(0, (next?.minTokens ?? 0) - tokens))} tokens to `
      )}${pc.bold(next?.short ?? "the top")}`,
      "",
      `  ${pc.bold(compact(tokens))} ${pc.dim("tokens")}   ${pc.bold(
        "31"
      )} ${pc.dim("active days")}`,
      `  ${pc.yellow("🔥")} ${pc.bold("12 day streak")}  ${pc.dim(
        sparkline([3, 5, 4, 8, 6, 9, 7, 9, 8, 9, 9, 9])
      )}`,
      "",
      pc.dim("  https://www.vibecom.build/u/chrismicah"),
    ].join("\n"),
    pc.bold(gradient("  your rank  "))
  );
  await beat(1200);

  p.note(
    [
      `${pc.green("✔")} Signed in as ${pc.bold("chrismicah")}`,
      `${pc.green("✔")} Collecting from ${pc.bold(
        "every project on this computer"
      )}${pc.dim(" — new ones count automatically")}`,
      `${pc.green("✔")} Reading ${pc.bold("Claude Code + Codex")}`,
      "",
      `${pc.bold("You're set up.")} Just code — activity uploads on its own.`,
      "",
      pc.dim("Nothing else is required. Choose Done to exit."),
    ].join("\n"),
    pc.green("you're live")
  );
  await beat(900);

  console.log(`${pc.dim("│")}`);
  console.log(`${pc.green("◆")}  Nothing else is needed. Anything to change?`);
  console.log(
    `${pc.dim("│")}  ${pc.green("●")} ${pc.green("Done")} ${pc.dim(
      "— start building"
    )}`
  );
  console.log(`${pc.dim("│")}  ${pc.dim("○ Connect more projects")}`);
  console.log(`${pc.dim("│")}  ${pc.dim("○ See exactly what gets sent")}`);
  console.log(`${pc.dim("└")}`);
  await beat(1400);

  console.log();
  console.log(rule("that was a simulation"));
  console.log(
    bullet(`run ${pc.bold("vibecom")} to do it for real, on this machine`)
  );
  console.log();
}
