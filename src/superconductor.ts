import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BEGIN = "# >>> vibecom codex app-server bridge >>>";
const END = "# <<< vibecom codex app-server bridge <<<";

export const superconductorCodexWrapper = (home = os.homedir()): string =>
  path.join(home, ".superconductor", "bin", "codex");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function bridgeBlock(binary: string): string {
  return `${BEGIN}
# Codex app-server deliberately has no TUI transcript. This proxy forwards the
# JSON-RPC stream unchanged and persists only documented numeric usage updates.
for _vibecom_arg in "$@"; do
  if [ "$_vibecom_arg" = "app-server" ]; then
    SUPERCONDUCTOR_VIBECOM_BRIDGE=1 ${shellQuote(binary)} codex-app-server --real "$REAL_BIN" -- "$@"
    exit $?
  fi
done
${END}`;
}

/**
 * Add an idempotent bridge to Superconductor's *managed* Codex wrapper. The
 * wrapper still owns lifecycle traps and remains a transparent pass-through
 * outside Superconductor. If its format changes, do nothing rather than risk
 * changing a third-party launcher we cannot recognize.
 */
export function installSuperconductorCodexBridge(
  binary: string,
  wrapper = superconductorCodexWrapper()
): { installed: boolean; reason?: string } {
  if (!path.isAbsolute(binary)) return { installed: false, reason: "binary is not absolute" };
  let source: string;
  try {
    source = fs.readFileSync(wrapper, "utf8");
  } catch {
    return { installed: false, reason: "Superconductor is not installed" };
  }
  if (!source.includes("# Superconductor agent-wrapper") || !source.includes("REAL_BIN=")) {
    return { installed: false, reason: "unrecognized Superconductor wrapper" };
  }
  const block = bridgeBlock(binary);
  const old = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");
  const withoutOld = source.replace(old, "");
  const anchor = "export SC_RUNTIME_ROOT=";
  const position = withoutOld.indexOf(anchor);
  if (position < 0) return { installed: false, reason: "wrapper anchor is missing" };
  const backup = `${wrapper}.vibecom-backup`;
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(wrapper, backup, fs.constants.COPYFILE_EXCL);
    const next = `${withoutOld.slice(0, position)}${block}\n\n${withoutOld.slice(position)}`;
    fs.writeFileSync(wrapper, next, { mode: fs.statSync(wrapper).mode });
    return { installed: true };
  } catch {
    return { installed: false, reason: "could not update Superconductor wrapper" };
  }
}

export function superconductorBridgeInstalled(
  wrapper = superconductorCodexWrapper()
): boolean {
  try {
    const source = fs.readFileSync(wrapper, "utf8");
    return source.includes(BEGIN) && source.includes(END);
  } catch {
    return false;
  }
}
