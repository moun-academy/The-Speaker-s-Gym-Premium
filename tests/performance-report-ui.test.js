import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("keeps score calculation details optional, concise, and punctuated", () => {
  assert.doesNotMatch(html, /performance-score-basis[^\n]+report\.scoreBasis/);
  assert.match(html, /How is this score calculated\?/);
  assert.match(html, /class="performance-calculation" hidden/);
  assert.match(html, /Pace variety: 8 points\. Volume variety: 8 points\. Pitch variety: 8 points\. Pauses: 6 points\./);
  assert.match(html, /function activatePerformanceDetails/);
  assert.doesNotMatch(html, /DELIVERY[^<]*· 30%/);
});

test("uses the available mobile width and stacks the report cards", () => {
  assert.match(html, /#analyticsPage\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/s);
  assert.match(html, /\.performance-review-grid\s*\{\s*grid-template-columns:\s*1fr;/s);
  assert.match(html, /\.performance-hero\s*\{\s*padding:\s*12px 10px;/s);
});

test("hides Tone and clarifies vague coaching copy in stored reports", () => {
  assert.match(html, /type === 'vocal' && key === 'emphasis'/);
  assert.match(html, /Connect your example to your main point, then finish with one clear final sentence/);
  assert.match(html, /After the joke, state one real goal, explain why it matters/);
  assert.match(html, /Previous instruction:/);
  assert.doesNotMatch(html, /Variety keeps listeners engaged/);
  assert.match(html, /function factualDeliveryEvidence/);
  assert.match(html, /performanceReportHtml\(selected\.report,[^\n]+selected\.metrics \|\| null\)/);
});
