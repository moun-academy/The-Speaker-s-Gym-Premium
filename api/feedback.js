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

function normalizeReview(value, dimensionNames) {
  const dimensions = {};
  for (const name of dimensionNames) dimensions[name] = normalizeDimension(value?.dimensions?.[name]);
  return {
    score: clampScore(value?.score),
    confidence: ["high", "medium", "low"].includes(value?.confidence) ? value.confidence : "low",
    dimensions,
  };
}

function normalizeReport(raw) {
  const report = raw && typeof raw === "object" ? raw : {};
  const cleanItems = items => (Array.isArray(items) ? items : []).slice(0, 4).map(item => ({
    category: String(item?.category || "").slice(0, 80),
    point: String(item?.point || "").slice(0, 500),
    evidence: String(item?.evidence || "").slice(0, 500),
  }));
  return {
    version: 2,
    summary: String(report.summary || "Speech analysis complete.").slice(0, 1000),
    overallScore: clampScore(report.overallScore),
    vocal: normalizeReview(report.vocal, [
      "pace", "pauses", "pitchRange", "volumeVariation", "emphasis", "rhythm",
    ]),
    verbal: normalizeReview(report.verbal, [
      "clarity", "structure", "logicalFlow", "wordChoice",
      "concision", "fillerControl", "repetitionControl",
    ]),
    strengths: cleanItems(report.strengths),
    improvements: cleanItems(report.improvements),
    nextFocus: {
      title: String(report.nextFocus?.title || "One clear improvement").slice(0, 160),
      action: String(report.nextFocus?.action || "Apply one focused change in your next speech.").slice(0, 700),
    },
  };
}

function reportToFeedback(report) {
  const formatItems = items => items.map(item =>
    `• ${item.point}${item.evidence ? ` — ${item.evidence}` : ""}`
  ).join("\n");
  return [
    `Summary: ${report.summary}`,
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

async function generatePerformanceReport({ transcript, metrics, hasAudioMetrics }) {
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
    strengths: [{ category: "string", point: "string", evidence: "exact quote or metric" }],
    improvements: [{ category: "string", point: "string", evidence: "exact quote or metric" }],
    nextFocus: { title: "string", action: "specific practice instruction" },
  };

  const completion = await client.chat.completions.create({
    model: "gpt-5.4-nano",
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
          `Use this exact object shape: ${JSON.stringify(requiredShape)}`,
          "Give three strengths and three improvements. Make the next focus measurable.",
          `Acoustic measurements available: ${hasAudioMetrics ? "yes" : "no"}.`,
        ].join("\n"),
      },
      {
        role: "user",
        content: `Measurements:\n${JSON.stringify(metrics, null, 2)}\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || "{}";
  return normalizeReport(JSON.parse(raw));
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
    let metrics;

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
      const duration = fields.duration ? parseFloat(fields.duration) : transcription.duration || 0;
      const acousticMetrics = parseAcousticMetrics(fields.acousticMetrics);
      metrics = analyzeMetrics(transcription.words || [], duration, transcript, acousticMetrics);
    } else {
      const { text } = await parseJsonBody(req);
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Missing transcript text or audio file" });
      }
      transcript = text.trim();
      metrics = analyzeMetrics([], 0, transcript, null);
    }

    const report = await generatePerformanceReport({
      transcript,
      metrics,
      hasAudioMetrics: Boolean(metrics.acoustic),
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
