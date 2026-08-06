import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key-not-used";

const { normalizeReport, validatePerformanceReport } = await import("../api/feedback.js");

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

test("accepts a complete measured report and calculates a balanced overall score", () => {
  const raw = completeReport();
  assert.deepEqual(validatePerformanceReport(raw, { hasAudioMetrics: true }), []);
  assert.equal(normalizeReport(raw).overallScore, 76);
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
