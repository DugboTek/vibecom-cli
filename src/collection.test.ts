import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

/*
 * COLLECTION.md is a promise to users about what leaves their machine. A
 * promise that is maintained by hand drifts the first time someone adds a
 * field. These tests read the actual source and fail if the code and the
 * document disagree, in either direction.
 */

/* Resolved from cwd rather than __dirname so this runs identically from the
   repo root (npm test) and from a standalone checkout of the CLI. */
function cliFile(...parts: string[]): string {
  for (const base of [process.cwd(), path.join(process.cwd(), "cli")]) {
    const candidate = path.join(base, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate ${parts.join("/")} from ${process.cwd()}`);
}

const doc = fs.readFileSync(cliFile("COLLECTION.md"), "utf-8");
const core = fs.readFileSync(cliFile("src", "core.ts"), "utf-8");

/**
 * Every sender whose payload the document describes.
 *
 * Listed explicitly rather than discovered, because the failure mode of a
 * clever scan is silence: a sender it does not recognise contributes no
 * attributes, both checks below pass over it, and the document stops
 * describing what actually leaves the machine — the exact drift this file
 * exists to prevent. A new sender must be added here, and the guard below
 * fails until it is.
 */
const SENDERS = ["sendScanned", "sendRepoStats"];

/** Every `attr("name", ...)` any sender emits — the real wire payload. */
function wireAttributes(): string[] {
  const names: string[] = [];
  for (const sender of SENDERS) {
    const start = core.indexOf(`export async function ${sender}`);
    assert.ok(start > -1, `${sender} not found — did the sender get renamed?`);
    const body = core.slice(start, core.indexOf("\n}", start));
    const found = [...body.matchAll(/attr\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(found.length > 0, `no attributes parsed out of ${sender}`);
    names.push(...found);
  }
  return [...new Set(names)];
}

test("every sender that posts to the ingest API is covered by this guard", () => {
  /* Without this, adding a third sender would silently narrow the two checks
     below instead of failing them. */
  const declared = [...core.matchAll(/export async function (send\w+)/g)].map(
    (m) => m[1]
  );
  const unguarded = declared.filter((name) => !SENDERS.includes(name));
  assert.deepEqual(
    unguarded,
    [],
    `these senders are not covered by SENDERS in this test: ${unguarded.join(", ")}.\n` +
      "Add them, or their attributes will go undocumented without failing anything."
  );
});

test("every field the CLI sends is documented in COLLECTION.md", () => {
  const undocumented = wireAttributes().filter(
    (name) => !doc.includes(`\`${name}\``)
  );
  assert.deepEqual(
    undocumented,
    [],
    `these attributes are sent but not documented: ${undocumented.join(", ")}.\n` +
      "Add them to the table in cli/COLLECTION.md before shipping."
  );
});

test("COLLECTION.md does not claim fields the CLI never sends", () => {
  const sent = new Set(wireAttributes());
  // Only inspect the payload table, so prose mentioning other identifiers is fine.
  const tableStart = doc.indexOf("| Attribute | Type | Meaning |");
  assert.ok(tableStart > -1, "the payload table is missing from COLLECTION.md");
  const table = doc.slice(tableStart, doc.indexOf("\n\n", tableStart));
  const claimed = [...table.matchAll(/^\|\s*`([^`]+)`/gm)].map((m) => m[1]);
  const phantom = claimed.filter((name) => !sent.has(name));
  assert.deepEqual(
    phantom,
    [],
    `COLLECTION.md documents fields that are not actually sent: ${phantom.join(", ")}`
  );
});

test("the never-collected list stays in the document", () => {
  // These are the load-bearing promises. Losing one silently would be the
  // worst possible regression in a file whose whole job is to be trusted.
  for (const promise of [
    "Source code",
    "Prompts",
    "File paths",
    "Shell commands",
    "Environment variables",
  ]) {
    assert.ok(
      doc.includes(promise),
      `COLLECTION.md no longer promises to exclude: ${promise}`
    );
  }
});

test("the salt is never part of the payload", () => {
  const start = core.indexOf("export async function sendScanned");
  const body = core.slice(start, core.indexOf("\n}", start));
  assert.ok(
    !/salt/i.test(body),
    "sendScanned references the salt — it must never leave the machine"
  );
});

test("the project id is a truncated salted hash, not a path", () => {
  assert.match(
    core,
    /projectIdFor\s*=\s*\(salt: string, root: string\) =>\s*\n?\s*sha256\(`\$\{salt\}:\$\{root\}`\)\.slice\(0, 32\)/,
    "projectIdFor changed shape — re-check the claim in COLLECTION.md"
  );
});
