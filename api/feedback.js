import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_CHARS = 12000;

export const config = {
  api: {
    bodyParser: false, // Disable default body parser for file uploads
  },
};

// Helper to parse multipart form data
async function parseMultipartForm(req) {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw new Error('Upload exceeds size limit');
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytesReceived = 0;

    req.on('data', chunk => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_UPLOAD_BYTES) {
        reject(new Error('Upload exceeds size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
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

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytesReceived = 0;

    req.on('data', chunk => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_UPLOAD_BYTES) {
        reject(new Error('Request body exceeds size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8').trim();
        if (!rawBody) {
          resolve({});
          return;
        }
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', reject);
  });
}

async function parseTextBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytesReceived = 0;

    req.on('data', chunk => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_UPLOAD_BYTES) {
        reject(new Error('Request body exceeds size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ text });
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
  const pauses = [];

  // Count filler words
  words.forEach(word => {
    const wordText = word.word.toLowerCase().trim();
    if (fillerWords.includes(wordText)) {
      fillerCount++;
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
  const safeDuration = duration > 0 ? duration : 0;
  const wordsPerMinute = safeDuration > 0 ? Math.round((words.length / safeDuration) * 60) : 0;

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
    pauseCount: pauses.length,
    pacingVariation
  };
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

      const transcript = (transcription.text || '').trim().slice(0, MAX_TEXT_CHARS);
      const words = transcription.words || [];
      const duration = fields.duration ? parseFloat(fields.duration) : transcription.duration || 0;

      console.log(`Transcription complete. Words: ${words.length}, Duration: ${duration}s`);

      // Step 2: Analyze speech metrics
      const metrics = analyzeMetrics(words, duration);

      console.log('Metrics:', metrics);

      // Step 3: Generate feedback with GPT-4o using enriched data
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
- Filler words detected: ${metrics.fillerWordCount} ("um", "uh", "like", etc.)
`;

      const completion = await client.chat.completions.create({
        model: 'gpt-5.1',
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
              'Summary: [One sentence overall assessment]',
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
        ],
        temperature: 0.5
      });

      const feedback = completion.choices?.[0]?.message?.content?.trim() || 'No feedback generated.';

      return res.status(200).json({
        feedback,
        transcript,
        metrics
      });

    } else {
      // Fallback: Handle old text-only format for backwards compatibility
      let payload;
      if (req.body && typeof req.body === 'object') {
        payload = req.body;
      } else if (contentType.includes('text/plain')) {
        payload = await parseTextBody(req);
      } else {
        payload = await parseJsonBody(req);
      }
      const { text } = payload || {};

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Missing transcript text or audio file' });
      }

      const cleanedText = text.trim().slice(0, MAX_TEXT_CHARS);

      const completion = await client.chat.completions.create({
        model: 'gpt-5.1',
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
              'Keep the tone concise, specific, and constructive.'
            ].join(' '),
          },
          { role: 'user', content: cleanedText }
        ],
        temperature: 0.5
      });

      const feedback = completion.choices?.[0]?.message?.content?.trim() || 'No feedback generated.';
      return res.status(200).json({ feedback });
    }

  } catch (error) {
    console.error('Feedback generation failed:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);

    if (error.message && error.message.includes('size limit')) {
      return res.status(413).json({
        error: 'Request too large',
        details: error.message
      });
    }

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
