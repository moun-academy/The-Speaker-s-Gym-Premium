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
