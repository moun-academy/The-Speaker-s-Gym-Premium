// Short-chunk speech to text for the web app's meeting mode. The browser cannot point its built-in
// speech recognition at the audio of a video call, so it sends a few seconds of that audio at a time
// and gets back the words with timestamps. Used by Speak on the Spot (to detect the target words)
// and by the vocal variety pace games (to count words a minute).
import OpenAI from "openai";
import admin from "firebase-admin";

export const config = { api: { bodyParser: false } };

const MAX_BYTES = 1.5 * 1024 * 1024;               // a few seconds of compressed audio is ~50 KB
const EXTENSIONS = new Set(["webm", "ogg", "mp4", "m4a", "mp3", "wav"]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) { reject(Object.assign(new Error("Audio chunk is too large"), { status: 413 })); req.destroy?.(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseMultipart(buffer, contentType) {
  const boundary = String(contentType || "").split("boundary=")[1]?.replace(/^"|"$/g, "");
  if (!boundary) throw Object.assign(new Error("No multipart boundary"), { status: 400 });
  const result = { fields: {}, files: {} };
  for (const part of buffer.toString("binary").split(`--${boundary}`)) {
    if (!part.includes("Content-Disposition")) continue;
    const name = part.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const filename = part.match(/filename="([^"]*)"/)?.[1];
    const start = part.indexOf("\r\n\r\n") + 4, end = part.lastIndexOf("\r\n");
    const content = part.substring(start, end);
    if (filename !== undefined) result.files[name] = { filename, data: Buffer.from(content, "binary") };
    else result.fields[name] = content;
  }
  return result;
}

// Speech-to-text invents words from near-silence and noise (“thank you”, “thanks for watching”, repeated words). Those
// phantom words would count as speed, so they are removed here using the service's own confidence figures.
const PHANTOM_PHRASES = new Set([
  "thank you", "thank you very much", "thanks", "thanks for watching", "thank you for watching", "thank you for watching and i will see you in the next video",
  "please subscribe", "like and subscribe", "bye", "bye bye", "goodbye", "you", "so", "okay", "oh", "uh", "um", "hmm", "mm", "mhm", "the end",
  "subtitles by the amara org community", "music", "applause", "silence", "laughter"
]);
const plain = text => String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export function cleanTranscription(raw, { voicedMs = Infinity } = {}) {
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];
  const unreliable = segments.filter(segment =>
    (Number(segment.no_speech_prob) > 0.6 && Number(segment.avg_logprob) < -1) || Number(segment.compression_ratio) > 2.4);
  const inUnreliable = word => unreliable.some(segment => word.start >= Number(segment.start) - 0.05 && word.start < Number(segment.end) + 0.05);
  const original = Array.isArray(raw?.words) ? raw.words : [];
  let words = original.filter(word => !inUnreliable(word) && !/^[\[(].*[\])]$/.test(String(word.word).trim()));
  const phantom = PHANTOM_PHRASES.has(plain(raw?.text)) && (voicedMs < 2000 || segments.some(segment => Number(segment.no_speech_prob) > 0.5));
  if (phantom) words = [];
  const dropped = original.length - words.length;
  // when words were removed the text is rebuilt from the ones that stayed, so a dropped phantom cannot leak back in through it
  const text = dropped ? words.map(word => String(word.word).trim()).join(" ") : String(raw?.text || "").trim();
  return { text, words, dropped };
}

// Only signed-in users may spend speech-to-text money. The browser sends its Firebase ID token as
// "Authorization: Bearer <token>", the same login the rest of the app uses.
function bearerToken(req) {
  return String(req.headers?.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

// Checking a login token needs no secret: Firebase signs tokens with public keys, so only the project id
// is required (it must match the app's firebaseConfig).
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "speaker-s-gym-premium";

export async function verifyFirebaseUser(token) {
  const app = admin.apps.find(candidate => candidate?.name === "transcribe-auth")
    || admin.initializeApp({ projectId: FIREBASE_PROJECT_ID }, "transcribe-auth");
  try { return (await admin.auth(app).verifyIdToken(token)).uid; }
  catch { throw Object.assign(new Error("Invalid login"), { status: 401 }); }
}

export function createHandler(getClient, verifyUser = verifyFirebaseUser) {
  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
    const client = getClient();
    if (!client) return res.status(500).json({ error: "Speech service is not configured" });

    try {
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ error: "Please sign in to use speech recognition" });
      try { await verifyUser(token); }
      catch (error) {
        return res.status(error.status === 500 ? 500 : 401).json({ error: error.status === 500 ? "Login check is not configured" : "Please sign in again" });
      }
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("multipart/form-data")) return res.status(400).json({ error: "Send the audio as multipart form data" });
      const { files, fields } = parseMultipart(await readBody(req), contentType);
      const audio = files.audio;
      if (!audio || !audio.data.length) return res.status(400).json({ error: "No audio provided" });
      const extension = String(audio.filename).split(".").pop().toLowerCase();
      if (!EXTENSIONS.has(extension)) return res.status(400).json({ error: "Unsupported audio type" });
      const language = /^[a-z]{2}$/.test(fields.language || "") ? fields.language : "en";
      const prompt = String(fields.prompt || "").replace(/[^\p{L}\p{N}\s,.'’-]/gu, " ").trim().slice(0, 300);

      const transcription = await client.audio.transcriptions.create({
        file: new File([audio.data], `chunk.${extension}`, { type: extension === "mp4" || extension === "m4a" ? "audio/mp4" : `audio/${extension}` }),
        model: "whisper-1",
        language,
        temperature: 0,
        ...(prompt ? { prompt } : {}),
        response_format: "verbose_json",
        timestamp_granularities: ["word", "segment"]
      });
      const voicedMs = Number(fields.voicedMs);
      const cleaned = cleanTranscription(transcription, { voicedMs: Number.isFinite(voicedMs) ? voicedMs : Infinity });
      return res.status(200).json({
        text: cleaned.text,
        words: cleaned.words.map(word => ({ word: String(word.word).trim(), start: Number(word.start), end: Number(word.end) })),
        dropped: cleaned.dropped,
        duration: Number(transcription.duration) || 0
      });
    } catch (error) {
      const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
      return res.status(status).json({ error: status === 413 ? "Audio chunk is too large" : "Could not transcribe this audio" });
    }
  };
}

export default createHandler(() => process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null);
