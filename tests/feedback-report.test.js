import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key-not-used";

const { analyzePaceVariety, normalizeReport, scoreBand, validatePerformanceReport } = await import("../api/feedback.js");

const dimension = score => ({ score, evidence: "Measured evidence." });

function completeReport() {
  return {
    summary: "A complete report.",
    overallScore: 0,
    vocal: {
      score: 82,
      confidence: "high",
      dimensions: Object.fromEntries(
        ["pace", "volumeVariation", "pitchRange", "pauses"]
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
  assert.equal(report.version, 7);
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
  assert.equal(report.overallScore, 39);
  assert.equal(report.scoreCap.applied, true);
  assert.match(report.scoreCap.reason, /limited to 39/i);
});

test("caps a speech with no clear Point even when the delivery is strong", () => {
  const raw = setAllScores(completeReport(), 90);
  raw.prep.steps.point.score = 25;

  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 39);
  assert.match(report.scoreCap.reason, /clear, coherent, and relevant answer/i);
});

test("limits a Point without a meaningful Reason or Example to 49", () => {
  const raw = setAllScores(completeReport(), 90);
  raw.prep.steps.reason.score = 20;
  raw.prep.steps.example.score = 20;

  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 49);
  assert.match(report.scoreCap.reason, /meaningful Reason or Example/i);
});

test("limits weak or incomplete structure to 59", () => {
  const raw = setAllScores(completeReport(), 80);
  raw.prep.steps.point.score = 60;
  raw.prep.steps.reason.score = 55;
  raw.prep.steps.example.score = 20;
  raw.prep.steps.finalPoint.score = 20;

  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 59);
  assert.match(report.scoreCap.reason, /weak or incomplete/i);
});

test("requires all four meaningful PREP steps for a score of 70", () => {
  const raw = setAllScores(completeReport(), 80);
  raw.prep.steps.point.score = 70;
  raw.prep.steps.reason.score = 70;
  raw.prep.steps.example.score = 70;
  raw.prep.steps.finalPoint.score = 40;

  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 69);
  assert.match(report.scoreCap.reason, /all four meaningful PREP steps/i);
});

test("requires competent delivery for a score of 80", () => {
  const raw = setAllScores(completeReport(), 100);
  for (const item of Object.values(raw.prep.steps)) item.score = 75;
  for (const item of Object.values(raw.vocal.dimensions)) item.score = 64;

  const report = normalizeReport(raw);
  assert.equal(report.overallScore, 79);
  assert.match(report.scoreCap.reason, /competent delivery/i);
});

test("prevents delivery and language from lifting the score more than 10 points above the message", () => {
  const raw = setAllScores(completeReport(), 100);
  for (const item of Object.values(raw.prep.steps)) item.score = 70;
  raw.verbal.dimensions.clarity.score = 50;
  raw.verbal.dimensions.logicalFlow.score = 50;

  const report = normalizeReport(raw);
  assert.equal(report.scoreBreakdown.messageAndStructure.score, 62);
  assert.equal(report.overallScore, 72);
  assert.match(report.scoreCap.reason, /more than 10 points/i);
});

test("weights the four Delivery Review dimensions as 8, 8, 8, and 6", () => {
  const raw = completeReport();
  raw.vocal.dimensions.pace.score = 100;
  raw.vocal.dimensions.volumeVariation.score = 100;
  raw.vocal.dimensions.pitchRange.score = 100;
  raw.vocal.dimensions.pauses.score = 0;

  assert.equal(normalizeReport(raw).scoreBreakdown.delivery.score, 80);
});

test("measured constant delivery scores low even when the AI suggests high scores", () => {
  const raw = setAllScores(completeReport(), 95);
  const metrics = {
    wordCount: 80,
    pauseCount: 0,
    averagePauseDuration: 0,
    paceSegmentCount: 5,
    paceVariationStdDevWpm: 2,
    acoustic: { volumeVariationDb: 0.5, pitchVariationSemitones: 0.3 },
  };

  const report = normalizeReport(raw, [], metrics);
  assert.ok(report.scoreBreakdown.delivery.score < 25);
  assert.match(report.vocal.dimensions.pace.evidence, /measured 2 WPM/i);
});

test("controlled delivery variety scores higher than erratic delivery", () => {
  const raw = setAllScores(completeReport(), 95);
  const controlled = normalizeReport(raw, [], {
    wordCount: 80,
    pauseCount: 8,
    averagePauseDuration: 0.6,
    paceSegmentCount: 5,
    paceVariationStdDevWpm: 18,
    acoustic: { volumeVariationDb: 6, pitchVariationSemitones: 5.5 },
  });
  const erratic = normalizeReport(raw, [], {
    wordCount: 60,
    pauseCount: 30,
    averagePauseDuration: 3,
    paceSegmentCount: 5,
    paceVariationStdDevWpm: 50,
    acoustic: { volumeVariationDb: 15, pitchVariationSemitones: 14 },
  });

  assert.ok(controlled.scoreBreakdown.delivery.score >= 70);
  assert.ok(erratic.scoreBreakdown.delivery.score < 45);
});

test("rewrites vague historical coaching language in plain English", () => {
  const raw = completeReport();
  raw.nextFocus.title = "Build one clear connection and close precisely";
  const history = [{
    id: "previous",
    date: "2026-08-01",
    report: {
      version: 6,
      overallScore: 55,
      improvements: [],
      nextFocus: {
        title: "Build one clear connection and close precisely",
        action: "Close precisely.",
      },
    },
  }];

  const report = normalizeReport(raw, history);
  assert.match(report.nextFocus.title, /Connect your example to your main point/i);
  assert.match(report.previousPerformance.challenges[0].category, /finish with one clear final sentence/i);
});

test("measures pace variety across successive speech segments", () => {
  const fast = Array.from({ length: 12 }, (_, index) => ({ start: index * 0.5, end: (index * 0.5) + 0.4 }));
  const slow = Array.from({ length: 12 }, (_, index) => ({ start: 6 + index, end: 6.8 + index }));
  const result = analyzePaceVariety([...fast, ...slow]);

  assert.equal(result.paceSegmentCount, 2);
  assert.ok(result.paceVariationWpm > 50);
  assert.ok(result.paceVariationStdDevWpm > 20);
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
