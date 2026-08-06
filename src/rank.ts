/**
 * The builder ladder, rendered in the terminal.
 *
 * The server has carried ranks, levels and streaks since the beginning, and
 * the CLI — the surface people actually sit in front of while the numbers
 * change — showed none of it. Setup ended with a flat "you're live" and no
 * reason to run the command again.
 *
 * The thresholds mirror STARTER_THRESHOLDS in src/lib/ranks.ts. They are
 * duplicated rather than imported because the CLI bundles standalone from a
 * public repository with no access to the server tree; rank.test.ts asserts
 * the two stay identical, so drift fails the build rather than shipping a
 * promotion that the profile page disagrees with.
 */

export type Rank = { level: number; name: string; short: string; minTokens: number };

const LADDER: readonly [string, string, number][] = [
  ["Junior Vibe Coder I", "Jr Coder I", 0],
  ["Junior Vibe Coder II", "Jr Coder II", 250_000],
  ["Vibe Coder", "Vibe Coder", 510_000],
  ["Senior Vibe Coder", "Sr Coder", 1_000_000],
  ["Junior Vibe Engineer", "Jr Engineer", 2_100_000],
  ["Vibe Engineer", "Engineer", 4_200_000],
  ["Senior Vibe Engineer", "Sr Engineer", 8_500_000],
  ["Staff Vibe Engineer", "Staff Engineer", 17_000_000],
  ["Context Maxxer I", "Ctx Maxxer I", 35_000_000],
  ["Context Maxxer II", "Ctx Maxxer II", 71_000_000],
  ["Senior Context Maxxer", "Sr Ctx Maxxer", 140_000_000],
  ["Principal Context Maxxer", "Principal Ctx", 290_000_000],
  ["Production Menace I", "Menace I", 590_000_000],
  ["Production Menace II", "Menace II", 1_200_000_000],
  ["Senior Production Menace", "Sr Menace", 2_400_000_000],
  ["Distinguished Production Menace", "Dist. Menace", 4_900_000_000],
  ["Supreme Production Menace, First Class", "Supreme Menace", 9_900_000_000],
  ["VibeMAXXER", "VibeMAXXER", 20_000_000_000],
];

export const RANKS: readonly Rank[] = LADDER.map(
  ([name, short, minTokens], index) => ({ level: index + 1, name, short, minTokens })
);

export function rankFor(tokens: number): Rank {
  let current = RANKS[0];
  for (const rank of RANKS) if (tokens >= rank.minTokens) current = rank;
  return current;
}

export function nextRank(rank: Rank): Rank | null {
  return RANKS[rank.level] ?? null;
}

/** 0..1 through the current band; 1 at the top of the ladder. */
export function progressTo(tokens: number, rank: Rank): number {
  const next = nextRank(rank);
  if (!next) return 1;
  const span = next.minTokens - rank.minTokens;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (tokens - rank.minTokens) / span));
}

/** 72_000_000 -> "72M". Matches the site's compact notation. */
export function compact(n: number): string {
  if (n >= 1_000_000_000) return `${round(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${round(n / 1_000)}K`;
  return String(Math.round(n));
}

const round = (n: number) =>
  n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);

/**
 * A filled bar with a fractional final cell.
 *
 * Eighth-blocks make a 24-cell bar read like a 192-step one, which matters
 * when a band spans a doubling of tokens and a whole session may move it less
 * than one full cell. Without the partial the bar looks frozen and the work
 * looks uncounted.
 */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function bar(fraction: number, width = 24): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const cells = clamped * width;
  const full = Math.floor(cells);
  const remainder = Math.floor((cells - full) * 8);
  const head = "█".repeat(full) + (full < width ? EIGHTHS[remainder] : "");
  return head + "·".repeat(Math.max(0, width - [...head].length));
}

/** Braille-height sparkline; flat when every value matches. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const marks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return marks[max > 0 ? 3 : 0].repeat(values.length);
  return values
    .map((value) => {
      const scaled = (value - min) / (max - min);
      return marks[Math.min(marks.length - 1, Math.round(scaled * 7))];
    })
    .join("");
}

/**
 * How many days back from today have activity, counting only an unbroken run.
 *
 * Today missing does not break a streak — the day is not over. Yesterday
 * missing does.
 */
export function streakFrom(days: readonly string[], today: Date): number {
  const seen = new Set(days);
  const cursor = new Date(today);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (!seen.has(iso(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (seen.has(iso(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}
