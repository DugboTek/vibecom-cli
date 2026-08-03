/**
 * Turn token counts into dollars.
 *
 * Cost used to arrive already-computed, in the OTLP metric stream Claude Code
 * exports. The installer stopped configuring that export — it is a global
 * setting, so opting in aimed telemetry at every repository on the machine,
 * including employers' — and cost went to zero with it. Transcripts carry no
 * cost field to fall back on: current Claude Code records `usage` and `model`
 * on every assistant message and no price anywhere.
 *
 * They do carry everything needed to derive it. So the number is computed here
 * from published list prices rather than reported by the tool, which is why it
 * is an API-equivalent figure and not a bill: nobody paying a flat monthly
 * subscription was ever charged this. It answers "what did this volume cost at
 * list price", the same question the old metric answered.
 *
 * A model with no rate is never quietly priced at zero. It returns null, the
 * caller counts its tokens as unpriced, and that count travels all the way to
 * the profile — because the failure this replaces was a silent zero that looked
 * exactly like a real one.
 */

/** Tokens for a single request, split the way pricing treats them. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Anthropic bills a premium to write a cache entry; the TTL sets the rate. */
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
};

/** USD per million tokens, resolved per token class. */
type Rate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/**
 * Anthropic multipliers over the base input rate: reads are a tenth, and a
 * cache write costs more than the tokens would have cost uncached — 1.25x at
 * the five-minute TTL, 2x at the hour.
 */
const anthropic = (input: number, output: number): Rate => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

/** OpenAI discounts cached input to a tenth and charges nothing to write it. */
const openai = (input: number, output: number): Rate => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});

/**
 * Current published list prices, keyed by model family.
 *
 * Deliberately flat rather than date-versioned. Vendors reprice — OpenAI cut
 * these in July 2026 — and reconstructing a price history from third-party
 * archives would produce a number nobody could check. One stated methodology,
 * "what this volume costs at today's list price", is reproducible: anyone can
 * re-derive it from these rates and their own transcripts.
 *
 * Entries are only added for models with a published rate. Anything missing
 * stays missing; see `priceUsage`.
 */
const RATES: Record<string, Rate> = {
  // Anthropic, first-party API rates.
  "claude-fable-5": anthropic(10, 50),
  "claude-mythos-5": anthropic(10, 50),
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-sonnet-5": anthropic(3, 15),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-haiku-4-5": anthropic(1, 5),

  // OpenAI, list prices as of the 2026-07-30 reduction.
  "gpt-5.6-sol": openai(5, 30),
  "gpt-5.6-terra": openai(2, 12),
  "gpt-5.6-luna": openai(0.2, 1.2),
  "gpt-5.5": openai(5, 30),
};

/**
 * Models that are genuinely free, as opposed to merely unrated.
 *
 * Claude Code labels locally generated messages `<synthetic>` — interrupts,
 * cancellations, harness notices. They never reach an API and carry no usage,
 * so they cost nothing. Counting them as unpriced would understate coverage
 * with tokens that were never billable in the first place.
 */
const FREE = new Set(["<synthetic>"]);

/**
 * Resolve a rate for a model id.
 *
 * Ids pick up suffixes — `claude-haiku-4-5-20251001` is the dated snapshot of
 * `claude-haiku-4-5` — so a family key matches its own dated and tiered
 * variants. The boundary has to be a hyphen, or `gpt-5.5` would swallow a
 * future `gpt-5.55`, and the longest key wins so `claude-opus-4-8` is never
 * resolved by a shorter `claude-opus-4`.
 */
export function rateFor(model: string | null | undefined): Rate | null {
  if (!model) return null;
  if (FREE.has(model)) return anthropic(0, 0);
  let best: string | null = null;
  for (const key of Object.keys(RATES)) {
    if (model !== key && !model.startsWith(`${key}-`)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? RATES[best] : null;
}

/** Every token in a usage record, priced or not. */
export const totalTokens = (usage: TokenUsage): number =>
  usage.inputTokens +
  usage.outputTokens +
  usage.cacheReadTokens +
  usage.cacheWrite5mTokens +
  usage.cacheWrite1hTokens;

/**
 * Cost of one usage record at list price, or null when the model has no rate.
 *
 * Null is the whole point of the return type: a caller that treats "unknown
 * model" as "$0" reintroduces the bug this module exists to fix.
 */
export function priceUsage(
  model: string | null | undefined,
  usage: TokenUsage
): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  return (
    (usage.inputTokens * rate.input +
      usage.outputTokens * rate.output +
      usage.cacheReadTokens * rate.cacheRead +
      usage.cacheWrite5mTokens * rate.cacheWrite5m +
      usage.cacheWrite1hTokens * rate.cacheWrite1h) /
    1_000_000
  );
}

/** Model families with a published rate, for docs and tests. */
export const pricedModels = (): string[] => Object.keys(RATES).sort();
