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

const WIDTH = 64;
const HEIGHT = 30;

/** Sprocket holes, so the frame reads as film rather than a box. */
const PERF = "▖▘".repeat(WIDTH / 2);

type Frame = { art: string[]; caption: string };

/* Hand-set rather than generated: these are pictures, and a generator would
   produce something regular and lifeless. Each is exactly HEIGHT lines. */
const FRAMES: Frame[] = [
  {
    caption: "an empty desk, a dark screen",
    art: [
      "                                                                ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   |                                        |  |           ",
      "    |   |                                        |  |           ",
      "    |   |                                        |  |           ",
      "    |   |                                        |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '               [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
      "                                                                ",
    ],
  },
  {
    caption: "NAME sits down",
    art: [
      "                                                                ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   |                                        |  |           ",
      "    |   |                                        |  |           ",
      "    |   |                                        |  |           ",
      "    |   |                                        |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '               [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                                                                ",
      "                                                                ",
      "               _.-''''''''-._                                   ",
      "             ,'              ',                                 ",
      "            /                  \\                                ",
      "           |                    |                               ",
      "            \\                  /                                ",
      "             '._            _.'                                 ",
      "          ______'-........-'______                              ",
      "        ,'                        ',                            ",
      "      ,'                            ',                          ",
      "     /                                \\                         ",
      "    |                                  |                        ",
      " ___|__________________________________|___                     ",
      "(____________________________________________)                  ",
    ],
  },
  {
    caption: "opens a new project",
    art: [
      "                                                                ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   | $ mkdir my-thing && cd my-thing        |  |           ",
      "    |   | $ claude                               |  |           ",
      "    |   |                                        |  |           ",
      "    |   |                                        |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '        ~      [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                  /                  \\                          ",
      "                 /                    \\                         ",
      "               _.-''''''''-._                                   ",
      "             ,'              ',                                 ",
      "            /                  \\                                ",
      "           |                    |                               ",
      "            \\                  /                                ",
      "             '._            _.'                                 ",
      "          ______'-........-'______                              ",
      "        ,'                        ',                            ",
      "      ,'                            ',                          ",
      "     /                                \\                         ",
      "    |                                  |                        ",
      " ___|__________________________________|___                     ",
      "(____________________________________________)                  ",
    ],
  },
  {
    caption: "and starts typing",
    art: [
      "        .                                                       ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   | $ claude                               |  |           ",
      "    |   | > build me something that ships        |  |           ",
      "    |   |                                        |  |           ",
      "    |   |   thinking ...                         |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '        ~      [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                  /                  \\                          ",
      "                 /                    \\                         ",
      "               _.-''''''''-._                                   ",
      "             ,'              ',                                 ",
      "            /                  \\                                ",
      "           |                    |                               ",
      "            \\                  /                                ",
      "             '._            _.'                                 ",
      "          ______'-........-'______                              ",
      "        ,'                        ',                            ",
      "      ,'                            ',                          ",
      "     /                                \\                         ",
      "    |                                  |                        ",
      " ___|__________________________________|___                     ",
      "(____________________________________________)                  ",
    ],
  },
  {
    caption: "it starts answering back",
    art: [
      "        . *                                                     ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   | > build me something that ships        |  |           ",
      "    |   |                                        |  |           ",
      "    |   |   writing src/index.ts                 |  |           ",
      "    |   |   ~~~~~~~~~~~~~~                       |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '        ~      [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                  /                  \\                          ",
      "                 /                    \\                         ",
      "               _.-''''''''-._                                   ",
      "             ,'              ',                                 ",
      "            /                  \\                                ",
      "           |                    |                               ",
      "            \\                  /                                ",
      "             '._            _.'                                 ",
      "          ______'-........-'______                              ",
      "        ,'                        ',                            ",
      "      ,'                            ',                          ",
      "     /                                \\                         ",
      "    |                                  |                        ",
      " ___|__________________________________|___                     ",
      "(____________________________________________)                  ",
    ],
  },
  {
    caption: "something is taking shape",
    art: [
      "        . * .                                                   ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   |   writing src/index.ts                 |  |           ",
      "    |   |   writing src/server.ts                |  |           ",
      "    |   |   ##############..........  41%        |  |           ",
      "    |   |                                        |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '        ~      [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                  /                  \\                          ",
      "                 /                    \\                         ",
      "               _.-''''''''-._                                   ",
      "             ,'              ',                                 ",
      "            /                  \\                                ",
      "           |                    |                               ",
      "            \\                  /                                ",
      "             '._            _.'                                 ",
      "          ______'-........-'______                              ",
      "        ,'                        ',                            ",
      "      ,'                            ',                          ",
      "     /                                \\                         ",
      "    |                                  |                        ",
      " ___|__________________________________|___                     ",
      "(____________________________________________)                  ",
    ],
  },
  {
    caption: "it stands up on its own",
    art: [
      "        * . *                                                   ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   |   building ...                         |  |           ",
      "    |   |   ############################  98%    |  |           ",
      "    |   |   no errors                            |  |           ",
      "    |   |                                        |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '        ~      [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                  /                  \\                          ",
      "                 /                    \\                         ",
      "               _.-''''''''-._                                   ",
      "             ,'              ',                                 ",
      "            /                  \\                                ",
      "           |                    |                               ",
      "            \\                  /                                ",
      "             '._            _.'                                 ",
      "          ______'-........-'______                              ",
      "        ,'                        ',                            ",
      "      ,'                            ',                          ",
      "     /                                \\                         ",
      "    |                                  |                        ",
      " ___|__________________________________|___                     ",
      "(____________________________________________)                  ",
    ],
  },
  {
    caption: "you ship it, NAME",
    art: [
      "        * .  '*'  .                                             ",
      "      ______________________________________________            ",
      "     /                                              \\           ",
      "    |   .----------------------------------------.  |           ",
      "    |   |   built. shipped.                      |  |           ",
      "    |   |   ############################ 100%    |  |           ",
      "    |   |                                        |  |           ",
      "    |   |   + {TOKENS}                           |  |           ",
      "    |   '----------------------------------------'  |           ",
      "     \\____________________________________________/             ",
      "              \\__________________________/                      ",
      "                     |            |                             ",
      "  ___________________|____________|__________________           ",
      " '        ~      [::::::::::::::::::::]              '          ",
      "        (___)    '--------------------'                         ",
      "                  /                  \\                          ",
      "                 /                    \\                         ",
      "               _.-''''''''-._                                   ",
      "             ,'              ',                                 ",
      "            /                  \\                                ",
      "           |                    |                               ",
      "            \\                  /                                ",
      "             '._            _.'                                 ",
      "          ______'-........-'______                              ",
      "        ,'                        ',                            ",
      "      ,'                            ',                          ",
      "     /                                \\                         ",
      "    |                                  |                        ",
      " ___|__________________________________|___                     ",
      "(____________________________________________)                  ",
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Put the person's name in the story.
 *
 * "somebody sits down" is a stock animation playing at you. The same frames
 * with your own handle in them are about you, which is the difference between
 * a loading screen and a welcome — and this is the one moment the tool has
 * their full attention.
 */
function personalise(caption: string, name?: string): string {
  return caption.replace(/NAME/g, name ?? "somebody");
}

/**
 * Put the reader's own number on the screen, or no number at all.
 *
 * The closing frame used to read "+ 6,300,000 tokens counted" as fixed art —
 * somebody else's lifetime total, shown to everybody. Somebody with 180K real
 * tokens watched a fabricated 6.3M scroll past and then got handed their
 * actual figure a moment later by the rank card, which made the first number
 * the product ever showed them a made-up one. A count we do not have yet is
 * not a smaller number, it is no number.
 */
function fillTokens(line: string, tokens?: number): string {
  const start = line.indexOf("{TOKENS}");
  if (start === -1) return line;
  /* The frame repaints in place over a fixed number of lines, so the
     substitution has to leave the row exactly as wide as it was. Write into
     the span between the placeholder and the panel's closing border, and pad
     to fill it rather than letting a shorter number shift the border left. */
  const end = line.indexOf("|", start);
  const span = (end === -1 ? line.length : end) - start;
  const text =
    tokens === undefined
      ? "counting your tokens ..."
      : `${tokens.toLocaleString("en-US")} tokens counted`;
  return (
    line.slice(0, start) + text.slice(0, span).padEnd(span) + line.slice(start + span)
  );
}

function render(
  frame: Frame,
  index: number,
  shift: number,
  name?: string,
  tokens?: number
): string {
  const lines = [
    pc.dim(PERF),
    ...frame.art.map((line, row) =>
      gradient(fillTokens(line, tokens), shift + row * 0.03)
    ),
    pc.dim(PERF),
    /* Padded to a fixed width because the strip repaints in place: a shorter
       caption drawn over a longer one leaves the tail of the longer one on
       screen, and the line reads as two captions spliced together. */
    `  ${pc.dim(`${index + 1}/${FRAMES.length}`)}  ${pc.bold(
      personalise(frame.caption, name).padEnd(WIDTH - 6)
    )}`,
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
export async function playReel(
  name?: string,
  tokens?: () => number | undefined
): Promise<void> {
  if (!canAnimate) {
    console.log(
      render(FRAMES[FRAMES.length - 1], FRAMES.length - 1, 0, name, tokens?.())
    );
    return;
  }
  process.stdout.write("\x1b[?25l"); // hide the cursor while it repaints
  try {
    for (let i = 0; i < FRAMES.length; i++) {
      const body = render(FRAMES[i], i, i * 0.08, name, tokens?.());
      process.stdout.write(i === 0 ? body + "\n" : `\x1b[${LINES}A` + body + "\n");
      await sleep(i === FRAMES.length - 1 ? 700 : 420);
    }
  } finally {
    process.stdout.write("\x1b[?25h");
  }
}

/** Every frame, one after another — for screenshots and the README. */
export function reelFrames(name?: string, tokens?: number): string[] {
  return FRAMES.map((frame, index) =>
    render(frame, index, index * 0.08, name, tokens)
  );
}
