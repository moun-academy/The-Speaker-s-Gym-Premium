// Rules for the Vocal Variety Arena. Pure functions only: no DOM, no microphone.
// Everything here is browser-only practice. It never feeds the app's AI coaching scores.
import { quantile } from './vocal-variety-core.js';

export const FRAME_DT = 0.05;       // one stored frame every 50 ms
export const SOFT_EDGE = 0.28;      // below this level the voice is in the soft zone
export const STRONG_EDGE = 0.72;    // above this level the voice is in the strong zone
export const BAND = 0.2;            // distance from the ribbon centre that still counts as a hit
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export const ZONES = {
  soft: { id: 'soft', label: 'Whisper', color: '#a78bfa' },
  natural: { id: 'natural', label: 'Steady', color: '#2dd4bf' },
  strong: { id: 'strong', label: 'Boom', color: '#fbbf24' }
};
export const ZONE_ORDER = ['soft', 'natural', 'strong'];
export const zoneOf = level => level < SOFT_EDGE ? 'soft' : level > STRONG_EDGE ? 'strong' : 'natural';

// ---- The personal volume scale -------------------------------------------------
// Microphones differ, so levels are relative to the player's own whisper, natural voice
// and power voice (measured in "Find your range"): whisper = 0, natural = 0.5, power = 1.
export const DEFAULT_SCALE = Object.freeze({ floor: -66, soft: -50, natural: -33, power: -19 });

export function normalizeScale(raw = {}) {
  const pick = (value, fallback) => Number.isFinite(value) ? value : fallback;
  let floor = pick(raw.floor, DEFAULT_SCALE.floor), soft = pick(raw.soft, DEFAULT_SCALE.soft);
  let natural = pick(raw.natural, DEFAULT_SCALE.natural), power = pick(raw.power, DEFAULT_SCALE.power);
  let widened = false;
  if (natural - soft < 6) { soft = natural - 8; widened = true; }
  if (power - natural < 6) { power = natural + 10; widened = true; }
  if (soft - floor < 6) floor = soft - 6;
  return { floor, soft, natural, power, span: power - soft, widened };
}

export function levelOf(db, scale) {
  if (!Number.isFinite(db)) return null;
  const level = db <= scale.natural
    ? (db - scale.soft) / (scale.natural - scale.soft) * 0.5
    : 0.5 + (db - scale.natural) / (scale.power - scale.natural) * 0.5;
  return clamp(level, -0.3, 1.3);
}

export const activeThreshold = scale => scale.floor + Math.max(4, (scale.soft - scale.floor) * 0.4);
export const relativeDb = (db, scale) => db - scale.natural;

// Frames are dB readings (20 * log10 rms) captured during the "Find your range" steps.
export function scaleFromCalibration({ silence = [], whisper = [], normal = [], power = [] }) {
  const floor = quantile(silence, 0.9);
  const gate = (Number.isFinite(floor) ? floor : DEFAULT_SCALE.floor) + 5;
  const heard = frames => frames.filter(db => Number.isFinite(db) && db > gate);
  const soft = heard(whisper), natural = heard(normal), strong = heard(power);
  return {
    heard: { whisper: soft.length, normal: natural.length, power: strong.length },
    scale: normalizeScale({ floor: floor ?? undefined, soft: quantile(soft, 0.5) ?? undefined, natural: quantile(natural, 0.5) ?? undefined, power: quantile(strong, 0.8) ?? undefined })
  };
}

// Peak-hold envelope. Syllable dips inside a word should not look like a drop in energy,
// but a real pause should leave a gap.
export class EnvelopeTracker {
  constructor(scale) { this.scale = scale; this.reset(); }
  reset() { this.env = null; this.lastT = null; this.lastActive = -Infinity; }
  push(t, db) {
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const raw = levelOf(db, this.scale), active = db > activeThreshold(this.scale);
    if (active) {
      this.lastActive = t;
      this.env = this.env === null ? raw : Math.max(raw, this.env - 1.5 * dt);
    } else if (t - this.lastActive > 0.35) {
      this.env = null;                       // a real pause: the next word starts fresh
    }
    return { level: this.env, raw, active };
  }
}

// ---- Rounds ----------------------------------------------------------------------
const smooth = s => s * s * (3 - 2 * s);
export function targetAt(plan, t) {
  const keys = plan.keys;
  if (!keys?.length) return null;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
    }
  }
  return keys.at(-1)[1];
}
export const phaseAt = (plan, t) => plan.phases.find(phase => t >= phase.from && t < phase.to) || plan.phases.at(-1);

const phase = (from, to, label, icon, cue) => ({ from, to, label, icon, cue });

export const STAGES = [
  {
    id: 'whisper-boom', n: 1, kind: 'guided', title: 'Whisper to Boom', tagline: 'Pull them in. Then let it ring.',
    icon: '◌',
    plan: {
      duration: 30, goalSwings: 3,
      keys: [[0, 0.16], [8, 0.16], [11.5, 0.8], [21, 0.8], [24.5, 0.18], [30, 0.18]],
      phases: [
        phase(0, 9.5, 'Whisper it', '◌', 'Lean in. Make them come closer.'),
        phase(9.5, 22.5, 'Boom!', '↗', 'Lift it. Fill the room, comfortably.'),
        phase(22.5, 30, 'Land softly', '↘', 'Settle down. Let the last idea breathe.')
      ]
    },
    questions: [
      'Describe a moment that completely surprised you.',
      'What is the best news you have ever received?',
      'Tell us about a time you almost gave up, and did not.',
      'What is something you wish more people understood?'
    ]
  },
  {
    id: 'staircase', n: 2, kind: 'guided', title: 'The Staircase', tagline: 'Four steps. Each one louder.',
    icon: '▤',
    plan: {
      duration: 30, goalSwings: 2,
      keys: [[0, 0.18], [7, 0.18], [8.5, 0.5], [15, 0.5], [16.5, 0.78], [24, 0.78], [25.5, 0.9], [30, 0.9]],
      phases: [
        phase(0, 7.75, 'Quiet start', '◌', 'Begin gently. Plant your first idea.'),
        phase(7.75, 15.75, 'Steady voice', '〰', 'Speak like you are talking to a friend.'),
        phase(15.75, 24.75, 'Strong', '↗', 'Add energy. Mean every word.'),
        phase(24.75, 30, 'Peak', '✦', 'Finish on your strongest line.')
      ]
    },
    questions: [
      'Why does your biggest goal matter to you?',
      'What would change if everyone on your team spoke with more confidence?',
      'Convince us to try something new this week.',
      'What does success mean to you?'
    ]
  },
  {
    id: 'pulse', n: 3, kind: 'guided', title: 'The Pulse', tagline: 'Punch. Hush. Punch. Hush.',
    icon: '◖◗',
    plan: {
      duration: 36, goalSwings: 6,
      keys: [[0, 0.78], [5, 0.78], [6.2, 0.18], [11, 0.18], [12.2, 0.8], [17, 0.8], [18.2, 0.2], [23, 0.2], [24.2, 0.82], [30, 0.82], [31.2, 0.5], [36, 0.5]],
      phases: [
        phase(0, 5.6, 'Punch', '↗', 'Hit your point with energy.'),
        phase(5.6, 11.6, 'Hush', '◌', 'Drop the volume. Let them lean in.'),
        phase(11.6, 17.6, 'Punch', '↗', 'Back up. Own the room.'),
        phase(17.6, 23.6, 'Hush', '◌', 'Softer again. Make it a secret.'),
        phase(23.6, 30.6, 'Punch', '↗', 'Your biggest one yet.'),
        phase(30.6, 36, 'Steady close', '〰', 'Come back to your natural voice.')
      ]
    },
    questions: [
      'Sell us your favourite book, film, or place in 30 seconds.',
      'Argue for or against: mornings are the best part of the day.',
      'Explain what you do to someone who has never heard of it.',
      'Pitch a startup idea for a problem you face every day.'
    ]
  },
  {
    id: 'story-arc', n: 4, kind: 'guided', title: 'The Story Arc', tagline: 'Hook, build, peak, land.',
    icon: '⌒',
    plan: {
      duration: 36, goalSwings: 4,
      keys: [[0, 0.18], [7, 0.2], [15, 0.55], [21, 0.85], [27, 0.85], [31, 0.4], [36, 0.3]],
      phases: [
        phase(0, 8, 'The hook', '◌', 'Open quietly and pull us in.'),
        phase(8, 21, 'The build', '↗', 'Climb with the story. Speed up. Grow.'),
        phase(21, 27.5, 'The peak', '✦', 'This is the moment. Own it.'),
        phase(27.5, 36, 'The landing', '↘', 'Come down slowly. Leave us with a thought.')
      ]
    },
    questions: [
      'Tell the story of the best day of your life so far.',
      'Describe a challenge you overcame.',
      'Tell us about a person who changed how you see the world.',
      'Describe a place you could return to a thousand times.'
    ]
  },
  {
    id: 'freestyle', n: 5, kind: 'free', title: 'Freestyle Boss', tagline: 'No ribbon. Just you and the zones.',
    icon: '✺',
    plan: {
      duration: 45, goalSwings: 5,
      phases: [
        phase(0, 15, 'Open', '◌', 'Start anywhere. Make one deliberate change.'),
        phase(15, 30, 'Explore', '〰', 'Visit every zone at least once.'),
        phase(30, 45, 'Finish', '✦', 'Land your boldest moment.')
      ]
    },
    questions: [
      'If you could give one speech to the whole world, what would it say?',
      'Describe the future you are building, as if it already happened.',
      'What would you say to someone about to give up on their dream?',
      'Tell us about the moment you decided to become a better speaker.'
    ]
  }
];
export const stageById = id => STAGES.find(stage => stage.id === id);

// ---- Scoring -----------------------------------------------------------------------
const STAR_CUTS = { guided: [55, 72, 88], free: [50, 68, 85] };
export const starsFor = (score, kind) => STAR_CUTS[kind].filter(cut => score >= cut).length;

// Counts zone changes. A jump from whisper to boom counts as two swings.
// Short dips are ignored (dwell) and edges have hysteresis so a wobble on a border is not a swing.
export function countSwings(frames, dwell = 0.4) {
  const hysteresis = 0.04;
  let current = null, candidate = null, since = 0, swings = 0;
  const moments = [];
  const classify = level => {
    const soft = SOFT_EDGE + (current === 'soft' ? hysteresis : current === 'natural' ? -hysteresis : 0);
    const strong = STRONG_EDGE + (current === 'natural' ? hysteresis : current === 'strong' ? -hysteresis : 0);
    return level < soft ? 'soft' : level > strong ? 'strong' : 'natural';
  };
  for (const frame of frames) {
    if (!Number.isFinite(frame.level)) continue;
    const zone = classify(frame.level);
    if (current === null) { current = zone; candidate = zone; since = frame.t; continue; }
    if (zone === current) { candidate = zone; since = frame.t; continue; }
    if (zone !== candidate) { candidate = zone; since = frame.t; continue; }
    if (frame.t - since >= dwell) {
      const jump = Math.abs(ZONE_ORDER.indexOf(zone) - ZONE_ORDER.indexOf(current));
      swings += jump;
      moments.push({ t: since, from: current, to: zone, jump });
      current = zone;
    }
  }
  return { swings, moments };
}

export function scoreRound({ frames, stage, scale }) {
  const plan = stage.plan, guided = stage.kind === 'guided';
  const elapsed = Math.max(FRAME_DT, frames.at(-1)?.t ?? 0);
  const shown = frames.filter(frame => Number.isFinite(frame.level));
  const activeFrames = frames.filter(frame => frame.active);
  const activeFraction = frames.length ? shown.length / frames.length : 0;
  const coverage = clamp(activeFraction / 0.5, 0, 1);
  const completion = clamp(elapsed / (plan.duration * 0.8), 0, 1);

  const levels = shown.map(frame => frame.level);
  const lo = quantile(levels, 0.1) ?? 0, hi = quantile(levels, 0.9) ?? 0;
  const dbs = activeFrames.map(frame => frame.db);
  const rangeDb = dbs.length >= 10 ? quantile(dbs, 0.9) - quantile(dbs, 0.1) : 0;
  const rangeScore = clamp((hi - lo) / 0.7, 0, 1);

  const seconds = { soft: 0, natural: 0, strong: 0 };
  for (const frame of shown) seconds[zoneOf(frame.level)] += FRAME_DT;
  const shownSeconds = shown.length * FRAME_DT || 1;
  const shares = { soft: seconds.soft / shownSeconds, natural: seconds.natural / shownSeconds, strong: seconds.strong / shownSeconds };
  const balance = (Math.min(1, shares.soft / 0.15) + Math.min(1, shares.natural / 0.25) + Math.min(1, shares.strong / 0.15)) / 3;

  const { swings, moments } = countSwings(frames);
  const swingGoal = plan.goalSwings;
  const swingScore = clamp(swings / swingGoal, 0, 1);
  const varietyFraction = 0.45 * rangeScore + 0.35 * swingScore + 0.2 * balance;

  let match = null, bestStreak = 0;
  if (guided) {
    let run = 0, credit = 0;
    for (const frame of shown) {
      const distance = Math.abs(frame.level - targetAt(plan, frame.t));
      const value = distance <= BAND ? 1 : Math.max(0, 1 - (distance - BAND) / 0.25);
      credit += value;
      run = value === 1 ? run + FRAME_DT : 0;
      bestStreak = Math.max(bestStreak, run);
    }
    match = shown.length ? credit / shown.length : 0;
  }
  const base = guided ? 0.7 * match + 0.3 * varietyFraction : varietyFraction;
  const score = Math.round(100 * clamp(base * coverage * completion, 0, 1));

  const peakFrame = shown.reduce((best, frame) => !best || frame.level > best.level ? frame : best, null);
  const lowFrame = activeFrames.filter(frame => Number.isFinite(frame.level)).reduce((best, frame) => !best || frame.level < best.level ? frame : best, null);
  const goals = guided
    ? [
      { id: 'match', label: 'Follow the ribbon', detail: `${Math.round(match * 100)}% of 70%`, done: match >= 0.7 },
      { id: 'swings', label: `${swingGoal} swings`, detail: `${swings} of ${swingGoal}`, done: swings >= swingGoal },
      { id: 'flow', label: 'Keep talking', detail: `${Math.round(activeFraction * 100)}% of 60%`, done: activeFraction >= 0.6 }
    ]
    : [
      { id: 'whisper', label: 'Find a whisper', detail: `${seconds.soft.toFixed(1)}s of 1.2s`, done: seconds.soft >= 1.2 },
      { id: 'boom', label: 'Hit a boom', detail: `${seconds.strong.toFixed(1)}s of 1.2s`, done: seconds.strong >= 1.2 },
      { id: 'swings', label: `${swingGoal} swings`, detail: `${swings} of ${swingGoal}`, done: swings >= swingGoal },
      { id: 'flow', label: 'Keep talking', detail: `${Math.round(activeFraction * 100)}% of 60%`, done: activeFraction >= 0.6 }
    ];

  return {
    score, stars: starsFor(score, stage.kind), kind: stage.kind,
    match, varietyScore: Math.round(100 * varietyFraction), coverage, activeFraction, completion, elapsed,
    rangeDb, rangeLevel: hi - lo, lo, hi, shares, seconds, balance,
    swings, swingGoal, swingMoments: moments, bestStreak,
    peak: peakFrame && { t: peakFrame.t, level: peakFrame.level, rel: relativeDb(peakFrame.db, scale) },
    low: lowFrame && { t: lowFrame.t, level: lowFrame.level, rel: relativeDb(lowFrame.db, scale) },
    goals
  };
}

export function rangeLabel(rangeDb) {
  return rangeDb < 6 ? 'Flat' : rangeDb < 12 ? 'Gentle' : rangeDb < 20 ? 'Dynamic' : 'Electric';
}

export function coachingTip(result) {
  if (result.activeFraction < 0.3) return 'We barely heard you. Move a little closer to the microphone, keep it still, and keep talking: pauses are powerful, but we need the voice too.';
  if (result.activeFraction < 0.5) return 'Great pauses, but you were silent for more than half the round. Keep one idea flowing into the next and let the volume do the changing.';
  if (result.shares.strong < 0.08) return 'Your Boom zone is still untouched. Choose one word per sentence and give it real energy. Keep it comfortable, never strained.';
  if (result.shares.soft < 0.08) return 'You stayed out of the Whisper zone. Try getting softer on purpose before your biggest point. Quiet makes people lean in.';
  if (result.swings < result.swingGoal) return 'You stayed in one gear for long stretches. Change zones at the start of a new idea, not in the middle of a word.';
  if (result.kind === 'guided' && result.match < 0.6) return 'Watch the glowing ribbon a little earlier. Start changing volume as the ribbon turns, not after it has passed.';
  if (result.kind === 'guided' && result.match < 0.85) return 'Strong contrast. To tighten up, change volume on a sentence boundary and hold it until the ribbon moves.';
  return 'That is real vocal variety: clear zones, confident changes, and a voice that never gets stuck. Try a new question to keep it fresh.';
}

// ---- Progress, ranks, badges -----------------------------------------------------------
export const RANKS = [
  { name: 'Murmur', xp: 0 }, { name: 'Speaker', xp: 80 }, { name: 'Storyteller', xp: 220 },
  { name: 'Orator', xp: 450 }, { name: 'Voice Master', xp: 800 }, { name: 'Legend', xp: 1300 }
];
export function rankFor(xp) {
  let index = 0;
  RANKS.forEach((rank, i) => { if (xp >= rank.xp) index = i; });
  const current = RANKS[index], next = RANKS[index + 1] || null;
  const span = next ? next.xp - current.xp : 1, into = next ? xp - current.xp : 1;
  return { index, name: current.name, nextName: next?.name || null, into, span, toNext: next ? next.xp - xp : 0, pct: next ? clamp(into / span, 0, 1) : 1 };
}

export const emptyProgress = () => ({ v: 1, xp: 0, rounds: 0, stars: {}, best: {}, badges: {}, streak: { count: 0, last: null }, seen: {}, tuned: false });

export function sanitizeProgress(raw) {
  const base = emptyProgress();
  if (!raw || typeof raw !== 'object') return base;
  const number = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
  const table = (value, valid) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([, v]) => valid(v)));
  return {
    v: 1, xp: number(raw.xp), rounds: number(raw.rounds),
    stars: table(raw.stars, v => Number.isInteger(v) && v >= 0 && v <= 3),
    best: table(raw.best, v => Number.isFinite(v) && v >= 0 && v <= 100),
    badges: table(raw.badges, v => typeof v === 'string'),
    streak: { count: number(raw.streak?.count), last: typeof raw.streak?.last === 'string' ? raw.streak.last : null },
    seen: table(raw.seen, v => Number.isInteger(v) && v >= 0),
    tuned: raw.tuned === true
  };
}

export const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function nextStreak(streak, now) {
  const today = dayKey(now);
  if (streak.last === today) return { ...streak };
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return { count: streak.last === dayKey(yesterday) ? streak.count + 1 : 1, last: today };
}

export const isUnlocked = (progress, stage) => stage.n === 1 || (progress.stars[STAGES[stage.n - 2].id] || 0) >= 1;

export const BADGES = [
  { id: 'tuned', name: 'Tuned In', icon: '🎚️', desc: 'Find your range for the first time.', earned: ctx => ctx.progress.tuned },
  { id: 'whisper', name: 'First Whisper', icon: '◌', desc: 'Spend 2 seconds in the Whisper zone.', earned: ctx => ctx.result && ctx.result.seconds.soft >= 2 },
  { id: 'boom', name: 'Boom!', icon: '💥', desc: 'Spend 2 seconds in the Boom zone.', earned: ctx => ctx.result && ctx.result.seconds.strong >= 2 },
  { id: 'range', name: 'Wide Range', icon: '↕', desc: 'Show a 20 dB range in one take.', earned: ctx => ctx.result && ctx.result.rangeDb >= 20 },
  { id: 'swing', name: 'Swing King', icon: '🎢', desc: 'Make 8 swings between zones.', earned: ctx => ctx.result && ctx.result.swings >= 8 },
  { id: 'ribbon', name: 'On the Ribbon', icon: '🎯', desc: 'Match the ribbon 90% or better.', earned: ctx => ctx.result && ctx.result.match !== null && ctx.result.match >= 0.9 },
  { id: 'trio', name: 'Triple Star', icon: '⭐', desc: 'Earn three stars on any round.', earned: ctx => ctx.result && ctx.result.stars === 3 },
  { id: 'spark', name: '3 Day Spark', icon: '🔥', desc: 'Practice three days in a row.', earned: ctx => ctx.progress.streak.count >= 3 },
  { id: 'journey', name: 'Full Journey', icon: '🏁', desc: 'Earn a star on every stage.', earned: ctx => STAGES.every(stage => (ctx.progress.stars[stage.id] || 0) >= 1) }
];

function awardBadges(progress, ctx, now) {
  const fresh = [];
  for (const badge of BADGES) {
    if (progress.badges[badge.id] || !badge.earned({ ...ctx, progress })) continue;
    progress.badges[badge.id] = dayKey(now);
    fresh.push(badge);
  }
  return fresh;
}

export function applyTune(progress, now = new Date()) {
  const base = sanitizeProgress(progress);
  const next = { ...base, badges: { ...base.badges }, streak: nextStreak(base.streak, now) };
  const gained = next.tuned ? 5 : 20;
  next.xp += gained; next.tuned = true;
  const badges = awardBadges(next, {}, now);
  return { progress: next, xpGained: gained, newBadges: badges, rank: rankFor(next.xp) };
}

// `questionIndex` is the question that was just played; `seen[stage]` stores the next one to offer.
export function applyRound(progress, stage, result, now = new Date(), questionIndex = null) {
  const before = sanitizeProgress(progress);
  const next = { ...before, stars: { ...before.stars }, best: { ...before.best }, badges: { ...before.badges }, seen: { ...before.seen } };
  const previousStars = next.stars[stage.id] || 0, previousBest = next.best[stage.id] || 0;
  const firstClear = previousStars === 0 && result.stars >= 1;
  const personalBest = result.score > previousBest;
  const goalXp = result.goals.filter(goal => goal.done).length * 4;
  const xpGained = 10 + result.stars * 12 + Math.round(result.score * 0.4) + goalXp + (firstClear ? 25 : 0) + (personalBest && previousBest > 0 ? 5 : 0);
  next.xp = before.xp + xpGained;
  next.rounds = before.rounds + 1;
  next.stars[stage.id] = Math.max(previousStars, result.stars);
  next.best[stage.id] = Math.max(previousBest, result.score);
  next.seen[stage.id] = ((questionIndex ?? before.seen[stage.id] ?? 0) + 1) % stage.questions.length;
  next.streak = nextStreak(before.streak, now);
  const newBadges = awardBadges(next, { stage, result }, now);
  return {
    progress: next, xpGained, firstClear, personalBest, newBadges,
    rankBefore: rankFor(before.xp), rank: rankFor(next.xp),
    unlockedNext: firstClear ? STAGES[stage.n] || null : null
  };
}
