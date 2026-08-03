import pc from "picocolors";

/* Colour and animation degrade separately.

   Colour follows the usual contract — on for a TTY, forced by FORCE_COLOR,
   killed by NO_COLOR — so piping into `less -R` or a CI log still reads well.
   Animation additionally needs a real terminal: cursor-movement escapes
   written into a pipe would corrupt it. */
export const isTTY = Boolean(process.stdout.isTTY);
const forced = Boolean(process.env.FORCE_COLOR);
const disabled =
  Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb";

export const canColor = (isTTY || forced) && !disabled;
export const canAnimate = isTTY && !disabled && !process.env.CI;

type RGB = [number, number, number];

/** vibecom's ramp: community blue → signal lime. */
const RAMP: RGB[] = [
  [69, 174, 242],
  [79, 194, 227],
  [100, 215, 194],
  [159, 236, 123],
  [217, 255, 87],
];

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Sample the ramp at 0..1, wrapping so `shift` can scroll it forever. */
function sample(pos: number): RGB {
  const p = ((pos % 1) + 1) % 1;
  const scaled = p * (RAMP.length - 1);
  const i = Math.floor(scaled);
  return lerp(RAMP[i], RAMP[Math.min(i + 1, RAMP.length - 1)], scaled - i);
}

const rgb = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;

export function gradient(text: string, shift = 0): string {
  if (!canColor) return text;
  const chars = [...text];
  // Divide by length, not length-1: reaching exactly 1.0 wraps the ramp and
  // snaps the final character back to the start colour.
  return chars
    .map((ch, i) =>
      ch.trim() === "" ? ch : rgb(sample(i / Math.max(chars.length, 1) + shift), ch)
    )
    .join("");
}

const WORDMARK = [
  "██╗   ██╗██╗██████╗ ███████╗ ██████╗ ██████╗ ███╗   ███╗",
  "██║   ██║██║██╔══██╗██╔════╝██╔════╝██╔═══██╗████╗ ████║",
  "██║   ██║██║██████╔╝█████╗  ██║     ██║   ██║██╔████╔██║",
  "╚██╗ ██╔╝██║██╔══██╗██╔══╝  ██║     ██║   ██║██║╚██╔╝██║",
  " ╚████╔╝ ██║██████╔╝███████╗╚██████╗╚██████╔╝██║ ╚═╝ ██║",
  "  ╚═══╝  ╚═╝╚═════╝ ╚══════╝ ╚═════╝ ╚═════╝ ╚═╝     ╚═╝",
];

const COMPACT = "◆ vibecom";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sweep the gradient across the wordmark a few times, then settle. Falls back
 * to one static frame when the terminal is narrow or animation is off.
 */
export async function banner(subtitle: string): Promise<void> {
  const width = process.stdout.columns ?? 80;
  const wide = width >= 66;

  // No animation (piped, CI, dumb term) still gets one coloured frame.
  if (!canAnimate) {
    const art = wide
      ? WORDMARK.map((line, row) => "  " + gradient(line, row * 0.04)).join("\n")
      : "  " + gradient(COMPACT);
    console.log(`\n${art}\n  ${pc.dim(subtitle)}\n`);
    return;
  }

  if (!wide) {
    console.log("");
    for (let f = 0; f < 14; f++) {
      process.stdout.write(`\r  ${gradient(COMPACT, f / 14)}`);
      await sleep(45);
    }
    console.log(`\n  ${pc.dim(subtitle)}\n`);
    return;
  }

  console.log("");
  const frames = 18;
  for (let f = 0; f <= frames; f++) {
    const shift = f / frames;
    // Reveal left-to-right while the ramp scrolls underneath it.
    const revealed = Math.ceil((WORDMARK[0].length * (f + 1)) / (frames + 1));
    const out = WORDMARK.map(
      (line, row) => "  " + gradient(line.slice(0, revealed), shift + row * 0.04)
    ).join("\n");
    if (f > 0) process.stdout.write(`\x1b[${WORDMARK.length}A`);
    console.log(out);
    await sleep(28);
  }
  console.log(`  ${pc.dim(subtitle)}\n`);
}

/* ------- primitives ------- */

export const bullet = (s: string) => `  ${pc.dim("│")}  ${s}`;

export const rule = (label?: string) => {
  const width = Math.min(process.stdout.columns ?? 60, 60);
  if (!label) return pc.dim("─".repeat(width));
  const dashes = Math.max(width - label.length - 3, 0);
  return `${pc.dim("─")} ${gradient(label)} ${pc.dim("─".repeat(dashes))}`;
};

export const ok = (s: string) => `${pc.green("✔")} ${s}`;
export const warn = (s: string) => `${pc.yellow("▲")} ${s}`;
export const bad = (s: string) => `${pc.red("✖")} ${s}`;
export const plus = (s: string) => `  ${pc.green("+")} ${pc.dim(s)}`;
export const minus = (s: string) => `  ${pc.red("−")} ${pc.dim(s)}`;

/** Big, unmissable device code — the one thing the user must transcribe. */
export function bigCode(code: string): string {
  const padded = ` ${[...code].join(" ")} `;
  const line = "─".repeat(padded.length);
  return [
    pc.dim(`  ┌${line}┐`),
    `  ${pc.dim("│")}${gradient(padded, 0.2)}${pc.dim("│")}`,
    pc.dim(`  └${line}┘`),
  ].join("\n");
}

/** Pulse a line while awaiting `work`; clean single-line output when static. */
/** Mutable label so a long job can report where it has got to. */
export type Progress = { label: string };

export async function pulse<T>(
  label: string | Progress,
  work: Promise<T>
): Promise<T> {
  const read = () => (typeof label === "string" ? label : label.label);
  if (!canAnimate) {
    console.log(`  ${read()}`);
    return work;
  }
  let alive = true;
  work.finally(() => {
    alive = false;
  });
  const spin = (async () => {
    for (let f = 0; alive; f++) {
      const dots = ".".repeat(f % 4).padEnd(3);
      process.stdout.write(`\r\x1b[2K  ${gradient("◆", f / 12)} ${read()}${dots}`);
      await sleep(120);
    }
  })();
  try {
    return await work;
  } finally {
    await spin;
    /* Clear the line *and* return the cursor, then leave the row usable. The
       spinner writes with \r and no newline, so anything printed afterwards —
       a warning about a project that failed — landed on the same row and the
       output read as one mangled line. */
    process.stdout.write(`\r\x1b[2K`);
  }
}

/**
 * Run blocking work without freezing the spinner.
 *
 * Scanning is synchronous file I/O across thousands of transcripts, which
 * holds the event loop and stops any spinner from painting — the command looks
 * hung. Yielding between units lets the frame render and gives the caller a
 * place to report progress.
 */
export async function withProgress<Item, Result>(
  items: Item[],
  each: (item: Item, index: number) => Result,
  onTick?: (done: number, total: number) => void
): Promise<Result[]> {
  const out: Result[] = [];
  for (let i = 0; i < items.length; i++) {
    out.push(each(items[i], i));
    // Every few units is enough to keep the loop responsive without the
    // yields themselves dominating the run.
    if (i % 25 === 0) {
      onTick?.(i + 1, items.length);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  onTick?.(items.length, items.length);
  return out;
}

export function tierSwatch(tier: number): string {
  const colors = [pc.green, pc.yellow, pc.red];
  const fn = colors[tier - 1] ?? pc.dim;
  const empty = 3 - tier;
  return fn("●".repeat(tier)) + (empty > 0 ? pc.dim("○".repeat(empty)) : "");
}
