import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCALE, FRAME_DT, STAGES, BADGES, EnvelopeTracker, activeThreshold, applyRound, applyTune, coachingTip, countSwings,
  emptyProgress, isUnlocked, levelOf, normalizeScale, phaseAt, rankFor, sanitizeProgress, scaleFromCalibration, scoreRound,
  starsFor, targetAt, zoneOf
} from '../vocal-variety-game.js';

const scale = normalizeScale(DEFAULT_SCALE);
const dbAt = level => level <= 0.5 ? scale.soft + level / 0.5 * (scale.natural - scale.soft) : scale.natural + (level - 0.5) / 0.5 * (scale.power - scale.natural);

// Builds frames the way the app stores them: one every 50 ms.
function take(stage, levelAt, seconds = stage.plan.duration) {
  const frames = [];
  for (let i = 0; i < seconds / FRAME_DT; i++) {
    const t = i * FRAME_DT, level = levelAt(t);
    frames.push({ t, db: level === null ? -80 : dbAt(level), level, active: level !== null });
  }
  return frames;
}
const stage = id => STAGES.find(item => item.id === id);

test('levels are relative to the speaker: whisper 0, natural 0.5, power 1', () => {
  assert.ok(Math.abs(levelOf(scale.soft, scale)) < 1e-9);
  assert.ok(Math.abs(levelOf(scale.natural, scale) - 0.5) < 1e-9);
  assert.ok(Math.abs(levelOf(scale.power, scale) - 1) < 1e-9);
  assert.equal(levelOf(NaN, scale), null);
  assert.equal(levelOf(-200, scale), -0.3);
  assert.deepEqual(['soft', 'natural', 'strong'], [0.1, 0.5, 0.9].map(zoneOf));
});

test('a scale where the player barely changed volume is widened, never inverted', () => {
  const flat = normalizeScale({ floor: -60, soft: -34, natural: -33, power: -32 });
  assert.ok(flat.soft <= flat.natural - 6 && flat.power >= flat.natural + 6 && flat.floor <= flat.soft - 6);
  assert.equal(flat.widened, true);
  assert.equal(normalizeScale({}).widened, false);
  assert.ok(activeThreshold(scale) < scale.soft, 'a whisper must count as speech');
});

test('calibration turns whisper, natural and power samples into a personal scale', () => {
  const rep = (value, n = 40) => Array(n).fill(value);
  const result = scaleFromCalibration({ silence: rep(-70), whisper: rep(-52), normal: rep(-34), power: rep(-16) });
  assert.deepEqual(result.heard, { whisper: 40, normal: 40, power: 40 });
  assert.equal(result.scale.soft, -52);
  assert.equal(result.scale.natural, -34);
  assert.equal(result.scale.power, -16);
  const missed = scaleFromCalibration({ silence: rep(-70), whisper: rep(-72), normal: rep(-34), power: rep(-16) });
  assert.equal(missed.heard.whisper, 0, 'a whisper below the room noise is reported as not heard');
});

test('the envelope bridges syllable dips but leaves a gap for a real pause', () => {
  const tracker = new EnvelopeTracker(scale);
  let t = 0;
  const feed = db => tracker.push(t += FRAME_DT, db);
  for (let i = 0; i < 10; i++) feed(scale.natural);
  const dip = feed(scale.natural - 9);
  assert.ok(dip.level > 0.35, 'one quiet frame inside a word must not look like a drop');
  let last;
  for (let i = 0; i < 12; i++) last = feed(-80);
  assert.equal(last.level, null, 'silence longer than 0.35 s is a gap');
});

test('ribbon targets interpolate and every stage covers its full duration with phases', () => {
  const whisper = stage('whisper-boom').plan;
  assert.equal(targetAt(whisper, 0), 0.16);
  assert.equal(targetAt(whisper, 15), 0.8);
  assert.equal(targetAt(whisper, 99), 0.18);
  assert.ok(targetAt(whisper, 10) > 0.16 && targetAt(whisper, 10) < 0.8);
  assert.equal(targetAt(stage('freestyle').plan, 5), null);
  for (const item of STAGES) {
    const { phases, duration } = item.plan;
    assert.equal(phases[0].from, 0);
    assert.equal(phases.at(-1).to, duration);
    phases.forEach((p, i) => i && assert.equal(p.from, phases[i - 1].to));
    assert.equal(item.questions.length, 4);
    assert.equal(phaseAt(item.plan, duration - 0.01), phases.at(-1));
  }
});

test('swings count zone changes, ignore short dips and wobble on a border', () => {
  const frames = take(stage('freestyle'), t => t < 5 ? 0.1 : t < 10 ? 0.5 : t < 15 ? 0.9 : 0.1, 20);
  const { swings, moments } = countSwings(frames);
  assert.equal(swings, 1 + 1 + 2);
  assert.equal(moments.length, 3);
  const blip = take(stage('freestyle'), t => (t > 5 && t < 5.2) ? 0.9 : 0.5, 10);
  assert.equal(countSwings(blip).swings, 0, 'a 0.2 s spike is not a zone change');
  const wobble = take(stage('freestyle'), t => 0.72 + Math.sin(t * 9) * 0.03, 10);
  assert.equal(countSwings(wobble).swings, 0, 'hovering on the border must not farm swings');
});

test('following the ribbon earns three stars; silence, a flat voice and a quick exit do not', () => {
  const guided = stage('whisper-boom');
  const perfect = scoreRound({ frames: take(guided, t => targetAt(guided.plan, t)), stage: guided, scale });
  assert.ok(perfect.score >= 90 && perfect.stars === 3, `perfect score ${perfect.score}`);
  assert.ok(perfect.match > 0.98 && perfect.swings >= guided.plan.goalSwings);
  assert.ok(perfect.goals.every(goal => goal.done));

  const silent = scoreRound({ frames: take(guided, () => null), stage: guided, scale });
  assert.equal(silent.score, 0);
  assert.equal(silent.stars, 0);

  const flat = scoreRound({ frames: take(guided, () => 0.5), stage: guided, scale });
  assert.ok(flat.score < 55 && flat.stars === 0, `flat score ${flat.score}`);
  assert.ok(flat.rangeDb < 1 && flat.swings === 0);

  const early = scoreRound({ frames: take(guided, t => targetAt(guided.plan, t), 6), stage: guided, scale });
  assert.ok(early.score < perfect.score / 2, 'a take that stops at 20% cannot score like a full one');
});

test('talking through only half the round still counts, but little talking does not', () => {
  const guided = stage('staircase');
  const half = scoreRound({ frames: take(guided, t => t % 4 < 2 ? targetAt(guided.plan, t) : null), stage: guided, scale });
  const barely = scoreRound({ frames: take(guided, t => t % 10 < 1 ? targetAt(guided.plan, t) : null), stage: guided, scale });
  assert.ok(half.score >= 60, `half the time speaking: ${half.score}`);
  assert.ok(barely.score < 25, `barely speaking: ${barely.score}`);
  assert.match(coachingTip(barely), /barely heard/);
});

test('freestyle rewards range, balance and swings, and reports goals', () => {
  const free = stage('freestyle');
  const pattern = t => [0.12, 0.5, 0.88, 0.5, 0.15, 0.85, 0.5, 0.1, 0.9][Math.floor(t / 5) % 9];
  const rich = scoreRound({ frames: take(free, pattern), stage: free, scale });
  assert.equal(rich.match, null);
  assert.ok(rich.stars === 3 && rich.goals.length === 4 && rich.goals.every(goal => goal.done), JSON.stringify(rich.goals));
  const monotone = scoreRound({ frames: take(free, () => 0.5), stage: free, scale });
  assert.ok(monotone.stars === 0);
  assert.match(coachingTip(monotone), /Boom zone/);
  assert.equal(starsFor(50, 'free'), 1);
  assert.equal(starsFor(50, 'guided'), 0);
});

test('ranks climb with XP', () => {
  assert.equal(rankFor(0).name, 'Murmur');
  assert.equal(rankFor(80).name, 'Speaker');
  assert.equal(rankFor(5000).name, 'Legend');
  assert.equal(rankFor(5000).pct, 1);
  const half = rankFor(150);
  assert.equal(half.name, 'Speaker');
  assert.ok(half.pct > 0.49 && half.pct < 0.51 && half.nextName === 'Storyteller');
});

test('finishing a round awards XP, stars, unlocks, badges and a day streak', () => {
  const guided = stage('whisper-boom');
  const result = scoreRound({ frames: take(guided, t => targetAt(guided.plan, t)), stage: guided, scale });
  const monday = new Date(2026, 9, 19, 10), tuesday = new Date(2026, 9, 20, 10);
  const first = applyRound(emptyProgress(), guided, result, monday, 0);
  assert.equal(first.firstClear, true);
  assert.equal(first.unlockedNext.id, 'staircase');
  assert.ok(first.progress.xp > 60 && first.progress.stars['whisper-boom'] === 3);
  assert.equal(first.progress.seen['whisper-boom'], 1);
  assert.equal(first.progress.streak.count, 1);
  for (const id of ['whisper', 'boom', 'ribbon', 'trio']) assert.ok(first.progress.badges[id], `${id} badge`);
  assert.equal(isUnlocked(first.progress, stage('staircase')), true);
  assert.equal(isUnlocked(first.progress, stage('pulse')), false);

  const again = applyRound(first.progress, guided, result, monday, 1);
  assert.equal(again.firstClear, false);
  assert.equal(again.newBadges.length, 0);
  assert.equal(again.progress.streak.count, 1, 'two rounds on one day are one streak day');
  const nextDay = applyRound(again.progress, guided, result, tuesday, 2);
  assert.equal(nextDay.progress.streak.count, 2);
  const skipped = applyRound(nextDay.progress, guided, result, new Date(2026, 9, 25), 3);
  assert.equal(skipped.progress.streak.count, 1, 'a missed day restarts the streak');
  assert.equal(skipped.progress.seen['whisper-boom'], 0, 'questions cycle');
});

test('tuning gives a small bonus and a badge once', () => {
  const first = applyTune(emptyProgress(), new Date(2026, 9, 19));
  assert.equal(first.xpGained, 20);
  assert.ok(first.progress.badges.tuned);
  assert.equal(first.newBadges[0].id, 'tuned');
  const second = applyTune(first.progress, new Date(2026, 9, 19));
  assert.equal(second.xpGained, 5);
  assert.equal(second.newBadges.length, 0);
});

test('saved progress is sanitized so a damaged save cannot break the game', () => {
  assert.deepEqual(sanitizeProgress(null), emptyProgress());
  const cleaned = sanitizeProgress({ xp: -5, rounds: 'x', stars: { a: 4, b: 2, c: -1 }, best: { a: 101, b: 50 }, badges: { x: 1, y: '2026-10-19' }, streak: { count: 'z', last: 7 }, tuned: 'yes' });
  assert.equal(cleaned.xp, 0);
  assert.deepEqual(cleaned.stars, { b: 2 });
  assert.deepEqual(cleaned.best, { b: 50 });
  assert.deepEqual(cleaned.badges, { y: '2026-10-19' });
  assert.deepEqual(cleaned.streak, { count: 0, last: null });
  assert.equal(cleaned.tuned, false);
  assert.equal(new Set(BADGES.map(badge => badge.id)).size, BADGES.length);
});
