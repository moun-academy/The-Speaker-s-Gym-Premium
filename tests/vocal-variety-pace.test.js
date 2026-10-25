import test from 'node:test';
import assert from 'node:assert/strict';
import { WordPaceTracker, speakingSeconds } from '../vocal-variety-pace.js';
import { readFileSync } from 'node:fs';

const clip = (index, wpm, start = index * 3, end = start + 3) => ({ index, start, end, text: 'recognized words',
  words: Array.from({ length: Math.ceil((end - start) * wpm / 60) }, (_, i) => ({ word: `word${i}`, start: start + (i + 0.25) * 60 / wpm, end: start + (i + 0.5) * 60 / wpm })).filter(w => w.start < end) });

test('timestamps measure actual speed without rounding a three-second word count into arbitrary bands', () => {
  for (const wpm of [80, 100, 125, 150, 190]) {
    const pace = new WordPaceTracker();
    for (let i = 0; i < 4; i++) pace.add(clip(i, wpm));
    // Whole continuous utterance, rather than restarting word timing on each clip boundary.
    const continuous = new WordPaceTracker();
    continuous.add(clip(0, wpm, 0, 12));
    assert.ok(Math.abs(continuous.at(6) - wpm) < 0.01, `${wpm} WPM measured as ${continuous.at(6)}`);
    // Each synthetic clip holds a whole number of words, so it can only be as exact as that (150 reads as 8 words in 3 s = 160).
    assert.ok(Math.abs(pace.at(6) - wpm) / wpm < 0.1, `clip-edge quantization must not pin a changing voice: ${wpm} read ${pace.at(6)}`);
  }
});

test('late and repeated responses do not create fake slowdowns or double word counts', () => {
  const pace = new WordPaceTracker();
  pace.add(clip(0, 125)); pace.add(clip(2, 125));
  assert.equal(pace.at(4.5), null, 'missing middle clip is unknown, not zero words');
  pace.add(clip(1, 125));
  const measured = pace.at(4.5), count = pace.words.length;
  assert.ok(measured > 115 && measured < 135);
  pace.add(clip(1, 125));
  assert.equal(pace.words.length, count);
  assert.equal(pace.at(4.5), measured);
});

test('speed changes move up and down, and silence, stale data and invalid timestamps show no invented WPM', () => {
  const pace = new WordPaceTracker();
  pace.add(clip(0, 90, 0, 9)); pace.add(clip(1, 180, 9, 18)); pace.add(clip(2, 90, 18, 27));
  assert.ok(Math.abs(pace.at(5) - 90) < 0.01);
  assert.ok(Math.abs(pace.at(14) - 180) < 0.01);
  assert.ok(Math.abs(pace.at(23) - 90) < 0.01);
  assert.equal(pace.latest(40), null, 'old recognition cannot masquerade as current speed');
  pace.add({ index: 3, start: 27, end: 30, text: '', words: [], silent: true });
  assert.equal(pace.latest(30), null, 'silence is not a slow voice');
  const invalid = new WordPaceTracker();
  invalid.add({ index: 0, start: 0, end: 3, text: 'bad', words: [{ word: 'bad', start: NaN, end: 1 }] });
  assert.equal(invalid.at(1.5), null);
  assert.equal(invalid.words.length, 0);
  invalid.add({ index: 1, start: 3, end: 6, text: 'no timings', words: [] });
  assert.equal(invalid.latest(6), null);
});

test('the game never substitutes acoustic guesses when speech recognition fails', () => {
  const source = readFileSync(new URL('../vocal-variety.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /soundWpm|wpmFromSound|paceSource = 'sound'/);
  assert.match(source, /This round was not scored/);
  assert.match(source, /const orbX = xOf\(measuredAt\)/);
});

// words at a steady rate, optionally with a pause (seconds) after word number `after`
const talk = (wpm, count, { from = 0, after = -1, pause = 0, index = 0, clipStart = from, clipEnd } = {}) => {
  const words = Array.from({ length: count }, (_, i) => { const start = from + i * 60 / wpm + (i > after && after >= 0 ? pause : 0); return { word: `w${i}x${index}`, start, end: start + 0.2 }; });
  return { index, start: clipStart, end: clipEnd ?? (words.at(-1).end + 0.1), text: 'speech', words };
};

test('a long thinking pause barely changes the reading, but a speaker who is really slow still reads slow', () => {
  const steady = new WordPaceTracker(); steady.add(talk(150, 24));
  const paused = new WordPaceTracker(); paused.add(talk(150, 24, { after: 11, pause: 2.5 }));
  const slow = new WordPaceTracker(); slow.add(talk(80, 14));
  const mid = steady.words[12].start;
  assert.ok(Math.abs(steady.at(mid) - 150) < 0.5);
  assert.ok(paused.at(paused.words[12].start) > 125, `a two-and-a-half second pause read ${paused.at(paused.words[12].start)}`);
  assert.ok(paused.at(paused.words[12].start) < 150, 'a long pause still shows a little');
  assert.ok(Math.abs(slow.at(slow.words[7].start) - 80) < 0.5, 'a slow, steady speaker is not sped up');
  assert.equal(speakingSeconds([0, 0.4, 0.8, 5.8, 6.2]).toFixed(1), '2.0', 'five seconds of silence count as 0.8');
  assert.equal(speakingSeconds([1]), 0);
});

test('overlapping clips give each word once, from the clip where it was heard best', () => {
  const pace = new WordPaceTracker();
  // clip 0 covers 0-3.8, clip 1 covers 3-6.8; the word at 3.3 is in both, near the end of one and the start of the other
  const word = (text, start) => ({ word: text, start, end: start + 0.2 });
  pace.add({ index: 0, start: 0, end: 3.8, text: 'a', words: [word('one', 0.2), word('two', 1.4), word('three', 3.3), word('four', 3.7)] });
  pace.add({ index: 1, start: 3, end: 6.8, text: 'b', words: [word('Three', 3.45), word('four', 3.9), word('five', 5.2), word('six', 6.3)] });
  assert.deepEqual(pace.words.map(w => w.word.toLowerCase()), ['one', 'two', 'three', 'four', 'five', 'six']);
  assert.equal(pace.words.find(w => w.word.toLowerCase() === 'three').clip, 1, 'the clip that heard the word farther from its own edge owns it');
  // the two clips spelled the same sound differently ("three" and "free"): still one word, never two
  const spelled = new WordPaceTracker();
  spelled.add({ index: 0, start: 0, end: 3.8, text: 'a', words: [word('one', 0.2), word('three', 3.3), word('four', 3.7)] });
  spelled.add({ index: 1, start: 3, end: 6.8, text: 'b', words: [word('free', 3.45), word('for', 3.9), word('five', 5.2)] });
  assert.deepEqual(spelled.words.map(w => w.word), ['one', 'free', 'for', 'five'], 'each stretch of the overlap is counted from one clip');
  // a word the owning clip missed is not lost: clip 0 heard it, clip 1 did not
  const missed = new WordPaceTracker();
  missed.add({ index: 0, start: 0, end: 3.8, text: 'a', words: [word('one', 0.2), word('rare', 3.6)] });
  missed.add({ index: 1, start: 3, end: 6.8, text: 'b', words: [word('five', 5.2)] });
  assert.deepEqual(missed.words.map(w => w.word), ['one', 'rare', 'five']);
  // the same real word said twice in a row is kept when the clips do not overlap
  const apart = new WordPaceTracker();
  apart.add({ index: 0, start: 0, end: 3, text: 'x', words: [word('very', 2.7)] });
  apart.add({ index: 1, start: 3, end: 6, text: 'x', words: [word('very', 3.1)] });
  assert.equal(apart.words.length, 2);
});

test('invented words do not count: stretched timestamps and looping repeats are dropped', () => {
  const pace = new WordPaceTracker();
  const word = (text, start, length = 0.2) => ({ word: text, start, end: start + length });
  pace.add({ index: 0, start: 0, end: 6, text: 'x', words: [word('thanks', 0.5, 4.5), word('you', 1), word('you', 1.3), word('you', 1.6), word('you', 1.9), word('you', 2.2), word('real', 2.6)] });
  assert.deepEqual(pace.words.map(w => w.word), ['you', 'you', 'you', 'real'], 'a 4.5 second word and the fourth repeat are gone');
});

test('the status line has what it needs: how many words, and how far behind the newest one is', () => {
  const pace = new WordPaceTracker();
  assert.deepEqual(pace.stats(5), { words: 0, behind: null });
  pace.add(talk(120, 10));
  const s = pace.stats(12);
  assert.equal(s.words, 10);
  assert.ok(s.behind > 5 && s.behind < 8);
});

test('the game counts overlapping clips, retries, and says what is happening', () => {
  const source = readFileSync(new URL('../vocal-variety.js', import.meta.url), 'utf8');
  assert.match(source, /overlapMs: 800/);
  assert.match(source, /id="vvPaceStatus"/);
  assert.match(source, /Counting words: /);
  assert.match(source, /Is the student unmuted/);
  assert.match(source, /fail\.failures >= 4/, 'a few missed clips are tolerated before pace is called unavailable');
  assert.doesNotMatch(source, /\[401, 403, 404, 405, 500, 501\]\.includes\(fail\.status\)/, 'a single server error no longer ends pace counting');
});
