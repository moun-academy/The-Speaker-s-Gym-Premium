import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const cleanText = value => String(value || "")
  .replace(/[\u2013\u2014]/g, ",")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 500);

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

  const prompt = cleanText(req.body?.prompt);
  if (!prompt) return res.status(400).json({ error: "A question is required" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "AI examples are not configured" });

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-5.6-luna",
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You teach people to answer questions using Point, Reason, Example, Point.",
            "Return only JSON with exactly these string fields: point, reason, example, finalPoint.",
            "Create one concise, natural answer that directly responds to the supplied question.",
            "The Point must answer directly. The Reason must explain why. The Example must be specific and plausible. The Final Point must restate the answer with a clear takeaway.",
            "Write one or two short sentences per field.",
            "Do not use em dashes or en dashes."
          ].join("\n")
        },
        { role: "user", content: prompt }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw);
    const example = {
      point: cleanText(parsed.point),
      reason: cleanText(parsed.reason),
      example: cleanText(parsed.example),
      finalPoint: cleanText(parsed.finalPoint)
    };

    if (Object.values(example).some(value => !value)) {
      return res.status(502).json({ error: "The AI returned an incomplete example" });
    }
    return res.status(200).json({ example });
  } catch (error) {
    console.error("Structure example error:", error.message);
    return res.status(error.status || 500).json({ error: "Could not create an example" });
  }
}
