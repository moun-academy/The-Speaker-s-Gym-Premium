// Speak on the Spot: presets, scoring, ranks and badges, with no screen or microphone involved so they can be tested.
// The speech detection and the screen stay in index.html; they call these functions.

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export const PRESETS = [
  { id: 'spark', icon: '⚡', name: 'Quick Spark', blurb: '30 seconds, 4 words. A fast warm-up.', think: 3, duration: 30, interval: 7, words: 4 },
  { id: 'classic', icon: '🎯', name: 'Classic', blurb: 'The original: 60 seconds, 6 words.', think: 5, duration: 60, interval: 10, words: 6 },
  { id: 'pressure', icon: '🔥', name: 'Pressure', blurb: '8 words, 6 seconds each. No time to blink.', think: 3, duration: 60, interval: 6, words: 8 },
  { id: 'endurance', icon: '🏔️', name: 'Endurance', blurb: '90 seconds, 10 words. Stay fluent.', think: 5, duration: 90, interval: 8, words: 10 },
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

// ---------------------------------------------------------------- scoring
export const WORD_POINTS = 15, MISS_PENALTY = 10, EARLY_PENALTY = 5, FINISH_BONUS = 10;
// Up to 10 extra points for a word: all of them at once, none if it only just made it in before its timer ran out.
export const SPEED_MAX = 10;
export const speedBonus = (detectedAtSeconds, intervalSeconds = 10) => clamp(Math.round(SPEED_MAX * (1 - detectedAtSeconds / Math.max(1, intervalSeconds))), 0, SPEED_MAX);
const PER_WORD_MAX = WORD_POINTS + SPEED_MAX;

export function longestStreak(words) {
  let run = 0, best = 0;
  words.forEach(word => { run = word.used ? run + 1 : 0; best = Math.max(best, run); });
  return best;
}

// session: { words: [{ used, missed, detectedAt }], earlyStopped }. The score is out of 100 for every preset:
// the points a perfect run could earn are the denominator, so a 4-word spark can reach 100 just like a 10-word marathon.
export function scoreSession(session) {
  const words = session.words || [];
  const used = words.filter(word => word.used).length;
  const missed = words.filter(word => word.missed && !word.used).length;
  const interval = session.settings?.wordInterval ?? 10;
  const speed = words.reduce((sum, word) => sum + (word.used ? speedBonus(word.detectedAt || 0, interval) : 0), 0);
  const finish = session.earlyStopped ? 0 : FINISH_BONUS;
  const early = session.earlyStopped ? EARLY_PENALTY : 0;
  const raw = used * WORD_POINTS + speed + finish - missed * MISS_PENALTY - early;
  const max = Math.max(1, words.length * PER_WORD_MAX + FINISH_BONUS);
  const score = words.length ? clamp(Math.round(raw / max * 100), 0, 100) : 0;
  return { used, missed, total: words.length, speed, finish, early, wordPoints: used * WORD_POINTS, missPoints: missed * MISS_PENALTY, raw, max, score, longestStreak: longestStreak(words) };
}

export const GRADES = [
  { letter: 'S', min: 90, label: 'Spotlight' }, { letter: 'A', min: 80, label: 'Sharp' }, { letter: 'B', min: 65, label: 'Solid' },
  { letter: 'C', min: 45, label: 'Getting there' }, { letter: 'D', min: 0, label: 'Keep at it' }
];
export const gradeOf = score => GRADES.find(grade => score >= grade.min) || GRADES[GRADES.length - 1];
export const starsFor = score => (score >= 85 ? 3 : score >= 60 ? 2 : score >= 30 ? 1 : 0);

export function xpFor(result, { earlyStopped }) {
  const streakBonus = result.longestStreak >= 3 ? 5 : 0;
  return Math.round(result.score / 5) + result.used * 2 + (earlyStopped ? 0 : 10) + streakBonus;
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
  { id: 'word-wizard', icon: '🧙', name: 'Word Wizard', hint: 'Use every word in a game of 4 or more.', test: ctx => ctx.result.total >= 4 && ctx.result.used === ctx.result.total },
  { id: 'speed-demon', icon: '🚀', name: 'Speed Demon', hint: 'Work 3 words in within 3 seconds each.', test: ctx => ctx.session.words.filter(word => word.used && word.detectedAt <= 3).length >= 3 },
  { id: 'hot-streak', icon: '🔥', name: 'Hot Streak', hint: 'Use 5 words in a row.', test: ctx => ctx.result.longestStreak >= 5 },
  { id: 'pressure-cooker', icon: '🥵', name: 'Pressure Cooker', hint: 'Score 70+ on Pressure.', test: ctx => ctx.preset === 'pressure' && ctx.result.score >= 70 },
  { id: 'iron-voice', icon: '🏔️', name: 'Iron Voice', hint: 'Finish Endurance with 60+.', test: ctx => ctx.preset === 'endurance' && !ctx.session.earlyStopped && ctx.result.score >= 60 },
  { id: 'century', icon: '💯', name: 'Century', hint: 'Use 100 words in total.', test: ctx => ctx.profile.totalUsed >= 100 },
  { id: 'explorer', icon: '🧭', name: 'Explorer', hint: 'Play Quick Spark, Classic, Pressure and Endurance.', test: ctx => ['spark', 'classic', 'pressure', 'endurance'].every(id => ctx.profile.presetsPlayed.includes(id)) }
];

export const newProfile = () => ({ xp: 0, sessions: 0, totalUsed: 0, bestStreak: 0, badges: [], presetsPlayed: [], history: [], settings: { preset: 'classic', custom: '' } });
export function normalizeProfile(raw) {
  const base = newProfile();
  if (!raw || typeof raw !== 'object') return base;
  const preset = PRESETS.some(p => p.id === raw.settings?.preset) ? raw.settings.preset : 'classic';
  return {
    xp: Math.max(0, Number(raw.xp) || 0), sessions: Math.max(0, Number(raw.sessions) || 0),
    totalUsed: Math.max(0, Number(raw.totalUsed) || 0), bestStreak: Math.max(0, Number(raw.bestStreak) || 0),
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
    xp: before.xp + xp, sessions: before.sessions + 1, bestStreak: Math.max(before.bestStreak, result.longestStreak),
    badges: [...before.badges, ...earned.map(badge => badge.id)],
    history: [...before.history, { at: now, preset, score: result.score, used: result.used, total: result.total }].slice(-12)
  };
  return { profile: after, xp, earned, rankedUp: rankFor(after.xp).index > ranksBefore };
}

export function coachingTip(result, session, detection) {
  if (detection === 'off') return 'Word detection was not available this time, so the score only reflects the timers. Try Chrome on a computer, or allow the microphone, to have each word counted.';
  if (!result.total) return 'Pick a game and the words will appear one by one.';
  if (result.used === 0) return 'No words were picked up. Check that your microphone is on and speak the word clearly the moment it appears: even one sentence like “Speaking of …” counts.';
  const times = session.words.filter(word => word.used).map(word => word.detectedAt);
  const avg = times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : 0;
  if (result.missed >= Math.ceil(result.total / 2)) return 'Words are slipping by. When a new one appears, say it straight away and build the sentence around it afterwards.';
  if (avg > (session.settings?.wordInterval ?? 10) * 0.6) return 'You get the words in, just late. Say each word in your very next sentence, then connect it to your answer.';
  if (result.score >= 90) return 'That is a spotlight performance. Raise the stakes: try Pressure, or write your own tricky question.';
  if (result.score >= 65) return 'Solid. To land the last points, open with a clear answer, then use the words as your reasons and examples.';
  return 'Good start. Open with your answer, then treat each word as a prop: describe it, compare it, or tell a quick story with it.';
}
