import assert from "node:assert/strict";
import { test } from "node:test";

import { reelFrames } from "./reel";

/* The closing frame once read "+ 6,300,000 tokens counted" as fixed art — one
   person's lifetime total, shown to everyone. Somebody with 180K real tokens
   watched a fabricated 6.3M scroll past and was handed their true figure a
   moment later by the rank card, so the first number the product ever showed
   them was invented. These tests exist to keep any number on that screen the
   reader's own. */

const ESC = String.fromCharCode(27);
const strip = (text: string) =>
  text.split(new RegExp(`${ESC}\\[[0-9;]*m`, "g")).join("");

test("the reel never states a token count it was not given", () => {
  const frames = reelFrames("builder").map(strip).join("\n");
  const numbers = frames.match(/[\d][\d,]{3,}/g) ?? [];
  assert.deepEqual(
    numbers,
    [],
    `the reel invented these figures: ${numbers.join(", ")}`
  );
  assert.match(frames, /counting your tokens/);
});

test("given a real total, the reel shows that total", () => {
  const frames = reelFrames("builder", 412_000).map(strip).join("\n");
  assert.match(frames, /412,000 tokens counted/);
  assert.doesNotMatch(frames, /counting your tokens/);
});

test("substituting the count does not change the frame geometry", () => {
  /* The strip repaints in place by walking back a fixed number of lines, so a
     substitution that changes a row's width corrupts every frame after it. */
  for (const value of [undefined, 0, 412_000, 987_654_321]) {
    const widths = new Set(
      reelFrames("builder", value)
        .flatMap((frame) => strip(frame).split("\n"))
        .filter((line) => line.includes("|"))
        .map((line) => line.length)
    );
    assert.equal(
      widths.size,
      1,
      `tokens=${value} produced rows of differing width: ${[...widths].join(", ")}`
    );
  }
});

test("no frame claims something happened on the reader's machine", () => {
  /* "tests 329 passed" was a claim about a test run the CLI never performed. */
  const frames = reelFrames("builder").map(strip).join("\n");
  assert.doesNotMatch(frames, /tests \d+ passed/);
});
