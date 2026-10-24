import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES, modeById, makeDeck, analogyText, estimateFloorDb, voicedThresholdDb, analyseRound, scoreRound, gradeOf,
  summarize, rankFor, RANKS, applyResult, newProfile, normalizeProfile, coachingTip, MIN_REACTION_MS
} from '../think-fast-core.js';
import { WORDS } from '../think-fast-words.js';

const seeded = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
// 25 ms frames of silence (-70 dB) with a stretch of speech (-30 dB) between startMs and endMs
function frames(totalMs, speech) {
  const out = [];
  for (let t = 0; t <= totalMs; t += 25) out.push({ t, db: speech.some(([a, b]) => t >= a && t < b) ? -30 : -70 });
  return out;
}

test('every mode explains itself in three short steps, and the single modes give a one-line hint', () => {
  MODES.forEach(mode => {
    assert.equal(mode.how.length, 3, `${mode.id} needs three steps`);
    mode.how.forEach(step => assert.ok(step.length > 20 && step.length < 160, `${mode.id} step reads well`));
    if (mode.id !== 'mix') assert.ok(mode.hint.length > 10, `${mode.id} needs a hint`);
  });
  assert.match(MODES.find(m => m.id === 'sellit').how.join(' '), /pitch/i);
  assert.ok(makeDeck('sellit', 3, () => 0.3).every(prompt => modeById(prompt.kind).hint), 'every prompt can show its hint');
});

test('the whole analogy word list survived the move into its own module', () => {
  assert.equal(WORDS.length, 169);
  assert.ok(WORDS.some(([word, article, plural]) => word === 'SCISSORS' && article === null && plural === true));
});

test('analogies read correctly for singular, plural and article-less words', () => {
  assert.equal(analogyText(['BATTERY', 'A'], ['JACUZZI', 'A']), 'A BATTERY IS LIKE A JACUZZI');
  assert.equal(analogyText(['SCISSORS', null, true], ['ERASER', 'AN']), 'SCISSORS ARE LIKE AN ERASER');
});

test('decks have the right size, no repeated prompts, and Wild Mix uses every kind', () => {
  for (const mode of MODES) {
    const deck = makeDeck(mode.id, 20, seeded(7));
    assert.equal(deck.length, 20);
    assert.equal(new Set(deck.map(prompt => prompt.text)).size, 20, `${mode.id} repeats a prompt`);
    deck.forEach(prompt => assert.ok(prompt.text && prompt.tail && prompt.lead, `${mode.id} prompt is complete`));
  }
  const kinds = new Set(makeDeck('mix', 20, seeded(3)).map(prompt => prompt.kind));
  assert.deepEqual([...kinds].sort(), ['analogy', 'hottake', 'sellit']);
  assert.ok(makeDeck('analogy', 10, seeded(1)).every(prompt => /^(A |AN )?.+ (IS|ARE) LIKE /.test(prompt.text)));
});

test('the room noise estimate ignores an early speaker and the threshold sits clear above it', () => {
  const quiet = Array.from({ length: 80 }, (_, i) => -66 + (i % 5) * 0.5);
  const withSpeech = [...quiet, ...Array.from({ length: 20 }, () => -28)];
  assert.ok(Math.abs(estimateFloorDb(withSpeech) - estimateFloorDb(quiet)) < 2);
  assert.equal(estimateFloorDb([-60]), -65, 'too little to go on falls back to a quiet room');
  assert.equal(voicedThresholdDb(-70), -56, 'a silent call still needs a real voice');
  assert.equal(voicedThresholdDb(-50), -41);
});

test('speech onset is found, early blips and the game’s own chime are ignored', () => {
  const clean = analyseRound(frames(3000, [[800, 2600]]), { limitMs: 3000, floorDb: -70 });
  assert.equal(clean.onsetMs, 800);
  assert.ok(clean.talkShare > 0.75, `talk share ${clean.talkShare}`);

  const chime = analyseRound(frames(3000, [[0, 250]]), { limitMs: 3000, floorDb: -70 });
  assert.equal(chime.onsetMs, null, 'sound before the minimum reaction time is not an answer');
  assert.ok(MIN_REACTION_MS >= 300);

  const blip = analyseRound(frames(3000, [[1000, 1075]]), { limitMs: 3000, floorDb: -70 });
  assert.equal(blip.onsetMs, null, 'a cough shorter than a syllable is not speech');

  const gappy = analyseRound(frames(3000, [[600, 800], [850, 1100], [1150, 2000]]), { limitMs: 3000, floorDb: -70 });
  assert.equal(gappy.onsetMs, 600, 'tiny gaps between syllables do not restart the run');

  const late = analyseRound(frames(3500, [[3200, 3500]]), { limitMs: 3000, floorDb: -70 });
  assert.equal(late.onsetMs, null, 'speech after the buzzer is too late');
});

test('round points reward a fast start and keeping going', () => {
  const fast = scoreRound({ onsetMs: 500, talkShare: 1 }, 3000);
  assert.equal(fast.points, 100); assert.equal(fast.grade, 'lightning');
  const quick = scoreRound({ onsetMs: 1200, talkShare: 0.7 }, 3000);
  assert.ok(quick.points >= 65 && quick.points < 90, `quick ${quick.points}`);
  const slowButTalking = scoreRound({ onsetMs: 2900, talkShare: 1 }, 3000);
  assert.ok(slowButTalking.points >= 40 && slowButTalking.points <= 50, `slow ${slowButTalking.points}`);
  assert.equal(scoreRound({ onsetMs: null, talkShare: 0 }, 3000).grade, 'miss');
  assert.ok(scoreRound({ onsetMs: 1500, talkShare: 1 }, 2000).points < scoreRound({ onsetMs: 1500, talkShare: 1 }, 5000).points, 'the same start is later on a shorter clock');
  assert.deepEqual(['lightning', 'quick', 'steady', 'late', 'miss'], [90, 70, 40, 5, 0].map(points => gradeOf(points).id));
});

test('a session adds up score, stars, combo and XP, and a practice run just counts rounds', () => {
  const rounds = [{ points: 100, onsetMs: 500 }, { points: 90, onsetMs: 700 }, { points: 0, onsetMs: null }, { points: 70, onsetMs: 1100 }, { points: 60, onsetMs: 1300 }];
  const summary = summarize(rounds, { listening: true });
  assert.equal(summary.score, 64);
  assert.equal(summary.stars, 1);
  assert.equal(summary.longestCombo, 2);
  assert.equal(summary.misses, 1);
  assert.equal(summary.answered, 4);
  assert.equal(summary.bestReactionMs, 500);
  assert.equal(summary.avgReactionMs, 900);
  assert.ok(summary.xp > 25 && summary.xp < 50, `xp ${summary.xp}`);

  const perfect = summarize(Array.from({ length: 10 }, () => ({ points: 95, onsetMs: 600 })), { listening: true });
  assert.equal(perfect.stars, 3); assert.equal(perfect.longestCombo, 10);
  assert.ok(perfect.xp > summarize(Array.from({ length: 10 }, () => ({ points: 95, onsetMs: 600 })).slice(0, 3), { listening: true }).xp * 3, 'a long streak is worth more per round');

  const practice = summarize([{ points: null }, { points: null }, { points: null }], { listening: false });
  assert.equal(practice.score, null); assert.equal(practice.stars, 0); assert.equal(practice.xp, 9);
  assert.equal(summarize(rounds, { listening: true, completed: false }).finishBonus, 0, 'ending early earns no finish bonus');
});

test('ranks climb with XP and report progress to the next one', () => {
  assert.equal(rankFor(0).current.name, 'Rookie');
  assert.equal(rankFor(99).current.name, 'Rookie');
  assert.equal(rankFor(100).current.name, 'Sprinter');
  assert.equal(rankFor(150).toNext, 150);
  assert.ok(Math.abs(rankFor(200).progress - 0.5) < 1e-9);
  const top = rankFor(RANKS[RANKS.length - 1].xp + 500);
  assert.equal(top.next, null); assert.equal(top.progress, 1);
});

test('finishing a session updates the profile, awards badges once, and notices a rank-up', () => {
  const rounds = Array.from({ length: 10 }, () => ({ points: 92, onsetMs: 450 }));
  const summary = summarize(rounds, { listening: true });
  const first = applyResult(newProfile(), { summary, rounds, mode: 'analogy', limit: 3, roundCount: 10 }, 1000);
  assert.equal(first.profile.sessions, 1);
  assert.equal(first.profile.xp, summary.xp + 10);
  assert.equal(first.profile.bestScore, 92);
  assert.equal(first.profile.bestReactionMs, 450);
  assert.deepEqual(first.earned.map(badge => badge.id).sort(), ['first-blitz', 'lightning-strike', 'no-dead-air', 'on-fire', 'unstoppable'].sort());
  assert.equal(first.rankedUp, true);
  const second = applyResult(first.profile, { summary, rounds, mode: 'analogy', limit: 3, roundCount: 10 }, 2000);
  assert.equal(second.earned.length, 0, 'badges are only awarded once');
  assert.equal(second.newBest, false);
  assert.equal(second.profile.history.length, 2);

  const early = summarize(rounds.slice(0, 3), { listening: true, completed: false });
  assert.ok(!applyResult(newProfile(), { summary: early, rounds: rounds.slice(0, 3), mode: 'hottake', limit: 3, roundCount: 10 }).earned.some(badge => badge.id === 'first-blitz'), 'ending early is not a finished blitz');

  let profile = newProfile();
  for (const mode of ['analogy', 'hottake', 'sellit']) profile = applyResult(profile, { summary, rounds, mode, limit: 3, roundCount: 10 }).profile;
  assert.ok(profile.badges.includes('explorer'));
});

test('saved profiles are repaired instead of trusted', () => {
  assert.deepEqual(normalizeProfile(null), newProfile());
  const messy = normalizeProfile({ xp: -5, bestScore: 900, badges: ['first-blitz', 'made-up'], modesPlayed: ['analogy', 'x'], history: new Array(30).fill({}), settings: { mode: 'nope', limit: 9, rounds: 7, listen: false, muted: 1 } });
  assert.equal(messy.xp, 0); assert.equal(messy.bestScore, 100);
  assert.deepEqual(messy.badges, ['first-blitz']); assert.deepEqual(messy.modesPlayed, ['analogy']);
  assert.equal(messy.history.length, 12);
  assert.deepEqual(messy.settings, { mode: 'analogy', limit: 3, rounds: 10, listen: false, muted: true });
});

test('coaching tips match what happened', () => {
  const listening = (rounds, extra = {}) => ({ listening: true, rounds, misses: 0, avgReactionMs: 800, score: 70, ...extra });
  assert.match(coachingTip({ listening: false, rounds: 5 }, 3), /Hear me/);
  assert.match(coachingTip(listening(10, { misses: 4, score: 40 }), 3), /Open with a sound/);
  assert.match(coachingTip(listening(10, { avgReactionMs: 2200, score: 50 }), 3), /first word/);
  assert.match(coachingTip(listening(10, { score: 92 }), 3), /2 seconds/);
  assert.match(coachingTip(listening(10, { score: 92 }), 2), /Wild Mix/);
});
