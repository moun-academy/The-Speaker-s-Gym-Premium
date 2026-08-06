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

function cleanReportItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 4).map(item => ({
    category: String(item?.category || "").slice(0, 80),
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
      overallScore: clampScore(item?.report?.overallScore),
      vocalScore: clampScore(item?.report?.vocal?.score),
      verbalScore: clampScore(item?.report?.verbal?.score),
      improvements: cleanReportItems(item?.report?.improvements),
      nextFocus: {
        title: String(item?.report?.nextFocus?.title || "").slice(0, 160),
        action: String(item?.report?.nextFocus?.action || "").slice(0, 500),
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
  if (/concise|concision|wordiness/.test(key)) return "concision";
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

function normalizePreviousPerformance(raw, previous, currentOverallScore) {
  if (!previous) return { available: false, previousReportId: "", previousDate: "", previousOverallScore: null, overallChange: null, challenges: [] };
  const rawChallenges = Array.isArray(raw?.challenges) ? raw.challenges : [];
  const challenges = previousChallenges(previous).map(challenge => {
    const key = challengeKey(challenge.category);
    const match = rawChallenges.find(item => challengeKey(item?.category) === key) || {};
    const allowedStatuses = ["fixed", "improved", "still_present", "not_measurable"];
    return {
      category: challenge.category || "Previous focus",
      previousChallenge: challenge.point || challenge.evidence || "Previous coaching challenge",
      status: allowedStatuses.includes(match.status) ? match.status : "not_measurable",
      evidence: String(match.evidence || "The current speech does not provide enough direct evidence for a reliable comparison.").slice(0, 500),
    };
  });
  const previousOverallScore = previous.report.overallScore;
  return {
    available: true,
    previousReportId: previous.id,
    previousDate: previous.date,
    previousOverallScore,
    overallChange: typeof previousOverallScore === "number" && typeof currentOverallScore === "number"
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

function normalizeReport(raw, history = []) {
  const report = raw && typeof raw === "object" ? raw : {};
  const prep = normalizePrep(report.prep);
  const vocal = normalizeReview(report.vocal, [
    "pace", "pauses", "pitchRange", "volumeVariation", "emphasis", "rhythm",
  ]);
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
    verbal.score = scoreDimensions(verbal.dimensions);
  }
  const reviewScores = [vocal.score, verbal.score].filter(score => typeof score === "number");
  const overallScore = reviewScores.length
    ? Math.round(reviewScores.reduce((sum, score) => sum + score, 0) / reviewScores.length)
    : null;
  const improvements = cleanReportItems(report.improvements);
  const previousPerformance = normalizePreviousPerformance(report.previousPerformance, history[0], overallScore);
  return {
    version: 4,
    summary: String(report.summary || "Speech analysis complete.").slice(0, 1000),
    overallScore,
    scoreBasis: "Average of the measurable vocal and verbal review scores. PREP is the verbal Structure dimension and is calculated from Point, Reason, Example, and Final Point.",
    vocal,
    verbal,
    prep,
    strengths: cleanReportItems(report.strengths),
    improvements,
    nextFocus: {
      title: String(report.nextFocus?.title || "One clear improvement").slice(0, 160),
      action: String(report.nextFocus?.action || "Apply one focused change in your next speech.").slice(0, 700),
    },
    previousPerformance,
    commonChallenges: buildCommonChallenges(history, improvements),
  };
}

function reportToFeedback(report) {
  const formatItems = items => items.map(item =>
    `• ${item.point}${item.evidence ? ` — ${item.evidence}` : ""}`
  ).join("\n");
  return [
    `Summary: ${report.summary}`,
    `PREP structure: ${report.prep?.score ?? "Not measured"}/100`,
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
        pauses: { score: 0, evidence: "string" },
        pitchRange: { score: 0, evidence: "string" },
        volumeVariation: { score: 0, evidence: "string" },
        emphasis: { score: 0, evidence: "string" },
        rhythm: { score: 0, evidence: "string" },
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

  const completion = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    reasoning_effort: "none",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are an expert evidence-based public-speaking coach.",
          "Return only one JSON object. Do not use markdown.",
          "Score the recorded speech from 0 to 100 using the transcript and supplied measurements.",
          "Never claim pitch, volume, or vocal energy was measured when acoustic measurements are absent.",
          "When a dimension cannot be supported, use null for its score and explain the limitation in evidence.",
          "Quote short exact phrases from the transcript as evidence for verbal judgments.",
          "Do not infer personality, emotion, identity, health, or confidence from the voice.",
          "Calibrate every dimension independently. Do not reuse a generic score or default to 78.",
          "Use the full 0-100 scale: below 50 needs substantial work, 50-69 developing, 70-84 solid, and 85+ exceptional evidence.",
          "Score PREP explicitly as Point, Reason, Example, and Final Point. A missing step scores 0. Do not invent an implied step that is not supported by the transcript.",
          "Point measures whether the answer states one clear position. Reason measures whether it gives a relevant why. Example measures whether it gives a specific personal or practical example. Final Point measures whether it returns to the main idea or gives a clear takeaway or recommendation.",
          "The PREP score is the average of the four PREP step scores. The verbal structure dimension must use that same PREP score so PREP contributes once to the verbal review and overall score.",
          "For each challenge in the immediately previous report, assess whether it is fixed, improved, still present, or not measurable in this speech.",
          `Use this exact object shape: ${JSON.stringify(requiredShape)}`,
          "Give three strengths and three improvements. Make the next focus measurable.",
          `Acoustic measurements available: ${hasAudioMetrics ? "yes" : "no"}.`,
        ].join("\n"),
      },
      {
        role: "user",
        content: `Question or topic:\n${promptContext || "Not provided"}\n\nMeasurements:\n${JSON.stringify(metrics, null, 2)}\n\nRecent performance history (newest first):\n${JSON.stringify(history, null, 2)}\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || "{}";
  return normalizeReport(JSON.parse(raw), history);
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
