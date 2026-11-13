// Business Vocabulary: the rules. The screen lives in business-vocab.js, the words in business-vocab-words.js.
import { WORDS, CATEGORIES, CONFUSABLE } from './business-vocab-words.js';
export { WORDS, CATEGORIES };

export const ROUND_SIZE = 10;
export const MASTERED = 3;                     // a word is mastered after three correct answers in a row
export const MODES = [
  { id: 'learn', name: 'Flashcards', icon: '📚', blurb: 'See each word, its meaning and how it is used. Mark the ones you know.' },
  { id: 'meaning', name: 'Match the Meaning', icon: '🎯', blurb: 'Read a definition and pick the word that fits.' },
  { id: 'gap', name: 'Fill the Gap', icon: '✍️', blurb: 'Complete a real business sentence with the right word.' },
  { id: 'review', name: 'Review Mistakes', icon: '🔁', blurb: 'Practise the words you got wrong until they stick.' }
];
export const RANKS = [
  { name: 'Intern', at: 0, icon: '🎒' }, { name: 'Associate', at: 10, icon: '📎' }, { name: 'Analyst', at: 25, icon: '📊' },
  { name: 'Manager', at: 45, icon: '🗂️' }, { name: 'Director', at: 70, icon: '🏢' }, { name: 'Executive', at: 90, icon: '💼' },
  { name: 'Boardroom Pro', at: 100, icon: '👑' }
];

const byId = new Map(WORDS.map(word => [word.id, word]));
export const wordById = id => byId.get(id);
const confusable = new Map();
for (const [a, b] of CONFUSABLE) { (confusable.get(a) || confusable.set(a, new Set()).get(a)).add(b); (confusable.get(b) || confusable.set(b, new Set()).get(b)).add(a); }
export const areConfusable = (a, b) => !!confusable.get(a)?.has(b);

const shuffle = (list, rng = Math.random) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; };

// ---- progress
export function newProfile() { return { words: {}, xp: 0, sessions: 0, bestStreak: 0, settings: { category: 'all' } }; }
export function normalizeProfile(raw) {
  const base = newProfile();
  if (!raw || typeof raw !== 'object') return base;
  const words = {};
  for (const [id, entry] of Object.entries(raw.words || {})) {
    if (!byId.has(id) || !entry || typeof entry !== 'object') continue;
    const n = key => Math.max(0, Math.floor(Number(entry[key]) || 0));
    words[id] = { box: Math.min(MASTERED, n('box')), right: n('right'), wrong: n('wrong'), seen: n('seen'), last: n('last') };
  }
  const category = CATEGORIES.some(c => c.id === raw.settings?.category) ? raw.settings.category : 'all';
  return { words, xp: Math.max(0, Number(raw.xp) || 0), sessions: Math.max(0, Number(raw.sessions) || 0), bestStreak: Math.max(0, Number(raw.bestStreak) || 0), settings: { category } };
}
const entryOf = (profile, id) => profile.words[id] || { box: 0, right: 0, wrong: 0, seen: 0, last: 0 };
export const boxOf = (profile, id) => entryOf(profile, id).box;
export const isMastered = (profile, id) => boxOf(profile, id) >= MASTERED;

export function progressOf(profile, category = 'all') {
  const list = WORDS.filter(word => category === 'all' || word.category === category);
  let mastered = 0, learning = 0;
  for (const word of list) { const box = boxOf(profile, word.id); if (box >= MASTERED) mastered++; else if (profile.words[word.id]?.seen) learning++; }
  return { total: list.length, mastered, learning, fresh: list.length - mastered - learning };
}
export function rankFor(mastered) {
  let index = 0;
  RANKS.forEach((rank, i) => { if (mastered >= rank.at) index = i; });
  const current = RANKS[index], next = RANKS[index + 1] || null;
  return { current, next, toNext: next ? next.at - mastered : 0, progress: next ? (mastered - current.at) / (next.at - current.at) : 1 };
}
export const reviewIds = profile => WORDS.filter(word => (profile.words[word.id]?.wrong || 0) > 0 && !isMastered(profile, word.id)).map(word => word.id);

// One answer (quiz) or one self-rating (flashcards). Right moves a word up a box; wrong starts it again from zero.
export function recordAnswer(profile, id, correct, now = Date.now()) {
  const entry = { ...entryOf(profile, id) };
  entry.seen++; entry.last = now;
  if (correct) { entry.right++; entry.box = Math.min(MASTERED, entry.box + 1); } else { entry.wrong++; entry.box = 0; }
  return { ...profile, words: { ...profile.words, [id]: entry } };
}

// ---- building a round
// Unmastered words first (new and shaky ones mixed), then mastered ones to keep them fresh.
export function makeDeck(profile, { mode, category = 'all', size = ROUND_SIZE, rng = Math.random } = {}) {
  let pool = WORDS.filter(word => category === 'all' || word.category === category);
  if (mode === 'review') {
    const ids = new Set(reviewIds(profile));
    pool = pool.filter(word => ids.has(word.id));
    if (!pool.length) pool = WORDS.filter(word => ids.has(word.id));
  }
  // Lowest box first (shuffled within each box), then mastered words; the chosen ones are shuffled again.
  const open = shuffle(pool.filter(word => !isMastered(profile, word.id)), rng).sort((a, b) => boxOf(profile, a.id) - boxOf(profile, b.id));
  const done = shuffle(pool.filter(word => isMastered(profile, word.id)), rng);
  return shuffle([...open, ...done].slice(0, size), rng);
}

// Four choices: the answer plus three of the same part of speech that cannot be mistaken for it.
// In Fill the Gap the wrong ones also come from other topics, so only one word fits the sentence.
export function choicesFor(word, mode, rng = Math.random) {
  const usable = other => other.id !== word.id && !areConfusable(word.id, other.id);
  let pool = WORDS.filter(other => usable(other) && other.pos === word.pos && (mode !== 'gap' || other.category !== word.category));
  if (pool.length < 3) pool = WORDS.filter(other => usable(other) && other.pos === word.pos);
  if (pool.length < 3) pool = WORDS.filter(usable);
  return shuffle([word, ...shuffle(pool, rng).slice(0, 3)], rng);
}

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The example sentence split around the word, for Fill the Gap.
export function blankSentence(word) {
  const match = new RegExp(`\\b${escapeRe(word.word)}\\b`, 'i').exec(word.example);
  if (!match) return null;
  return { before: word.example.slice(0, match.index), answer: match[0], after: word.example.slice(match.index + match[0].length) };
}

// ---- scoring
export function scoreRound(answers) {
  let streak = 0, bestStreak = 0, correct = 0;
  for (const answer of answers) { if (answer.correct) { correct++; streak++; bestStreak = Math.max(bestStreak, streak); } else streak = 0; }
  const total = answers.length, accuracy = total ? correct / total : 0;
  const xp = correct * 10 + bestStreak * 2 + (total >= 5 && correct === total ? 20 : 0);
  const stars = total ? (accuracy >= 0.9 ? 3 : accuracy >= 0.7 ? 2 : accuracy >= 0.4 ? 1 : 0) : 0;
  return { correct, total, accuracy, bestStreak, xp, stars };
}
export function finishSession(profile, result) {
  return { ...profile, xp: profile.xp + result.xp, sessions: profile.sessions + 1, bestStreak: Math.max(profile.bestStreak, result.bestStreak) };
}
export function verdict(result) {
  if (!result.total) return 'Nothing answered this time.';
  if (result.accuracy === 1) return 'Flawless. You would sound sharp in any boardroom.';
  if (result.accuracy >= 0.8) return 'Excellent. These words are becoming yours.';
  if (result.accuracy >= 0.6) return 'Good work. A couple more rounds and they will stick.';
  return 'A solid start. Review the words below, then go again.';
}
