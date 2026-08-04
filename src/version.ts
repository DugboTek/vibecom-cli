/**
 * The CLI's own version, and the rules for comparing two of them.
 *
 * There used to be two numbers and neither was real: `--version` printed a
 * hard-coded `3.2.0` while `package.json` said `0.1.0`, so the thing a user
 * would quote in a bug report bore no relation to the code they were running.
 * Both are now derived from `package.json` at build time, which makes it the
 * single place a release is declared.
 *
 * The build stamp stays alongside it. A version says which release this is; the
 * stamp says which build of it, which is what makes a locally built binary
 * distinguishable from the published one at the same version.
 */

/* Replaced at build time by esbuild's `define`. The fallbacks are what a
   `tsx src/index.ts` run from a checkout reports, and they are deliberately not
   version-shaped so a development build can never be mistaken for a release. */
declare const __VIBECOM_VERSION__: string;
declare const __VIBECOM_BUILD__: string;

export const VERSION: string =
  typeof __VIBECOM_VERSION__ === "string" ? __VIBECOM_VERSION__ : "0.0.0-dev";

export const BUILD: string =
  typeof __VIBECOM_BUILD__ === "string" ? __VIBECOM_BUILD__ : "dev";

export type SemVer = { major: number; minor: number; patch: number; pre: string | null };

/**
 * Parse `1.2.3` or `1.2.3-rc.1`, or return null.
 *
 * Null rather than a zeroed default: an unparseable version means "I do not
 * know what this is", and treating that as 0.0.0 would make every unknown
 * build look older than every real one — which is exactly how an update
 * mechanism talks itself into overwriting a newer binary.
 */
export function parseVersion(value: string): SemVer | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  };
}

/**
 * Order two versions: negative if `a` is older, positive if newer, 0 if equal.
 *
 * A prerelease sorts before its own release — `1.2.3-rc.1` precedes `1.2.3` —
 * per semver, so shipping a release supersedes the candidates that led to it.
 */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** How one version differs from another, for a human-readable update line. */
export function bumpKind(
  from: SemVer,
  to: SemVer
): "major" | "minor" | "patch" | "prerelease" | "none" {
  if (to.major !== from.major) return "major";
  if (to.minor !== from.minor) return "minor";
  if (to.patch !== from.patch) return "patch";
  if (to.pre !== from.pre) return "prerelease";
  return "none";
}

/**
 * Read the version out of a built bundle.
 *
 * esbuild inlines the define as a string literal, so the published artefact
 * carries its own version in a form that can be read back without running it —
 * which is what lets an update check compare before overwriting anything.
 */
export function versionFromBundle(source: string): string | null {
  const marker = source.match(/vibecom (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return marker?.[1] ?? null;
}
