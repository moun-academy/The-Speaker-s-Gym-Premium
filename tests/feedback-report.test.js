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
  assert.equal(report.version, 8);
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
    longestPause: 0,
    wordsPerMinute: 150,
    paceSegmentCount: 5,
    paceSegmentsWpm: [148, 150, 151, 149, 152],
    paceVariationStdDevWpm: 2,
    acoustic: { volumeVariationDb: 0.5, volumeRangeDb: 1.2, pitchVariationSemitones: 0.3, pitchRangeSemitones: 0.8 },
  };

  const report = normalizeReport(raw, [], metrics);
  assert.ok(report.scoreBreakdown.delivery.score < 25);
  assert.match(report.vocal.dimensions.pace.evidence, /Average pace: 150 WPM/i);
  assert.doesNotMatch(report.vocal.dimensions.pace.evidence, /scores higher/i);
});

test("describes the measured delivery instead of explaining the scoring rule", () => {
  const report = normalizeReport(completeReport(), [], {
    wordCount: 84,
    pauseCount: 5,
    averagePauseDuration: 0.43,
    longestPause: 0.9,
    wordsPerMinute: 150,
    paceSegmentCount: 7,
    paceSegmentsWpm: [148, 154, 90, 172, 185, 158, 143],
    paceSamples: [
      { wpm: 148, startSeconds: 0 },
      { wpm: 154, startSeconds: 6 },
      { wpm: 90, startSeconds: 12 },
      { wpm: 172, startSeconds: 24 },
      { wpm: 185, startSeconds: 30 },
      { wpm: 158, startSeconds: 36 },
      { wpm: 143, startSeconds: 42 },
    ],
    paceVariationStdDevWpm: 28,
    acoustic: {
      volumeVariationDb: 10.3,
      volumeRangeDb: 29.1,
      pitchVariationSemitones: 3.07,
      pitchRangeSemitones: 11.5,
    },
  });

  assert.equal(report.vocal.dimensions.pace.evidence, "Average pace: 150 WPM. Your slowest 12-word sample was 90 WPM, and your fastest was 185 WPM. Around 0:12, you slowed from 154 to 90 WPM. Around 0:24, you accelerated from 90 to 172 WPM.");
  assert.doesNotMatch(report.vocal.dimensions.pace.evidence, /section/i);
  assert.match(report.vocal.dimensions.volumeVariation.evidence, /29\.1 dB range/i);
  assert.match(report.vocal.dimensions.pitchRange.evidence, /11\.5 semitones, about one octave/i);
  assert.match(report.vocal.dimensions.pauses.evidence, /one every 17 words.*Longest pause: 0\.90 seconds/i);
  assert.doesNotMatch(JSON.stringify(report.vocal.dimensions), /scores higher|keeps listeners engaged/i);
});

test("strong deliberate pace variety scores higher than moderate variety", () => {
  const raw = setAllScores(completeReport(), 95);
  const moderate = normalizeReport(raw, [], {
    wordCount: 80,
    pauseCount: 8,
    averagePauseDuration: 0.6,
    paceSegmentCount: 5,
    paceVariationStdDevWpm: 18,
    acoustic: { volumeVariationDb: 6, pitchVariationSemitones: 5.5 },
  });
  const strong = normalizeReport(raw, [], {
    wordCount: 80,
    pauseCount: 8,
    averagePauseDuration: 0.6,
    paceSegmentCount: 5,
    paceVariationStdDevWpm: 50,
    acoustic: { volumeVariationDb: 6, pitchVariationSemitones: 5.5 },
  });

  assert.equal(moderate.vocal.dimensions.pace.score, 72);
  assert.equal(strong.vocal.dimensions.pace.score, 96);
  assert.ok(strong.scoreBreakdown.delivery.score > moderate.scoreBreakdown.delivery.score);
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

test("rewrites structured aspiration and generic comparison language", () => {
  const raw = completeReport();
  raw.previousPerformance.challenges = [{
    category: "Replace the joke with a structured aspiration",
    status: "not_measurable",
    evidence: "The current speech does not provide enough direct evidence for a reliable comparison.",
  }];
  const history = [{
    id: "previous",
    date: "2026-08-01",
    report: {
      version: 7,
      overallScore: 55,
      improvements: [{
        category: "Replace the joke with a structured aspiration",
        point: "Replace the joke with a structured aspiration",
        evidence: "",
      }],
      nextFocus: { title: "", action: "" },
    },
  }];

  const challenge = normalizeReport(raw, history).previousPerformance.challenges[0];
  assert.match(challenge.category, /state one real goal/i);
  assert.match(challenge.evidence, /did not include a joke followed by a real goal/i);
  assert.doesNotMatch(challenge.category, /structured aspiration/i);
});

test("measures pace variety across successive speech segments", () => {
  const fast = Array.from({ length: 12 }, (_, index) => ({ start: index * 0.5, end: (index * 0.5) + 0.4 }));
  const slow = Array.from({ length: 12 }, (_, index) => ({ start: 6 + index, end: 6.8 + index }));
  const result = analyzePaceVariety([...fast, ...slow]);

  assert.equal(result.paceSegmentCount, 2);
  assert.equal(result.paceSamples[0].startSeconds, 0);
  assert.equal(result.paceSamples[1].startSeconds, 6);
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
