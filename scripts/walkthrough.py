#!/usr/bin/env python3
"""Record what a real person sees when they run the CLI.

The CLI's own tests assert on return values. They cannot catch the failures
that actually lose beginners: a prompt that scrolls the explanation off screen,
a default that says "Yes" to something irreversible, an error that names an
internal function instead of a next step.

This drives the real binary inside a real pty at a real terminal size, feeds
scripted keystrokes, and renders each screen the way a terminal would. The
output is a transcript you can read, diff, and paste into a design review.

Usage:
  python3 cli/scripts/walkthrough.py                    # first-run, accept defaults
  python3 cli/scripts/walkthrough.py --keys $'\\x1b[B\\r' # send down-arrow, enter
  python3 cli/scripts/walkthrough.py --cols 60          # test a narrow terminal
  python3 cli/scripts/walkthrough.py --args status
"""

import argparse
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import fcntl
import time
from pathlib import Path

try:
    import pyte
except ImportError:
    sys.exit("need pyte: python3 -m pip install pyte")

REPO = Path(__file__).resolve().parents[2]
BUNDLE = REPO / "public" / "cli.js"


def build_sandbox(tmp: Path, signed_in: bool, origin: str, foreign: bool = False,
                  linked: bool = False) -> Path:
    """A throwaway HOME so a walkthrough can never touch the real config."""
    (tmp / ".config" / "vibecom").mkdir(parents=True, exist_ok=True)
    os.chmod(tmp / ".config" / "vibecom", 0o700)

    demo = tmp / "projects" / "demo-app"
    demo.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "."], cwd=demo, check=True)
    subprocess.run(["git", "config", "user.email", "demo@example.com"], cwd=demo, check=True)
    subprocess.run(["git", "config", "user.name", "demo"], cwd=demo, check=True)
    (demo / "README.md").write_text("# demo\n")
    subprocess.run(["git", "add", "-A"], cwd=demo, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=demo, check=True)

    if foreign:
        # A repo owned by someone who is not you — employer or client code.
        # This must never be auto-selected, so it needs a walkthrough of its own.
        subprocess.run(
            ["git", "remote", "add", "origin",
             "https://github.com/some-employer/internal-service.git"],
            cwd=demo, check=True,
        )

    if linked:
        # A project already connected, so the "you're live" state can be seen
        # without a working server or a real sign-in.
        import hashlib
        slots = tmp / ".config" / "vibecom" / "projects"
        slots.mkdir(parents=True, exist_ok=True)
        root = str(demo)
        (slots / (hashlib.sha256(root.encode()).hexdigest() + ".json")).write_text(
            '{"root":"%s","salt":"abc","projectId":"pid","tier":1,'
            '"label":"demo-app","origin":"%s","linkedAt":"2026-08-05T00:00:00Z"}'
            % (root, origin)
        )

    if signed_in:
        cred = tmp / ".config" / "vibecom" / "credentials.json"
        cred.write_text(
            '{"username":"testbuilder","token":"sandbox-not-a-real-token",'
            f'"origin":"{origin}"}}'
        )
        os.chmod(cred, 0o600)
    return demo


def run(argv, cwd, env, cols, rows, keys, budget):
    """Run argv in a pty, feeding `keys` on each prompt-looking pause."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(argv[0], argv, env)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    raw = bytearray()
    pending = list(keys)
    deadline = time.time() + budget
    idle_since = None

    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            raw += chunk
            stream.feed(chunk)
            idle_since = None
            continue
        # Nothing printed for a beat: the CLI is waiting on us.
        idle_since = idle_since or time.time()
        if time.time() - idle_since > 1.2 and pending:
            os.write(fd, pending.pop(0))
            idle_since = None

    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    os.close(fd)
    return screen, bytes(raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=90)
    ap.add_argument("--rows", type=int, default=45)
    ap.add_argument("--seconds", type=float, default=40)
    ap.add_argument("--keys", default="\r", help="keystrokes, one per prompt")
    ap.add_argument("--args", nargs="*", default=[])
    ap.add_argument("--signed-out", action="store_true")
    ap.add_argument("--linked", action="store_true",
                    help="pretend a project is already connected")
    ap.add_argument("--foreign-remote", action="store_true",
                    help="make the demo repo look owned by someone else")
    # The canonical host. vibecom.build 308s to www, and credentials do not
    # survive a redirect — pointing a walkthrough at the apex tests the error
    # path, not the product.
    ap.add_argument("--origin", default="https://www.vibecom.build")
    opts = ap.parse_args()

    if not BUNDLE.exists():
        sys.exit(f"build it first: node scripts/build-cli.mjs  (missing {BUNDLE})")

    tmp = Path(tempfile.mkdtemp(prefix="vibecom-walkthrough-"))
    try:
        demo = build_sandbox(tmp, not opts.signed_out, opts.origin,
                             foreign=opts.foreign_remote,
                             linked=opts.linked)
        env = {
            **os.environ,
            "HOME": str(tmp),
            "XDG_CONFIG_HOME": str(tmp / ".config"),
            "VIBECOM_ORIGIN": opts.origin,
            "TERM": "xterm-256color",
            "COLUMNS": str(opts.cols),
            "LINES": str(opts.rows),
            # Never let a walkthrough pop a real browser tab.
            "BROWSER": "true",
        }
        keys = [k.encode() for k in opts.keys] if opts.keys else []
        screen, _ = run(
            [shutil.which("node"), str(BUNDLE), *opts.args],
            demo, env, opts.cols, opts.rows, keys, opts.seconds,
        )
        print(f"── final screen · {opts.cols}×{opts.rows} · "
              f"args={opts.args or ['(wizard)']} " + "─" * 20)
        for line in screen.display:
            print(line.rstrip())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
