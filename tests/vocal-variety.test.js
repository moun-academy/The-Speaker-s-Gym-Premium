import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, rmsOf, midiOf, noteName, RhythmTracker, summarize } from '../vocal-variety-core.js';

function tone(hz, sampleRate = 48000, amplitude = 0.16) {
  return Float32Array.from({ length: 2048 }, (_, i) => amplitude * (
    Math.sin(2 * Math.PI * hz * i / sampleRate) + 0.35 * Math.sin(4 * Math.PI * hz * i / sampleRate)
  ));
}

test('pitch follows low and high voice notes across common audio sample rates', () => {
  for (const rate of [44100, 48000]) {
    for (const hz of [82.41, 110, 164.81, 220, 329.63, 440]) {
      const measured = detectPitch(tone(hz, rate), rate);
      assert.ok(measured && Math.abs(12 * Math.log2(measured / hz)) < 0.15, `${hz} Hz at ${rate}: got ${measured}`);
    }
  }
  assert.equal(noteName(midiOf(440)), 'A4');
  assert.equal(noteName(midiOf(110)), 'A2');
});

test('silence and nonperiodic noise do not become musical notes', () => {
  assert.equal(detectPitch(new Float32Array(2048), 48000), null);
  assert.equal(detectPitch(tone(220, 48000, 0.001), 48000), null);
  let seed = 42;
  const noise = Float32Array.from({ length: 2048 }, () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.2;
  });
  assert.equal(detectPitch(noise, 48000), null);
});

test('volume measurement distinguishes amplitude without changing detected pitch', () => {
  const soft = tone(220, 48000, 0.03), strong = tone(220, 48000, 0.12);
  assert.ok(Math.abs(20 * Math.log10(rmsOf(strong) / rmsOf(soft)) - 12.041) < 0.01);
  assert.ok(Math.abs(detectPitch(soft, 48000) - detectPitch(strong, 48000)) < 0.1);
});

test('notes used means sustained distinct notes; range is a separate robust measurement', () => {
  const frames = Array.from({ length: 60 }, (_, i) => ({ t: i / 10, midi: i < 30 ? 45 : 52, db: i < 30 ? -38 : -24, pace: i < 30 ? 2 : 4 }));
  frames.push({ t: 6, midi: 80, db: -4, pace: null }); // transient outlier
  const summary = summarize(frames);
  assert.deepEqual(summary.notes, [45, 52]);
  assert.equal(summary.pitchRange, 7);
  assert.equal(summary.volumeRange, 14);
  assert.equal(summary.paceLow, 2);
  assert.equal(summary.paceHigh, 4);
  assert.equal(summarize([]).pitchRange, null);
  assert.deepEqual(summarize([{ midi: null }]).notes, []);
});

function rhythmAt(rate) {
  const tracker = new RhythmTracker(); let value;
  for (let i = 0; i <= 500; i++) {
    const t = i * 0.02;
    value = tracker.push(t, 0.04 + 0.08 * (0.5 + 0.5 * Math.cos(2 * Math.PI * rate * t)));
  }
  return value;
}

test('estimated rhythm distinguishes slow and fast syllable pulses and rejects silence', () => {
  assert.ok(Math.abs(rhythmAt(2) - 2) < 0.4);
  assert.ok(Math.abs(rhythmAt(4) - 4) < 0.4);
  const tracker = new RhythmTracker();
  for (let i = 0; i < 500; i++) assert.equal(tracker.push(i * 0.02, 0), null);
  assert.equal(rhythmAt(0), null); // sustained hum has no syllable peaks
});

function sine(hz, rate = 48000, amplitude = 0.2, length = 2048) {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
}

test('the vowel filter passes voice-range sound and removes hiss and consonant bursts', async () => {
  const { lowPassRms } = await import('../vocal-variety-core.js');
  const low = lowPassRms(sine(150), 48000, 500), high = lowPassRms(sine(6000), 48000, 500);
  assert.ok(Math.abs(low - 0.2 / Math.SQRT2) < 0.01, `150 Hz passes: ${low}`);
  assert.ok(20 * Math.log10(low / high) > 30, `6 kHz is at least 30 dB quieter: ${20 * Math.log10(low / high)}`);
  assert.equal(lowPassRms(new Float32Array(2048), 48000), 0);
});

test('sound-only pace estimates follow measured recordings and rise with speed', async () => {
  const { wpmFromSound } = await import('../vocal-variety-core.js');
  assert.equal(wpmFromSound(NaN), null);
  assert.equal(wpmFromSound(null), null);
  let last = -Infinity;
  for (let peaks = 0.5; peaks <= 5; peaks += 0.1) { const wpm = wpmFromSound(peaks); assert.ok(wpm >= last, `${peaks}/s`); last = wpm; }
  assert.ok(wpmFromSound(1.6) < 110 && wpmFromSound(2.0) < 110, 'a slow rhythm reads as Slow');
  assert.ok(wpmFromSound(2.4) >= 110 && wpmFromSound(2.4) < 140, 'a middle rhythm reads as Steady');
  assert.ok(wpmFromSound(2.8) >= 140 && wpmFromSound(3.2) >= 140, 'a quick rhythm reads as Fast');
});
