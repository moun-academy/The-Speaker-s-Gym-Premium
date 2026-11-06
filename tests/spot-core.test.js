import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRESETS, presetFor, presetById, tokenMatchesWord, highlightWords, countWords, countWordHits, estimateConnection, scoreSession,
  gradeOf, starsFor, xpFor, rankFor, RANKS, applyResult, newProfile, normalizeProfile, coachingTip, STORY_WEIGHTS
} from '../spot-core.js';

const words = (used, total = 6) => Array.from({ length: total }, (_, i) => ({ word: 'w' + i, used: i < used }));
const story = n => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');
const session = (used, spoken, extra = {}) => ({ words: words(used), transcript: story(spoken), settings: { speechDuration: 60, wordInterval: 10 }, earlyStopped: false, connection: null, ...extra });

test('every preset fits inside its own speech time, and the settings map back to the preset', () => {
  PRESETS.filter(p => p.words).forEach(p => {
    assert.ok(p.words * p.interval <= p.duration, `${p.id} words ${p.words}×${p.interval}s must fit in ${p.duration}s`);
    assert.equal(presetFor({ thinkTime: p.think, speechDuration: p.duration, wordInterval: p.interval, numWords: p.words }), p.id);
  });
  assert.equal(presetFor({ thinkTime: 5, speechDuration: 60, wordInterval: 10, numWords: 5 }), 'custom');
  assert.equal(presetById('nope').id, 'classic');
});

test('word matching keeps its old leniency and can count how many times a word was said', () => {
  assert.ok(tokenMatchesWord('guitars', 'Guitar'));
  assert.ok(tokenMatchesWord('guitarist', 'Guitar'));
  assert.ok(!tokenMatchesWord('guitarist', 'Gui'));
  assert.equal(countWordHits('The ocean, then another ocean and oceans too', 'Ocean'), 3);
  assert.equal(countWordHits('', 'Ocean'), 0);
  assert.equal(countWords('Once upon a time, there was a dragon!'), 8);
  assert.equal(countWords(''), 0);
});

test('transcripts are split so target words can be highlighted without losing any text', () => {
  const text = 'I love my Guitar, and the oceans too!';
  const parts = highlightWords(text, ['Guitar', 'Ocean']);
  assert.equal(parts.map(p => p.text).join(''), text);
  assert.deepEqual(parts.filter(p => p.hit).map(p => p.text.trim()), ['Guitar,', 'oceans']);
});

test('the score looks at the whole story: words worked in, how long it is and how well it connects', () => {
  const full = scoreSession(session(6, 90, { connection: { score: 100, feedback: 'Lovely.' } }));
  assert.equal(full.score, 100);
  assert.equal(full.targetWords, 90);
  assert.equal(STORY_WEIGHTS.words + STORY_WEIGHTS.length + STORY_WEIGHTS.connection, 100);
  assert.equal(full.connectionFeedback, 'Lovely.'); assert.equal(full.connectionEstimated, false);
  const short = scoreSession(session(6, 30, { connection: { score: 100 } }));
  assert.ok(short.score < full.score, 'a shorter story scores lower');
  const longer = scoreSession(session(6, 60, { connection: { score: 100 } }));
  assert.ok(short.score < longer.score && longer.score < full.score, 'the longer the story, the better, up to a full telling');
  const list = scoreSession(session(6, 90, { connection: { score: 20 } }));
  assert.ok(list.score < full.score - 15, 'a list of words that is not a connected story scores much lower');
  const dropped = scoreSession(session(2, 90, { connection: { score: 100 } }));
  assert.ok(dropped.score < full.score - 20, 'leaving most words out costs points');
  assert.equal(scoreSession({ words: [], transcript: story(50), settings: {} }).score, 0);
  assert.equal(scoreSession(session(0, 0)).score, 0, 'silence scores nothing');
});

test('using a word late, or only at the end, costs nothing: speed is not scored', () => {
  const early = session(6, 90, { connection: { score: 80 } }); early.words.forEach(w => { w.detectedAt = 1; });
  const late = session(6, 90, { connection: { score: 80 } }); late.words.forEach(w => { w.detectedAt = 9; });
  assert.equal(scoreSession(early).score, scoreSession(late).score);
  assert.doesNotMatch(readFileSync(new URL('../spot-core.js', import.meta.url), 'utf8'), /speedBonus|detectedAt/);
});

test('without the AI rating the connection is a capped estimate that is flagged as one', () => {
  const connectedText = 'Because the dragon was lonely, he flew to the town, and then he met a baker, so they became friends. But the mayor was angry, therefore they hid, and later they escaped.';
  assert.ok(estimateConnection(connectedText, 4) > 40);
  assert.ok(estimateConnection(connectedText, 4) <= 70);
  assert.ok(estimateConnection('dragon baker castle ocean garden bridge tower river lake island valley', 6) < 10, 'a list of nouns reads as no connection');
  const result = scoreSession(session(4, 80, { transcript: connectedText + ' ' + story(60) }));
  assert.equal(result.connectionEstimated, true);
  assert.ok(result.connection <= 70);
  assert.equal(result.connectionFeedback, '');
});

test('grades, stars and XP', () => {
  assert.deepEqual([95, 82, 70, 50, 10].map(s => gradeOf(s).letter), ['S', 'A', 'B', 'C', 'D']);
  assert.deepEqual([100, 85, 84, 60, 59, 30, 29].map(starsFor), [3, 3, 2, 2, 1, 1, 0]);
  const result = scoreSession(session(6, 90, { connection: { score: 100 } }));
  assert.equal(xpFor(result, { earlyStopped: false }), 20 + 12 + 10);
  assert.equal(xpFor({ score: 0, used: 0 }, { earlyStopped: true }), 0);
});

test('ranks climb with XP', () => {
  assert.equal(rankFor(0).current.name, 'Newcomer');
  assert.equal(rankFor(80).current.name, 'Improviser');
  assert.equal(rankFor(120).toNext, 120);
  const top = rankFor(RANKS[RANKS.length - 1].xp + 1);
  assert.equal(top.next, null); assert.equal(top.progress, 1);
});

test('finishing a game updates the profile once, with story badges and rank-ups', () => {
  const s = session(6, 160, { connection: { score: 90 } });
  const result = scoreSession(s);
  const first = applyResult(newProfile(), { result, session: s, preset: 'classic' }, 1);
  assert.equal(first.profile.sessions, 1);
  assert.equal(first.profile.totalUsed, 6);
  assert.equal(first.profile.longestStory, 160);
  assert.deepEqual(first.earned.map(b => b.id).sort(), ['connected', 'first-spot', 'storyteller', 'word-wizard']);
  const second = applyResult(first.profile, { result, session: s, preset: 'classic' }, 2);
  assert.equal(second.earned.length, 0, 'badges are awarded once');
  const estimated = scoreSession(session(6, 160, { connection: null }));
  assert.ok(!applyResult(newProfile(), { result: estimated, session: session(6, 160), preset: 'classic' }).earned.some(b => b.id === 'connected'), 'only a real rating earns the connection badge');
  let profile = newProfile(), last;
  for (const preset of ['spark', 'classic', 'pressure', 'endurance']) { last = applyResult(profile, { result, session: s, preset }); profile = last.profile; }
  assert.ok(profile.badges.includes('explorer'));
  for (let i = 0; i < 20; i++) last = applyResult(last.profile, { result, session: s, preset: 'classic' });
  assert.ok(last.profile.badges.includes('century'));
  assert.ok(applyResult({ ...newProfile(), xp: 70 }, { result, session: s, preset: 'classic' }).rankedUp);
});

test('saved profiles are repaired, and old ones keep working', () => {
  assert.deepEqual(normalizeProfile(null), newProfile());
  const old = normalizeProfile({ xp: 50, sessions: 3, totalUsed: 9, bestStreak: 5, badges: ['first-spot', 'speed-demon'] });
  assert.deepEqual(old.badges, ['first-spot'], 'a badge that no longer exists is dropped');
  assert.equal(old.xp, 50); assert.equal(old.longestStory, 0);
});

test('coaching tips are about the story, not about speed', () => {
  const tip = (used, spoken, connection) => coachingTip(scoreSession(session(used, spoken, { connection: { score: connection } })), {}, 'on');
  assert.match(coachingTip(scoreSession(session(6, 90)), {}, 'off'), /could not be read/);
  assert.match(tip(6, 3, 90), /keep talking/);
  assert.match(tip(1, 90, 90), /plot twist/);
  assert.match(tip(6, 30, 90), /Keep the story going/);
  assert.match(tip(6, 90, 30), /Connect the dots/);
  assert.match(tip(6, 90, 100), /spotlight story/);
  for (const text of [tip(6, 3, 90), tip(1, 90, 90), tip(6, 30, 90), tip(6, 90, 30), tip(6, 90, 100)]) assert.doesNotMatch(text, /faster|quickly|straight away|speed/i);
});

test('the game shows words on a schedule, keeps unused ones on the board, and goes back one step', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /A new word is shown every few seconds whether or not the last one has been used/);
  assert.match(html, /baseHits/, 'saying a word before it appears does not count');
  assert.match(html, /fetchStoryConnection/);
  assert.match(html, /window\.spotBackOneStep/);
  assert.match(html, /!window\.spotBackOneStep\?\.\(\)\) navigateToPage\('main'\)/);
  assert.doesNotMatch(html, /Speed bonus|words\[idx\]\.missed = true/);
});
