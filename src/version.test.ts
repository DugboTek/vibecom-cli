import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  bumpKind,
  compareVersions,
  parseVersion,
  versionFromBundle,
  VERSION,
} from "./version";

/* Resolved from cwd rather than __dirname so this runs identically from the
   repo root (npm test) and from a standalone checkout of the CLI, which is
   what the public mirror is. */
function cliFile(...parts: string[]): string {
  for (const base of [process.cwd(), path.join(process.cwd(), "cli")]) {
    const candidate = path.join(base, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate ${parts.join("/")} from ${process.cwd()}`);
}

const v = (s: string) => {
  const parsed = parseVersion(s);
  assert.ok(parsed, `${s} should parse`);
  return parsed;
};

test("versions parse, with or without a leading v", () => {
  assert.deepEqual(v("1.2.3"), { major: 1, minor: 2, patch: 3, pre: null });
  assert.deepEqual(v("v0.1.0"), { major: 0, minor: 1, patch: 0, pre: null });
  assert.deepEqual(v("2.0.0-rc.1"), { major: 2, minor: 0, patch: 0, pre: "rc.1" });
});

test("an unparseable version is null, never a zeroed default", () => {
  /* Treating "unknown" as 0.0.0 would make every unrecognised build look older
     than every real one — which is how an updater talks itself into
     overwriting a newer binary with an older one. */
  for (const bad of ["", "dev", "1.2", "latest", "2026-08-03T12:00:00Z", "1.2.3.4"]) {
    assert.equal(parseVersion(bad), null, `${bad} must not parse`);
  }
});

test("ordering runs major, then minor, then patch", () => {
  assert.ok(compareVersions(v("1.0.0"), v("2.0.0")) < 0);
  assert.ok(compareVersions(v("1.9.0"), v("1.10.0")) < 0, "10 is after 9, not before");
  assert.ok(compareVersions(v("1.2.3"), v("1.2.4")) < 0);
  assert.equal(compareVersions(v("1.2.3"), v("1.2.3")), 0);
  assert.ok(compareVersions(v("2.0.0"), v("1.9.9")) > 0);
});

test("a prerelease sorts before the release it led to", () => {
  assert.ok(compareVersions(v("1.2.3-rc.1"), v("1.2.3")) < 0);
  assert.ok(compareVersions(v("1.2.3"), v("1.2.3-rc.1")) > 0);
  assert.ok(compareVersions(v("1.2.3-rc.1"), v("1.2.3-rc.2")) < 0);
});

test("the kind of bump is named, because that is what a user acts on", () => {
  assert.equal(bumpKind(v("1.2.3"), v("2.0.0")), "major");
  assert.equal(bumpKind(v("1.2.3"), v("1.3.0")), "minor");
  assert.equal(bumpKind(v("1.2.3"), v("1.2.4")), "patch");
  assert.equal(bumpKind(v("1.2.3-rc.1"), v("1.2.3")), "prerelease");
  assert.equal(bumpKind(v("1.2.3"), v("1.2.3")), "none");
});

test("a version can be read back out of a built bundle", () => {
  // This is what an update check reads before overwriting anything.
  assert.equal(
    versionFromBundle('#!/usr/bin/env node\nconsole.log(`vibecom 1.4.2 (build x)`)'),
    "1.4.2"
  );
  assert.equal(versionFromBundle("no version here"), null);
});

test("package.json is the single source of the version", () => {
  /* The regression this guards: `--version` printed a hard-coded 3.2.0 while
     package.json said 0.1.0, so the number a user quoted in a bug report
     described nothing at all. */
  const pkg = JSON.parse(
    fs.readFileSync(cliFile("package.json"), "utf8")
  ) as { version: string };
  assert.ok(parseVersion(pkg.version), "package.json holds a real semver");

  const src = fs.readFileSync(cliFile("src", "index.ts"), "utf8");
  assert.ok(
    !/vibecom \d+\.\d+\.\d+/.test(src),
    "no hand-written version may appear in the CLI source"
  );
});

test("an unbuilt checkout reports a version that cannot pass for a release", () => {
  // Running from source must never look like a published build.
  if (VERSION === "0.0.0-dev") {
    assert.equal(parseVersion(VERSION)?.pre, "dev");
  } else {
    assert.ok(parseVersion(VERSION), "a built binary carries a real version");
  }
});
