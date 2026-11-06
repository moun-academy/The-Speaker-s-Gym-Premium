// Speak on the Spot: presets, scoring, ranks and badges, with no screen or microphone involved so they can be tested.
// The speech detection and the screen stay in index.html; they call these functions.

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export const PRESETS = [
  { id: 'spark', icon: '⚡', name: 'Quick Spark', blurb: 'A 30-second story with 4 new words.', think: 3, duration: 30, interval: 7, words: 4 },
  { id: 'classic', icon: '🎯', name: 'Classic', blurb: 'A 60-second story with 6 new words.', think: 5, duration: 60, interval: 10, words: 6 },
  { id: 'pressure', icon: '🔥', name: 'Pressure', blurb: 'A 60-second story, a new word every 6 seconds.', think: 3, duration: 60, interval: 6, words: 8 },
  { id: 'endurance', icon: '🏔️', name: 'Endurance', blurb: 'A 90-second story with 10 words. Keep it flowing.', think: 5, duration: 90, interval: 8, words: 10 },
  { id: 'custom', icon: '🎛️', name: 'Custom', blurb: 'Choose every setting yourself.' }
];
export const presetById = id => PRESETS.find(preset => preset.id === id) || PRESETS[1];
// Which preset the four settings add up to (so a manual change shows as Custom).
export function presetFor({ thinkTime, speechDuration, wordInterval, numWords }) {
  const match = PRESETS.find(p => p.words && p.think === thinkTime && p.duration === speechDuration && p.interval === wordInterval && p.words === numWords);
  return match ? match.id : 'custom';
}

// ---------------------------------------------------------------- word matching (same rules the game has always used)
const normalize = text => String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
export function tokenMatchesWord(token, word) {
  const target = normalize(word).trim();
  if (!target || !token) return false;
  const variants = new Set([target, target + 's', target + 'es', target + 'ed', target + 'ing',
    target.endsWith('y') ? target.slice(0, -1) + 'ies' : null, target.endsWith('e') ? target.slice(0, -1) + 'ing' : null].filter(Boolean));
  if (variants.has(token)) return true;
  return target.length >= 5 && token.startsWith(target);
}
// Splits a transcript into pieces and marks the ones that hit a target word: [{ text, hit }].
export function highlightWords(text, words) {
  const parts = String(text || '').split(/(\s+)/);
  return parts.map(part => {
    const token = normalize(part).trim();
    const hit = token && !/^\s+$/.test(part) && words.some(word => tokenMatchesWord(token, word));
    return { text: part, hit: Boolean(hit) };
  });
}

// ---------------------------------------------------------------- the story
// Speak on the Spot is about telling ONE connected story that works the random words in as they appear. Using a word
// quickly earns nothing extra: what counts is how many words end up in the story, how long the story is, and how
// well it connects.
export const countWords = text => normalize(text).split(/\s+/).filter(Boolean).length;
export function countWordHits(text, word) {
  return normalize(text).split(/\s+/).filter(token => token && tokenMatchesWord(token, word)).length;
}

export const STORY_WEIGHTS = { words: 45, length: 25, connection: 30 };
export const WORDS_PER_SECOND = 1.5;       // about 90 words a minute of actual story is a full-length telling

// Words that join one idea to the next. Used only when the AI rating is not available, and then only as an estimate.
const CONNECTORS = ['because', 'so', 'then', 'but', 'and then', 'therefore', 'meanwhile', 'suddenly', 'after', 'when', 'while', 'until', 'which', 'however', 'finally', 'next', 'later', 'as a result', 'that is why', 'luckily', 'unfortunately'];
export function estimateConnection(text, usedWords) {
  const body = ' ' + normalize(text).replace(/\s+/g, ' ') + ' ';
  const found = CONNECTORS.reduce((sum, word) => sum + (body.split(' ' + word + ' ').length - 1), 0);
  return clamp(found / Math.max(3, usedWords * 1.5), 0, 1) * 70;      // never more than 70: only a real reading can say 100
}

// session: { words: [{ used }], transcript, settings: { speechDuration }, connection: { score } | null }
export function scoreSession(session) {
  const words = session.words || [];
  const used = words.filter(word => word.used).length;
  const total = words.length;
  const spokenWords = countWords(session.transcript);
  const targetWords = Math.round((session.settings?.speechDuration || 60) * WORDS_PER_SECOND);
  const lengthRatio = clamp(spokenWords / Math.max(1, targetWords), 0, 1);
  const rated = Number.isFinite(session.connection?.score);
  const connection = spokenWords ? (rated ? clamp(session.connection.score, 0, 100) : estimateConnection(session.transcript, used)) : 0;
  const wordPoints = total ? Math.round(STORY_WEIGHTS.words * used / total) : 0;
  const lengthPoints = Math.round(STORY_WEIGHTS.length * lengthRatio);
  const connectionPoints = Math.round(STORY_WEIGHTS.connection * connection / 100);
  const score = total ? clamp(wordPoints + lengthPoints + connectionPoints, 0, 100) : 0;
  return { used, missed: total - used, total, spokenWords, targetWords, lengthRatio, connection, connectionEstimated: !rated, connectionFeedback: rated ? String(session.connection.feedback || '') : '', wordPoints, lengthPoints, connectionPoints, score };
}

export const GRADES = [
  { letter: 'S', min: 90, label: 'Spotlight' }, { letter: 'A', min: 80, label: 'Sharp' }, { letter: 'B', min: 65, label: 'Solid' },
  { letter: 'C', min: 45, label: 'Getting there' }, { letter: 'D', min: 0, label: 'Keep at it' }
];
export const gradeOf = score => GRADES.find(grade => score >= grade.min) || GRADES[GRADES.length - 1];
export const starsFor = score => (score >= 85 ? 3 : score >= 60 ? 2 : score >= 30 ? 1 : 0);

export function xpFor(result, { earlyStopped }) {
  return Math.round(result.score / 5) + result.used * 2 + (earlyStopped ? 0 : 10);
}

// ---------------------------------------------------------------- ranks and badges
export const RANKS = [
  { name: 'Newcomer', xp: 0, icon: '🌱' }, { name: 'Improviser', xp: 80, icon: '🎭' }, { name: 'Quick Wit', xp: 240, icon: '⚡' },
  { name: 'Smooth Talker', xp: 520, icon: '😎' }, { name: 'Silver Tongue', xp: 1000, icon: '🥈' }, { name: 'Spotlight Star', xp: 2000, icon: '🌟' }
];
export function rankFor(xp) {
  let index = 0;
  RANKS.forEach((rank, i) => { if (xp >= rank.xp) index = i; });
  const current = RANKS[index], next = RANKS[index + 1] || null;
  return { index, current, next, progress: next ? clamp((xp - current.xp) / (next.xp - current.xp), 0, 1) : 1, toNext: next ? next.xp - xp : 0 };
}

// ctx: { result (scoreSession output), session, preset, profile (before, with this run's presetsPlayed/totalUsed merged) }
export const BADGES = [
  { id: 'first-spot', icon: '🎬', name: 'First Spot', hint: 'Finish a challenge.', test: ctx => !ctx.session.earlyStopped },
  { id: 'word-wizard', icon: '🧙', name: 'Word Wizard', hint: 'Work every word into one story (4 or more words).', test: ctx => ctx.result.total >= 4 && ctx.result.used === ctx.result.total },
  { id: 'storyteller', icon: '📖', name: 'Storyteller', hint: 'Tell a story of 150 words or more.', test: ctx => ctx.result.spokenWords >= 150 },
  { id: 'connected', icon: '🔗', name: 'Connect the Dots', hint: 'Get a connection rating of 80 or more.', test: ctx => !ctx.result.connectionEstimated && ctx.result.connection >= 80 },
  { id: 'pressure-cooker', icon: '🥵', name: 'Pressure Cooker', hint: 'Score 70+ on Pressure.', test: ctx => ctx.preset === 'pressure' && ctx.result.score >= 70 },
  { id: 'iron-voice', icon: '🏔️', name: 'Iron Voice', hint: 'Finish Endurance with 60+.', test: ctx => ctx.preset === 'endurance' && !ctx.session.earlyStopped && ctx.result.score >= 60 },
  { id: 'century', icon: '💯', name: 'Century', hint: 'Use 100 words in total.', test: ctx => ctx.profile.totalUsed >= 100 },
  { id: 'explorer', icon: '🧭', name: 'Explorer', hint: 'Play Quick Spark, Classic, Pressure and Endurance.', test: ctx => ['spark', 'classic', 'pressure', 'endurance'].every(id => ctx.profile.presetsPlayed.includes(id)) }
];

export const newProfile = () => ({ xp: 0, sessions: 0, totalUsed: 0, longestStory: 0, badges: [], presetsPlayed: [], history: [], settings: { preset: 'classic', custom: '' } });
export function normalizeProfile(raw) {
  const base = newProfile();
  if (!raw || typeof raw !== 'object') return base;
  const preset = PRESETS.some(p => p.id === raw.settings?.preset) ? raw.settings.preset : 'classic';
  return {
    xp: Math.max(0, Number(raw.xp) || 0), sessions: Math.max(0, Number(raw.sessions) || 0),
    totalUsed: Math.max(0, Number(raw.totalUsed) || 0), longestStory: Math.max(0, Number(raw.longestStory) || 0),
    badges: Array.isArray(raw.badges) ? raw.badges.filter(id => BADGES.some(badge => badge.id === id)) : [],
    presetsPlayed: Array.isArray(raw.presetsPlayed) ? raw.presetsPlayed.filter(id => PRESETS.some(p => p.id === id && p.words)) : [],
    history: Array.isArray(raw.history) ? raw.history.slice(-12) : [],
    settings: { preset, custom: String(raw.settings?.custom || '').slice(0, 140) }
  };
}

export function applyResult(profile, { result, session, preset }, now = Date.now()) {
  const before = normalizeProfile(profile);
  const xp = xpFor(result, session);
  const presetsPlayed = preset && preset !== 'custom' && !before.presetsPlayed.includes(preset) ? [...before.presetsPlayed, preset] : before.presetsPlayed;
  const merged = { ...before, totalUsed: before.totalUsed + result.used, presetsPlayed };
  const earned = BADGES.filter(badge => !before.badges.includes(badge.id) && badge.test({ result, session, preset, profile: merged }));
  const ranksBefore = rankFor(before.xp).index;
  const after = {
    ...merged,
    xp: before.xp + xp, sessions: before.sessions + 1, longestStory: Math.max(before.longestStory, result.spokenWords),
    badges: [...before.badges, ...earned.map(badge => badge.id)],
    history: [...before.history, { at: now, preset, score: result.score, used: result.used, total: result.total }].slice(-12)
  };
  return { profile: after, xp, earned, rankedUp: rankFor(after.xp).index > ranksBefore };
}

export function coachingTip(result, session, detection) {
  if (detection === 'off') return 'Word detection was not available this time, so the story could not be read. Try Chrome on a computer, or allow the microphone, so your story can be scored.';
  if (!result.total) return 'Pick a game and the words will appear one by one.';
  if (result.spokenWords < 8) return 'Hardly any story was heard. Check that your microphone is on, then just keep talking: the story is what scores.';
  if (result.used < Math.ceil(result.total / 2)) return 'Most words never made it into your story. Treat each new word as a plot twist: use it when it appears, or circle back to it later.';
  if (result.lengthRatio < 0.6) return 'Keep the story going: longer is better. When you run out of ideas, ask yourself "and then what happened?" and carry on.';
  if (result.connection < 60) return 'Connect the dots. Link each new word to the last one with because, so, then or but, so the story moves forward instead of listing things.';
  if (result.score >= 90) return 'That is a spotlight story: long, connected and every word earns its place. Raise the stakes with Pressure, or write your own question.';
  if (result.score >= 65) return 'Solid story. To finish stronger, give it a beginning, a problem and an ending, and land the last word in the final sentence.';
  return 'Good start. Pick a character and a place, then let each new word change what happens next.';
}
