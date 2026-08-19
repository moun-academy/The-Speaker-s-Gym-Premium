import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("bases the Speaking Score primarily on the latest five AI reports", () => {
  assert.match(html, /function speakingScoreSnapshot/);
  assert.match(html, /speech\?\.report\?\.version >= 8/);
  assert.match(html, /Number\(speech\.report\.overallScore\)/);
  assert.match(html, /\.slice\(-5\)/);
  assert.match(html, /recentPerformance \* 0\.8/);
  assert.match(html, /consistency \* 0\.2/);
  assert.match(html, /Updates after every AI-analyzed speech\. Latest five reports: 80%\. Practice consistency: 20%\./);
});

test("removes the old coarse pacing, filler, and self-rating score factors", () => {
  assert.match(html, /id="sfRecentPerformance"/);
  assert.match(html, /id="sfConsistency"/);
  assert.doesNotMatch(html, /id="sfPacing"|id="sfClarity"|id="sfConfidence"/);
});

test("uses clear pace sample language without numbered sections", () => {
  assert.match(html, /Your slowest 12-word sample was/);
  assert.match(html, /Around \$\{Math\.floor\(rounded \/ 60\)\}/);
  assert.doesNotMatch(html, /short sections|entering section/);
});
