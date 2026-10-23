import test from 'node:test';
import assert from 'node:assert/strict';
import { WordPaceTracker } from '../vocal-variety-pace.js';
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
    assert.ok(Math.abs(pace.at(6) - wpm) < 10, 'clip-edge quantization must not pin a changing voice');
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
