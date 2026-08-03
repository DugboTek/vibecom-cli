import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pricedModels,
  priceUsage,
  rateFor,
  totalTokens,
  type TokenUsage,
} from "./pricing";

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...over,
});

test("input and output bill at the model's list rate", () => {
  // Opus 5 is $5/M in, $25/M out.
  const usd = priceUsage(
    "claude-opus-5",
    usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
  );
  assert.equal(usd, 30);
});

test("cache reads bill at a tenth of input, writes at a premium", () => {
  const read = priceUsage("claude-opus-5", usage({ cacheReadTokens: 1_000_000 }));
  assert.equal(read, 0.5);

  // 1.25x at the five-minute TTL, 2x at the hour.
  const write5m = priceUsage(
    "claude-opus-5",
    usage({ cacheWrite5mTokens: 1_000_000 })
  );
  assert.equal(write5m, 6.25);

  const write1h = priceUsage(
    "claude-opus-5",
    usage({ cacheWrite1hTokens: 1_000_000 })
  );
  assert.equal(write1h, 10);
});

test("OpenAI cache writes are free, unlike Anthropic's", () => {
  assert.equal(
    priceUsage("gpt-5.6-sol", usage({ cacheWrite5mTokens: 1_000_000 })),
    0
  );
  assert.equal(
    priceUsage("gpt-5.6-sol", usage({ cacheReadTokens: 1_000_000 })),
    0.5
  );
});

test("a dated snapshot resolves to its model family", () => {
  // claude-haiku-4-5-20251001 is what the transcripts actually record.
  assert.equal(
    priceUsage("claude-haiku-4-5-20251001", usage({ outputTokens: 1_000_000 })),
    5
  );
});

test("the longest matching family wins", () => {
  // A shorter prefix must never price a more specific model.
  const specific = priceUsage("gpt-5.6-terra", usage({ inputTokens: 1_000_000 }));
  const other = priceUsage("gpt-5.6-sol", usage({ inputTokens: 1_000_000 }));
  assert.equal(specific, 2);
  assert.equal(other, 5);
});

test("a family key does not match a longer sibling number", () => {
  // gpt-5.5 must not swallow a future gpt-5.55.
  assert.equal(rateFor("gpt-5.55"), null);
  assert.notEqual(rateFor("gpt-5.5"), null);
});

test("an unrated model returns null rather than zero", () => {
  // This is the whole contract: the caller must be able to tell "nothing to
  // charge" apart from "we had no rate", because a silent zero is what made
  // cost vanish from every profile in the first place.
  assert.equal(priceUsage("k3", usage({ outputTokens: 5_000_000 })), null);
  assert.equal(priceUsage("gpt-5.4", usage({ outputTokens: 5_000_000 })), null);
  assert.equal(priceUsage(null, usage({ outputTokens: 5_000_000 })), null);
  assert.equal(priceUsage(undefined, usage({ outputTokens: 1 })), null);
});

test("locally generated messages are free, not unrated", () => {
  // Claude Code's <synthetic> records never reach an API. Counting them as
  // unpriced would understate coverage with never-billable tokens.
  assert.equal(priceUsage("<synthetic>", usage({ outputTokens: 1_000 })), 0);
});

test("every priced model charges more for output than input", () => {
  // A transposed pair in the table would be invisible in any single figure.
  for (const model of pricedModels()) {
    const input = priceUsage(model, usage({ inputTokens: 1_000_000 }))!;
    const output = priceUsage(model, usage({ outputTokens: 1_000_000 }))!;
    assert.ok(
      output > input,
      `${model} prices output at ${output} and input at ${input}`
    );
  }
});

test("totalTokens counts every class exactly once", () => {
  assert.equal(
    totalTokens(
      usage({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 4,
        cacheWrite5mTokens: 8,
        cacheWrite1hTokens: 16,
      })
    ),
    31
  );
});
