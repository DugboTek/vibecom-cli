import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  installSuperconductorCodexBridge,
  superconductorBridgeInstalled,
} from "./superconductor";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibecom-superconductor-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the Superconductor bridge is idempotent and only intercepts app-server", () => {
  const wrapper = path.join(dir, "codex");
  fs.writeFileSync(
    wrapper,
    "#!/bin/bash\n# Superconductor agent-wrapper v3\nREAL_BIN=\"/real/codex\"\nexport SC_RUNTIME_ROOT=\"/tmp/sc\"\n\"$REAL_BIN\" \"$@\"\n"
  );
  assert.deepEqual(installSuperconductorCodexBridge("/usr/local/bin/vibecom", wrapper), {
    installed: true,
  });
  assert.equal(superconductorBridgeInstalled(wrapper), true);
  assert.deepEqual(installSuperconductorCodexBridge("/usr/local/bin/vibecom", wrapper), {
    installed: true,
  });
  const patched = fs.readFileSync(wrapper, "utf8");
  assert.equal((patched.match(/# >>> vibecom codex app-server bridge >>>/g) ?? []).length, 1);
  assert.match(patched, /if \[ "\$_vibecom_arg" = "app-server" \]/);
  assert.doesNotMatch(patched, /vibecom codex-app-server --real "\$REAL_BIN" -- "\$@"\nexport/);
});

test("an unknown third-party wrapper is never changed", () => {
  const wrapper = path.join(dir, "unknown");
  fs.writeFileSync(wrapper, "#!/bin/bash\nexec codex \"$@\"\n");
  assert.equal(installSuperconductorCodexBridge("/usr/local/bin/vibecom", wrapper).installed, false);
  assert.equal(superconductorBridgeInstalled(wrapper), false);
});
