import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, presetFor, presetById, tokenMatchesWord, highlightWords, speedBonus, longestStreak, scoreSession, gradeOf, starsFor,
  xpFor, rankFor, RANKS, applyResult, newProfile, normalizeProfile, coachingTip
} from '../spot-core.js';

const word = (state, detectedAt = 0) => ({ word: 'x', used: state === 'used', missed: state === 'missed', detectedAt: state === 'used' ? detectedAt : null });
const session = (states, extra = {}) => ({ words: states.map(s => (Array.isArray(s) ? word(...s) : word(s))), earlyStopped: false, settings: { wordInterval: 10 }, ...extra });

test('every preset fits inside its own speech time, and the settings map back to the preset', () => {
  PRESETS.filter(p => p.words).forEach(p => {
    assert.ok(p.words * p.interval <= p.duration, `${p.id} words ${p.words}×${p.interval}s must fit in ${p.duration}s`);
    assert.equal(presetFor({ thinkTime: p.think, speechDuration: p.duration, wordInterval: p.interval, numWords: p.words }), p.id);
  });
  assert.equal(presetFor({ thinkTime: 5, speechDuration: 60, wordInterval: 10, numWords: 5 }), 'custom');
  assert.equal(presetById('nope').id, 'classic');
  assert.deepEqual(presetFor({ thinkTime: 5, speechDuration: 60, wordInterval: 10, numWords: 6 }), 'classic', 'the original defaults are Classic');
});

test('word matching keeps its old leniency and nothing more', () => {
  assert.ok(tokenMatchesWord('guitars', 'Guitar'));
  assert.ok(tokenMatchesWord('guitarist', 'Guitar'));
  assert.ok(tokenMatchesWord('flies', 'Fly'));
  assert.ok(tokenMatchesWord('hoping', 'Hope'));
  assert.ok(!tokenMatchesWord('guitarist', 'Gui'), 'short targets must match exactly');
  assert.ok(!tokenMatchesWord('cat', 'Cactus'));
  assert.ok(!tokenMatchesWord('', 'Guitar'));
});

test('transcripts are split so target words can be highlighted without losing any text', () => {
  const text = 'I love my Guitar, and the oceans too!';
  const parts = highlightWords(text, ['Guitar', 'Ocean']);
  assert.equal(parts.map(p => p.text).join(''), text);
  assert.deepEqual(parts.filter(p => p.hit).map(p => p.text.trim()), ['Guitar,', 'oceans']);
  assert.deepEqual(highlightWords('', ['x']), [{ text: '', hit: false }]);
});

test('speed bonus and streaks follow the existing rules', () => {
  assert.deepEqual([0, 1, 3, 5, 9, 10, 14].map(s => speedBonus(s, 10)), [10, 9, 7, 5, 1, 0, 0]);
  assert.equal(speedBonus(3, 6), 5, 'the same moment is later on a shorter timer');
  assert.equal(longestStreak(session(['used', 'used', 'missed', 'used', 'used', 'used', 'missed']).words), 3);
  assert.equal(longestStreak([]), 0);
});

test('scores are out of 100 whatever the preset, so a short game can be perfect', () => {
  const perfectSpark = scoreSession(session([['used', 0], ['used', 0], ['used', 0], ['used', 0]]));
  assert.equal(perfectSpark.score, 100);
  const perfectMarathon = scoreSession(session(Array.from({ length: 10 }, () => ['used', 0])));
  assert.equal(perfectMarathon.score, 100);
  const slowButSteady = scoreSession(session(Array.from({ length: 6 }, () => ['used', 9])));
  assert.ok(slowButSteady.score >= 60 && slowButSteady.score <= 70, `slow ${slowButSteady.score}`);
  const half = scoreSession(session(['used', 'used', 'used', 'missed', 'missed', 'missed']));
  assert.ok(half.score < slowButSteady.score);
  assert.equal(scoreSession(session(['missed', 'missed'])).score, 0, 'never below zero');
  const stopped = scoreSession(session([['used', 1], 'missed'], { earlyStopped: true }));
  const finished = scoreSession(session([['used', 1], 'missed']));
  assert.ok(stopped.score < finished.score, 'stopping early costs points');
  assert.equal(finished.used, 1); assert.equal(finished.missed, 1); assert.equal(finished.total, 2);
  assert.equal(scoreSession({ words: [] }).score, 0);
});

test('grades, stars and XP', () => {
  assert.deepEqual([95, 82, 70, 50, 10].map(s => gradeOf(s).letter), ['S', 'A', 'B', 'C', 'D']);
  assert.deepEqual([100, 85, 84, 60, 59, 30, 29].map(starsFor), [3, 3, 2, 2, 1, 1, 0]);
  const result = scoreSession(session(Array.from({ length: 6 }, () => ['used', 1])));
  assert.equal(xpFor(result, { earlyStopped: false }), Math.round(result.score / 5) + 12 + 10 + 5);
  assert.equal(xpFor({ score: 0, used: 0, longestStreak: 0 }, { earlyStopped: true }), 0);
});

test('ranks climb with XP', () => {
  assert.equal(rankFor(0).current.name, 'Newcomer');
  assert.equal(rankFor(80).current.name, 'Improviser');
  assert.equal(rankFor(120).toNext, 120);
  const top = rankFor(RANKS[RANKS.length - 1].xp + 1);
  assert.equal(top.next, null); assert.equal(top.progress, 1);
});

test('finishing a game updates the profile once, with badges and rank-ups', () => {
  const s = session(Array.from({ length: 6 }, () => ['used', 1]));
  const result = scoreSession(s);
  const first = applyResult(newProfile(), { result, session: s, preset: 'classic' }, 1);
  assert.equal(first.profile.sessions, 1);
  assert.equal(first.profile.totalUsed, 6);
  assert.equal(first.profile.xp, first.xp);
  assert.deepEqual(first.earned.map(b => b.id).sort(), ['first-spot', 'hot-streak', 'speed-demon', 'word-wizard']);
  assert.equal(first.rankedUp, false, 'one game is not enough for a new rank');
  const second = applyResult(first.profile, { result, session: s, preset: 'classic' }, 2);
  assert.equal(second.earned.length, 0, 'badges are awarded once');
  assert.equal(second.profile.history.length, 2);

  let profile = newProfile(), last;
  for (const preset of ['spark', 'classic', 'pressure', 'endurance']) { last = applyResult(profile, { result, session: s, preset }); profile = last.profile; }
  assert.ok(profile.badges.includes('explorer'));
  assert.ok(!profile.badges.includes('century'), '24 words so far is not 100');
  for (let i = 0; i < 20; i++) last = applyResult(last.profile, { result, session: s, preset: 'classic' });
  assert.ok(last.profile.badges.includes('century'));
  assert.ok(rankFor(last.profile.xp).index >= 3, 'twenty-odd good games climb the ranks');
  assert.ok(applyResult({ ...newProfile(), xp: 70 }, { result, session: s, preset: 'classic' }).rankedUp, 'crossing a threshold is noticed');
});
