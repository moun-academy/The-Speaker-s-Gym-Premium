import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("shows the scoring formula once and keeps the score cards concise", () => {
  assert.doesNotMatch(html, /performance-score-basis[^\n]+report\.scoreBasis/);
  assert.match(html, /Pace variety 8 \+ Volume variety 8 \+ Pitch variety 8 \+ Pauses 6/);
  assert.doesNotMatch(html, /DELIVERY[^<]*· 30%/);
});

test("hides Tone and clarifies vague coaching copy in stored reports", () => {
  assert.match(html, /type === 'vocal' && key === 'emphasis'/);
  assert.match(html, /Connect your example to your main point, then finish with one clear final sentence/);
});
