import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing transcript text' });
  }

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a concise speaking coach. Provide a quick transcript summary, three bullet strengths, and three bullet suggestions to improve.',
        },
        { role: 'user', content: text.trim() }
      ],
      temperature: 0.5
    });

    const feedback = completion.choices?.[0]?.message?.content?.trim() || 'No feedback generated.';
    return res.status(200).json({ feedback });
  } catch (error) {
    console.error('Feedback generation failed:', error);
    return res.status(500).json({ error: 'Failed to generate feedback' });
  }
}
