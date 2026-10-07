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

test("GPT-5.6 bills cache writes and discounts cache reads", () => {
  assert.equal(
    priceUsage("gpt-5.6-sol", usage({ cacheWrite5mTokens: 100_000 })),
    0.5
  );
  assert.equal(
    priceUsage("gpt-5.6-sol", usage({ cacheReadTokens: 100_000 })),
    0.04
  );
  assert.equal(
    priceUsage("gpt-5.5", usage({ cacheWrite5mTokens: 100_000 })),
    0,
    "the write charge starts with GPT-5.6"
  );
});

test("every GPT-5.6 tier uses its published list rate", () => {
  assert.equal(
    priceUsage("gpt-5.6-terra", usage({ inputTokens: 100_000 })),
    0.2
  );
  assert.equal(
    priceUsage("gpt-5.6-terra", usage({ outputTokens: 100_000 })),
    1.2
  );
  assert.equal(
    priceUsage("gpt-5.6-luna", usage({ inputTokens: 100_000 })),
    0.02
  );
  assert.equal(
    priceUsage("gpt-5.6-luna", usage({ outputTokens: 100_000 })),
    0.12
  );
});

test("published rates cover the Codex models present in historical scans", () => {
  assert.equal(
    priceUsage("gpt-5.2-codex", usage({ outputTokens: 100_000 })),
    1.4
  );
  assert.equal(
    priceUsage("gpt-5.3-codex", usage({ inputTokens: 100_000 })),
    0.175
  );
  assert.equal(
    priceUsage("gpt-5.4", usage({ outputTokens: 100_000 })),
    1.5
  );
  assert.equal(
    priceUsage("gpt-5.4-mini", usage({ inputTokens: 100_000 })),
    0.075
  );
});

test("OpenAI long-context pricing is applied per request", () => {
  const atLimit = priceUsage(
    "gpt-5.6-sol",
    usage({ inputTokens: 2_000, cacheReadTokens: 270_000, outputTokens: 10_000 })
  );
  const aboveLimit = priceUsage(
    "gpt-5.6-sol",
    usage({ inputTokens: 2_001, cacheReadTokens: 270_000, outputTokens: 10_000 })
  );

  assert.ok(Math.abs(atLimit! - 0.316) < 1e-12);
  assert.ok(Math.abs(aboveLimit! - 0.532008) < 1e-12);
});

test("GPT-5.4 mini does not receive the 1.05M-context uplift", () => {
  assert.equal(
    priceUsage("gpt-5.4-mini", usage({ inputTokens: 1_000_000 })),
    0.75
  );
});

test("Sonnet 5 uses its published standard rate", () => {
  assert.equal(
    priceUsage(
      "claude-sonnet-5",
      usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    ),
    12
  );
});

test("Kimi K3 and its wire model id use the published API rate", () => {
  for (const model of ["k3", "kimi-code/k3", "kimi-k3"]) {
    assert.equal(priceUsage(model, usage({ inputTokens: 100_000 })), 0.3);
    assert.ok(
      Math.abs(priceUsage(model, usage({ cacheReadTokens: 100_000 }))! - 0.03) <
        1e-12
    );
    assert.equal(priceUsage(model, usage({ outputTokens: 100_000 })), 1.5);
    assert.equal(priceUsage(model, usage({ cacheWrite5mTokens: 100_000 })), 0.3);
    assert.equal(priceUsage(model, usage({ cacheWrite1hTokens: 100_000 })), 0.6);
  }
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
  const specific = priceUsage("gpt-5.6-terra", usage({ inputTokens: 100_000 }));
  const other = priceUsage("gpt-5.6-sol", usage({ inputTokens: 100_000 }));
  assert.equal(specific, 0.2);
  assert.equal(other, 0.4);
});

test("GPT-6 tiers keep their distinct cached-input discounts", () => {
  assert.equal(priceUsage("gpt-6.1-sol", usage({ cacheReadTokens: 100_000 })), 0.01);
  assert.equal(priceUsage("gpt-6-sol", usage({ cacheReadTokens: 100_000 })), 0.02);
  assert.equal(priceUsage("gpt-6-astra", usage({ inputTokens: 100_000 })), 1);
  assert.equal(priceUsage("gpt-6-luna", usage({ outputTokens: 1_000_000 })), 0.5);
});

test("new Claude tiers use their published cache-read rates", () => {
  for (const model of ["claude-fable-5-1", "claude-mythos-5-1"]) {
    assert.equal(priceUsage(model, usage({ cacheReadTokens: 1_000_000 })), 0.25);
  }
  assert.equal(priceUsage("claude-opus-5-5", usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 })), 24);
  assert.equal(priceUsage("claude-opus-5-5", usage({ cacheReadTokens: 1_000_000 })), 0.2);
  assert.equal(priceUsage("claude-sonnet-5-5", usage({ cacheReadTokens: 1_000_000 })), 0.2);
});

test("Haiku 5.5 applies its 100K request threshold, including cached input", () => {
  assert.equal(priceUsage("claude-haiku-5-5", usage({ inputTokens: 100_000 })), 0.01);
  const above = priceUsage("claude-haiku-5-5", usage({ inputTokens: 1, cacheReadTokens: 100_000, outputTokens: 1_000 }));
  assert.ok(Math.abs(above! - 0.0075005) < 1e-12);
  assert.equal(priceUsage("claude-haiku-5-5", usage({ inputTokens: 200_000 }), false), 0.02,
    "whole-session totals cannot establish a single request's context size");
});

test("unknown premium tiers and future versions never inherit a base rate", () => {
  for (const model of ["gpt-5.4-pro", "gpt-5.5-pro", "claude-opus-5-99", "gpt-5.6-sol-hypothetical"]) {
    assert.equal(rateFor(model), null, model);
  }
  assert.equal(priceUsage("gpt-5.2-codex-2025-12-11", usage({ outputTokens: 100_000 })), 1.4);
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
  assert.equal(
    priceUsage("gpt-5.3-codex-spark", usage({ outputTokens: 5_000_000 })),
    null
  );
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
    const input = priceUsage(model, usage({ inputTokens: 1_000_000 }), false)!;
    const output = priceUsage(model, usage({ outputTokens: 1_000_000 }), false)!;
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
