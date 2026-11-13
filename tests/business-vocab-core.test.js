import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WORDS, CATEGORIES, MODES, RANKS, MASTERED, ROUND_SIZE, wordById, areConfusable, newProfile, normalizeProfile, progressOf, rankFor,
  reviewIds, recordAnswer, isMastered, makeDeck, choicesFor, blankSentence, scoreRound, finishSession, verdict
} from '../business-vocab-core.js';
import { CONFUSABLE } from '../business-vocab-words.js';

const seeded = seed => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test('there are exactly 100 different words, 20 in each of the five topics', () => {
  assert.equal(WORDS.length, 100);
  assert.equal(new Set(WORDS.map(w => w.word.toLowerCase())).size, 100);
  assert.equal(new Set(WORDS.map(w => w.id)).size, 100);
  assert.equal(CATEGORIES.length, 5);
  for (const c of CATEGORIES) assert.equal(WORDS.filter(w => w.category === c.id).length, 20, c.id);
});

test('every word has a part of speech, a definition that does not give it away, and a sentence that uses it', () => {
  for (const w of WORDS) {
    assert.ok(['noun', 'verb', 'adjective'].includes(w.pos), `${w.word}: ${w.pos}`);
    assert.ok(w.definition.length > 12 && /[.]$/.test(w.definition), `${w.word} definition`);
    const plain = w.word.toLowerCase().replace(/-/g, ' ');
    const defn = w.definition.toLowerCase();
    if (!['roi', 'kpi', 'batna'].includes(w.id)) assert.ok(!new RegExp(`\\b${plain}\\b`).test(defn), `${w.word} appears in its own definition`);
    const blank = blankSentence(w);
    assert.ok(blank, `${w.word} is not in its example sentence`);
    assert.equal((blank.before + blank.answer + blank.after), w.example);
  }
});

test('the list of look-alike words only names real words', () => {
  for (const [a, b] of CONFUSABLE) { assert.ok(wordById(a), a); assert.ok(wordById(b), b); }
  assert.ok(areConfusable('merger', 'acquisition') && areConfusable('acquisition', 'merger'));
});

test('every question has four different choices, one right answer, no look-alikes, and a matching part of speech', () => {
  const rng = seeded(7);
  for (const mode of ['meaning', 'gap']) for (const w of WORDS) {
    const choices = choicesFor(w, mode, rng);
    assert.equal(choices.length, 4);
    assert.equal(new Set(choices.map(c => c.id)).size, 4);
    assert.equal(choices.filter(c => c.id === w.id).length, 1);
    for (const c of choices) if (c.id !== w.id) {
      assert.ok(!areConfusable(w.id, c.id), `${w.word} offered with ${c.word}`);
      assert.equal(c.pos, w.pos, `${w.word} (${w.pos}) offered with ${c.word} (${c.pos})`);
      if (mode === 'gap') assert.notEqual(c.category, w.category, 'in Fill the Gap the wrong words come from other topics');
    }
  }
});

test('a round has ten different words, from the chosen topic, new and shaky words before mastered ones', () => {
  let profile = newProfile();
  const deck = makeDeck(profile, { mode: 'meaning', category: 'finance', rng: seeded(3) });
  assert.equal(deck.length, ROUND_SIZE);
  assert.equal(new Set(deck.map(w => w.id)).size, ROUND_SIZE);
  assert.ok(deck.every(w => w.category === 'finance'));
  // master 15 of the 20 finance words: the next round must include all five that are left
  const finance = WORDS.filter(w => w.category === 'finance');
  for (const w of finance.slice(0, 15)) for (let i = 0; i < MASTERED; i++) profile = recordAnswer(profile, w.id, true);
  const next = makeDeck(profile, { mode: 'gap', category: 'finance', rng: seeded(9) });
  for (const w of finance.slice(15)) assert.ok(next.some(d => d.id === w.id), `${w.word} left out`);
});

test('three right answers in a row master a word; one wrong answer sends it back to review', () => {
  let profile = newProfile();
  profile = recordAnswer(profile, 'leverage', true);
  profile = recordAnswer(profile, 'leverage', true);
  assert.equal(isMastered(profile, 'leverage'), false);
  profile = recordAnswer(profile, 'leverage', false);
  assert.deepEqual(reviewIds(profile), ['leverage']);
  for (let i = 0; i < 2; i++) profile = recordAnswer(profile, 'leverage', true);
  assert.equal(isMastered(profile, 'leverage'), false, 'a mistake means three more right answers are needed');
  profile = recordAnswer(profile, 'leverage', true);
  assert.equal(isMastered(profile, 'leverage'), true);
  assert.deepEqual(reviewIds(profile), [], 'a mastered word leaves the review list');
  const review = makeDeck(recordAnswer(newProfile(), 'merger', false), { mode: 'review' });
  assert.deepEqual(review.map(w => w.id), ['merger']);
});

test('progress, ranks and scoring', () => {
  let profile = newProfile();
  assert.deepEqual(progressOf(profile), { total: 100, mastered: 0, learning: 0, fresh: 100 });
  profile = recordAnswer(profile, 'synergy', false);
  for (let i = 0; i < 3; i++) profile = recordAnswer(profile, 'pivot', true);
  assert.deepEqual(progressOf(profile, 'strategy'), { total: 20, mastered: 1, learning: 1, fresh: 18 });
  assert.equal(rankFor(0).current.name, 'Intern');
  assert.equal(rankFor(25).current.name, 'Analyst');
  assert.equal(rankFor(100).current.name, 'Boardroom Pro');
  assert.equal(rankFor(100).next, null);
  assert.equal(RANKS.at(-1).at, 100);
  const perfect = scoreRound(Array.from({ length: 10 }, () => ({ correct: true })));
  assert.deepEqual({ ...perfect }, { correct: 10, total: 10, accuracy: 1, bestStreak: 10, xp: 140, stars: 3 });
  const mixed = scoreRound([{ correct: true }, { correct: false }, { correct: true }, { correct: true }]);
  assert.equal(mixed.bestStreak, 2); assert.equal(mixed.stars, 2);
  assert.match(verdict(perfect), /Flawless/);
  const after = finishSession(newProfile(), perfect);
  assert.equal(after.xp, 140); assert.equal(after.sessions, 1); assert.equal(after.bestStreak, 10);
  assert.equal(MODES.length, 4);
});

test('saved progress is repaired, and unknown words or bad numbers are dropped', () => {
  assert.deepEqual(normalizeProfile(null), newProfile());
  const fixed = normalizeProfile({ words: { leverage: { box: 9, right: '2', wrong: -1 }, nonsense: { box: 1 } }, xp: 'x', settings: { category: 'nope' } });
  assert.deepEqual(Object.keys(fixed.words), ['leverage']);
  assert.equal(fixed.words.leverage.box, MASTERED); assert.equal(fixed.words.leverage.wrong, 0);
  assert.equal(fixed.xp, 0); assert.equal(fixed.settings.category, 'all');
});

test('the game is in the menu, is cached for offline use and goes back one step', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../build-web.js', import.meta.url), 'utf8');
  assert.match(html, /data-page="business"[\s\S]{0,200}Business Vocabulary/);
  assert.match(html, /id="bizVocabRoot"/);
  assert.match(html, /import\('\.\/business-vocab\.js'\)/);
  assert.match(html, /window\.BusinessVocab\?\.back\(\)/);
  for (const file of ['business-vocab.js', 'business-vocab-core.js', 'business-vocab-words.js', 'business-vocab.css']) {
    assert.match(sw, new RegExp(`'/${file.replace('.', '\\.')}'`)); assert.match(build, new RegExp(`'${file.replace('.', '\\.')}'`));
  }
});

test('the old hidden word game is gone, and the program task opens Business Vocabulary instead', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="vocabPage"|vocabStats|VOCAB_DATA|\.vocab-|Word Upgrade/);
  assert.match(html, /t: 'Vocabulary upgrade'[^}]*mode: 'business'/);
});
