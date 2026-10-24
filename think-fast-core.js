// Think Fast: the rules, scoring and prompts, with no screen or microphone in sight so they can be tested.
// think-fast.js draws the game and feeds this file the numbers it hears.
import { WORDS } from './think-fast-words.js';

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// ---------------------------------------------------------------- prompts
export const MODES = [
  { id: 'analogy', icon: '🔗', name: 'Analogy Blitz', blurb: 'Link two random things with a quick “because”.', lead: 'Complete the analogy', tail: 'BECAUSE…', example: 'A BATTERY IS LIKE A JACUZZI',
    hint: 'Say “…because” and finish the thought out loud.',
    how: ['Two random things appear in a sentence, like “A BATTERY IS LIKE A JACUZZI”.', 'Start talking straight away: say “because…” and give any reason that comes to mind.', 'Keep going until the buzzer. Silly answers are welcome. Silence is the only way to lose.'] },
  { id: 'hottake', icon: '🔥', name: 'Hot Take', blurb: 'Pick a side in one breath and defend it.', lead: 'Agree or disagree', tail: 'AGREE OR DISAGREE, AND WHY?', example: 'Homework should be banned.',
    hint: 'Pick a side now, then give one reason.',
    how: ['A bold statement appears, like “Homework should be banned.”', 'Pick a side at once: “I agree because…” or “I disagree because…”.', 'Give a reason, then keep talking until the buzzer. Either side scores the same.'] },
  { id: 'sellit', icon: '🎤', name: 'Sell It', blurb: 'A strange product appears. Pitch it out loud like a salesperson.', lead: 'Pitch this now', tail: 'SELL IT IN ONE BREATH!', example: 'A pen that never runs out',
    hint: 'Say what it is, who needs it, and why it is amazing.',
    how: ['A strange product appears, like “A pen that never runs out”.', 'Start pitching immediately, as if you were selling it to a stranger: say what it is, who needs it and why it is amazing.', 'Keep selling until the buzzer. Big claims and silly details are the whole point.'] },
  { id: 'mix', icon: '🎲', name: 'Wild Mix', blurb: 'All three, shuffled. You never know what is next.', lead: '', tail: '', example: 'Anything can come next',
    hint: '',
    how: ['Every prompt is a surprise: an analogy, a hot take or a product to sell.', 'The small label above the prompt tells you which one it is.', 'Start talking at once and keep going until the buzzer.'] }
];
export const modeById = id => MODES.find(mode => mode.id === id) || MODES[0];

export const HOT_TAKES = [
  'Homework should be banned.', 'Cities beat small towns.', 'Breakfast is the best meal of the day.', 'Remote work beats the office.',
  'Social media does more harm than good.', 'Everyone should learn to cook.', 'Books are better than movies.', 'Mornings beat evenings.',
  'Cash will disappear within ten years.', 'School should start later.', 'Video games are a real sport.', 'Tipping should be abolished.',
  'You should never text and drive.', 'Pineapple belongs on pizza.', 'Public speaking should be taught from age six.', 'Failure is the best teacher.',
  'Summer is better than winter.', 'Dogs make better pets than cats.', 'Every student should travel abroad.', 'Phones should be banned in class.',
  'A four-day work week is the future.', 'First impressions are usually right.', 'It is better to be early than on time.', 'Money can buy happiness.',
  'Handwriting is a dying skill worth saving.', 'Silence is more powerful than words.', 'Teachers deserve higher pay than doctors.', 'Self-driving cars will make roads safer.',
  'Reality TV is harmless fun.', 'Everyone should speak two languages.', 'Standing desks are a fad.', 'Old music beats new music.',
  'Cheating a little is sometimes fine.', 'Zoo animals are better off than wild ones.', 'The customer is not always right.', 'Taking a gap year is smart.',
  'Exams measure the wrong things.', 'Leaders are made, not born.', 'Fast food should carry a health warning.', 'Learning never stops after school.'
];

export const PITCHES = [
  'A pen that never runs out', 'An umbrella for the sun', 'Shoes that tie themselves', 'A mirror that only tells the truth',
  'A backpack that carries itself', 'Socks that never get lost', 'A clock that runs backwards', 'A fridge that orders groceries',
  'A pillow that cancels noise', 'A bicycle that folds into a wallet', 'Glasses that translate any language', 'A spoon that cools soup',
  'A lamp powered by compliments', 'A bed that makes itself', 'A water bottle that sings', 'A hat that finds your keys',
  'A wallet that stops you overspending', 'A door that only opens for good news', 'A coffee mug that never goes cold', 'A notebook that writes back',
  'A treadmill for your brain', 'A phone that rings only for good news', 'A microphone that removes nerves', 'A chair that fixes your posture',
  'A suitcase that never gets heavy', 'A calendar that adds free time', 'A toothbrush for the whole family', 'A plant that tells jokes',
  'A jacket for every season', 'A map of the best day ever', 'A robot that returns emails', 'A cloud you can sit on',
  'Boots that make walking fun', 'A bookmark that remembers where you stopped', 'A flashlight that finds lost ideas', 'A bakery on wheels',
  'A radio that plays your mood', 'A time machine for lunch breaks', 'A gym membership for confidence', 'A candle that smells like success'
];

export function analogyText(first, second) {
  const part = ([word, article]) => (article ? `${article} ${word}` : word);
  return `${part(first)} ${first[2] ? 'ARE' : 'IS'} LIKE ${part(second)}`;
}

function pick(list, rng, used) {
  for (let tries = 0; tries < 40; tries++) {
    const index = Math.floor(rng() * list.length);
    if (!used.has(index)) { used.add(index); return list[index]; }
  }
  return list[Math.floor(rng() * list.length)];
}

// A deck of prompts for one session: no repeats inside a session, shuffled for Wild Mix.
export function makeDeck(modeId, rounds, rng = Math.random) {
  const usedWords = new Set(), usedTakes = new Set(), usedPitches = new Set();
  const single = ['analogy', 'hottake', 'sellit'];
  const deck = [];
  for (let i = 0; i < rounds; i++) {
    const kind = modeId === 'mix' ? single[(i + Math.floor(rng() * 3)) % 3] : modeId;
    const mode = modeById(kind);
    let text;
    if (kind === 'analogy') {
      const first = pick(WORDS, rng, usedWords); let second = pick(WORDS, rng, usedWords);
      if (second === first) second = WORDS[(WORDS.indexOf(first) + 1) % WORDS.length];
      text = analogyText(first, second);
    } else if (kind === 'hottake') text = pick(HOT_TAKES, rng, usedTakes).toUpperCase();
    else text = pick(PITCHES, rng, usedPitches).toUpperCase();
    deck.push({ kind, lead: mode.lead, text, tail: mode.tail });
  }
  return deck;
}

// ---------------------------------------------------------------- settings
export const TIME_OPTIONS = [
  { seconds: 5, label: '5 s', hint: 'Warm-up' }, { seconds: 4, label: '4 s', hint: 'Standard' },
  { seconds: 3, label: '3 s', hint: 'Challenging' }, { seconds: 2, label: '2 s', hint: 'Expert' }
];
export const ROUND_OPTIONS = [
  { rounds: 5, label: '5', hint: 'Quick' }, { rounds: 10, label: '10', hint: 'Standard' },
  { rounds: 15, label: '15', hint: 'Extended' }, { rounds: 20, label: '20', hint: 'Marathon' }
];

// ---------------------------------------------------------------- listening
export const MIN_REACTION_MS = 350;   // nobody reads and answers faster; also hides the game's own chime
const RUN_MS = 180, GAP_MS = 70, FRAME_CAP_MS = 60;

// Room noise from frames that were quiet (dB values). A low quantile stays honest even if someone spoke early.
export function estimateFloorDb(dbs) {
  const clean = dbs.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length < 5) return -65;
  return clamp(clean[Math.floor(clean.length * 0.25)], -85, -45);
}
export const voicedThresholdDb = floorDb => Math.max(floorDb + 9, -56);

// frames: [{ t: ms since the prompt appeared, db }]. Finds when speech began and how much of the rest was spoken.
export function analyseRound(frames, { limitMs, floorDb }) {
  const threshold = voicedThresholdDb(floorDb);
  const usable = frames.filter(frame => frame.t >= MIN_REACTION_MS && frame.t <= limitMs).sort((a, b) => a.t - b.t);
  let runStart = null, lastVoiced = null, onsetMs = null;
  for (const frame of usable) {
    if (frame.db >= threshold) {
      if (runStart === null) runStart = frame.t;
      lastVoiced = frame.t;
      if (lastVoiced - runStart >= RUN_MS) { onsetMs = runStart; break; }
    } else if (runStart !== null && frame.t - lastVoiced > GAP_MS) { runStart = null; }
  }
  if (onsetMs === null) return { onsetMs: null, talkShare: 0, voicedMs: 0 };
  let voicedMs = 0;
  const after = usable.filter(frame => frame.t >= onsetMs);
  after.forEach((frame, index) => {
    if (frame.db < threshold) return;
    const next = after[index + 1];
    voicedMs += Math.min(next ? next.t - frame.t : FRAME_CAP_MS, FRAME_CAP_MS);
  });
  const remaining = limitMs - onsetMs;
  return { onsetMs, voicedMs, talkShare: remaining > 300 ? clamp(voicedMs / remaining, 0, 1) : 1 };
}

// ---------------------------------------------------------------- scoring
export const GRADES = [
  { id: 'lightning', min: 85, label: 'Lightning', icon: '⚡' },
  { id: 'quick', min: 65, label: 'Quick', icon: '🚀' },
  { id: 'steady', min: 35, label: 'Got there', icon: '👍' },
  { id: 'late', min: 1, label: 'Too slow', icon: '🐢' },
  { id: 'miss', min: 0, label: 'Silence', icon: '🫥' }
];
export const gradeOf = points => GRADES.find(grade => points >= grade.min) || GRADES[GRADES.length - 1];
export const COMBO_MIN = 35;         // points that keep a combo alive

export function scoreRound({ onsetMs, talkShare }, limitMs) {
  if (onsetMs === null || onsetMs === undefined) return { points: 0, grade: 'miss' };
  const speed = onsetMs <= 600 ? 80 : clamp(80 - 55 * (onsetMs - 600) / Math.max(1, limitMs - 600), 25, 80);
  const flow = 20 * clamp(talkShare / 0.7, 0, 1);
  const points = Math.round(speed + flow);
  return { points, grade: gradeOf(points).id };
}

// rounds: [{ points, onsetMs, listening }] in order. Practice rounds have points === null.
export function summarize(rounds, { listening, completed = true }) {
  const spoken = rounds.length;
  let combo = 0, longestCombo = 0, xp = 0;
  const reactions = [];
  rounds.forEach(round => {
    if (listening) {
      combo = round.points >= COMBO_MIN ? combo + 1 : 0;
      longestCombo = Math.max(longestCombo, combo);
      xp += Math.round(round.points / 10 * (1 + 0.1 * Math.min(Math.max(combo - 1, 0), 5)));
      if (Number.isFinite(round.onsetMs)) reactions.push(round.onsetMs);
    } else xp += 3;
  });
  const points = rounds.map(round => round.points || 0);
  const score = listening && spoken ? Math.round(points.reduce((sum, value) => sum + value, 0) / spoken) : null;
  const stars = score === null ? 0 : score >= 85 ? 3 : score >= 65 ? 2 : score >= COMBO_MIN ? 1 : 0;
  return {
    listening, completed, rounds: spoken, score, stars, longestCombo,
    answered: listening ? rounds.filter(round => round.points > 0).length : spoken,
    misses: listening ? rounds.filter(round => !(round.points > 0)).length : 0,
    avgReactionMs: reactions.length ? Math.round(reactions.reduce((sum, value) => sum + value, 0) / reactions.length) : null,
    bestReactionMs: reactions.length ? Math.min(...reactions) : null,
    xp, finishBonus: completed ? 10 : 0
  };
}

// ---------------------------------------------------------------- ranks and badges
export const RANKS = [
  { name: 'Rookie', xp: 0, icon: '🌱' }, { name: 'Sprinter', xp: 100, icon: '👟' }, { name: 'Quick Draw', xp: 300, icon: '🤠' },
  { name: 'Lightning', xp: 700, icon: '⚡' }, { name: 'Thunder', xp: 1500, icon: '🌩️' }, { name: 'Mind Reader', xp: 3000, icon: '🧠' }
];
export function rankFor(xp) {
  let index = 0;
  RANKS.forEach((rank, i) => { if (xp >= rank.xp) index = i; });
  const current = RANKS[index], next = RANKS[index + 1] || null;
  return { index, current, next, progress: next ? clamp((xp - current.xp) / (next.xp - current.xp), 0, 1) : 1, toNext: next ? next.xp - xp : 0 };
}

// ctx: { summary, rounds: [{points,onsetMs}], limit (seconds), roundCount, mode, profile (before this session) }
export const BADGES = [
  { id: 'first-blitz', icon: '🏁', name: 'First Blitz', hint: 'Finish a session.', test: ctx => ctx.summary.completed },
  { id: 'lightning-strike', icon: '⚡', name: 'Lightning Strike', hint: 'Start speaking within half a second.', test: ctx => ctx.summary.listening && ctx.summary.bestReactionMs !== null && ctx.summary.bestReactionMs <= 500 },
  { id: 'on-fire', icon: '🔥', name: 'On Fire', hint: 'Answer 5 prompts in a row.', test: ctx => ctx.summary.longestCombo >= 5 },
  { id: 'unstoppable', icon: '🚀', name: 'Unstoppable', hint: 'Answer 10 prompts in a row.', test: ctx => ctx.summary.longestCombo >= 10 },
  { id: 'no-dead-air', icon: '🎙️', name: 'No Dead Air', hint: 'Answer every prompt in a 10+ round session.', test: ctx => ctx.summary.listening && ctx.summary.rounds >= 10 && ctx.summary.misses === 0 },
  { id: 'marathon', icon: '🏃', name: 'Marathon', hint: 'Finish a 20-round session.', test: ctx => ctx.summary.completed && ctx.roundCount >= 20 },
  { id: 'expert-mind', icon: '🧠', name: 'Expert Mind', hint: 'Score 65+ on 2 seconds a round.', test: ctx => ctx.summary.listening && ctx.limit <= 2 && ctx.summary.score >= 65 },
  { id: 'explorer', icon: '🧭', name: 'Mode Explorer', hint: 'Play Analogy Blitz, Hot Take and Sell It.', test: ctx => ['analogy', 'hottake', 'sellit'].every(id => ctx.profile.modesPlayed.includes(id) || ctx.mode === id) }
];

export const newProfile = () => ({ xp: 0, bestScore: 0, bestReactionMs: null, sessions: 0, badges: [], modesPlayed: [], history: [], settings: { mode: 'analogy', limit: 3, rounds: 10, listen: true, muted: false } });

export function normalizeProfile(raw) {
  const base = newProfile();
  if (!raw || typeof raw !== 'object') return base;
  const settings = { ...base.settings, ...(raw.settings || {}) };
  return {
    xp: Math.max(0, Number(raw.xp) || 0), bestScore: clamp(Number(raw.bestScore) || 0, 0, 100),
    bestReactionMs: Number.isFinite(raw.bestReactionMs) ? raw.bestReactionMs : null,
    sessions: Math.max(0, Number(raw.sessions) || 0),
    badges: Array.isArray(raw.badges) ? raw.badges.filter(id => BADGES.some(badge => badge.id === id)) : [],
    modesPlayed: Array.isArray(raw.modesPlayed) ? raw.modesPlayed.filter(id => MODES.some(mode => mode.id === id)) : [],
    history: Array.isArray(raw.history) ? raw.history.slice(-12) : [],
    settings: {
      mode: MODES.some(mode => mode.id === settings.mode) ? settings.mode : 'analogy',
      limit: TIME_OPTIONS.some(option => option.seconds === settings.limit) ? settings.limit : 3,
      rounds: ROUND_OPTIONS.some(option => option.rounds === settings.rounds) ? settings.rounds : 10,
      listen: settings.listen !== false, muted: !!settings.muted
    }
  };
}

// Returns the updated profile plus what was earned this time. Does not touch storage.
export function applyResult(profile, ctx, now = Date.now()) {
  const before = normalizeProfile(profile);
  const { summary } = ctx;
  const gained = summary.xp + summary.finishBonus;
  const ranksBefore = rankFor(before.xp).index;
  const modesPlayed = ctx.mode === 'mix' ? before.modesPlayed : [...new Set([...before.modesPlayed, ctx.mode])];
  const full = { ...ctx, profile: { ...before, modesPlayed } };
  const earned = BADGES.filter(badge => !before.badges.includes(badge.id) && badge.test(full));
  const after = {
    ...before,
    xp: before.xp + gained,
    sessions: before.sessions + 1,
    bestScore: summary.score === null ? before.bestScore : Math.max(before.bestScore, summary.score),
    bestReactionMs: summary.bestReactionMs === null ? before.bestReactionMs : Math.min(before.bestReactionMs ?? Infinity, summary.bestReactionMs),
    badges: [...before.badges, ...earned.map(badge => badge.id)],
    modesPlayed,
    history: [...before.history, { at: now, mode: ctx.mode, score: summary.score, stars: summary.stars, avgReactionMs: summary.avgReactionMs, rounds: summary.rounds, limit: ctx.limit }].slice(-12)
  };
  return { profile: after, gained, earned, rankedUp: rankFor(after.xp).index > ranksBefore, newBest: summary.score !== null && summary.score > before.bestScore && before.sessions > 0 };
}

export function coachingTip(summary, limit) {
  if (!summary.listening) return 'Switch on “Hear me” and the game times how fast you start speaking, so you can watch your reaction time shrink.';
  if (!summary.rounds) return 'Start a session and say the first word that comes to mind.';
  if (summary.misses >= Math.ceil(summary.rounds * 0.3)) return 'Open with a sound, any sound: “Because…”, “Well…” or “Imagine…”. Starting out loud beats waiting for the perfect line.';
  if (summary.avgReactionMs !== null && summary.avgReactionMs > limit * 1000 * 0.6) return 'You get there, just late. Say the first word of the prompt out loud the moment it appears, then let the rest follow.';
  if (summary.score >= 85) return `That is razor sharp. Raise the difficulty: ${limit > 2 ? 'drop to ' + (limit - 1) + ' seconds a round' : 'try Wild Mix with 20 rounds'}.`;
  if (summary.score >= 65) return 'Quick and steady. Keep talking until the buzzer: the last half of each round is where the extra points are.';
  return 'Good start. Aim to begin before you feel ready; your first sentence does not need to be clever.';
}

export const CUES = [
  'Speak before thinking. No wrong answers.', 'Your first thought is good enough.', 'Trust your instincts. Say it out loud.',
  'No pausing. Just speak.', 'Faster than your doubts. Go!', 'Speed beats perfection here.', 'Your brain is faster than you think.',
  'Start talking and the idea will catch up.'
];
