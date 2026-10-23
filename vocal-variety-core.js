// Browser-only practice measurements. These never feed the app's AI scores.
export const quantile = (values, q) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.round((sorted.length - 1) * q)] : null;
};

export function rmsOf(samples) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / samples.length) || 0;
}

// Normalized autocorrelation, with the first strong peak to avoid subharmonics.
// The Lecture 5 detector uses the same principle. Reject silence and noisy frames.
export function detectPitch(samples, sampleRate) {
  if (rmsOf(samples) < 0.008) return null;
  const minLag = Math.floor(sampleRate / 650);
  const maxLag = Math.min(Math.floor(sampleRate / 65), samples.length - 2);
  const overlap = samples.length - maxLag;
  const corr = new Float32Array(maxLag + 1);
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < overlap; i++) {
      const a = samples[i] - mean, b = samples[i + lag] - mean;
      sum += a * b; a2 += a * a; b2 += b * b;
    }
    corr[lag] = sum / (Math.sqrt(a2 * b2) || 1);
    best = Math.max(best, corr[lag]);
  }
  if (best < 0.8) return null;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] < best * 0.94 || corr[lag] < corr[lag - 1] || corr[lag] < corr[lag + 1]) continue;
    const a = corr[lag - 1], b = corr[lag], c = corr[lag + 1];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    const hz = sampleRate / (lag + Math.max(-0.5, Math.min(0.5, shift)));
    return hz >= 65 && hz <= 650 ? hz : null;
  }
  return null;
}

export const midiOf = hz => Number.isFinite(hz) && hz > 0 ? 69 + 12 * Math.log2(hz / 440) : null;
export function noteName(midi) {
  if (!Number.isFinite(midi)) return '—';
  const n = Math.round(midi);
  return ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// Energy peaks approximate syllable rhythm, not recognized words. A four-second
// window includes pauses; silence itself is never reported as a slow voice.
export class RhythmTracker {
  constructor() { this.reset(); }
  reset() { this.peaks = []; this.frames = []; this.previous = null; this.before = 0; this.floor = 0.008; this.lastPeak = -1; }
  push(t, rms) {
    this.floor = Math.min(0.02, this.floor * 0.995 + Math.min(rms, 0.02) * 0.005);
    if (this.previous && this.previous.rms > this.before && this.previous.rms >= rms
      && this.previous.rms > Math.max(0.012, this.floor * 1.65)
      && this.previous.t - this.lastPeak >= 0.12) {
      this.peaks.push(this.previous.t); this.lastPeak = this.previous.t;
    }
    this.before = this.previous?.rms || 0;
    this.previous = { t, rms };
    this.frames.push({ t, active: rms > Math.max(0.012, this.floor * 1.3) });
    this.frames = this.frames.filter(frame => frame.t >= t - 4);
    this.peaks = this.peaks.filter(peak => peak >= t - 4);
    if (t < 3 || rms < Math.max(0.012, this.floor * 1.3) || this.peaks.length < 3
      || this.frames.filter(frame => frame.active).length / this.frames.length < 0.2) return null;
    return this.peaks.length / Math.min(t, 4);
  }
}

// Loudness of the vowels only: a 2nd-order low-pass filter (default 500 Hz) before taking the
// level. Counting bumps in this signal follows syllables far better than counting bumps in the
// full signal, where consonant bursts add extra peaks to slow speech. The first part of the
// buffer is skipped while the filter settles.
export function lowPassRms(samples, sampleRate, cutoff = 500) {
  const w0 = 2 * Math.PI * cutoff / sampleRate, alpha = Math.sin(w0) / Math.SQRT2, cos = Math.cos(w0);
  const b0 = (1 - cos) / 2, b1 = 1 - cos, a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  const skip = Math.min(Math.floor(samples.length / 4), 512);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, energy = 0, count = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i], y = (b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    if (i >= skip) { energy += y * y; count++; }
  }
  return Math.sqrt(energy / Math.max(1, count)) || 0;
}

// Words per minute estimated from the sound alone, used only when the speech service is not
// available. Syllable-like peaks per second were measured against recordings of known speed
// (about 60 to 320 WPM) and these knots follow that measurement. It is an estimate: expect it to
// be right about which of Slow, Steady and Fast you are in most of the time, not to the exact WPM.
const SOUND_TO_WPM = [[1.2, 40], [1.6, 60], [2.0, 95], [2.4, 128], [2.8, 158], [3.2, 200], [3.6, 280], [4.4, 340]];
export function wpmFromSound(peaksPerSecond) {
  if (!Number.isFinite(peaksPerSecond)) return null;
  const knots = SOUND_TO_WPM;
  if (peaksPerSecond <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (peaksPerSecond <= knots[i][0]) {
      const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
      return y0 + (y1 - y0) * (peaksPerSecond - x0) / (x1 - x0);
    }
  }
  return knots.at(-1)[1];
}

// Syllable-like energy peaks per second over a short window, pauses included (a pause is part of
// slowing down). A peak must stand 3 dB above the valley before it, and be louder than `gateDb`,
// so room noise does not count. Feed it the low-passed level (see lowPassRms).
export class PaceMeter {
  constructor({ window = 3.5, gateDb = -55 } = {}) { this.window = window; this.gateDb = gateDb; this.reset(); }
  reset() { this.peaks = []; this.heard = []; this.smooth = null; this.rising = true; this.max = -Infinity; this.maxT = 0; this.min = Infinity; this.lastPeak = -1; this.start = null; }
  push(t, rms) {
    if (this.start === null) this.start = t;
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    this.smooth = this.smooth === null ? db : this.smooth * 0.45 + db * 0.55;
    const value = this.smooth;
    if (this.rising) {
      if (value > this.max) { this.max = value; this.maxT = t; }
      if (value < this.max - 3) {
        if (this.max > this.gateDb && this.maxT - this.lastPeak >= 0.1) { this.peaks.push(this.maxT); this.lastPeak = this.maxT; }
        this.rising = false; this.min = value;
      }
    } else {
      this.min = Math.min(this.min, value);
      if (value > this.min + 3) { this.rising = true; this.max = value; this.maxT = t; }
    }
    if (value > this.gateDb) this.heard.push(t);
    const from = t - this.window;
    while (this.peaks.length && this.peaks[0] < from) this.peaks.shift();
    while (this.heard.length && this.heard[0] < from) this.heard.shift();
    const span = Math.min(this.window, t - this.start);
    if (span < 1.2 || this.heard.length < 5) return null;
    return this.peaks.length / span;
  }
}

// Pitch for the pitch game: the median of recent voiced estimates, held briefly across
// unvoiced consonants so the line does not break on every "s" or "t".
export class PitchSmoother {
  constructor({ window = 0.35, hold = 0.5 } = {}) { this.window = window; this.hold = hold; this.reset(); }
  reset() { this.recent = []; this.lastVoiced = -Infinity; this.value = null; }
  push(t, midi) {
    if (Number.isFinite(midi)) { this.recent.push({ t, midi }); this.lastVoiced = t; }
    while (this.recent.length && this.recent[0].t < t - this.window) this.recent.shift();
    if (this.recent.length) this.value = quantile(this.recent.map(item => item.midi), 0.5);
    if (t - this.lastVoiced > this.hold) this.value = null;
    return this.value;
  }
}

export function summarize(frames) {
  const voiced = frames.filter(frame => Number.isFinite(frame.midi));
  const notes = new Map();
  let last = null, run = 0;
  for (const frame of frames) {
    const note = Number.isFinite(frame.midi) ? Math.round(frame.midi) : null;
    run = note !== null && note === last ? run + 1 : 1;
    if (note !== null && run >= 2) notes.set(note, (notes.get(note) || 0) + 1);
    last = note;
  }
  const pitches = voiced.map(frame => frame.midi);
  const volumes = voiced.map(frame => frame.db);
  const paces = frames.map(frame => frame.pace).filter(Number.isFinite);
  return {
    notes: [...notes.keys()].sort((a, b) => a - b),
    pitchRange: pitches.length >= 10 ? quantile(pitches, 0.9) - quantile(pitches, 0.1) : null,
    volumeRange: volumes.length >= 10 ? quantile(volumes, 0.9) - quantile(volumes, 0.1) : null,
    paceLow: paces.length >= 10 ? quantile(paces, 0.1) : null,
    paceHigh: paces.length >= 10 ? quantile(paces, 0.9) : null,
    voicedSeconds: voiced.length * 0.1
  };
}
