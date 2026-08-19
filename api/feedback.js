import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const config = {
  api: {
    bodyParser: false,
  },
};

async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers["content-type"]?.split("boundary=")[1];
        if (!boundary) return reject(new Error("No boundary found"));

        const result = { fields: {}, files: {} };
        for (const part of buffer.toString("binary").split(`--${boundary}`)) {
          if (!part.includes("Content-Disposition")) continue;
          const nameMatch = part.match(/name="([^"]+)"/);
          const filenameMatch = part.match(/filename="([^"]+)"/);
          if (!nameMatch) continue;

          const contentStart = part.indexOf("\r\n\r\n") + 4;
          const contentEnd = part.lastIndexOf("\r\n");
          const content = part.substring(contentStart, contentEnd);
          const name = nameMatch[1];

          if (filenameMatch) {
            result.files[name] = {
              filename: filenameMatch[1],
              data: Buffer.from(content, "binary"),
            };
          } else {
            result.fields[name] = content;
          }
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

const clampScore = value => {
  if (value === null || value === undefined || value === "") return null;
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
};

const removeLongDashes = value => String(value || "").replace(/[\u2013\u2014]/g, ",");

function sanitizeGeneratedCopy(value) {
  if (typeof value === "string") {
    return removeLongDashes(value).replace(/\bconcision\b/gi, "clear and direct");
  }
  if (Array.isArray(value)) return value.map(sanitizeGeneratedCopy);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeGeneratedCopy(item)]));
  }
  return value;
}

function parseAcousticMetrics(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const allowed = [
      "sampleCount", "voicedFrameCount", "meanPitchHz", "pitchRangeSemitones",
      "pitchVariationSemitones", "meanVolumeDb", "volumeRangeDb",
      "volumeVariationDb", "energyPeakCount", "voicedRatio",
    ];
    const clean = {};
    for (const key of allowed) {
      const value = Number(parsed?.[key]);
      if (Number.isFinite(value)) clean[key] = Math.round(value * 100) / 100;
    }
    return Object.keys(clean).length ? clean : null;
  } catch {
    return null;
  }
}

function countRepeatedPhrases(transcript) {
  const tokens = String(transcript || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const counts = new Map();
  for (let size = 2; size <= 4; size++) {
    for (let index = 0; index <= tokens.length - size; index++) {
      const phrase = tokens.slice(index, index + size).join(" ");
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase, count]) => ({ phrase, count }));
}

export function analyzePaceVariety(words) {
  const safeWords = Array.isArray(words) ? words : [];
  const chunkSize = 12;
  const paceSamples = [];

  for (let index = 0; index < safeWords.length; index += chunkSize) {
    const chunk = safeWords.slice(index, index + chunkSize);
    if (chunk.length < 6) continue;
    const start = Number(chunk[0]?.start);
    const end = Number(chunk[chunk.length - 1]?.end);
    const duration = end - start;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const wpm = Math.round((chunk.length / duration) * 60);
    // Ignore implausible samples caused by unreliable word timestamps while
    // preserving genuinely slow and fast delivery.
    if (wpm < 35 || wpm > 260) continue;
    paceSamples.push({
      wpm,
      startSeconds: Math.round(start * 10) / 10,
      endSeconds: Math.round(end * 10) / 10,
      wordCount: chunk.length,
    });
  }

  const segmentWpm = paceSamples.map(sample => sample.wpm);

  if (segmentWpm.length < 2) {
    return {
      paceSegmentCount: segmentWpm.length,
      paceSegmentsWpm: segmentWpm,
      paceSamples,
      paceVariationWpm: null,
      paceVariationStdDevWpm: null,
    };
  }

  const mean = segmentWpm.reduce((sum, value) => sum + value, 0) / segmentWpm.length;
  const variance = segmentWpm.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / segmentWpm.length;
  return {
    paceSegmentCount: segmentWpm.length,
    paceSegmentsWpm: segmentWpm.slice(0, 20),
    paceSamples: paceSamples.slice(0, 20),
    paceVariationWpm: Math.max(...segmentWpm) - Math.min(...segmentWpm),
    paceVariationStdDevWpm: Math.round(Math.sqrt(variance) * 10) / 10,
  };
}

function analyzeMetrics(words, duration, transcript, acousticMetrics = null) {
  const safeWords = Array.isArray(words) ? words : [];
  const safeDuration = Number(duration) || 0;
  const fillerWords = ["um", "uh", "like", "you know", "so", "basically", "actually", "literally"];
  const fillerWordsUsed = {};
  const pauses = [];

  for (const item of safeWords) {
    const word = String(item.word || "").toLowerCase().trim();
    if (fillerWords.includes(word)) {
      fillerWordsUsed[word] = (fillerWordsUsed[word] || 0) + 1;
    }
  }
  for (let index = 1; index < safeWords.length; index++) {
    const pause = Number(safeWords[index].start) - Number(safeWords[index - 1].end);
    if (Number.isFinite(pause) && pause > 0.2) pauses.push(pause);
  }

  const fillerWordCount = Object.values(fillerWordsUsed).reduce((sum, count) => sum + count, 0);
  const wordsPerMinute = safeDuration > 0 ? Math.round((safeWords.length / safeDuration) * 60) : 0;
  let pacingVariation = safeWords.length ? "steady" : "unknown";
  if (pauses.length > safeWords.length * 0.3) pacingVariation = "halting";
  else if (pauses.length < safeWords.length * 0.1 && wordsPerMinute > 150) pacingVariation = "rushed";

  return {
    wordCount: safeWords.length,
    durationSeconds: Math.round(safeDuration * 10) / 10,
    wordsPerMinute,
    averagePauseDuration: pauses.length
      ? Math.round((pauses.reduce((sum, value) => sum + value, 0) / pauses.length) * 100) / 100
      : 0,
    longestPause: pauses.length ? Math.round(Math.max(...pauses) * 100) / 100 : 0,
    pauseCount: pauses.length,
    fillerWordCount,
    fillerWordsUsed,
    fillerRatePerMinute: safeDuration > 0
      ? Math.round((fillerWordCount / safeDuration) * 600) / 10
      : 0,
    repeatedPhrases: countRepeatedPhrases(transcript),
    pacingVariation,
    ...analyzePaceVariety(safeWords),
    acoustic: acousticMetrics,
  };
}

function normalizeDimension(value) {
  return {
    score: clampScore(value?.score),
    evidence: String(value?.evidence || "").slice(0, 500),
  };
}

function scoreDimensions(dimensions) {
  const measuredScores = Object.values(dimensions)
    .map(dimension => dimension.score)
    .filter(score => typeof score === "number");
  return measuredScores.length
    ? Math.round(measuredScores.reduce((sum, score) => sum + score, 0) / measuredScores.length)
    : null;
}

function weightedScore(items) {
  const measured = items.filter(item => typeof item.score === "number" && Number.isFinite(item.score));
  const totalWeight = measured.reduce((sum, item) => sum + item.weight, 0);
  return totalWeight
    ? Math.round(measured.reduce((sum, item) => sum + (item.score * item.weight), 0) / totalWeight)
    : null;
}

const averageMeasured = (...scores) => weightedScore(scores.map(score => ({ score, weight: 1 })));

export function scoreBand(score) {
  if (typeof score !== "number") return "Not measured";
  if (score < 40) return "Poor";
  if (score < 55) return "Needs significant improvement";
  if (score < 70) return "Developing";
  if (score < 80) return "Competent";
  if (score < 90) return "Strong";
  return "Exceptional";
}

const nullableScoreSchema = {
  anyOf: [
    { type: "integer", minimum: 0, maximum: 100 },
    { type: "null" },
  ],
};

const measuredScoreSchema = { type: "integer", minimum: 0, maximum: 100 };

const dimensionSchema = scoreSchema => ({
  type: "object",
  additionalProperties: false,
  properties: {
    score: scoreSchema,
    evidence: { type: "string" },
  },
  required: ["score", "evidence"],
});

const reportItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string" },
    point: { type: "string" },
    evidence: { type: "string" },
  },
  required: ["category", "point", "evidence"],
};

const performanceReportSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    overallScore: nullableScoreSchema,
    vocal: {
      type: "object",
      additionalProperties: false,
      properties: {
        score: nullableScoreSchema,
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        dimensions: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ["pace", "volumeVariation", "pitchRange", "pauses"]
              .map(name => [name, dimensionSchema(nullableScoreSchema)])
          ),
          required: ["pace", "volumeVariation", "pitchRange", "pauses"],
        },
      },
      required: ["score", "confidence", "dimensions"],
    },
    verbal: {
      type: "object",
      additionalProperties: false,
      properties: {
        score: measuredScoreSchema,
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        dimensions: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ["clarity", "structure", "logicalFlow", "wordChoice", "concision", "fillerControl", "repetitionControl"]
              .map(name => [name, dimensionSchema(measuredScoreSchema)])
          ),
          required: ["clarity", "structure", "logicalFlow", "wordChoice", "concision", "fillerControl", "repetitionControl"],
        },
      },
      required: ["score", "confidence", "dimensions"],
    },
    prep: {
      type: "object",
      additionalProperties: false,
      properties: {
        score: measuredScoreSchema,
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        steps: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ["point", "reason", "example", "finalPoint"]
              .map(name => [name, dimensionSchema(measuredScoreSchema)])
          ),
          required: ["point", "reason", "example", "finalPoint"],
        },
      },
      required: ["score", "confidence", "steps"],
    },
    strengths: {
      type: "array",
      items: reportItemSchema,
      minItems: 3,
      maxItems: 3,
    },
    improvements: {
      type: "array",
      items: reportItemSchema,
      minItems: 3,
      maxItems: 3,
    },
    nextFocus: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        action: { type: "string" },
      },
      required: ["title", "action"],
    },
    previousPerformance: {
      type: "object",
      additionalProperties: false,
      properties: {
        challenges: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              category: { type: "string" },
              status: { type: "string", enum: ["fixed", "improved", "still_present", "not_measurable"] },
              evidence: { type: "string" },
            },
            required: ["category", "status", "evidence"],
          },
        },
      },
      required: ["challenges"],
    },
  },
  required: [
    "summary", "overallScore", "vocal", "verbal", "prep", "strengths",
    "improvements", "nextFocus", "previousPerformance",
  ],
};

const hasMeasuredScore = value => typeof value?.score === "number" && Number.isFinite(value.score);

export function validatePerformanceReport(raw, { hasAudioMetrics = false } = {}) {
  const issues = [];
  const verbalNames = [
    "clarity", "structure", "logicalFlow", "wordChoice",
    "concision", "fillerControl", "repetitionControl",
  ];
  const prepNames = ["point", "reason", "example", "finalPoint"];
  const vocalNames = hasAudioMetrics
    ? ["pace", "volumeVariation", "pitchRange", "pauses"]
    : [];

  for (const name of verbalNames) {
    if (!hasMeasuredScore(raw?.verbal?.dimensions?.[name])) issues.push(`verbal.${name}`);
  }
  for (const name of prepNames) {
    if (!hasMeasuredScore(raw?.prep?.steps?.[name])) issues.push(`prep.${name}`);
  }
  for (const name of vocalNames) {
    if (!hasMeasuredScore(raw?.vocal?.dimensions?.[name])) issues.push(`vocal.${name}`);
  }
  if (!String(raw?.summary || "").trim()) issues.push("summary");
  if (!String(raw?.nextFocus?.title || "").trim()) issues.push("nextFocus.title");
  if (!String(raw?.nextFocus?.action || "").trim()) issues.push("nextFocus.action");
  if (!Array.isArray(raw?.strengths) || raw.strengths.length < 3) issues.push("strengths");
  if (!Array.isArray(raw?.improvements) || raw.improvements.length < 3) issues.push("improvements");
  return issues;
}

function normalizeReview(value, dimensionNames) {
  const dimensions = {};
  for (const name of dimensionNames) dimensions[name] = normalizeDimension(value?.dimensions?.[name]);
  return {
    score: scoreDimensions(dimensions),
    confidence: ["high", "medium", "low"].includes(value?.confidence) ? value.confidence : "low",
    dimensions,
  };
}

function normalizePrep(value) {
  const stepNames = ["point", "reason", "example", "finalPoint"];
  const steps = {};
  for (const name of stepNames) steps[name] = normalizeDimension(value?.steps?.[name]);
  const score = scoreDimensions(steps);
  return {
    score,
    confidence: ["high", "medium", "low"].includes(value?.confidence) ? value.confidence : "low",
    steps,
  };
}

function friendlyCategory(value) {
  const category = clarifyCoachingCopy(value).slice(0, 160);
  return /\bconcision\b/i.test(category) ? "Clear and direct" : category;
}

function clarifyCoachingCopy(value) {
  return String(value || "")
    .replace(
      /replace the joke with a structured aspiration/gi,
      "After the joke, state one real goal, explain why it matters, give one example, and repeat the goal at the end"
    )
    .replace(
      /build one clear connection and close precisely/gi,
      "Connect your example to your main point, then finish with one clear final sentence"
    )
    .replace(/build one clear connection/gi, "explain how your example supports your main point")
    .replace(/close precisely/gi, "finish with one clear final sentence")
    .replace(/land (?:the|your) point/gi, "finish by stating your main point in one clear sentence")
    .replace(/tighten (?:the|your) message/gi, "remove repeated or unrelated words");
}

function clarifyComparisonEvidence(value, category) {
  const evidence = String(value || "").trim();
  if (/not enough evidence|does not provide enough direct evidence|insufficient evidence/i.test(evidence)) {
    if (/joke|structured aspiration/i.test(String(category || ""))) {
      return "This speech did not include a joke followed by a real goal, so this instruction could not be checked.";
    }
    return "This speech did not include enough of the same behavior to check this previous instruction.";
  }
  return clarifyCoachingCopy(evidence);
}

function cleanReportItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 4).map(item => ({
    category: friendlyCategory(item?.category),
    point: String(item?.point || "").slice(0, 500),
    evidence: String(item?.evidence || "").slice(0, 500),
  }));
}

function normalizeHistory(raw) {
  const history = Array.isArray(raw) ? raw : [];
  return history.slice(0, 5).map(item => ({
    id: String(item?.id || "").slice(0, 160),
    date: String(item?.date || "").slice(0, 80),
    report: {
      version: Number(item?.report?.version) || 0,
      overallScore: clampScore(item?.report?.overallScore),
      vocalScore: clampScore(item?.report?.vocal?.score),
      verbalScore: clampScore(item?.report?.verbal?.score),
      improvements: cleanReportItems(item?.report?.improvements),
      nextFocus: {
        title: clarifyCoachingCopy(item?.report?.nextFocus?.title).slice(0, 200),
        action: clarifyCoachingCopy(item?.report?.nextFocus?.action).slice(0, 500),
      },
    },
  })).filter(item => item.id || item.report.improvements.length || item.report.nextFocus.title);
}

function challengeKey(value) {
  const key = String(value || "general").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || "general";
  if (/filler|verbal tic/.test(key)) return "filler control";
  if (/pace|pacing|speaking speed|wpm/.test(key)) return "pace";
  if (/pause/.test(key)) return "pauses";
  if (/structure|organization|organisation/.test(key)) return "structure";
  if (/logical flow|coherence|transition/.test(key)) return "logical flow";
  if (/clarity|articulation/.test(key)) return "clarity";
  if (/repeat|repetition/.test(key)) return "repetition control";
  if (/pitch|volume|emphasis|rhythm|vocal variety/.test(key)) return "vocal variety";
  if (/clear and direct|concise|concision|wordiness/.test(key)) return "clear and direct";
  return key;
}

function previousChallenges(previous) {
  if (!previous) return [];
  const challenges = [...previous.report.improvements];
  const focus = previous.report.nextFocus;
  if (focus.title && !challenges.some(item => challengeKey(item.category) === challengeKey(focus.title))) {
    challenges.push({ category: focus.title, point: focus.action, evidence: "" });
  }
  return challenges.slice(0, 4);
}

function normalizePreviousPerformance(raw, previous, currentOverallScore, currentVersion) {
  if (!previous) return { available: false, previousReportId: "", previousDate: "", previousOverallScore: null, overallChange: null, challenges: [] };
  const rawChallenges = Array.isArray(raw?.challenges) ? raw.challenges : [];
  const challenges = previousChallenges(previous).map(challenge => {
    const key = challengeKey(challenge.category);
    const match = rawChallenges.find(item => challengeKey(item?.category) === key) || {};
    const allowedStatuses = ["fixed", "improved", "still_present", "not_measurable"];
    return {
      category: clarifyCoachingCopy(challenge.category || "Previous focus").slice(0, 200),
      previousChallenge: clarifyCoachingCopy(challenge.point || challenge.evidence || "Previous coaching challenge").slice(0, 500),
      status: allowedStatuses.includes(match.status) ? match.status : "not_measurable",
      evidence: clarifyComparisonEvidence(
        match.evidence || "The current speech does not provide enough direct evidence for a reliable comparison.",
        challenge.category
      ).slice(0, 500),
    };
  });
  const previousOverallScore = previous.report.overallScore;
  const comparableScores = previous.report.version === currentVersion;
  return {
    available: true,
    previousReportId: previous.id,
    previousDate: previous.date,
    previousOverallScore,
    comparableScores,
    comparisonNote: comparableScores
      ? ""
      : "Overall scores are not compared because the scoring method changed. Challenge progress is still evaluated.",
    overallChange: comparableScores && typeof previousOverallScore === "number" && typeof currentOverallScore === "number"
      ? currentOverallScore - previousOverallScore
      : null,
    challenges,
  };
}

function buildCommonChallenges(history, currentImprovements) {
  const reports = [
    ...history.map(item => item.report.improvements),
    currentImprovements,
  ];
  const counts = new Map();
  for (const improvements of reports) {
    const seen = new Set();
    for (const item of improvements) {
      const key = challengeKey(item.category || item.point);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = counts.get(key) || { category: item.category || "General", count: 0, summary: item.point || "" };
      existing.count += 1;
      if (item.point) existing.summary = item.point;
      counts.set(key, existing);
    }
  }
  return [...counts.values()]
    .filter(item => item.count >= 2)
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
    .slice(0, 3);
}

function scoreFromAnchors(value, anchors) {
  if (!Number.isFinite(value)) return null;
  if (value <= anchors[0][0]) return anchors[0][1];
  for (let index = 1; index < anchors.length; index++) {
    const [rightValue, rightScore] = anchors[index];
    const [leftValue, leftScore] = anchors[index - 1];
    if (value <= rightValue) {
      const progress = (value - leftValue) / (rightValue - leftValue);
      return Math.round(leftScore + ((rightScore - leftScore) * progress));
    }
  }
  return anchors[anchors.length - 1][1];
}

function measuredDimension(score, evidence) {
  return { score: clampScore(score), evidence };
}

function finiteMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describeOctaveSpan(semitones) {
  const octaves = semitones / 12;
  if (octaves < 0.2) return "a small fraction of an octave";
  if (octaves < 0.4) return "about one quarter of an octave";
  if (octaves < 0.65) return "about half an octave";
  if (octaves < 0.9) return "about three quarters of an octave";
  if (octaves < 1.2) return "about one octave";
  return `about ${octaves.toFixed(1)} octaves`;
}

function formatSpeechTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export function calibrateDeliveryReview(vocal, metrics) {
  if (!metrics?.acoustic) return vocal;

  const dimensions = { ...vocal.dimensions };
  const segmentCount = Number(metrics.paceSegmentCount) || 0;
  const paceStdDev = finiteMetric(metrics.paceVariationStdDevWpm);
  const paceSegments = (Array.isArray(metrics.paceSegmentsWpm) ? metrics.paceSegmentsWpm : [])
    .filter(value => typeof value === "number" && Number.isFinite(value));
  const paceSamples = (Array.isArray(metrics.paceSamples) ? metrics.paceSamples : [])
    .filter(sample => typeof sample?.wpm === "number" && Number.isFinite(sample.wpm));
  const averagePace = finiteMetric(metrics.wordsPerMinute)
    ?? (paceSegments.length ? Math.round(paceSegments.reduce((sum, value) => sum + value, 0) / paceSegments.length) : null);
  const slowestPace = paceSegments.length ? Math.min(...paceSegments) : null;
  const fastestPace = paceSegments.length ? Math.max(...paceSegments) : null;
  let largestSlowdown = null;
  let largestAcceleration = null;
  for (let index = 1; index < paceSegments.length; index++) {
    const change = paceSegments[index] - paceSegments[index - 1];
    if (change < 0 && (!largestSlowdown || change < largestSlowdown.change)) {
      largestSlowdown = { from: paceSegments[index - 1], to: paceSegments[index], sampleIndex: index, change };
    }
    if (change > 0 && (!largestAcceleration || change > largestAcceleration.change)) {
      largestAcceleration = { from: paceSegments[index - 1], to: paceSegments[index], sampleIndex: index, change };
    }
  }
  const paceChangeEvidence = [
    largestSlowdown
      ? `${paceSamples[largestSlowdown.sampleIndex]?.startSeconds !== undefined ? `Around ${formatSpeechTime(paceSamples[largestSlowdown.sampleIndex].startSeconds)}, you` : "You"} slowed from ${largestSlowdown.from} to ${largestSlowdown.to} WPM.`
      : "",
    largestAcceleration
      ? `${paceSamples[largestAcceleration.sampleIndex]?.startSeconds !== undefined ? `Around ${formatSpeechTime(paceSamples[largestAcceleration.sampleIndex].startSeconds)}, you` : "You"} accelerated from ${largestAcceleration.from} to ${largestAcceleration.to} WPM.`
      : "",
  ].filter(Boolean).join(" ");
  const paceEvidence = averagePace !== null && slowestPace !== null && fastestPace !== null
    ? `Average pace: ${averagePace} WPM. Your slowest 12-word sample was ${slowestPace} WPM, and your fastest was ${fastestPace} WPM. ${paceChangeEvidence}`.trim()
    : paceStdDev !== null
      ? `Your pace varied by ${paceStdDev} WPM across ${segmentCount} consecutive 12-word samples.`
      : "The speech was too short to compare multiple 12-word pace samples.";
  dimensions.pace = segmentCount >= 2 && paceStdDev !== null
    ? measuredDimension(
        scoreFromAnchors(paceStdDev, [[0, 10], [3, 20], [7, 40], [12, 58], [18, 72], [25, 82], [35, 90], [50, 96], [80, 100]]),
        paceEvidence
      )
    : measuredDimension(null, paceEvidence);

  const volumeStdDev = finiteMetric(metrics.acoustic.volumeVariationDb);
  const volumeRange = finiteMetric(metrics.acoustic.volumeRangeDb);
  dimensions.volumeVariation = volumeStdDev !== null
    ? measuredDimension(
        scoreFromAnchors(volumeStdDev, [[0, 10], [0.8, 20], [1.5, 35], [2.5, 50], [4, 65], [6, 78], [8, 82], [11, 65], [15, 40], [25, 25]]),
        volumeRange !== null
          ? `Volume moved across a ${volumeRange.toFixed(1)} dB range between the softer and louder parts of the speech.`
          : `Volume varied by ${volumeStdDev.toFixed(1)} dB across the speech.`
      )
    : measuredDimension(null, "Volume variety could not be measured reliably.");

  const pitchStdDev = finiteMetric(metrics.acoustic.pitchVariationSemitones);
  const pitchRange = finiteMetric(metrics.acoustic.pitchRangeSemitones);
  dimensions.pitchRange = pitchStdDev !== null
    ? measuredDimension(
        scoreFromAnchors(pitchStdDev, [[0, 10], [0.5, 20], [1, 35], [2, 52], [3.5, 68], [5.5, 80], [7.5, 82], [10, 65], [14, 40]]),
        pitchRange !== null
          ? `Pitch moved across ${pitchRange.toFixed(1)} semitones, ${describeOctaveSpan(pitchRange)}, between the lower and higher parts of the speech.`
          : `Pitch varied by ${pitchStdDev.toFixed(1)} semitones across the speech.`
      )
    : measuredDimension(null, "Pitch variety could not be measured reliably.");

  const wordCount = Number(metrics.wordCount) || 0;
  const pauseCount = Number(metrics.pauseCount) || 0;
  const averagePause = Number(metrics.averagePauseDuration) || 0;
  const longestPause = Number(metrics.longestPause) || 0;
  if (wordCount > 0) {
    const pauseRate = pauseCount / wordCount;
    const frequencyScore = scoreFromAnchors(pauseRate, [[0, 15], [0.02, 25], [0.05, 50], [0.08, 70], [0.12, 80], [0.18, 72], [0.25, 50], [0.35, 25], [0.5, 10]]);
    const durationScore = pauseCount > 0
      ? scoreFromAnchors(averagePause, [[0.2, 25], [0.35, 55], [0.5, 75], [0.9, 82], [1.3, 75], [2, 55], [3, 30], [5, 15]])
      : 15;
    const pauseScore = Math.round((frequencyScore * 0.6) + (durationScore * 0.4));
    dimensions.pauses = measuredDimension(
      pauseScore,
      pauseCount > 0
        ? `${pauseCount} pauses across ${wordCount} words, about one every ${Math.max(1, Math.round(wordCount / pauseCount))} words. Average pause: ${averagePause.toFixed(2)} seconds. Longest pause: ${longestPause.toFixed(2)} seconds.`
        : `No pauses longer than 0.2 seconds were measured across ${wordCount} words.`
    );
  } else {
    dimensions.pauses = measuredDimension(null, "Pauses could not be measured reliably.");
  }

  const measuredCount = Object.values(dimensions).filter(item => typeof item.score === "number").length;
  return {
    ...vocal,
    dimensions,
    confidence: measuredCount === 4 ? "high" : measuredCount >= 2 ? "medium" : "low",
  };
}

export function normalizeReport(raw, history = [], metrics = null) {
  const scoringVersion = 8;
  const report = raw && typeof raw === "object" ? raw : {};
  const prep = normalizePrep(report.prep);
  const vocal = calibrateDeliveryReview(normalizeReview(report.vocal, [
    "pace", "volumeVariation", "pitchRange", "pauses",
  ]), metrics);
  const verbal = normalizeReview(report.verbal, [
    "clarity", "structure", "logicalFlow", "wordChoice",
    "concision", "fillerControl", "repetitionControl",
  ]);
  if (typeof prep.score === "number") {
    const stepSummary = Object.entries(prep.steps)
      .map(([name, value]) => `${name === "finalPoint" ? "final point" : name} ${value.score ?? "not measured"}`)
      .join(", ");
    verbal.dimensions.structure = {
      score: prep.score,
      evidence: `PREP breakdown: ${stepSummary}.`,
    };
  }

  const messageAndStructureScore = weightedScore([
    { score: prep.score, weight: 30 },
    { score: verbal.dimensions.clarity.score, weight: 12 },
    { score: verbal.dimensions.logicalFlow.score, weight: 8 },
  ]);
  const deliveryScore = weightedScore([
    { score: vocal.dimensions.pace.score, weight: 8 },
    { score: vocal.dimensions.volumeVariation.score, weight: 8 },
    { score: vocal.dimensions.pitchRange.score, weight: 8 },
    { score: vocal.dimensions.pauses.score, weight: 6 },
  ]);
  const languageControlScore = weightedScore([
    { score: verbal.dimensions.concision.score, weight: 8 },
    { score: verbal.dimensions.wordChoice.score, weight: 4 },
    { score: verbal.dimensions.fillerControl.score, weight: 4 },
    { score: verbal.dimensions.repetitionControl.score, weight: 4 },
  ]);

  vocal.score = deliveryScore;
  verbal.score = weightedScore([
    { score: messageAndStructureScore, weight: 50 },
    { score: languageControlScore, weight: 20 },
  ]);

  const uncappedOverallScore = weightedScore([
    { score: messageAndStructureScore, weight: 50 },
    { score: deliveryScore, weight: 30 },
    { score: languageControlScore, weight: 20 },
  ]);
  const prepScores = Object.values(prep.steps)
    .map(step => step.score)
    .filter(score => typeof score === "number");
  const identifiedPrepSteps = prepScores.filter(score => score >= 50).length;
  const pointScore = prep.steps.point.score;
  const reasonScore = prep.steps.reason.score;
  const exampleScore = prep.steps.example.score;
  const clarityScore = verbal.dimensions.clarity.score;
  const logicalFlowScore = verbal.dimensions.logicalFlow.score;
  let scoreMaximum = 100;
  let scoreCapReason = "";

  const applyScoreMaximum = (maximum, reason) => {
    if (maximum < scoreMaximum) {
      scoreMaximum = maximum;
      scoreCapReason = reason;
    }
  };

  if ((pointScore ?? 0) < 50 || (clarityScore ?? 0) < 40 || (logicalFlowScore ?? 0) < 35) {
    applyScoreMaximum(39, "The score is limited to 39 because the speech did not provide a clear, coherent, and relevant answer.");
  }
  if ((pointScore ?? 0) >= 50 && (reasonScore ?? 0) < 50 && (exampleScore ?? 0) < 50) {
    applyScoreMaximum(49, "The score is limited to 49 because the main Point did not have a meaningful Reason or Example.");
  }
  if ((prep.score ?? 0) < 60 || identifiedPrepSteps < 3 || (messageAndStructureScore ?? 0) < 50) {
    applyScoreMaximum(59, "The score is limited to 59 because Message and Structure is weak or incomplete.");
  }
  if (identifiedPrepSteps < 4 || (messageAndStructureScore ?? 0) < 60) {
    applyScoreMaximum(69, "The score is limited to 69 because scores of 70 or higher require all four meaningful PREP steps and a solid message.");
  }
  if ((prep.score ?? 0) < 70 || (deliveryScore ?? 0) < 65) {
    applyScoreMaximum(79, "The score is limited to 79 because scores of 80 or higher require strong PREP structure and competent delivery.");
  }
  if (
    (uncappedOverallScore ?? 0) > 89 &&
    ((messageAndStructureScore ?? 0) < 85 ||
      (typeof deliveryScore === "number" && deliveryScore < 80) ||
      (languageControlScore ?? 0) < 80)
  ) {
    applyScoreMaximum(89, "The score is limited to 89 because an exceptional score requires excellent message, delivery, and language control.");
  }
  if (typeof messageAndStructureScore === "number") {
    applyScoreMaximum(
      Math.min(100, messageAndStructureScore + 10),
      "Delivery and language cannot raise the overall score more than 10 points above Message and Structure."
    );
  }

  const overallScore = typeof uncappedOverallScore === "number"
    ? Math.min(uncappedOverallScore, scoreMaximum)
    : null;
  const improvements = cleanReportItems(report.improvements);
  const previousPerformance = normalizePreviousPerformance(report.previousPerformance, history[0], overallScore, scoringVersion);
  return {
    version: scoringVersion,
    summary: String(report.summary || "Speech analysis complete.").slice(0, 1000),
    overallScore,
    scoreBand: scoreBand(overallScore),
    scoreBasis: "Overall = Message and Structure 50% + Delivery 30% + Language Control 20%. PREP contributes 30 percentage points inside the Message and Structure category.",
    scoreBreakdown: {
      messageAndStructure: { score: messageAndStructureScore, weight: 50 },
      delivery: { score: deliveryScore, weight: 30 },
      languageControl: { score: languageControlScore, weight: 20 },
      uncappedOverallScore,
    },
    scoreCap: {
      applied: typeof overallScore === "number" && overallScore < uncappedOverallScore,
      maximum: scoreMaximum < 100 ? scoreMaximum : null,
      reason: scoreCapReason,
    },
    vocal,
    verbal,
    prep,
    strengths: cleanReportItems(report.strengths),
    improvements,
    nextFocus: {
      title: clarifyCoachingCopy(report.nextFocus?.title || "One clear improvement").slice(0, 200),
      action: clarifyCoachingCopy(report.nextFocus?.action || "Apply one focused change in your next speech.").slice(0, 700),
    },
    previousPerformance,
    commonChallenges: buildCommonChallenges(history, improvements),
  };
}

function reportToFeedback(report) {
  const formatItems = items => items.map(item =>
    `• ${item.point}${item.evidence ? `. ${item.evidence}` : ""}`
  ).join("\n");
  return [
    `Summary: ${report.summary}`,
    `PREP structure (Point, Reason, Example, Point): ${report.prep?.score ?? "Not measured"}/100`,
    "",
    "What you did well:",
    formatItems(report.strengths) || "• Keep practicing to build a stronger evidence base.",
    "",
    "What to improve:",
    formatItems(report.improvements) || "• Complete another speech for a deeper comparison.",
    "",
    "Next speech focus:",
    `• ${report.nextFocus.title}: ${report.nextFocus.action}`,
  ].join("\n");
}

async function generatePerformanceReport({ transcript, promptContext, metrics, hasAudioMetrics, history = [] }) {
  const requiredShape = {
    summary: "string",
    overallScore: 0,
    vocal: {
      score: 0,
      confidence: "high|medium|low",
      dimensions: {
        pace: { score: 0, evidence: "string" },
        volumeVariation: { score: 0, evidence: "string" },
        pitchRange: { score: 0, evidence: "string" },
        pauses: { score: 0, evidence: "string" },
      },
    },
    verbal: {
      score: 0,
      confidence: "high|medium|low",
      dimensions: {
        clarity: { score: 0, evidence: "string" },
        structure: { score: 0, evidence: "string" },
        logicalFlow: { score: 0, evidence: "string" },
        wordChoice: { score: 0, evidence: "string" },
        concision: { score: 0, evidence: "string" },
        fillerControl: { score: 0, evidence: "string" },
        repetitionControl: { score: 0, evidence: "string" },
      },
    },
    prep: {
      score: 0,
      confidence: "high|medium|low",
      steps: {
        point: { score: 0, evidence: "exact quote or explanation" },
        reason: { score: 0, evidence: "exact quote or explanation" },
        example: { score: 0, evidence: "exact quote or explanation" },
        finalPoint: { score: 0, evidence: "exact quote or explanation" },
      },
    },
    strengths: [{ category: "string", point: "string", evidence: "exact quote or metric" }],
    improvements: [{ category: "string", point: "string", evidence: "exact quote or metric" }],
    nextFocus: { title: "string", action: "specific practice instruction" },
    previousPerformance: {
      challenges: [{ category: "must match a previous improvement category", status: "fixed|improved|still_present|not_measurable", evidence: "current speech quote or metric" }],
    },
  };

  const messages = [
      {
        role: "system",
        content: [
          "You are an expert evidence-based public-speaking coach.",
          "Return only one JSON object. Do not use markdown.",
          "Do not use em dashes or en dashes anywhere in the response.",
          "Score the recorded speech from 0 to 100 using the transcript and supplied measurements.",
          "Never claim pitch, volume, or vocal energy was measured when acoustic measurements are absent.",
          "When a dimension cannot be supported, use null for its score and explain the limitation in evidence.",
          "Every transcript-based verbal dimension must have a numeric score. Never return null for clarity, structure, logical flow, word choice, concision, filler control, or repetition control when a transcript is present.",
          "Quote short exact phrases from the transcript as evidence for verbal judgments.",
          "Do not infer personality, emotion, identity, health, or confidence from the voice.",
          "Calibrate every dimension independently. Do not reuse a generic score or default to 78.",
          "Use the full 0-100 scale with strict anchors: 0-39 poor or unstructured, 40-54 needs significant improvement, 55-69 developing, 70-79 competent, 80-89 strong, and 90-100 exceptional.",
          "Scores of 90 or higher must be rare and require specific evidence of excellent content and delivery.",
          "Do not begin at a high score and deduct points. Judge each dimension directly against the anchors.",
          "Clarity measures whether the answer gives a clear message that is relevant to the question or topic.",
          "The concision field means Clear and direct: whether the speaker gets to the point without unnecessary words, detours, or repetition.",
          "Never use the word concision in user-facing summary, evidence, strengths, improvements, or next focus. Say Clear and direct instead.",
          "Do not let fluent delivery, few fillers, or little repetition inflate weak content. Those dimensions only measure their named behavior.",
          "A fluent but unstructured or off-topic speech must receive low content scores.",
          "For Delivery Review, the pace field means Pace variety: whether the speaker intentionally speeds up and slows down. Use the segment WPM variation measurements, not only average WPM.",
          "The volumeVariation field means Volume variety: whether the speaker becomes meaningfully louder and softer.",
          "The pitchRange field means Pitch variety: whether the voice moves meaningfully higher and lower.",
          "Pauses measure whether silence is used intentionally to separate ideas.",
          "Variety helps sustain listener engagement. Constant pace, pitch, and volume should score lower than meaningful variation. For pace, a broad intentional contrast between slow and fast delivery should score higher and must not be penalized merely because the measured range is wide.",
          "Score PREP explicitly as Point, Reason, Example, and Final Point. A missing step scores 0. Do not invent an implied step that is not supported by the transcript.",
          "Every PREP step must have a numeric score. Use 0 when the transcript does not contain that step, never null.",
          "A vague, irrelevant, or merely implied PREP step is not meaningful support and must score below 50.",
          "Point measures whether the answer states one clear position. Reason measures whether it gives a relevant why. Example measures whether it gives a specific personal or practical example. Final Point measures whether it returns to the main idea or gives a clear takeaway or recommendation.",
          "The PREP score is the average of the four PREP step scores. The verbal structure dimension must use that same PREP score so PREP contributes once to the verbal review and overall score.",
          "For each challenge in the immediately previous report, assess whether it is fixed, improved, still present, or not measurable in this speech.",
          "For a not measurable comparison, give the specific reason, such as a different topic, a missing behavior, a speech that was too short, or an unavailable audio measurement. Never use a generic phrase such as not enough evidence.",
          `Use this exact object shape: ${JSON.stringify(requiredShape)}`,
          "Give three strengths and three improvements. Make the next focus measurable and immediately understandable to a new speaker.",
          "Avoid vague coaching phrases such as structured aspiration, build a connection, close precisely, land the point, or tighten the message. State exactly what the speaker should say or do in plain language.",
          `Acoustic measurements available: ${hasAudioMetrics ? "yes" : "no"}.`,
        ].join("\n"),
      },
      {
        role: "user",
        content: `Question or topic:\n${promptContext || "Not provided"}\n\nMeasurements:\n${JSON.stringify(metrics, null, 2)}\n\nRecent performance history (newest first):\n${JSON.stringify(history, null, 2)}\n\nTranscript:\n${transcript}`,
      },
    ];

  let lastIssues = ["empty response"];
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: "gpt-5.6-luna",
      reasoning_effort: "none",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "speech_performance_report",
          strict: true,
          schema: performanceReportSchema,
        },
      },
      messages,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lastIssues = ["invalid JSON"];
      parsed = null;
    }

    if (parsed) {
      lastIssues = validatePerformanceReport(parsed, { hasAudioMetrics });
      if (!lastIssues.length) {
        return sanitizeGeneratedCopy(normalizeReport(parsed, history, metrics));
      }
    }

    if (attempt === 0) {
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `The report is incomplete. Correct these fields and return the complete object: ${lastIssues.join(", ")}. All verbal and PREP scores must be numeric.`,
        }
      );
    }
  }

  const error = new Error(`AI report remained incomplete after retry: ${lastIssues.join(", ")}`);
  error.code = "incomplete_ai_report";
  error.status = 502;
  throw error;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let transcript = "";
    let promptContext = "";
    let metrics;
    let history = [];

    if (contentType.includes("multipart/form-data")) {
      const { files, fields } = await parseMultipartForm(req);
      const audioFile = files.audio;
      if (!audioFile) return res.status(400).json({ error: "No audio file provided" });

      const transcription = await client.audio.transcriptions.create({
        file: new File([audioFile.data], audioFile.filename, { type: "audio/webm" }),
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word"],
      });

      transcript = transcription.text || "";
      promptContext = String(fields.promptContext || "").trim().slice(0, 500);
      const duration = fields.duration ? parseFloat(fields.duration) : transcription.duration || 0;
      const acousticMetrics = parseAcousticMetrics(fields.acousticMetrics);
      metrics = analyzeMetrics(transcription.words || [], duration, transcript, acousticMetrics);
      try {
        history = normalizeHistory(JSON.parse(fields.previousReports || "[]"));
      } catch {
        history = [];
      }
    } else {
      const { text, promptContext: rawPromptContext, previousReports } = await parseJsonBody(req);
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Missing transcript text or audio file" });
      }
      transcript = text.trim();
      promptContext = String(rawPromptContext || "").trim().slice(0, 500);
      metrics = analyzeMetrics([], 0, transcript, null);
      history = normalizeHistory(previousReports);
    }

    const report = await generatePerformanceReport({
      transcript,
      promptContext,
      metrics,
      hasAudioMetrics: Boolean(metrics.acoustic),
      history,
    });
    metrics.vocalVariety = report.vocal.score;
    metrics.structure = report.verbal.dimensions.structure.score;
    metrics.verbalReview = report.verbal.score;
    metrics.overallPerformance = report.overallScore;

    return res.status(200).json({
      feedback: reportToFeedback(report),
      transcript,
      metrics,
      report,
    });
  } catch (error) {
    console.error("Feedback generation failed:", error);
    if (error.code === "incomplete_ai_report") {
      return res.status(502).json({
        error: "Incomplete AI report",
        details: "The analysis did not include every required verbal and PREP score after an automatic retry.",
      });
    }
    if (error.status) {
      return res.status(error.status).json({
        error: "OpenAI API error",
        details: error.message,
        status: error.status,
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OpenAI API key not configured",
        details: "OPENAI_API_KEY environment variable is missing",
      });
    }
    return res.status(500).json({
      error: "Failed to generate feedback",
      details: error.message,
    });
  }
}
