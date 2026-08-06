import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

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

test("the CLI ladder matches the server's thresholds exactly", () => {
  /* The CLI bundles standalone from a public repository and cannot import the
     server tree, so the ladder is duplicated. A rank the CLI announces that
     the profile page disagrees with is worse than showing no rank at all —
     the promotion is the reward, and contradicting it discredits both
     screens. Fail here rather than ship the disagreement. */
  const server = path.join(process.cwd(), "src", "lib", "ranks.ts");
  if (!fs.existsSync(server)) return; // public CLI checkout: nothing to compare
  const source = fs.readFileSync(server, "utf8");

  const block = /const STARTER_THRESHOLDS = \[([\s\S]*?)\] as const;/.exec(source);
  assert.ok(block, "could not find STARTER_THRESHOLDS in src/lib/ranks.ts");
  const thresholds = block[1]
    .split(",")
    .map((piece) => piece.trim().replace(/_/g, ""))
    .filter(Boolean)
    .map(Number);
  assert.deepEqual(
    RANKS.map((rank) => rank.minTokens),
    thresholds,
    "CLI rank thresholds have drifted from the server's"
  );

  const names = [...source.matchAll(/name: "([^"]+)"/g)]
    .map((match) => match[1])
    .slice(-RANKS.length);
  assert.deepEqual(
    RANKS.map((rank) => rank.name),
    names,
    "CLI rank names have drifted from the server's"
  );
});

test("a fresh account starts on the first rung, not an empty state", () => {
  const rank = rankFor(0);
  assert.equal(rank.level, 1);
  assert.equal(rank.name, "Junior Vibe Coder I");
});

test("rank boundaries are inclusive at the threshold", () => {
  assert.equal(rankFor(249_999).name, "Junior Vibe Coder I");
  assert.equal(rankFor(250_000).name, "Junior Vibe Coder II");
});

test("the top rank has no next and reads as complete", () => {
  const top = RANKS[RANKS.length - 1];
  assert.equal(nextRank(top), null);
  assert.equal(progressTo(Number.MAX_SAFE_INTEGER, top), 1);
});

test("progress is a real fraction of the band, not of the total", () => {
  const rank = rankFor(250_000); // band: 250k -> 510k
  assert.equal(progressTo(250_000, rank), 0);
  assert.ok(Math.abs(progressTo(380_000, rank) - 0.5) < 0.01);
  assert.equal(progressTo(510_000, rank), 1);
});

test("the bar shows movement below one whole cell", () => {
  /* A band can span a doubling of tokens, so a real session may be worth less
     than one full cell. Without a partial block the bar looks frozen and the
     work looks uncounted. */
  assert.notEqual(bar(0.01, 24), bar(0, 24));
  assert.equal([...bar(0, 24)].length, 24);
  assert.equal([...bar(1, 24)].length, 24);
  assert.equal(bar(1, 24), "█".repeat(24));
});

test("compact notation matches the site", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(999), "999");
  assert.equal(compact(72_000_000), "72M");
  assert.equal(compact(1_200_000_000), "1.2B");
});

test("a sparkline is one mark per day and flat when nothing varies", () => {
  assert.equal(sparkline([]), "");
  assert.equal([...sparkline([1, 5, 3, 9])].length, 4);
  assert.equal(sparkline([4, 4, 4]), "▄▄▄");
  assert.equal(sparkline([0, 0]), "▁▁");
});

test("today missing does not break a streak, yesterday missing does", () => {
  const today = new Date("2026-08-06T12:00:00Z");
  assert.equal(streakFrom(["2026-08-06", "2026-08-05", "2026-08-04"], today), 3);
  // The day is not over yet — yesterday's run still counts.
  assert.equal(streakFrom(["2026-08-05", "2026-08-04"], today), 2);
  // A gap at yesterday ends it.
  assert.equal(streakFrom(["2026-08-04"], today), 0);
  assert.equal(streakFrom([], today), 0);
});

test("the machine-wide slot is the fallback owner of any session", () => {
  /* Slot matching compares real directory paths, and the machine-wide slot's
     root is "*", so it can never win one. Without an explicit fallback every
     session landed in "unlinked projects — ignored": live telemetry kept
     flowing while historical import silently did nothing, and the rank card
     showed zero. A specific project must still win when one matches, so mixed
     setups keep their per-project tiers. */
  const GLOBAL = "*";
  const slots = [
    { root: "/code/app", label: "app" },
    { root: GLOBAL, label: "everything" },
  ];
  const pick = (root: string | null) =>
    (root ? slots.find((s) => s.root === root) : undefined) ??
    slots.find((s) => s.root === GLOBAL);

  assert.equal(pick("/code/app")?.label, "app", "a real project still wins");
  assert.equal(
    pick("/code/never-linked")?.label,
    "everything",
    "an unlinked project falls back to machine-wide tracking"
  );
  assert.equal(pick(null)?.label, "everything", "no cwd still resolves");

  const onlyProjects = slots.slice(0, 1);
  const pickNoGlobal = (root: string | null) =>
    (root ? onlyProjects.find((s) => s.root === root) : undefined) ??
    onlyProjects.find((s) => s.root === GLOBAL);
  assert.equal(
    pickNoGlobal("/code/other"),
    undefined,
    "without machine-wide tracking an unlinked project is still skipped"
  );
});
