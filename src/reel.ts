import { canAnimate, gradient } from "./ui";

/**
 * A flipbook of a hand typing, drawn as pages in a sketchbook.
 *
 * Onboarding has real waiting in it — every transcript on the machine off disk
 * and a round trip per batch — and a spinner spends that time saying only "not
 * finished". Fourteen pages of a hand working a keyboard say something
 * instead, and the page's own label carries the story while the drawing
 * carries the motion.
 *
 * The geometry is fixed: every page is exactly PAGE_W by PAGE_H, so the cursor
 * walks back a known number of rows and repaints in place. Only the fingers and
 * the keys beneath them change between pages; the wrist, sleeve and chassis are
 * byte-identical throughout, which is what stops the loop from flickering.
 */

/* Every page is this tall, which is what lets the cursor walk back a known
   number of rows and repaint in place. Width is guarded in reel.test.ts. */
const PAGE_W = 76;
const PAGE_H = 23;

/** The drawing. Pages, not frames — this is a sketchbook. */
const PAGES: string[][] = [
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                     ,-'                             '-,                    ",
    "                    /        .-----------------.        \\                   ",
    "                    |        |                 |        |                   ",
    "                    |        |                 |        |                   ",
    "                     \\       '-----------------'       /                    ",
    "                      \\                               /                     ",
    "                       \\                             /                      ",
    "                        \\                           /                       ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  |   _/\\_                  _/\\_       |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                     ,-'                             '-,                    ",
    "                    /        .-----------------.        \\                   ",
    "                    |        |      $ mkdir    |        |                   ",
    "                    |        |      my-thing   |        |                   ",
    "                     \\       '-----------------'       /                    ",
    "                      \\                               /                     ",
    "                       \\                             /                      ",
    "                        \\                           /                       ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  | _/\\_                    _/\\_       |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                     ,-'                             '-,                    ",
    "                    /        .-----------------.        \\                   ",
    "                    |        |      $ claude   |        |                   ",
    "                    |        |                 |        |                   ",
    "                     \\       '-----------------'       /                    ",
    "                      \\                               /                     ",
    "                       \\                             /                      ",
    "                        \\                           /                       ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  |   _/\\_                    _/\\_     |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                     ,-'                             '-,                    ",
    "                    /        .-----------------.        \\                   ",
    "                    |        |      build me   |        |                   ",
    "                    |        |      a thing    |        |                   ",
    "                     \\       '-----------------'       /                    ",
    "                      \\                               /                     ",
    "                       \\                             /                      ",
    "                        \\                           /                       ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  | _/\\_                    _/\\_       |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                     ,-'                             '-,                    ",
    "                    /        .-----------------.        \\                   ",
    "                    |        |      writing    |        |                   ",
    "                    |        |      index.ts   |        |                   ",
    "                     \\       '-----------------'       /                    ",
    "                      \\                               /                     ",
    "                       \\                             /                      ",
    "                        \\                           /                       ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  |   _/\\_                    _/\\_     |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                   o                                     o                  ",
    "                    \\                                   /                   ",
    "                     \\                                 /                    ",
    "                      ,-'                           '-,                     ",
    "                      |      .-----------------.      |                     ",
    "                      |      |      [####  ]   |      |                     ",
    "                      |      |        67%      |      |                     ",
    "                      |      '-----------------'      |                     ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  |                                    |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                     ,-'                             '-,                    ",
    "                    /        .-----------------.        \\                   ",
    "                    |        |       tests     |        |                   ",
    "                    |        |         OK      |        |                   ",
    "                     \\       '-----------------'       /                    ",
    "                      \\                               /                     ",
    "                       \\                             /                      ",
    "                        \\                           /                       ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  | _/\\_                    _/\\_       |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
  [
    "                                .-~~~~~~~~-.                                ",
    "                               ,'  .-  .-  ',                               ",
    "                               | ( o )( o ) |                               ",
    "                               |    \\..  /   |                              ",
    "                               |    '--'    |                               ",
    "                                '-.______.-'                                ",
    "                                    |  |                                    ",
    "                                  __|  |__                                  ",
    "                     ,-'                             '-,                    ",
    "                    /        .-----------------.        \\                   ",
    "                    |        |      SHIPPED    |        |                   ",
    "                    |        | {TOKENS}        |        |                   ",
    "                     \\       '-----------------'       /                    ",
    "                      \\                               /                     ",
    "                       \\                             /                      ",
    "                        \\                           /                       ",
    "                ____________________________________________                ",
    "                |  ,------------------------------------,  |                ",
    "                |  |   _/\\_                    _/\\_     |  |                ",
    "                |  | [][][][][][][][][][][][][][][][][] |  |                ",
    "                |  '------------------------------------'  |                ",
    "                |__________________________________________|                ",
    "                       \\______________________________/                     ",
  ],
];







/**
 * What the page is a study of. Advances slower than the drawing, because a
 * caption that changed every 100ms would be unreadable and the hand is the
 * thing carrying the motion.
 */
const BEATS = [
  "NAME sits down",
  "opens something empty",
  "and starts typing",
  "it starts answering back",
  "something is taking shape",
  "hands up — it builds",
  "the tests go green",
  "shipped",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function personalise(text: string, name?: string): string {
  return text.replace(/NAME/g, name ?? "somebody");
}

/**
 * Put the reader's own number on the page, or no number at all.
 *
 * A closing frame once read "+ 6,300,000 tokens counted" as fixed art — one
 * person's lifetime total, shown to everybody, contradicted seconds later by
 * the rank card. A count we do not have yet is not a smaller number, it is no
 * number.
 */
function fill(line: string, beat: string, tokens?: number): string {
  const at = line.indexOf("{TOKENS}");
  if (at === -1) return line;
  /* Write into the span up to the panel border and pad to fill it: the pages
     repaint on top of each other, so a shorter number would walk the border
     left on exactly the row carrying it. A count we do not have yet is not a
     smaller number, it is no number. */
  const rest = line.slice(at);
  const stops = [rest.indexOf("|"), rest.indexOf("'")].filter((i) => i > 0);
  const span = stops.length ? Math.min(...stops) : rest.length;
  const text =
    tokens === undefined
      ? "counting your tokens"
      : `${tokens.toLocaleString("en-US")} tokens`;
  void beat;
  return line.slice(0, at) + text.slice(0, span).padEnd(span) + line.slice(at + span);
}

function render(page: string[], beat: string, shift: number, tokens?: number): string {
  const body = page
    .map((line, row) => "  " + gradient(fill(line, beat, tokens), shift + row * 0.02))
    .join("\n");
  /* The caption rides above the drawing rather than inside it: the scene is a
     picture, and a label pinned into the artwork competes with it. */
  return `  ${gradient("  " + beat.padEnd(PAGE_W - 2))}\n` + body;
}

/** Rows this occupies on screen, including the two-space left margin. */
const LINES = PAGE_H + 1; // the caption row above the drawing

/**
 * Flip through the pages. Loops until `done` resolves, then stops on the last
 * page so the reader ends on a settled drawing rather than mid-keystroke.
 */
export async function playReel(
  name?: string,
  tokens?: () => number | undefined,
  done?: Promise<unknown>
): Promise<void> {
  const beatFor = (i: number) =>
    personalise(BEATS[Math.min(BEATS.length - 1, i % PAGES.length)], name);

  if (!canAnimate) {
    console.log(render(PAGES[PAGES.length - 1], beatFor(0), 0, tokens?.()));
    return;
  }

  /* Repainting walks the cursor back over the drawing's own height. In a
     window shorter than that the terminal has already scrolled, so those rows
     are not where the cursor thinks they are and every repaint smears the last
     one down the screen. Print one page instead. */
  const rows = process.stdout.rows ?? 24;
  if (rows < LINES + 4) {
    console.log(render(PAGES[PAGES.length - 1], beatFor(0), 0, tokens?.()));
    return;
  }

  let finished = false;
  void done?.then(() => {
    finished = true;
  });

  process.stdout.write("\x1b[?25l"); // hide the cursor while it repaints
  try {
    const minimum = PAGES.length;
    for (let i = 0; ; i++) {
      const page = PAGES[i % PAGES.length];
      const body = render(page, beatFor(i), i * 0.03, tokens?.());
      process.stdout.write(i === 0 ? body + "\n" : `\x1b[${LINES}A` + body + "\n");
      if (i >= minimum && (finished || i >= PAGES.length * 3)) break;
      await sleep(320);
    }
  } finally {
    process.stdout.write("\x1b[?25h");
  }
}

/** Every page, one after another — for screenshots and the README. */
export function reelFrames(name?: string, tokens?: number): string[] {
  return PAGES.map((page, i) =>
    render(page, personalise(BEATS[Math.min(BEATS.length - 1, i % BEATS.length)], name), i * 0.03, tokens)
  );
}
