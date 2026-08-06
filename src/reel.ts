import pc from "picocolors";
import { canAnimate, gradient } from "./ui";

/**
 * A short film strip that plays while setup works.
 *
 * Onboarding has real waiting in it — a network round trip, a scan of every
 * transcript on the machine — and a spinner spends that time saying only "not
 * finished". This says something instead: an empty desk, someone sitting down,
 * a thing being built, the thing shipping. It is the product's whole story in
 * four seconds, which is also what makes it worth pointing a camera at.
 *
 * Every frame is the same width and height, so the cursor walks back a fixed
 * number of lines and repaints in place — no flicker, no scroll, and the strip
 * stays put underneath.
 */

const WIDTH = 44;
const HEIGHT = 9;

/** Sprocket holes, so the frame reads as film rather than a box. */
const PERF = "▖▘".repeat(WIDTH / 2);

type Frame = { art: string[]; caption: string };

/* Hand-set rather than generated: these are pictures, and a generator would
   produce something regular and lifeless. Each is exactly HEIGHT lines. */
const FRAMES: Frame[] = [
  {
    caption: "a desk, a machine, nothing yet",
    art: [
      "                                            ",
      "                                            ",
      "              ╭──────────────╮              ",
      "              │              │              ",
      "              │              │              ",
      "              ╰──────┬───────╯              ",
      "                 ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
  {
    caption: "somebody sits down",
    art: [
      "                                            ",
      "                                            ",
      "              ╭──────────────╮              ",
      "              │              │              ",
      "         ○    │              │              ",
      "        /│\\   ╰──────┬───────╯              ",
      "         │       ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
  {
    caption: "the first line",
    art: [
      "                                            ",
      "                                            ",
      "              ╭──────────────╮              ",
      "              │ ▍            │              ",
      "         ○    │              │              ",
      "        /│\\   ╰──────┬───────╯              ",
      "        ─┼─      ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
  {
    caption: "it starts answering back",
    art: [
      "                                            ",
      "                     ·  ✦                   ",
      "              ╭──────────────╮              ",
      "              │ ▍▍▍▍         │              ",
      "         ○    │ ▍▍▍▍▍▍▍      │              ",
      "        /│\\   ╰──────┬───────╯              ",
      "        ─┼─      ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
  {
    caption: "something is taking shape",
    art: [
      "                  ✦   ·   ✦                 ",
      "                 ·   ▄▄▄   ·                ",
      "              ╭──────────────╮              ",
      "              │ ▍▍▍▍▍▍▍▍     │              ",
      "         ○    │ ▍▍▍▍▍▍▍▍▍▍▍  │              ",
      "        /│\\   ╰──────┬───────╯              ",
      "        ─┼─      ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
  {
    caption: "it stands up on its own",
    art: [
      "               ✦    ▄▄▄▄▄   ✦               ",
      "                ·  █████████  ·             ",
      "              ╭──────────────╮              ",
      "              │ ▍▍▍▍▍▍▍▍▍▍▍▍ │              ",
      "         ○    │ ▍▍▍▍▍▍▍▍▍▍▍▍ │              ",
      "        /│\\   ╰──────┬───────╯              ",
      "        ─┼─      ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
  {
    caption: "you ship it",
    art: [
      "            ✦      ▄▄▄▄▄▄▄      ✦           ",
      "              ·   ███████████   ·           ",
      "              ╭──────────────╮              ",
      "              │ ▍▍▍▍▍▍▍▍▍▍▍▍ │   ↗          ",
      "        \\○/   │ ▍▍▍▍▍▍▍▍▍▍▍▍ │              ",
      "         │    ╰──────┬───────╯              ",
      "        ─┴─      ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
  {
    caption: "and it counts",
    art: [
      "         ♥      ▄▄▄▄▄▄▄▄▄▄▄      ♥          ",
      "            ·  █████████████  ·             ",
      "              ╭──────────────╮              ",
      "              │ ▍▍▍▍▍▍▍▍▍▍▍▍ │   ↗          ",
      "        \\○/   │ ▍▍▍▍▍▍▍▍▍▍▍▍ │              ",
      "         │    ╰──────┬───────╯              ",
      "        ─┴─      ════╧════                  ",
      "        ────────────────────────────        ",
      "                                            ",
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function render(frame: Frame, index: number, shift: number): string {
  const lines = [
    pc.dim(PERF),
    ...frame.art.map((line, row) => gradient(line, shift + row * 0.03)),
    pc.dim(PERF),
    `  ${pc.dim(`${index + 1}/${FRAMES.length}`)}  ${pc.bold(frame.caption)}`,
  ];
  return lines.map((line) => `  ${line}`).join("\n");
}

/** Total printed lines: two perforation rows, the art, and the caption. */
const LINES = HEIGHT + 3;

/**
 * Play the strip once. Falls back to the closing frame alone when the terminal
 * cannot animate, so piped output and CI logs still get the picture without a
 * hundred repainted copies of it.
 */
export async function playReel(): Promise<void> {
  if (!canAnimate) {
    console.log(render(FRAMES[FRAMES.length - 1], FRAMES.length - 1, 0));
    return;
  }
  process.stdout.write("\x1b[?25l"); // hide the cursor while it repaints
  try {
    for (let i = 0; i < FRAMES.length; i++) {
      const body = render(FRAMES[i], i, i * 0.08);
      process.stdout.write(i === 0 ? body + "\n" : `\x1b[${LINES}A` + body + "\n");
      await sleep(i === FRAMES.length - 1 ? 700 : 420);
    }
  } finally {
    process.stdout.write("\x1b[?25h");
  }
}

/** Every frame, one after another — for screenshots and the README. */
export function reelFrames(): string[] {
  return FRAMES.map((frame, index) => render(frame, index, index * 0.08));
}
