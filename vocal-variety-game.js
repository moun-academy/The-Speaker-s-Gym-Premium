// Rules for the Vocal Variety Arena. Pure functions only: no DOM, no microphone.
// Every round is a PREP answer (Point, Reason, Example, Final Point) spoken with vocal variety
// in one of three dimensions: volume, pitch or pace (or all three together).
// Everything here is browser-only practice. It never feeds the app's AI coaching scores.
import { quantile, PitchSmoother, noteName } from './vocal-variety-core.js';

export const FRAME_DT = 0.05;       // one stored frame every 50 ms
export const SOFT_EDGE = 0.28;      // below this level: the low zone (whisper / low / slow)
export const STRONG_EDGE = 0.72;    // above this level: the high zone (boom / high / fast)
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

// Each dimension maps its measurement to the same 0..1 "level", so one engine scores them all.
// `band` is how far from the ribbon still counts as a hit. `lag` is kept at 0: pace readings arrive
// a few seconds late while speech is being transcribed, but each reading is filed under the moment
// the words were spoken, so scoring needs no allowance.
export const DIMENSIONS = {
  volume: { id: 'volume', name: 'Volume', zones: { soft: 'Whisper', natural: 'Steady', strong: 'Boom' }, hints: null, band: 0.2, lag: 0 },
  pitch: { id: 'pitch', name: 'Pitch', zones: { soft: 'Low', natural: 'Mid', strong: 'High' }, hints: null, band: 0.22, lag: 0.3 },
  pace: { id: 'pace', name: 'Pace', zones: { soft: 'Slow', natural: 'Steady', strong: 'Fast' }, hints: { soft: 'under 110 words a minute', natural: '110 to 139 words a minute', strong: '140 words a minute or more' }, band: 0.2, lag: 0 }
};
export const DIM_ORDER = ['volume', 'pitch', 'pace'];
export const ZONE_ORDER = ['soft', 'natural', 'strong'];
export const zoneOf = level => level < SOFT_EDGE ? 'soft' : level > STRONG_EDGE ? 'strong' : 'natural';
export const zoneLabel = (dim, zone) => DIMENSIONS[dim].zones[zone];
export const zoneHint = (dim, zone) => DIMENSIONS[dim].hints?.[zone] || '';

// ---- Zones that fit every voice, with no tuning -------------------------------------------
// Nobody is asked to whisper or shout. Zones hang off one number per speaker, their typical speech
// level (dBFS): it starts at a typical value, moves to this speaker during the sound check before a
// round ("say a few words"), and carries on from student to student, which also covers a microphone
// that is louder or quieter than usual and the levelling a video call applies. Whisper is more than
// about 6 dB under that level and Boom more than about 5 dB over it.
//   Volume: whisper-ish = 0, typical = 0.5, loud = 1.
//   Pitch:  the speaker's own median note is 0.5; six semitones up is 1, six down is 0.
//   Pace:   absolute words per minute (see paceLevel), the same for every speaker.
export const DEFAULT_NATURAL = -33;
export const DEFAULT_SCALE = Object.freeze({ floor: -59, soft: -47, natural: -33, power: -22 });

export function normalizeScale(raw = {}) {
  const pick = (value, fallback) => Number.isFinite(value) ? value : fallback;
  let floor = pick(raw.floor, DEFAULT_SCALE.floor), soft = pick(raw.soft, DEFAULT_SCALE.soft);
  let natural = pick(raw.natural, DEFAULT_SCALE.natural), power = pick(raw.power, DEFAULT_SCALE.power);
  let widened = false;
  if (natural - soft < 6) { soft = natural - 8; widened = true; }
  if (power - natural < 6) { power = natural + 10; widened = true; }
  if (soft - floor < 6) floor = soft - 6;
  const pitchCenter = Number.isFinite(raw.pitchCenter) && raw.pitchCenter >= 30 && raw.pitchCenter <= 90 ? raw.pitchCenter : null;
  const noiseFloor = Number.isFinite(raw.noiseFloor) ? raw.noiseFloor : null;
  return { floor, soft, natural, power, span: power - soft, widened, pitchCenter, noiseFloor };
}
export const voiceScale = (natural, pitchCenter = null, noiseFloor = null) => {
  const n = clamp(Number.isFinite(natural) ? natural : DEFAULT_NATURAL, -55, -6);
  return normalizeScale({ floor: n - 26, soft: n - 14, natural: n, power: n + 11, pitchCenter, noiseFloor });
};
// Only pitched speech teaches the sound check. Planning in silence or a steady room-noise
// signal must not move the middle of the volume scale down to the background level.
export class VoiceCalibration {
  constructor() { this.frames = []; }
  push(db, midi) {
    this.frames.push({ db, midi });
    if (this.frames.length > 1200) this.frames.shift();
    return this.result();
  }
  result() {
    const voiced = this.frames.filter(f => Number.isFinite(f.midi) && f.db > -65);
    if (voiced.length < 15) return null;
    const levels = voiced.map(f => f.db);
    if (quantile(levels, 0.9) - quantile(levels, 0.1) < 1.5) return null;
    const typical = quantile(voiced.map(f => f.db), 0.65);
    const quiet = this.frames.filter(f => !Number.isFinite(f.midi) && f.db < typical - 8).map(f => f.db);
    const noiseFloor = quiet.length >= 5 ? quantile(quiet, 0.8) : typical - 26;
    const speech = voiced.filter(f => f.db > noiseFloor + 8);
    if (speech.length < 15) return null;
    return { natural: quantile(speech.map(f => f.db), 0.65), noiseFloor, pitchCenter: learnPitchCenter(speech.map(f => f.midi)) };
  }
}
// `dbs` are loudness readings taken while someone talked. Only readings within 25 dB of the loudest
// count (the rest is room noise and gaps between words); under a second of voice changes nothing.
export function learnVoiceLevel(previous, dbs, weight = 0.6) {
  const readings = dbs.filter(Number.isFinite);
  const loud = quantile(readings, 0.95);
  if (loud === null || loud < -70) return previous;
  if (loud - quantile(readings, 0.1) < 2) return previous;
  const voiced = readings.filter(db => db > loud - 12);
  if (voiced.length < 10) return previous;
  const before = Number.isFinite(previous) ? previous : DEFAULT_NATURAL;
  return clamp(before + (quantile(voiced, 0.5) - before) * weight, -55, -15);
}
// The speaker's own natural note from the sound check (median of the notes heard, MIDI number). It is
// never carried from one student to the next: another voice sits somewhere else.
export function learnPitchCenter(midis) {
  const voiced = midis.filter(Number.isFinite);
  return voiced.length >= 15 ? quantile(voiced, 0.5) : null;
}

export function levelOf(db, scale) {
  if (!Number.isFinite(db)) return null;
  const level = db <= scale.natural
    ? (db - scale.soft) / (scale.natural - scale.soft) * 0.5
    : 0.5 + (db - scale.natural) / (scale.power - scale.natural) * 0.5;
  return clamp(level, -0.3, 1.3);
}
// The inverse of levelOf (inside the clamp): the dB value a volume level stands for.
export const dbOfLevel = (level, scale) => level <= 0.5
  ? scale.soft + level / 0.5 * (scale.natural - scale.soft)
  : scale.natural + (level - 0.5) / 0.5 * (scale.power - scale.natural);
export const pitchLevel = (midi, center) => Number.isFinite(midi) && Number.isFinite(center) ? clamp(0.5 + (midi - center) / 12, -0.3, 1.3) : null;

// Pace is absolute words per minute: Slow is under 110, Steady is 110 to 139, Fast is 140 or more.
// The level line is centred on 124.5 (the middle of 110..139) so those whole numbers land exactly
// in the right zones: 109 is Slow, 110 and 139 are Steady, 140 is Fast.
export const WPM_SLOW_BELOW = 110;
export const WPM_FAST_FROM = 140;
const WPM_CENTER = 124.5, WPM_SLOPE = 0.0147;
export const paceLevel = wpm => Number.isFinite(wpm) && wpm >= 0 ? clamp(0.5 + (Math.round(wpm) - WPM_CENTER) * WPM_SLOPE, -0.3, 1.3) : null;
export const wpmOfLevel = level => WPM_CENTER + (level - 0.5) / WPM_SLOPE;
export const paceZoneOfWpm = wpm => wpm < WPM_SLOW_BELOW ? 'soft' : wpm >= WPM_FAST_FROM ? 'strong' : 'natural';
export const activeThreshold = scale => Math.max(
  scale.floor + Math.max(4, (scale.soft - scale.floor) * 0.4),
  Number.isFinite(scale.noiseFloor) ? scale.noiseFloor + 8 : -Infinity
);
export const relativeDb = (db, scale) => db - scale.natural;

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
      // Hold across the valleys between syllables. Fast decay made an unchanged voice
      // jump between zones on every word instead of showing deliberate loud/soft changes.
      this.env = this.env === null ? raw : Math.max(raw, this.env - 0.6 * dt);
    } else if (t - this.lastActive > 0.35) {
      this.env = null;                       // a real pause: the next word starts fresh
    }
    return { level: this.env, raw, active };
  }
}

// Volume and pitch only. Pace must come from recognized words, not acoustic pulse estimates.
export class VoiceTracker {
  constructor(scale) { this.scale = scale; this.reset(); }
  reset() {
    this.envelope = new EnvelopeTracker(this.scale); this.smoother = new PitchSmoother();
    this.history = [];
  }
  push(t, rms, midi) {
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    const env = this.envelope.push(t, db);
    const talking = env.level !== null;
    if (Number.isFinite(midi) && env.active) { this.history.push(midi); if (this.history.length > 600) this.history.shift(); }
    const smooth = this.smoother.push(t, env.active ? midi : null);
    const center = this.scale.pitchCenter ?? (this.history.length >= 15 ? quantile(this.history, 0.5) : null);
    return {
      t, db, active: env.active, volume: env.level,
      midi: talking ? smooth : null, pitch: talking ? pitchLevel(smooth, center) : null, center
    };
  }
}

// ---- PREP and the games ------------------------------------------------------------------
export const PREP_PARTS = [
  { key: 'point', letter: 'P', label: 'Point', ask: 'Answer the question directly.', starters: '“My answer is…” or “I believe…”' },
  { key: 'reason', letter: 'R', label: 'Reason', ask: 'Explain why you think that.', starters: '“The main reason is…” or “This matters because…”' },
  { key: 'example', letter: 'E', label: 'Example', ask: 'Give a specific example, experience or evidence.', starters: '“For example…” or “One time…”' },
  { key: 'finalPoint', letter: 'P', label: 'Final Point', ask: 'Restate your answer and leave one clear takeaway.', starters: '“That is why…” or “The takeaway is…”' }
];
function prepPhases(durations, cues) {
  let from = 0;
  return PREP_PARTS.map((part, i) => {
    const phase = { ...part, from, to: from + durations[i], zone: cues[i][0], cue: cues[i][1] };
    from += durations[i];
    return phase;
  });
}
export function targetAt(plan, t) {
  const keys = plan.keys;
  if (!keys?.length) return null;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i], s = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * s * s * (3 - 2 * s);
    }
  }
  return keys.at(-1)[1];
}
export const phaseAt = (plan, t) => plan.phases.find(phase => t >= phase.from && t < phase.to) || plan.phases.at(-1);

export const STAGES = [
  {
    id: 'volume-ribbon', dim: 'volume', kind: 'guided', title: 'Volume: Loud & Soft',
    what: 'Follow the glowing ribbon. Boom your Point, whisper into your Example, land your Final Point strong.',
    plan: {
      duration: 40, goalSwings: 3,
      keys: [[0, 0.8], [7, 0.8], [8.5, 0.5], [17, 0.5], [18.5, 0.18], [24, 0.2], [30, 0.8], [32, 0.8], [33.5, 0.86], [40, 0.86]],
      phases: prepPhases([8, 10, 14, 8], [['Boom', 'Say your answer with energy.'], ['Steady', 'Explain why in your natural voice.'], ['Whisper → Boom', 'Start the story softly, then build it up.'], ['Boom', 'Land your takeaway strong.']])
    }
  },
  {
    id: 'volume-free', dim: 'volume', kind: 'free', title: 'Volume: Freestyle',
    what: 'No ribbon. Use Whisper, Steady and Boom your own way across your PREP answer.',
    plan: {
      duration: 45, goalSwings: 4,
      phases: prepPhases([9, 11, 15, 10], [['Try Boom', 'Make your point land.'], ['Steady', 'Clear and calm for the reason.'], ['Whisper + Boom', 'Use contrast in the story.'], ['Strong finish', 'Land the takeaway with presence.']])
    }
  },
  {
    id: 'pitch-ribbon', dim: 'pitch', kind: 'guided', title: 'Pitch: High & Low',
    what: 'Follow the ribbon up and down. Lift your Point, paint the Example, let the Final Point fall low and certain.',
    plan: {
      duration: 40, goalSwings: 4,
      keys: [[0, 0.8], [7, 0.8], [8.5, 0.5], [17, 0.5], [18.5, 0.2], [23, 0.2], [24.5, 0.8], [30, 0.8], [31.2, 0.5], [32, 0.5], [33.5, 0.18], [40, 0.18]],
      phases: prepPhases([8, 10, 14, 8], [['High', 'Lift your voice on the key words.'], ['Mid', 'Explain why in your natural melody.'], ['Low → High', 'Paint the story: go low, then lift.'], ['Low', 'Let your pitch fall. Finish low and certain.']])
    }
  },
  {
    id: 'pitch-free', dim: 'pitch', kind: 'free', title: 'Pitch: Freestyle',
    what: 'No ribbon. Use your low, mid and high voice your own way across your PREP answer.',
    plan: {
      duration: 45, goalSwings: 4,
      phases: prepPhases([9, 11, 15, 10], [['Lift', 'Lift the key word of your answer.'], ['Mid', 'Talk it through naturally.'], ['Low + High', 'Use your whole range in the story.'], ['Fall', 'End on a falling, confident note.']])
    }
  },
  {
    id: 'pace-ribbon', dim: 'pace', kind: 'guided', title: 'Pace: Fast, Slow & Pause',
    what: 'Follow the ribbon. Slow for your Point (under 110 words a minute), faster for your Example (140 or more), then pause and slow right down to finish.',
    plan: {
      duration: 40, goalSwings: 3,
      // Levels 0.14, 0.5 and 0.87 are about 100, 125 and 150 words a minute.
      keys: [[0, 0.14], [7, 0.14], [8.5, 0.5], [17, 0.5], [18.5, 0.87], [30, 0.87], [32, 0.14], [40, 0.12]],
      phases: prepPhases([8, 10, 14, 8], [['Slow', 'Under 110 words a minute. Slow and clear, let each word count.'], ['Steady', '110 to 139 words a minute. Explain why at an easy pace.'], ['Fast', '140 words a minute or more. Speed up, the story has energy.'], ['Slow + Pause', 'Pause, then slow right down (under 110) for the takeaway.']])
    }
  },
  {
    id: 'pace-free', dim: 'pace', kind: 'free', title: 'Pace: Freestyle',
    what: 'No ribbon. Change speed and use pauses your own way across your PREP answer.',
    plan: {
      duration: 45, goalSwings: 4,
      phases: prepPhases([9, 11, 15, 10], [['Slow', 'Open slowly (under 110 words a minute). Let it land.'], ['Steady', '110 to 139 words a minute for the reason.'], ['Fast', 'Pick up speed (140 or more) in the story.'], ['Pause', 'Pause, then deliver the takeaway slowly.']])
    }
  },
  {
    id: 'all-three', dim: 'all', kind: 'free', title: 'All Three: Full Vocal Variety',
    what: 'Volume, pitch and pace together in one PREP answer. Two swings in each to win. The final test.',
    plan: {
      duration: 50, goalSwings: 2,
      phases: prepPhases([10, 12, 16, 12], [['Boom + Slow', 'A strong, slow, clear answer.'], ['Steady', 'Natural voice and speed.'], ['Mix it', 'Whisper, lift, speed up: bring the story alive.'], ['Low + Slow', 'Slow down, pitch down, land it.']])
    }
  }
];
export const stageById = id => STAGES.find(stage => stage.id === id);

// ---- Speech length -----------------------------------------------------------------------
// The games are written for about 40 to 50 seconds. A student can pick 1, 1½ or 2 minutes:
// the PREP parts keep their share of the time and the ribbon stretches with them, but the
// ramps right at a PREP boundary keep their length, so a change of voice never gets lazy.
export const SPEECH_LENGTHS = [60, 90, 120];
export const DEFAULT_SPEECH = 120;
export const lengthLabel = seconds => seconds === 60 ? '1 min' : seconds === 90 ? '1½ min' : seconds === 120 ? '2 min' : `${seconds}s`;

export function scaleStage(stage, seconds) {
  const base = stage.plan.duration, k = seconds / base;
  if (!Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-9) return stage;
  const bounds = [0, ...stage.plan.phases.map(phase => phase.to)];
  const scaled = bounds.map(bound => bound === base ? seconds : bound * k);
  const mapTime = t => {
    let nearest = 0;
    bounds.forEach((bound, i) => { if (Math.abs(t - bounds[i]) < Math.abs(t - bounds[nearest])) nearest = i; });
    return Math.abs(t - bounds[nearest]) <= 3 ? scaled[nearest] + (t - bounds[nearest]) : t * k;
  };
  const phases = stage.plan.phases.map((phase, i) => ({ ...phase, from: scaled[i], to: scaled[i + 1] }));
  let keys;
  if (stage.plan.keys) {
    let previous = -Infinity;
    keys = stage.plan.keys.map(([t, value]) => {
      const mapped = Math.max(mapTime(t), previous + 0.05);
      previous = mapped;
      return [Math.min(mapped, seconds), value];
    });
  }
  const goalSwings = Math.max(stage.plan.goalSwings, Math.round(stage.plan.goalSwings * (1 + (k - 1) * 0.5)));
  return { ...stage, plan: { ...stage.plan, duration: seconds, goalSwings, phases, ...(keys ? { keys } : {}) } };
}

// PREP works best with questions that ask for an opinion you can back up with an example.
export const QUESTIONS = [
  'Should every student learn public speaking at school?',
  'What is the most important skill for the future, and why?',
  'Is it better to work from home or from an office?',
  'What makes a great leader?',
  'Should social media have an age limit?',
  'What habit has changed your life the most?',
  'Is failure necessary for success?',
  'What is the best advice you have ever received?',
  'Should young people take a gap year before university?',
  'What makes a great teacher?',
  'Is it better to be a specialist or a generalist?',
  'Which city would you recommend to a first-time visitor, and why?',
  'Should companies move to a four-day work week?',
  'What is one thing you would change about education?',
  'Is it more important to be liked or to be respected?',
  'Which book or film should everyone experience?',
  'Should phones be banned in classrooms?',
  'What does confidence mean to you?',
  'Is it better to plan your life or go with the flow?',
  'What is the most underrated quality in a friend?',
  'Should everyone learn a second language?',
  'Is it better to travel alone or with others?',
  'What is the best way to deal with stress?',
  'Does money make people happier?'
];
// Each game starts at a different place in the list so the games do not all ask the same question.
export const questionIndexFor = (progress, stage) => progress.seen?.[stage.id] ?? (STAGES.indexOf(stage) * 3) % QUESTIONS.length;

// ---- Scoring -----------------------------------------------------------------------
const STAR_CUTS = { guided: [55, 72, 88], free: [50, 68, 85] };
export const starsFor = (score, kind) => STAR_CUTS[kind].filter(cut => score >= cut).length;

// Counts zone changes. A jump from the low zone to the high zone counts as two swings.
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

// 1 inside the ribbon, fading to 0 just outside it. Shared by live scoring and final scoring.
export function ribbonCredit(dim, level, plan, t) {
  const cfg = DIMENSIONS[dim];
  const distance = Math.abs(level - targetAt(plan, Math.max(0, t - cfg.lag)));
  return distance <= cfg.band ? 1 : Math.max(0, 1 - (distance - cfg.band) / 0.15);
}

// Statistics for one dimension of a take. `guided` adds how closely the ribbon was followed.
export function dimensionStats(frames, dim, plan, guided, scale) {
  const cfg = DIMENSIONS[dim];
  const shown = frames.filter(frame => Number.isFinite(frame[dim]));
  const levels = shown.map(frame => frame[dim]);
  const lo = quantile(levels, 0.1) ?? 0, hi = quantile(levels, 0.9) ?? 0;
  const rangeScore = clamp((hi - lo) / 0.7, 0, 1);
  const seconds = { soft: 0, natural: 0, strong: 0 };
  for (const frame of shown) seconds[zoneOf(frame[dim])] += FRAME_DT;
  const total = shown.length * FRAME_DT || 1;
  const shares = { soft: seconds.soft / total, natural: seconds.natural / total, strong: seconds.strong / total };
  const balance = (Math.min(1, shares.soft / 0.15) + Math.min(1, shares.natural / 0.25) + Math.min(1, shares.strong / 0.15)) / 3;
  const { swings, moments } = countSwings(frames.map(frame => ({ t: frame.t, level: Number.isFinite(frame[dim]) ? frame[dim] : null })));
  const swingGoal = plan.goalSwings;
  const varietyFraction = 0.45 * rangeScore + 0.35 * clamp(swings / swingGoal, 0, 1) + 0.2 * balance;

  let match = null, bestStreak = 0;
  if (guided && plan.keys) {
    let run = 0, credit = 0;
    for (const frame of shown) {
      const value = ribbonCredit(dim, frame[dim], plan, frame.t);
      credit += value;
      run = value === 1 ? run + FRAME_DT : 0;
      bestStreak = Math.max(bestStreak, run);
    }
    match = shown.length ? credit / shown.length : 0;
  }

  // The range and the extreme moments, in units a person understands.
  let range;
  const center = dim === 'pitch' ? (scale.pitchCenter ?? quantile(shown.map(f => f.midi), 0.5)) : null;
  if (dim === 'volume') {
    // Measured on the smoothed loudness line, so the dips between syllables of a steady
    // voice do not count as range.
    const value = levels.length >= 10 ? dbOfLevel(hi, scale) - dbOfLevel(lo, scale) : 0;
    range = { value, text: `${value.toFixed(0)} dB` };
  } else if (dim === 'pitch') {
    const midis = shown.map(frame => frame.midi).filter(Number.isFinite);
    const value = midis.length >= 10 ? quantile(midis, 0.9) - quantile(midis, 0.1) : 0;
    range = { value, text: `${value.toFixed(1)} semitones`, low: quantile(midis, 0.1), high: quantile(midis, 0.9) };
  } else {
    const wpms = shown.map(frame => frame.wpm).filter(Number.isFinite);
    const low = quantile(wpms, 0.1), high = quantile(wpms, 0.9);
    const value = wpms.length >= 10 ? high - low : 0;
    range = { value, text: wpms.length >= 10 ? `${Math.round(low)} to ${Math.round(high)} words a minute` : '—', low, high };
  }
  const describe = frame => {
    if (!frame) return null;
    const base = { t: frame.t, level: frame[dim] };
    if (dim === 'volume') {
      const rel = dbOfLevel(frame.volume, scale) - scale.natural;
      return { ...base, rel, text: `${signedNumber(rel)} dB vs the usual level` };
    }
    if (dim === 'pitch') return { ...base, rel: Number.isFinite(center) ? frame.midi - center : 0, text: `${noteName(frame.midi)}, ${signedNumber(Number.isFinite(center) ? frame.midi - center : 0, 1)} semitones vs the usual note` };
    return { ...base, rel: frame.wpm, text: `about ${Math.round(frame.wpm)} words a minute` };
  };
  const peak = shown.reduce((best, frame) => !best || frame[dim] > best[dim] ? frame : best, null);
  const low = shown.filter(frame => frame.active || dim !== 'volume').reduce((best, frame) => !best || frame[dim] < best[dim] ? frame : best, null);
  return {
    dim, samples: shown.length, match, bestStreak, varietyFraction, varietyScore: Math.round(100 * varietyFraction),
    rangeScore, rangeLevel: hi - lo, lo, hi, range, seconds, shares, balance, swings, swingGoal, swingMoments: moments,
    peak: describe(peak), low: describe(low), center
  };
}
const signedNumber = (value, digits = 0) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;

export function scoreRound({ frames, stage, scale }) {
  const plan = stage.plan, guided = stage.kind === 'guided';
  const elapsed = Math.max(FRAME_DT, frames.at(-1)?.t ?? 0);
  const talking = frames.filter(frame => Number.isFinite(frame.volume));
  const activeFraction = frames.length ? talking.length / frames.length : 0;
  const coverage = clamp(activeFraction / 0.5, 0, 1);
  const completion = clamp(elapsed / (plan.duration * 0.8), 0, 1);
  const dims = Object.fromEntries(DIM_ORDER.map(dim => [dim, dimensionStats(frames, dim, plan, guided && dim === stage.dim, scale)]));
  const common = { kind: stage.kind, dim: stage.dim, dims, coverage, activeFraction, completion, elapsed };
  const flow = { id: 'flow', label: 'Keep talking', detail: `${Math.round(activeFraction * 100)}% of 60%`, done: activeFraction >= 0.6 };

  if (stage.dim === 'all') {
    const variety = mean(DIM_ORDER.map(dim => dims[dim].varietyFraction));
    const score = Math.round(100 * clamp(variety * coverage * completion, 0, 1));
    const goals = [...DIM_ORDER.map(dim => ({ id: dim, label: `${DIMENSIONS[dim].name}: ${plan.goalSwings} swings`, detail: `${dims[dim].swings} of ${plan.goalSwings}`, done: dims[dim].swings >= plan.goalSwings })), flow];
    return { ...common, main: null, score, stars: starsFor(score, 'free'), varietyScore: Math.round(variety * 100), goals };
  }
  const main = dims[stage.dim], names = DIMENSIONS[stage.dim].zones;
  const base = guided ? 0.7 * main.match + 0.3 * main.varietyFraction : main.varietyFraction;
  const score = Math.round(100 * clamp(base * coverage * completion, 0, 1));
  const goals = guided
    ? [
      { id: 'match', label: 'Follow the ribbon', detail: `${Math.round(main.match * 100)}% of 70%`, done: main.match >= 0.7 },
      { id: 'swings', label: `${main.swingGoal} swings`, detail: `${main.swings} of ${main.swingGoal}`, done: main.swings >= main.swingGoal },
      flow
    ]
    : [
      { id: 'low', label: `Reach ${names.soft}`, detail: `${main.seconds.soft.toFixed(1)}s of 1.2s`, done: main.seconds.soft >= 1.2 },
      { id: 'high', label: `Reach ${names.strong}`, detail: `${main.seconds.strong.toFixed(1)}s of 1.2s`, done: main.seconds.strong >= 1.2 },
      { id: 'swings', label: `${main.swingGoal} swings`, detail: `${main.swings} of ${main.swingGoal}`, done: main.swings >= main.swingGoal },
      flow
    ];
  return { ...common, main, score, stars: starsFor(score, stage.kind), varietyScore: main.varietyScore, match: main.match, goals };
}

// How each PREP part sounded: the zone the voice spent most time in (per dimension), how
// much of the part was spoken, and for guided games how well the ribbon was followed.
export function prepBreakdown(frames, stage) {
  const dims = stage.dim === 'all' ? DIM_ORDER : [stage.dim];
  return stage.plan.phases.map(phase => {
    const inPart = frames.filter(frame => frame.t >= phase.from && frame.t < phase.to);
    const talking = inPart.length ? inPart.filter(frame => Number.isFinite(frame.volume)).length / inPart.length : 0;
    const byDim = Object.fromEntries(dims.map(dim => {
      const voiced = inPart.filter(frame => Number.isFinite(frame[dim]));
      const counts = { soft: 0, natural: 0, strong: 0 };
      voiced.forEach(frame => { counts[zoneOf(frame[dim])]++; });
      const zone = voiced.length ? ZONE_ORDER.reduce((a, b) => counts[b] > counts[a] ? b : a) : null;
      const match = stage.kind === 'guided' && voiced.length ? mean(voiced.map(frame => ribbonCredit(dim, frame[dim], stage.plan, frame.t))) : null;
      return [dim, { zone, label: zone ? zoneLabel(dim, zone) : null, share: zone ? counts[zone] / voiced.length : 0, match }];
    }));
    return { key: phase.key, letter: phase.letter, label: phase.label, goal: phase.zone, talking, dims: byDim };
  });
}

export function rangeLabel(dim, value) {
  const cuts = { volume: [6, 12, 20], pitch: [2, 4, 7], pace: [20, 40, 70] }[dim];   // dB, semitones, words a minute
  return value < cuts[0] ? 'Flat' : value < cuts[1] ? 'Gentle' : value < cuts[2] ? 'Dynamic' : 'Electric';
}

const MISSING = {
  volume: {
    strong: 'Your Boom zone is still untouched. Give your Point real energy: strong, never strained.',
    soft: 'You never reached Whisper. Drop your voice at the start of your Example to pull people in.'
  },
  pitch: {
    strong: 'Your voice never went High. Lift the key word of your Point, the way you would when you are excited.',
    soft: 'Your voice never went Low. Let your pitch fall on the Final Point: falling pitch sounds certain.'
  },
  pace: {
    strong: 'You never reached Fast (140 words a minute or more). Tell your Example quicker, as if the story is exciting.',
    soft: 'You never reached Slow (under 110 words a minute). Slow your Point, and pause before your Final Point.'
  }
};
export function coachingTip(result) {
  if (result.activeFraction < 0.3) return 'We barely heard you. Move a little closer to the microphone, keep it still, and keep talking through all four PREP parts.';
  if (result.activeFraction < 0.5) return 'Great pauses, but you were silent for more than half the round. Use your notes to move from Point to Reason to Example to Final Point.';
  const focus = result.dim === 'all'
    ? DIM_ORDER.reduce((worst, dim) => result.dims[dim].varietyFraction < result.dims[worst].varietyFraction ? dim : worst, 'volume')
    : result.dim;
  const stats = result.dims[focus], prefix = result.dim === 'all' ? `${DIMENSIONS[focus].name} varied the least. ` : '';
  if (stats.shares.strong < 0.08) return prefix + MISSING[focus].strong;
  if (stats.shares.soft < 0.08) return prefix + MISSING[focus].soft;
  if (stats.swings < stats.swingGoal) return `${prefix}You stayed in one gear for long stretches. Every PREP step is a chance to change: try a new ${DIMENSIONS[focus].name.toLowerCase()} for each part.`;
  if (result.kind === 'guided' && result.match < 0.6) {
    return focus === 'pace' ? 'Your pace is measured over the last few seconds, so it shows a change a little late. Start speeding up or slowing down as the ribbon begins to turn.' : 'Watch the glowing ribbon a little earlier. Start changing as the ribbon turns, not after it has passed.';
  }
  if (result.kind === 'guided' && result.match < 0.85) return 'Strong contrast. To tighten up, change on a PREP boundary and hold it until the ribbon moves.';
  return 'That is real vocal variety with a clear structure: every PREP part sounded different. Try a new question to keep it fresh.';
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

export const emptyProgress = () => ({ v: 1, xp: 0, rounds: 0, stars: {}, best: {}, badges: {}, streak: { count: 0, last: null }, seen: {} });

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
    seen: table(raw.seen, v => Number.isInteger(v) && v >= 0 && v < QUESTIONS.length)
  };
}

export const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function nextStreak(streak, now) {
  const today = dayKey(now);
  if (streak.last === today) return { ...streak };
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return { count: streak.last === dayKey(yesterday) ? streak.count + 1 : 1, last: today };
}

const dimOf = (ctx, dim) => ctx.result?.dims?.[dim] || null;
export const BADGES = [
  { id: 'prepared', name: 'Prepared', icon: '📝', desc: 'Write notes for all four PREP parts before a round.', earned: ctx => ctx.prepared === true },
  { id: 'whisper', name: 'First Whisper', icon: '◌', desc: 'Spend 2 seconds in the Whisper zone.', earned: ctx => dimOf(ctx, 'volume')?.seconds.soft >= 2 },
  { id: 'boom', name: 'Boom!', icon: '💥', desc: 'Spend 2 seconds in the Boom zone.', earned: ctx => dimOf(ctx, 'volume')?.seconds.strong >= 2 },
  { id: 'range', name: 'Wide Range', icon: '↕', desc: 'Show a 20 dB volume range in one answer.', earned: ctx => dimOf(ctx, 'volume')?.range.value >= 20 },
  { id: 'melody', name: 'Melody Maker', icon: '🎵', desc: 'Use 6 semitones of pitch range in one answer.', earned: ctx => dimOf(ctx, 'pitch')?.range.value >= 6 },
  { id: 'shifter', name: 'Pace Shifter', icon: '⏱️', desc: 'Spend 2 seconds both Slow and Fast in one answer.', earned: ctx => dimOf(ctx, 'pace')?.seconds.soft >= 2 && dimOf(ctx, 'pace')?.seconds.strong >= 2 },
  { id: 'swing', name: 'Swing King', icon: '🎢', desc: 'Make 8 swings in one dimension.', earned: ctx => DIM_ORDER.some(dim => dimOf(ctx, dim)?.swings >= 8) },
  { id: 'ribbon', name: 'On the Ribbon', icon: '🎯', desc: 'Match a ribbon 90% or better.', earned: ctx => ctx.result?.match >= 0.9 },
  { id: 'trio', name: 'Triple Star', icon: '⭐', desc: 'Earn three stars on any game.', earned: ctx => ctx.result?.stars === 3 },
  { id: 'threat', name: 'Triple Threat', icon: '👑', desc: 'Earn three stars on All Three.', earned: ctx => ctx.stage?.dim === 'all' && ctx.result?.stars === 3 },
  { id: 'spark', name: '3 Day Spark', icon: '🔥', desc: 'Practice three days in a row.', earned: ctx => ctx.progress.streak.count >= 3 },
  { id: 'journey', name: 'Full Set', icon: '🏁', desc: 'Earn a star in every game.', earned: ctx => STAGES.every(stage => (ctx.progress.stars[stage.id] || 0) >= 1) }
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

// `questionIndex` is the question that was just played; `seen[stage]` stores the next one to offer.
// `prepared` is true when the player wrote notes for all four PREP parts.
export function applyRound(progress, stage, result, now = new Date(), questionIndex = null, { prepared = false } = {}) {
  const before = sanitizeProgress(progress);
  const next = { ...before, stars: { ...before.stars }, best: { ...before.best }, badges: { ...before.badges }, seen: { ...before.seen } };
  const previousStars = next.stars[stage.id] || 0, previousBest = next.best[stage.id] || 0;
  const firstClear = previousStars === 0 && result.stars >= 1;
  const personalBest = result.score > previousBest;
  const goalXp = result.goals.filter(goal => goal.done).length * 4;
  const xpGained = 10 + result.stars * 12 + Math.round(result.score * 0.4) + goalXp + (firstClear ? 25 : 0) + (personalBest && previousBest > 0 ? 5 : 0) + (prepared ? 5 : 0);
  next.xp = before.xp + xpGained;
  next.rounds = before.rounds + 1;
  next.stars[stage.id] = Math.max(previousStars, result.stars);
  next.best[stage.id] = Math.max(previousBest, result.score);
  next.seen[stage.id] = ((questionIndex ?? questionIndexFor(before, stage)) + 1) % QUESTIONS.length;
  next.streak = nextStreak(before.streak, now);
  const newBadges = awardBadges(next, { stage, result, prepared }, now);
  return { progress: next, xpGained, firstClear, personalBest, newBadges, rankBefore: rankFor(before.xp), rank: rankFor(next.xp) };
}
