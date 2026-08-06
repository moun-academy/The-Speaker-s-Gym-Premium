import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, transcript, feedback, metrics, history } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Missing message' });
    }

    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ error: 'No speech transcript available. Complete a speech first.' });
    }

    // Build metrics context if available
    let metricsContext = '';
    if (metrics) {
      metricsContext = `\nSpeech Metrics:
- Speaking pace: ${metrics.wordsPerMinute || 'N/A'} WPM (${metrics.pacingVariation || 'unknown'})
- Pauses: ${metrics.pauseCount || 0} notable pauses (avg ${metrics.averagePauseDuration || 0}s, longest ${metrics.longestPause || 0}s)
- Filler words: ${metrics.fillerWordCount || 0}${metrics.fillerWordsUsed && Object.keys(metrics.fillerWordsUsed).length > 0 ? `. ${Object.entries(metrics.fillerWordsUsed).map(([w, c]) => `"${w}" (${c}x)`).join(', ')}` : ''}`;
    }

    // Build conversation history for multi-turn chat
    const messages = [
      {
        role: 'system',
        content: [
          'You are an expert speaking coach having a conversation about a specific speech the user just gave.',
          'You have the full transcript, AI evaluation, and speech metrics for this speech.',
          'Answer questions ONLY based on this specific speech. Quote the speaker\'s actual words when relevant.',
          'Be concise, specific, and actionable. Use the transcript and metrics to give concrete advice.',
          'Do not use em dashes or en dashes.',
          'If the user asks about something unrelated to their speech or public speaking, gently redirect them.',
          '',
          '=== SPEECH TRANSCRIPT ===',
          transcript.trim(),
          '',
          feedback ? `=== AI EVALUATION ===\n${feedback.trim()}` : '',
          metricsContext ? `\n${metricsContext}` : '',
        ].filter(Boolean).join('\n'),
      },
    ];

    // Add conversation history (last 20 messages max to stay within context)
    if (Array.isArray(history)) {
      const recentHistory = history.slice(-20);
      for (const msg of recentHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // Add current user message
    messages.push({ role: 'user', content: message.trim() });

    const completion = await client.chat.completions.create({
      model: 'gpt-5.6-luna',
      reasoning_effort: 'none',
      messages,
    });

    const reply = (completion.choices?.[0]?.message?.content?.trim() || 'Sorry, I couldn\'t generate a response.')
      .replace(/[\u2013\u2014]/g, ',');

    return res.status(200).json({ reply });

  } catch (error) {
    console.error('Chat error:', error.message);

    if (error.status) {
      return res.status(error.status).json({
        error: 'OpenAI API error',
        details: error.message,
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OpenAI API key not configured',
      });
    }

    return res.status(500).json({
      error: 'Failed to generate response',
      details: error.message,
    });
  }
}
