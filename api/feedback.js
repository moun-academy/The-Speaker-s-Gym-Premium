import OpenAI from "openai";
import { Readable } from "stream";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const config = {
  api: {
    bodyParser: false, // Disable default body parser for file uploads
  },
};

// Helper to parse multipart form data
async function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type']?.split('boundary=')[1];

        if (!boundary) {
          return reject(new Error('No boundary found'));
        }

        const parts = buffer.toString('binary').split(`--${boundary}`);
        const result = { fields: {}, files: {} };

        for (const part of parts) {
          if (part.includes('Content-Disposition')) {
            const nameMatch = part.match(/name="([^"]+)"/);
            const filenameMatch = part.match(/filename="([^"]+)"/);

            if (nameMatch) {
              const name = nameMatch[1];
              const contentStart = part.indexOf('\r\n\r\n') + 4;
              const contentEnd = part.lastIndexOf('\r\n');
              const content = part.substring(contentStart, contentEnd);

              if (filenameMatch) {
                // It's a file
                const filename = filenameMatch[1];
                result.files[name] = {
                  filename,
                  data: Buffer.from(content, 'binary')
                };
              } else {
                // It's a field
                result.fields[name] = content;
              }
            }
          }
        }

        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// Analyze speech metrics from Whisper word timestamps
function analyzeMetrics(words, duration) {
  if (!words || words.length === 0) {
    return {
      wordsPerMinute: 0,
      averagePauseDuration: 0,
      longestPause: 0,
      fillerWordCount: 0,
      pacingVariation: 'unknown'
    };
  }

  const fillerWords = ['um', 'uh', 'like', 'you know', 'so', 'basically', 'actually', 'literally'];
  let fillerCount = 0;
  const fillerWordsUsed = {};
  const pauses = [];

  // Count filler words and track which ones were used
  words.forEach(word => {
    const wordText = word.word.toLowerCase().trim();
    if (fillerWords.includes(wordText)) {
      fillerCount++;
      fillerWordsUsed[wordText] = (fillerWordsUsed[wordText] || 0) + 1;
    }
  });

  // Calculate pauses between words
  for (let i = 1; i < words.length; i++) {
    const pause = words[i].start - words[i - 1].end;
    if (pause > 0.2) { // Pauses longer than 200ms
      pauses.push(pause);
    }
  }

  // Calculate words per minute
  const wordsPerMinute = Math.round((words.length / duration) * 60);

  // Analyze pacing variation
  let pacingVariation = 'steady';
  if (pauses.length > words.length * 0.3) {
    pacingVariation = 'halting';
  } else if (pauses.length < words.length * 0.1 && wordsPerMinute > 150) {
    pacingVariation = 'rushed';
  }

  return {
    wordsPerMinute,
    averagePauseDuration: pauses.length > 0 ? (pauses.reduce((a, b) => a + b, 0) / pauses.length).toFixed(2) : 0,
    longestPause: pauses.length > 0 ? Math.max(...pauses).toFixed(2) : 0,
    fillerWordCount: fillerCount,
    fillerWordsUsed,
    pauseCount: pauses.length,
    pacingVariation
  };
}

// Extract the trailing "SCORES: {...}" line from the model output.
// Returns { vocalVariety, structure } clamped to 0-100, plus the feedback
// text with that line removed. Falls back to nulls if absent/unparseable.
function extractScores(feedbackRaw) {
  let feedback = feedbackRaw;
  let vocalVariety = null;
  let structure = null;

  const match = feedbackRaw.match(/SCORES:\s*(\{[\s\S]*?\})\s*$/i);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      const clamp = v => {
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) return null;
        return Math.max(0, Math.min(100, n));
      };
      vocalVariety = clamp(parsed.vocalVariety);
      structure = clamp(parsed.structure);
    } catch (e) {
      console.warn('Failed to parse SCORES line:', e.message);
    }
    // Strip the SCORES line (and any trailing whitespace) from the prose.
    feedback = feedbackRaw.slice(0, match.index).trim();
  }

  return { feedback, vocalVariety, structure };
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const contentType = req.headers['content-type'] || '';

    // Handle audio file upload
    if (contentType.includes('multipart/form-data')) {
      const { files, fields } = await parseMultipartForm(req);
      const audioFile = files.audio;

      if (!audioFile) {
        return res.status(400).json({ error: 'No audio file provided' });
      }

      console.log(`Processing audio file: ${audioFile.filename}, size: ${audioFile.data.length} bytes`);

      // Step 1: Transcribe with Whisper (with word-level timestamps)
      const transcription = await client.audio.transcriptions.create({
        file: new File([audioFile.data], audioFile.filename, { type: 'audio/webm' }),
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word']
      });

      const transcript = transcription.text;
      const words = transcription.words || [];
      const duration = fields.duration ? parseFloat(fields.duration) : transcription.duration || 0;

      console.log(`Transcription complete. Words: ${words.length}, Duration: ${duration}s`);

      // Step 2: Analyze speech metrics
      const metrics = analyzeMetrics(words, duration);

      console.log('Metrics:', metrics);

      // Step 3: Generate feedback with GPT-5.4 Nano using enriched data
      const metricsText = `
Speech Metrics:
- Speaking pace: ${metrics.wordsPerMinute} words per minute (${
        metrics.wordsPerMinute < 120 ? 'slow' :
        metrics.wordsPerMinute > 160 ? 'fast' :
        'moderate'
      })
- Pacing variation: ${metrics.pacingVariation}
- Pauses: ${metrics.pauseCount} notable pauses detected
- Average pause: ${metrics.averagePauseDuration}s
- Longest pause: ${metrics.longestPause}s
- Filler words detected: ${metrics.fillerWordCount}${Object.keys(metrics.fillerWordsUsed).length > 0 ? ` — specifically: ${Object.entries(metrics.fillerWordsUsed).map(([word, count]) => `"${word}" (${count}x)`).join(', ')}` : ''}
`;

      const completion = await client.chat.completions.create({
        model: 'gpt-5.4-nano',
        reasoning_effort: 'none',
        messages: [
          {
            role: 'system',
            content: [
              'You are an expert speaking coach analyzing a recorded speech.',
              'You have access to both the transcript AND detailed speech metrics (pace, pauses, filler words).',
              '',
              'CRITICAL: You MUST quote specific phrases from the speaker\'s actual words in your feedback.',
              'Use quotation marks around their exact words when giving examples.',
              '',
              'Format your feedback as follows:',
              '',
              'Summary: [One sentence overall assessment. MUST list the specific filler words/sounds the speaker used (e.g. "um", "uh", "like") with how many times each was detected.]',
              '',
              'What you did well:',
              '• [Strength with QUOTED EXAMPLE: "exact phrase they said" - explain why this worked]',
              '• [Strength with QUOTED EXAMPLE: "exact phrase they said" - explain why this worked]',
              '• [Strength with QUOTED EXAMPLE: "exact phrase they said" - explain why this worked]',
              '',
              'What to improve:',
              '• [Area to improve with QUOTED EXAMPLE: "exact phrase they said" - suggest how to improve it]',
              '• [Area to improve with QUOTED EXAMPLE: "exact phrase they said" - suggest how to improve it]',
              '• [Area to improve with QUOTED EXAMPLE: "exact phrase they said" - suggest how to improve it]',
              '',
              'Next speech focus:',
              '• [One actionable goal based on the data and their specific content]',
              '',
              'After all the prose sections above, output ONE final line, exactly in this format and nothing after it:',
              'SCORES: {"vocalVariety": <0-100 integer>, "structure": <0-100 integer>}',
              'Scoring guidance:',
              '- vocalVariety = how dynamic and expressive the delivery is. Reward varied pace, deliberate pauses, and emphasis/contrast in word choice; penalize monotone rushing, flat steady pacing with no pauses, and heavy filler. Use the provided metrics (pace, pacing variation, pause count/length, filler count) AND the wording. 0 = monotone, 100 = highly dynamic.',
              '- structure = how well organized the speech is: a clear opening/hook, one or more distinct points, supporting detail or an example, and a deliberate close/landing. 0 = rambling with no shape, 100 = tight, complete arc. Judge only from the transcript.',
              'The SCORES line is mandatory and must be valid JSON. Do not wrap it in code fences.',
              '',
              'Examples of good feedback:',
              '- When you said "the most important thing is trust", you emphasized the key word effectively',
              '- The opening "I was completely lost" grabbed attention with vulnerability',
              '- Try replacing "um, like, you know" with a brief pause - silence is powerful',
              '',
              'Reference actual metrics (pace, pauses, filler count) AND quote their specific words.',
              'Make every point concrete and actionable with real examples from THIS speech.',
              'Keep the tone encouraging but honest.'
            ].join('\n'),
          },
          {
            role: 'user',
            content: `${metricsText}\n\nTranscript:\n${transcript}`
          }
        ]
      });

      const feedbackRaw = completion.choices?.[0]?.message?.content?.trim() || 'No feedback generated.';
      const { feedback, vocalVariety, structure } = extractScores(feedbackRaw);

      // Fold the AI scores into metrics so the client's leveling engine,
      // Firebase sync, and analytics all pick them up automatically.
      metrics.vocalVariety = vocalVariety;
      metrics.structure = structure;

      return res.status(200).json({
        feedback,
        transcript,
        metrics
      });

    } else {
      // Fallback: Handle old text-only format for backwards compatibility
      const { text } = req.body || {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Missing transcript text or audio file' });
      }

      const completion = await client.chat.completions.create({
        model: 'gpt-5.4-nano',
        reasoning_effort: 'none',
        messages: [
          {
            role: 'system',
            content: [
              'You are an encouraging speaking coach.',
              'Analyze the provided speech transcript and respond with the following labeled sections:',
              'Summary: one sentence.',
              'What you did well: exactly three bullet points.',
              'What to improve: exactly three bullet points.',
              'Next speech focus: one actionable bullet.',
              'Keep the tone concise, specific, and constructive.',
              'After all prose, output ONE final line exactly: SCORES: {"vocalVariety": <0-100 integer>, "structure": <0-100 integer>}.',
              'vocalVariety = how dynamic/expressive the delivery reads (varied pace, emphasis, contrast; penalize monotone and filler).',
              'structure = clarity of organization: opening/hook, distinct point(s), support/example, deliberate close. Valid JSON, no code fences.'
            ].join(' '),
          },
          { role: 'user', content: text.trim() }
        ]
      });

      const feedbackRaw = completion.choices?.[0]?.message?.content?.trim() || 'No feedback generated.';
      const { feedback, vocalVariety, structure } = extractScores(feedbackRaw);
      return res.status(200).json({ feedback, metrics: { vocalVariety, structure } });
    }

  } catch (error) {
    console.error('Feedback generation failed:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);

    // Check if it's an OpenAI API error
    if (error.status) {
      console.error('OpenAI API Status:', error.status);
      console.error('OpenAI API Error:', error.error);
      return res.status(error.status).json({
        error: 'OpenAI API error',
        details: error.message,
        status: error.status
      });
    }

    // Check if API key is missing
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OpenAI API key not configured',
        details: 'OPENAI_API_KEY environment variable is missing'
      });
    }

    return res.status(500).json({
      error: 'Failed to generate feedback',
      details: error.message
    });
  }
}
