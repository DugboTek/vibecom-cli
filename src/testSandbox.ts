import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway XDG_CONFIG_HOME, established before anything reads it.
 *
 * `core.ts` resolves CONFIG_DIR once, when the module is first evaluated, so a
 * test that sets the variable in its own body is already too late — the paths
 * are bound and every write lands in the real `~/.config/vibecom`. Importing
 * this module first is what makes the sandbox take effect: import order is
 * preserved through the CJS transform, statements around imports are not.
 *
 * Not named `*.test.ts`, so the runner does not treat it as a suite.
 */

export const sandbox = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-sandbox-"))
);

export const configHome = path.join(sandbox, "config");
fs.mkdirSync(configHome, { recursive: true });
process.env.XDG_CONFIG_HOME = configHome;

export const cleanupSandbox = () =>
  fs.rmSync(sandbox, { recursive: true, force: true });

/**
 * Prove the sandbox won the race before a test writes anything.
 *
 * A reordered import would otherwise turn a passing suite into one that
 * silently edits the developer's own linked projects.
 */
export function assertSandboxed(configDir: string): void {
  if (!configDir.startsWith(configHome)) {
    throw new Error(
      `config sandbox missed: ${configDir} is outside ${configHome} — ` +
        "import ./testSandbox before ./core or ./autopilot"
    );
  }
}
