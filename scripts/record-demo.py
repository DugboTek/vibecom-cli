#!/usr/bin/env python3
"""Record the CLI onboarding as a portrait video, with no screen recorder.

Screen recording a terminal means a real window, a real display, a real
cursor, and a result that changes with whatever else is on the desktop. This
drives the same pty the walkthrough uses, snapshots the emulated screen on a
fixed cadence, and draws each snapshot with a monospace font — so the output
is deterministic, correctly sized for phone video the first time, and free of
anything that happened to be on screen.

    python3 cli/scripts/record-demo.py --out demo.mp4

Colours come from the pyte cell attributes, so the gradient wordmark and the
green ticks survive into the frames.
"""

import argparse
import fcntl
import json
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
import time
from pathlib import Path

try:
    import pyte
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("need pyte and pillow: python3 -m pip install pyte pillow")

REPO = Path(__file__).resolve().parents[2]
BUNDLE = REPO / "public" / "cli.js"
FONT = "/System/Library/Fonts/Menlo.ttc"

# Portrait, phone-shaped. The grid is chosen so the CLI's 44-column film strip
# and its boxes fit without wrapping, which is what actually decides the size.
COLS, ROWS = 62, 46
VIDEO_W, VIDEO_H = 1080, 1920
BG = (13, 17, 23)

ANSI = {
    "black": (60, 66, 74), "red": (255, 123, 114), "green": (86, 211, 100),
    "brown": (232, 196, 121), "blue": (121, 192, 255), "magenta": (210, 168, 255),
    "cyan": (118, 224, 219), "white": (201, 209, 217), "default": (201, 209, 217),
}


def colour(name: str, default: tuple) -> tuple:
    if not name or name == "default":
        return default
    if len(name) == 6:
        try:
            return tuple(int(name[i:i + 2], 16) for i in (0, 2, 4))
        except ValueError:
            return default
    return ANSI.get(name, default)


def snapshot(screen) -> list:
    """One row per line: (text, fg, bold) runs, flattened to per-cell tuples."""
    out = []
    for row in range(screen.lines):
        cells = []
        line = screen.buffer[row]
        for col in range(screen.columns):
            cell = line[col]
            cells.append((cell.data or " ", cell.fg, cell.bold, cell.reverse))
        out.append(cells)
    return out


def draw(frame, font, cw, ch, pad_x, pad_y) -> Image.Image:
    image = Image.new("RGB", (VIDEO_W, VIDEO_H), BG)
    pen = ImageDraw.Draw(image)
    for row, cells in enumerate(frame):
        y = pad_y + row * ch
        for col, (char, fg, bold, reverse) in enumerate(cells):
            if char == " " and not reverse:
                continue
            rgb = colour(fg, ANSI["default"])
            if reverse:
                pen.rectangle(
                    [pad_x + col * cw, y, pad_x + (col + 1) * cw, y + ch], fill=rgb
                )
                rgb = BG
            pen.text((pad_x + col * cw, y), char, font=font, fill=rgb)
    return image


def record(argv, cwd, env, seconds, fps, keys):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    frames = []
    interval = 1.0 / fps
    deadline = time.time() + seconds
    next_frame = time.time()
    pending = list(keys)
    idle_since = None

    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.02)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                stream.feed(chunk)
                idle_since = None
            else:
                break
        else:
            idle_since = idle_since or time.time()
            if pending and time.time() - idle_since > 1.4:
                os.write(fd, pending.pop(0))
                idle_since = None
        now = time.time()
        if now >= next_frame:
            frames.append(snapshot(screen))
            next_frame = now + interval

    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    os.close(fd)
    # Hold the final state so the last screen is readable rather than a flash.
    frames.extend([frames[-1]] * (fps * 3) if frames else [])
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="vibecom-onboarding.mp4")
    ap.add_argument("--seconds", type=float, default=34)
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--keys", default="\r")
    ap.add_argument("--origin", default="https://www.vibecom.build")
    ap.add_argument("--token", default="")
    ap.add_argument("--user", default="chrismicah")
    opts = ap.parse_args()

    if not BUNDLE.exists():
        sys.exit("build first: node scripts/build-cli.mjs")

    tmp = Path(tempfile.mkdtemp(prefix="vibecom-demo-"))
    try:
        demo = tmp / "projects" / "my-app"
        demo.mkdir(parents=True)
        for cmd in (["git", "init", "-q", "."],
                    ["git", "config", "user.email", "demo@example.com"],
                    ["git", "config", "user.name", "demo"]):
            subprocess.run(cmd, cwd=demo, check=True)
        (demo / "README.md").write_text("# my-app\n")
        subprocess.run(["git", "add", "-A"], cwd=demo, check=True)
        subprocess.run(["git", "commit", "-qm", "init"], cwd=demo, check=True)

        cfg = tmp / ".config" / "vibecom"
        cfg.mkdir(parents=True)
        token = opts.token
        if not token:
            sys.exit(
                "pass --token: a real one, or the demo records the "
                "expired-sign-in path instead of the product"
            )
        (cfg / "credentials.json").write_text(
            json.dumps(
                {"username": opts.user, "token": token, "origin": opts.origin}
            )
        )

        env = {
            **os.environ, "HOME": str(tmp), "XDG_CONFIG_HOME": str(tmp / ".config"),
            "VIBECOM_ORIGIN": opts.origin, "TERM": "xterm-256color",
            "COLUMNS": str(COLS), "LINES": str(ROWS), "BROWSER": "true",
            "FORCE_COLOR": "3",
        }
        frames = record(
            [shutil.which("node"), str(BUNDLE)], demo, env,
            opts.seconds, opts.fps, [k.encode() for k in opts.keys],
        )
        print(f"captured {len(frames)} frames")

        # Size the glyphs to the grid rather than guessing a point size.
        size = 10
        while True:
            probe = ImageFont.truetype(FONT, size + 1)
            box = probe.getbbox("M")
            if (box[2] - box[0]) * COLS > VIDEO_W - 40:
                break
            size += 1
        font = ImageFont.truetype(FONT, size)
        cw = font.getbbox("M")[2] - font.getbbox("M")[0]
        ch = int(size * 1.35)
        pad_x = max(10, (VIDEO_W - cw * COLS) // 2)
        pad_y = max(20, (VIDEO_H - ch * ROWS) // 2)
        print(f"font {size}px · cell {cw}x{ch} · grid {COLS}x{ROWS}")

        shots = tmp / "shots"
        shots.mkdir()
        for index, frame in enumerate(frames):
            draw(frame, font, cw, ch, pad_x, pad_y).save(shots / f"{index:05d}.png")

        out = Path(opts.out).resolve()
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(opts.fps),
            "-i", str(shots / "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-vf", f"scale={VIDEO_W}:{VIDEO_H}", str(out),
        ], check=True)
        print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
