import test from 'node:test';
import assert from 'node:assert/strict';
import { PaceMeter, PitchSmoother } from '../vocal-variety-core.js';
import {
  BADGES, DEFAULT_NATURAL, DEFAULT_SCALE, DEFAULT_SPEECH, DIM_ORDER, SPEECH_LENGTHS, lengthLabel, scaleStage, FRAME_DT, PREP_PARTS, QUESTIONS, STAGES,
  EnvelopeTracker, VoiceTracker, WPM_FAST_FROM, WPM_SLOW_BELOW, activeThreshold, applyRound, coachingTip, countSwings, emptyProgress, learnPitchCenter,
  learnVoiceLevel, levelOf, normalizeScale, paceLevel, paceZoneOfWpm, phaseAt, pitchLevel, prepBreakdown, questionIndexFor, rankFor, rangeLabel,
  sanitizeProgress, scoreRound, starsFor, targetAt, voiceScale, wpmOfLevel, zoneHint, zoneLabel, zoneOf
} from '../vocal-variety-game.js';

const scale = normalizeScale({ ...DEFAULT_SCALE, pitchCenter: 50 });
const dbAt = level => level <= 0.5 ? scale.soft + level / 0.5 * (scale.natural - scale.soft) : scale.natural + (level - 0.5) / 0.5 * (scale.power - scale.natural);
const stage = id => STAGES.find(item => item.id === id);

// Builds frames the way the app stores them: one every 50 ms. `levels(t)` returns
// { volume, pitch, pace } levels; null volume means silence. Pace is stored as words a minute too.
function take(game, levels, seconds = game.plan.duration) {
  const frames = [];
  for (let i = 0; i < seconds / FRAME_DT; i++) {
    const t = i * FRAME_DT, { volume = 0.5, pitch = 0.5, pace = 0.5 } = levels(t);
    const talking = volume !== null;
    frames.push({
      t, db: talking ? dbAt(volume) : -80, active: talking, volume,
      midi: talking ? 50 + (pitch - 0.5) * 12 : null, pitch: talking ? pitch : null,
      wpm: talking ? wpmOfLevel(pace) : null, pace: talking ? pace : null
    });
  }
  return frames;
}
const follow = game => t => ({ [game.dim]: targetAt(game.plan, Math.max(0, t - ({ volume: 0, pitch: 0.3, pace: 0 })[game.dim])) });

test('every dimension maps to the same 0..1 scale', () => {
  assert.ok(Math.abs(levelOf(scale.soft, scale)) < 1e-9);
  assert.ok(Math.abs(levelOf(scale.natural, scale) - 0.5) < 1e-9);
  assert.ok(Math.abs(levelOf(scale.power, scale) - 1) < 1e-9);
  assert.equal(pitchLevel(50, 50), 0.5);
  assert.equal(pitchLevel(56, 50), 1);
  assert.equal(pitchLevel(44, 50), 0);
  assert.equal(pitchLevel(null, 50), null);
  assert.equal(paceLevel(null), null);
  assert.equal(paceLevel(0), -0.3, 'a long pause is as slow as it gets');
  assert.deepEqual(['soft', 'natural', 'strong'], [0.1, 0.5, 0.9].map(zoneOf));
  assert.deepEqual(['Whisper', 'Low', 'Fast'], [['volume', 'soft'], ['pitch', 'soft'], ['pace', 'strong']].map(([d, z]) => zoneLabel(d, z)));
});

test('pace zones are exactly Slow under 110, Steady 110 to 139 and Fast 140 or more words a minute', () => {
  const zone = wpm => zoneOf(paceLevel(wpm));
  assert.equal(WPM_SLOW_BELOW, 110);
  assert.equal(WPM_FAST_FROM, 140);
  for (const wpm of [0, 40, 80, 100, 109, 109.4]) assert.equal(zone(wpm), 'soft', `${wpm} WPM is Slow`);
  for (const wpm of [110, 125, 139, 139.4]) assert.equal(zone(wpm), 'natural', `${wpm} WPM is Steady`);
  for (const wpm of [140, 150, 180, 250]) assert.equal(zone(wpm), 'strong', `${wpm} WPM is Fast`);
  for (let wpm = 60; wpm <= 220; wpm++) assert.equal(zone(wpm), paceZoneOfWpm(wpm), `${wpm} WPM agrees`);
  assert.ok(paceLevel(100) < paceLevel(125) && paceLevel(125) < paceLevel(150), 'faster is higher');
  assert.deepEqual([0.14, 0.5, 0.87].map(level => Math.round(wpmOfLevel(level))), [100, 125, 150], 'the ribbon targets are 100, 125 and 150 WPM');
  assert.equal(zoneHint('pace', 'soft'), 'under 110 words a minute');
  assert.equal(zoneHint('pace', 'strong'), '140 words a minute or more');
  assert.equal(zoneHint('volume', 'soft'), '');
});

test('nobody is tuned: zones follow the speaker, start typical, and learn from the sound check', () => {
  const typical = voiceScale();
  assert.equal(typical.natural, DEFAULT_NATURAL);
  assert.equal(typical.soft, DEFAULT_NATURAL - 14);
  assert.equal(typical.power, DEFAULT_NATURAL + 11);
  assert.ok(activeThreshold(typical) < typical.soft, 'a soft voice still counts as speech');
  assert.ok(activeThreshold(typical) > typical.natural - 25, 'quiet background noise is not speech');
  assert.equal(voiceScale(NaN).natural, DEFAULT_NATURAL);
  assert.equal(voiceScale(-90).natural, -55, 'the level is kept in a sensible range');
  assert.equal(voiceScale(-30, 48).pitchCenter, 48);
  assert.equal(voiceScale(-30, 200).pitchCenter, null, 'an impossible note is dropped');
  const flat = normalizeScale({ floor: -60, soft: -34, natural: -33, power: -32 });
  assert.ok(flat.soft <= flat.natural - 6 && flat.power >= flat.natural + 6 && flat.floor <= flat.soft - 6);
  assert.equal(flat.widened, true);

  // A quiet speaker (-45 dB) with word gaps and room noise, then a loud one (-24 dB):
  const quiet = Array.from({ length: 80 }, (_, i) => i % 5 === 0 ? -78 : -45 + Math.sin(i) * 3);
  const first = learnVoiceLevel(DEFAULT_NATURAL, quiet, 0.9);
  assert.ok(first < -43 && first > -45.5, `moved nearly all the way to the quiet speaker: ${first}`);
  const loud = Array.from({ length: 80 }, (_, i) => i % 5 === 0 ? -60 : -24 + Math.sin(i) * 3);
  assert.ok(learnVoiceLevel(first, loud, 0.9) > -27, 'and straight to the next, louder, speaker');
  assert.equal(learnVoiceLevel(-33, Array(80).fill(-90)), -33, 'silence teaches nothing');
  assert.equal(learnVoiceLevel(-33, [-40, -40, -41, -39, -40]), -33, 'half a second of voice teaches nothing');
  assert.equal(learnVoiceLevel(-33, [NaN, undefined, null].concat(Array(5).fill(-40))), -33);

  // Pitch: this speaker's own median note, never carried to the next speaker.
  assert.equal(learnPitchCenter(Array(30).fill(47)), 47);
  assert.equal(learnPitchCenter([47, 48, null, NaN]), null, 'too few notes: the take decides');
  assert.equal(learnPitchCenter([]), null);

  // The same ribbon take earns the same stars wherever the speaker's level sits, once the zones follow it.
  const game = stage('volume-ribbon');
  for (const natural of [-45, -33, -22]) {
    const sc = voiceScale(natural), at = level => level <= 0.5 ? sc.soft + level / 0.5 * (sc.natural - sc.soft) : sc.natural + (level - 0.5) / 0.5 * (sc.power - sc.natural);
    const frames = Array.from({ length: game.plan.duration / FRAME_DT }, (_, i) => {
      const t = i * FRAME_DT, level = targetAt(game.plan, t);
      return { t, db: at(level), active: true, volume: level, midi: null, pitch: null, wpm: null, pace: null };
    });
    assert.ok(scoreRound({ frames, stage: game, scale: sc }).stars === 3, `speaker level ${natural}`);
  }
});

test('the envelope bridges syllable dips but leaves a gap for a real pause', () => {
  const tracker = new EnvelopeTracker(scale);
  let t = 0;
  const feed = db => tracker.push(t += FRAME_DT, db);
  for (let i = 0; i < 10; i++) feed(scale.natural);
  assert.ok(feed(scale.natural - 9).level > 0.35, 'one quiet frame inside a word must not look like a drop');
  let last;
  for (let i = 0; i < 12; i++) last = feed(-80);
  assert.equal(last.level, null, 'silence longer than 0.35 s is a gap');
});

// Amplitude modulated like syllables: `rate` loud peaks per second, 9.5 dB deep.
function paceAt(rate, seconds = 6, meter = new PaceMeter({ window: 2.5, gateDb: -60 })) {
  let value;
  for (let i = 0; i <= seconds * 50; i++) {
    const t = i * 0.02;
    value = meter.push(t, 0.04 + 0.08 * (0.5 + 0.5 * Math.cos(2 * Math.PI * rate * t)));
  }
  return value;
}
test('the sound-only pace meter (the fallback) counts peaks and treats pauses as slow', () => {
  assert.ok(Math.abs(paceAt(2) - 2) < 0.5, `2/s measured ${paceAt(2)}`);
  assert.ok(Math.abs(paceAt(4) - 4) < 0.5, `4/s measured ${paceAt(4)}`);
  const meter = new PaceMeter({ window: 2.5, gateDb: -60 });
  paceAt(4, 4, meter);
  let duringPause;
  for (let i = 0; i < 75; i++) duringPause = meter.push(4 + i * 0.02, 0.0001);
  assert.ok(duringPause < 2.6, `a 1.5 s pause slows the measured pace, got ${duringPause}`);
  for (let i = 75; i < 250; i++) duringPause = meter.push(4 + i * 0.02, 0.0001);
  assert.equal(duringPause, null, 'only silence in the window: no pace');
  assert.equal(paceAt(4, 6, new PaceMeter({ window: 2.5, gateDb: -10 })), null, 'peaks quieter than the gate are ignored');
});

test('the pitch smoother follows the median and holds briefly over unvoiced sounds', () => {
  const smoother = new PitchSmoother();
  [50, 51, 70, 50, 51].forEach((midi, i) => smoother.push(i * 0.05, midi));
  assert.ok(Math.abs(smoother.push(0.25, 50) - 50.5) <= 0.5, 'one octave jump is ignored');
  assert.ok(Number.isFinite(smoother.push(0.5, null)), 'held through a short consonant');
  assert.equal(smoother.push(1.2, null), null, 'released after a real pause');
});

test('the voice tracker turns the sound into volume and pitch levels (and a pace estimate for the fallback)', () => {
  const tracker = new VoiceTracker(scale);
  let frame;
  for (let i = 0; i < 250; i++) {
    const t = i * 0.02, rms = Math.pow(10, scale.natural / 20) * (0.6 + 0.4 * Math.cos(2 * Math.PI * 3 * t));
    frame = tracker.push(t, rms, 50);
  }
  assert.ok(frame.volume > 0.25 && frame.volume < 0.75, `volume ${frame.volume}`);
  assert.equal(frame.pitch, 0.5);
  assert.ok(frame.soundWpm > 100 && frame.soundWpm < 190, `3 syllable-like peaks a second is about 130 to 160 WPM, got ${frame.soundWpm}`);
  assert.equal(new VoiceTracker(normalizeScale({})).push(0, 0.03, 50).pitch, null, 'no pitch centre yet: wait for enough notes');
});

test('every game is a PREP answer with a clear title, and the question bank suits PREP', () => {
  assert.deepEqual(PREP_PARTS.map(part => part.label), ['Point', 'Reason', 'Example', 'Final Point']);
  assert.deepEqual([...new Set(STAGES.map(item => item.dim))], ['volume', 'pitch', 'pace', 'all']);
  for (const item of STAGES) {
    const { phases, duration } = item.plan;
    assert.deepEqual(phases.map(p => p.key), ['point', 'reason', 'example', 'finalPoint']);
    assert.equal(phases[0].from, 0);
    assert.equal(phases.at(-1).to, duration);
    phases.forEach((p, i) => i && assert.equal(p.from, phases[i - 1].to));
    assert.equal(phaseAt(item.plan, duration - 0.01), phases.at(-1));
    assert.ok(item.dim === 'all' ? item.title.startsWith('All Three') : item.title.startsWith(`${item.dim[0].toUpperCase()}${item.dim.slice(1)}:`), item.title);
    assert.equal(Boolean(item.plan.keys), item.kind === 'guided');
  }
  assert.equal(new Set(QUESTIONS).size, QUESTIONS.length);
  assert.ok(QUESTIONS.length >= 20);
  assert.notEqual(questionIndexFor(emptyProgress(), STAGES[0]), questionIndexFor(emptyProgress(), STAGES[1]), 'games start on different questions');
  const paceCues = stage('pace-ribbon').plan.phases.map(p => p.cue).join(' ');
  assert.match(paceCues, /110/);
  assert.match(paceCues, /140/);
});

test('every game can be played for 1, 1½ or 2 minutes with the same shape and the same PREP shares', () => {
  assert.deepEqual(SPEECH_LENGTHS, [60, 90, 120]);
  assert.equal(DEFAULT_SPEECH, 120);
  assert.deepEqual(SPEECH_LENGTHS.map(lengthLabel), ['1 min', '1½ min', '2 min']);
  for (const game of STAGES) {
    for (const seconds of SPEECH_LENGTHS) {
      const scaled = scaleStage(game, seconds), { phases, duration, keys } = scaled.plan;
      assert.equal(duration, seconds);
      assert.equal(phases[0].from, 0);
      assert.equal(phases.at(-1).to, seconds, `${game.id} ${seconds}s ends on time`);
      phases.forEach((p, i) => {
        if (i) assert.equal(p.from, phases[i - 1].to);
        assert.ok(Math.abs((p.to - p.from) / seconds - (game.plan.phases[i].to - game.plan.phases[i].from) / game.plan.duration) < 1e-9, 'PREP parts keep their share of the time');
      });
      assert.ok(scaled.plan.goalSwings >= game.plan.goalSwings);
      assert.equal(game.plan.duration === seconds, scaled === game);
      if (game.kind === 'free') { assert.equal(keys, undefined); continue; }
      assert.equal(keys[0][0], 0);
      assert.equal(keys.at(-1)[0], seconds);
      keys.forEach(([t], i) => i && assert.ok(t > keys[i - 1][0], `${game.id} ${seconds}s keys increase`));
      // The ribbon still lands on the same level in the middle of each PREP part...
      phases.forEach((p, i) => {
        const original = game.plan.phases[i], mid = 0.5, at = (plan, phase) => targetAt(plan, phase.from + (phase.to - phase.from) * mid);
        assert.ok(Math.abs(at(scaled.plan, p) - at(game.plan, original)) < 0.2, `${game.id} part ${i} at ${seconds}s`);
      });
      // ...and a change of voice at a PREP boundary takes as long as before.
      const boundary = game.plan.phases[0].to, boundaryScaled = phases[0].to;
      assert.ok(Math.abs((targetAt(scaled.plan, boundaryScaled + 1) - targetAt(scaled.plan, boundaryScaled - 1)) - (targetAt(game.plan, boundary + 1) - targetAt(game.plan, boundary - 1))) < 1e-9);
    }
  }
  const stretched = scaleStage(stage('volume-ribbon'), 120);
  assert.equal(stretched.plan.phases[1].to, 54, 'the Reason now ends 54 seconds in');
  assert.ok(stretched.plan.goalSwings > stage('volume-ribbon').plan.goalSwings, 'a longer speech expects more swings');
});

test('a full two-minute ribbon take scores like the short one', () => {
  for (const id of ['volume-ribbon', 'pitch-ribbon', 'pace-ribbon']) {
    const long = scaleStage(stage(id), 120);
    const perfect = scoreRound({ frames: take(long, follow(long)), stage: long, scale });
    assert.ok(perfect.stars === 3 && perfect.match > 0.95, `${id} at 2 minutes: ${perfect.score}`);
    const flat = scoreRound({ frames: take(long, () => ({})), stage: long, scale });
    assert.equal(flat.stars, 0, `${id} flat at 2 minutes`);
  }
});

test('swings count zone changes, ignore short dips and wobble on a border', () => {
  const at = (fn, seconds) => Array.from({ length: seconds / FRAME_DT }, (_, i) => ({ t: i * FRAME_DT, level: fn(i * FRAME_DT) }));
  const { swings, moments } = countSwings(at(t => t < 5 ? 0.1 : t < 10 ? 0.5 : t < 15 ? 0.9 : 0.1, 20));
  assert.equal(swings, 1 + 1 + 2);
  assert.equal(moments.length, 3);
  assert.equal(countSwings(at(t => (t > 5 && t < 5.2) ? 0.9 : 0.5, 10)).swings, 0, 'a 0.2 s spike is not a zone change');
  assert.equal(countSwings(at(t => 0.72 + Math.sin(t * 9) * 0.03, 10)).swings, 0, 'hovering on the border must not farm swings');
});

test('following each ribbon earns three stars; silence, a flat voice and a quick exit do not', () => {
  for (const id of ['volume-ribbon', 'pitch-ribbon', 'pace-ribbon']) {
    const game = stage(id);
    const perfect = scoreRound({ frames: take(game, follow(game)), stage: game, scale });
    assert.ok(perfect.score >= 88 && perfect.stars === 3, `${id} perfect score ${perfect.score}`);
    assert.ok(perfect.match > 0.95 && perfect.main.swings >= game.plan.goalSwings, `${id} match ${perfect.match} swings ${perfect.main.swings}`);
    assert.ok(perfect.goals.every(goal => goal.done), id);
    const flat = scoreRound({ frames: take(game, () => ({})), stage: game, scale });
    assert.ok(flat.stars === 0, `${id} flat score ${flat.score}`);
  }
  const game = stage('volume-ribbon');
  const silent = scoreRound({ frames: take(game, () => ({ volume: null })), stage: game, scale });
  assert.equal(silent.score, 0);
  const early = scoreRound({ frames: take(game, follow(game), 8), stage: game, scale });
  assert.ok(early.score < 40, `a take that stops at 20% cannot score like a full one: ${early.score}`);
});

test('the pace game is won by speaking at 100, 125 and 150 words a minute, and reads in words a minute', () => {
  const game = stage('pace-ribbon');
  // A normal speaker who simply talks at about 125 WPM all the way is Steady, and can reach neither end.
  const steady = scoreRound({ frames: take(game, () => ({ pace: paceLevel(125) })), stage: game, scale });
  assert.equal(steady.stars, 0);
  assert.ok(steady.main.seconds.strong === 0 && steady.main.seconds.soft === 0);
  // Speaking at 100 / 125 / 150 WPM in the right parts earns all three stars.
  const wpmFor = t => { const phase = phaseAt(game.plan, t).key; return phase === 'reason' ? 125 : phase === 'example' ? 150 : 100; };
  const good = scoreRound({ frames: take(game, t => ({ pace: paceLevel(wpmFor(t)) })), stage: game, scale });
  assert.equal(good.stars, 3, `100/125/150 WPM scored ${good.score}`);
  assert.ok(good.main.seconds.strong > 5 && good.main.seconds.soft > 5);
  // Ordinary quick speech, 145 WPM, is Fast. Ordinary slow speech, 105, is Slow.
  assert.equal(zoneOf(paceLevel(145)), 'strong');
  assert.equal(zoneOf(paceLevel(105)), 'soft');
  assert.match(good.main.range.text, /words a minute/);
  assert.match(good.main.peak.text, /words a minute/);
  assert.match(coachingTip(scoreRound({ frames: take(stage('pace-free'), () => ({ pace: paceLevel(125) })), stage: stage('pace-free'), scale })), /Fast \(140 words a minute or more\)/);
});

test('the pitch game is scored on pitch, not on volume', () => {
  const game = stage('pitch-ribbon');
  const loudButMonotone = scoreRound({ frames: take(game, t => ({ volume: targetAt(stage('volume-ribbon').plan, t), pitch: 0.5 })), stage: game, scale });
  assert.equal(loudButMonotone.stars, 0, `volume changes alone must not win the pitch game (${loudButMonotone.score})`);
  assert.ok(loudButMonotone.dims.volume.swings >= 3, 'volume is still measured for the other tiles');
  assert.match(coachingTip(loudButMonotone), /never went High/);
});

test('talking through only half the round still counts, but little talking does not', () => {
  const game = stage('volume-ribbon');
  const half = scoreRound({ frames: take(game, t => ({ volume: t % 4 < 2 ? targetAt(game.plan, t) : null })), stage: game, scale });
  const barely = scoreRound({ frames: take(game, t => ({ volume: t % 10 < 1 ? targetAt(game.plan, t) : null })), stage: game, scale });
  assert.ok(half.score >= 60, `half the time speaking: ${half.score}`);
  assert.ok(barely.score < 25, `barely speaking: ${barely.score}`);
  assert.match(coachingTip(barely), /barely heard/);
});

test('freestyle rewards range, balance and swings and names goals in the game’s own zones', () => {
  const game = stage('pace-free');
  const pattern = t => ({ pace: paceLevel([95, 125, 155, 125, 100, 160, 125, 90, 165][Math.floor(t / 5) % 9]) });
  const rich = scoreRound({ frames: take(game, pattern), stage: game, scale });
  assert.equal(rich.match, null);
  assert.deepEqual(rich.goals.map(goal => goal.label), ['Reach Slow', 'Reach Fast', '4 swings', 'Keep talking']);
  assert.ok(rich.stars === 3 && rich.goals.every(goal => goal.done), JSON.stringify(rich.goals));
  const monotone = scoreRound({ frames: take(game, () => ({})), stage: game, scale });
  assert.equal(monotone.stars, 0);
  assert.equal(starsFor(50, 'free'), 1);
  assert.equal(starsFor(50, 'guided'), 0);
});

test('All Three needs variety in volume, pitch and pace together', () => {
  const game = stage('all-three');
  const wave = (t, offset) => [0.12, 0.5, 0.88, 0.5][Math.floor((t + offset) / 4) % 4];
  const all = scoreRound({ frames: take(game, t => ({ volume: wave(t, 0), pitch: wave(t, 2), pace: wave(t, 5) })), stage: game, scale });
  assert.equal(all.main, null);
  assert.ok(all.stars === 3, `all three varied: ${all.score}`);
  assert.deepEqual(all.goals.map(goal => goal.id), [...DIM_ORDER, 'flow']);
  const volumeOnly = scoreRound({ frames: take(game, t => ({ volume: wave(t, 0) })), stage: game, scale });
  assert.ok(volumeOnly.score < 55, `one dimension is not enough: ${volumeOnly.score}`);
  assert.match(coachingTip(volumeOnly), /^(Pitch|Pace) varied the least/);
});

test('the PREP breakdown shows how each part of the answer sounded', () => {
  const game = stage('volume-ribbon');
  const parts = prepBreakdown(take(game, follow(game)), game);
  assert.deepEqual(parts.map(part => part.label), ['Point', 'Reason', 'Example', 'Final Point']);
  assert.deepEqual(parts.map(part => part.dims.volume.label), ['Boom', 'Steady', 'Whisper', 'Boom']);
  assert.ok(parts.every(part => part.talking === 1 && part.dims.volume.match > 0.9));
  const all = prepBreakdown(take(stage('all-three'), () => ({ volume: 0.9, pitch: 0.1, pace: 0.5 })), stage('all-three'));
  assert.deepEqual(Object.values(all[0].dims).map(d => d.label), ['Boom', 'Low', 'Steady']);
  assert.equal(all[0].dims.pitch.match, null, 'freestyle parts have no ribbon match');
});

test('ranges read in each dimension’s own units', () => {
  assert.equal(rangeLabel('volume', 4), 'Flat');
  assert.equal(rangeLabel('volume', 24), 'Electric');
  assert.equal(rangeLabel('pitch', 5), 'Dynamic');
  assert.equal(rangeLabel('pace', 45), 'Dynamic');
  const game = stage('pitch-ribbon');
  const r = scoreRound({ frames: take(game, follow(game)), stage: game, scale });
  assert.match(r.main.range.text, /semitones/);
  assert.match(r.main.peak.text, /semitones vs the usual note/);
  // A steady voice whose raw level dips between syllables still has almost no volume range.
  const steady = take(game, () => ({})).map((frame, i) => ({ ...frame, db: frame.db - (i % 4 === 0 ? 12 : 0) }));
  assert.ok(scoreRound({ frames: steady, stage: game, scale }).dims.volume.range.value < 1, 'syllable dips are not range');
});

test('ranks climb with XP', () => {
  assert.equal(rankFor(0).name, 'Murmur');
  assert.equal(rankFor(80).name, 'Speaker');
  assert.equal(rankFor(5000).name, 'Legend');
  assert.equal(rankFor(5000).pct, 1);
  const half = rankFor(150);
  assert.ok(half.name === 'Speaker' && half.pct > 0.49 && half.pct < 0.51 && half.nextName === 'Storyteller');
});

test('finishing a round awards XP, stars, badges, preparation and a day streak', () => {
  const game = stage('volume-ribbon');
  const result = scoreRound({ frames: take(game, follow(game)), stage: game, scale });
  const monday = new Date(2026, 9, 19, 10), tuesday = new Date(2026, 9, 20, 10);
  const first = applyRound(emptyProgress(), game, result, monday, 0, { prepared: true });
  assert.equal(first.firstClear, true);
  assert.ok(first.progress.xp > 60 && first.progress.stars['volume-ribbon'] === 3);
  assert.equal(first.progress.seen['volume-ribbon'], 1);
  assert.equal(first.progress.streak.count, 1);
  for (const id of ['prepared', 'whisper', 'boom', 'ribbon', 'trio']) assert.ok(first.progress.badges[id], `${id} badge`);
  assert.ok(!first.progress.badges.tuned, 'there is no tuning step any more, so no Tuned In badge');
  const unprepared = applyRound(emptyProgress(), game, result, monday, 0);
  assert.equal(first.xpGained - unprepared.xpGained, 5, 'writing PREP notes earns a small bonus');
  assert.ok(!unprepared.progress.badges.prepared);

  const again = applyRound(first.progress, game, result, monday, 1);
  assert.equal(again.firstClear, false);
  assert.equal(again.newBadges.length, 0);
  assert.equal(again.progress.streak.count, 1, 'two rounds on one day are one streak day');
  assert.equal(applyRound(again.progress, game, result, tuesday, 2).progress.streak.count, 2);
  const last = applyRound(again.progress, game, result, new Date(2026, 9, 25), QUESTIONS.length - 1);
  assert.equal(last.progress.streak.count, 1, 'a missed day restarts the streak');
  assert.equal(last.progress.seen['volume-ribbon'], 0, 'questions cycle');
});

test('saved progress is sanitized so a damaged save cannot break the game', () => {
  assert.deepEqual(sanitizeProgress(null), emptyProgress());
  const cleaned = sanitizeProgress({ xp: -5, rounds: 'x', stars: { a: 4, b: 2, c: -1 }, best: { a: 101, b: 50 }, badges: { x: 1, y: '2026-10-19' }, streak: { count: 'z', last: 7 }, seen: { a: 999, b: 3 }, tuned: true });
  assert.equal(cleaned.xp, 0);
  assert.deepEqual(cleaned.stars, { b: 2 });
  assert.deepEqual(cleaned.best, { b: 50 });
  assert.deepEqual(cleaned.badges, { y: '2026-10-19' });
  assert.deepEqual(cleaned.seen, { b: 3 });
  assert.deepEqual(cleaned.streak, { count: 0, last: null });
  assert.ok(!('tuned' in cleaned), 'the old tuning flag is dropped from saved progress');
  assert.equal(new Set(BADGES.map(badge => badge.id)).size, BADGES.length);
});
