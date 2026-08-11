import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key-not-used";

const { normalizeReport, scoreBand, validatePerformanceReport } = await import("../api/feedback.js");

const dimension = score => ({ score, evidence: "Measured evidence." });

function completeReport() {
  return {
    summary: "A complete report.",
    overallScore: 0,
    vocal: {
      score: 82,
      confidence: "high",
      dimensions: Object.fromEntries(
        ["pace", "pauses", "pitchRange", "volumeVariation", "emphasis", "rhythm"]
          .map(name => [name, dimension(82)])
      ),
    },
    verbal: {
      score: 70,
      confidence: "high",
      dimensions: Object.fromEntries(
        ["clarity", "structure", "logicalFlow", "wordChoice", "concision", "fillerControl", "repetitionControl"]
          .map(name => [name, dimension(70)])
      ),
    },
    prep: {
      score: 70,
      confidence: "high",
      steps: {
        point: dimension(80),
        reason: dimension(70),
        example: dimension(70),
        finalPoint: dimension(60),
      },
    },
    strengths: [1, 2, 3].map(index => ({ category: "Strength", point: `Point ${index}`, evidence: "Evidence" })),
    improvements: [1, 2, 3].map(index => ({ category: "Improvement", point: `Point ${index}`, evidence: "Evidence" })),
    nextFocus: { title: "Use a final point", action: "Repeat the main idea once at the end." },
    previousPerformance: { challenges: [] },
  };
}

function setAllScores(raw, score) {
  for (const item of Object.values(raw.vocal.dimensions)) item.score = score;
  for (const item of Object.values(raw.verbal.dimensions)) item.score = score;
  for (const item of Object.values(raw.prep.steps)) item.score = score;
  return raw;
}

test("uses the agreed 50/30/20 weighting instead of averaging vocal and verbal reviews", () => {
  const raw = completeReport();
  assert.deepEqual(validatePerformanceReport(raw, { hasAudioMetrics: true }), []);
  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 74);
  assert.equal(report.scoreBreakdown.messageAndStructure.weight, 50);
  assert.equal(report.scoreBreakdown.delivery.weight, 30);
  assert.equal(report.scoreBreakdown.languageControl.weight, 20);
  assert.equal(report.version, 5);
});

test("rejects the partial report that previously produced a vocal-only overall score", () => {
  const raw = completeReport();
  for (const item of Object.values(raw.verbal.dimensions)) item.score = null;
  for (const item of Object.values(raw.prep.steps)) item.score = null;
  raw.nextFocus = {};

  const issues = validatePerformanceReport(raw, { hasAudioMetrics: true });
  assert.ok(issues.includes("verbal.clarity"));
  assert.ok(issues.includes("verbal.repetitionControl"));
  assert.ok(issues.includes("prep.point"));
  assert.ok(issues.includes("prep.finalPoint"));
  assert.ok(issues.includes("nextFocus.title"));
});

test("treats a missing PREP element scored as zero as measured", () => {
  const raw = completeReport();
  raw.prep.steps.example = dimension(0);
  assert.deepEqual(validatePerformanceReport(raw, { hasAudioMetrics: true }), []);
});

test("caps a fluent but completely unstructured speech below 50", () => {
  const raw = setAllScores(completeReport(), 90);
  for (const item of Object.values(raw.prep.steps)) item.score = 0;

  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 49);
  assert.equal(report.scoreCap.applied, true);
  assert.match(report.scoreCap.reason, /capped at 49/i);
});

test("caps a speech with no clear Point even when the delivery is strong", () => {
  const raw = setAllScores(completeReport(), 90);
  raw.prep.steps.point.score = 25;

  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 49);
  assert.match(report.scoreCap.reason, /clear Point/i);
});

test("renames Concision in user-facing report categories", () => {
  const raw = completeReport();
  raw.improvements[0].category = "Concision";
  assert.equal(normalizeReport(raw).improvements[0].category, "Clear and direct");
});

test("places an average complete speech in the developing range", () => {
  const report = normalizeReport(setAllScores(completeReport(), 65));
  assert.equal(report.overallScore, 65);
  assert.equal(report.scoreBand, "Developing");
});

test("reserves exceptional scores for excellent complete speeches", () => {
  const report = normalizeReport(setAllScores(completeReport(), 94));
  assert.equal(report.overallScore, 94);
  assert.equal(report.scoreBand, "Exceptional");
  assert.equal(report.scoreCap.applied, false);
});

test("uses clear score-band labels", () => {
  assert.equal(scoreBand(25), "Poor");
  assert.equal(scoreBand(49), "Needs significant improvement");
  assert.equal(scoreBand(62), "Developing");
  assert.equal(scoreBand(77), "Competent");
  assert.equal(scoreBand(85), "Strong");
  assert.equal(scoreBand(93), "Exceptional");
});
