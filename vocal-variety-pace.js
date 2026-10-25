// Pace uses recognized, timestamped words, never sound peaks converted into invented WPM.
// Responses may arrive out of order. A missing clip is unknown, not a silent/slow speaker.
//
// Words a minute is read over a window of WINDOW seconds either side of a moment. Inside the window a long
// pause counts for only a little more than an ordinary gap between words, so thinking for two seconds does not
// make a fast speaker read as slow; a speaker who really is slow still reads slow.
const WINDOW = 4;                 // seconds either side: about 8 seconds, enough words to steady the reading
const MAX_WORD_SECONDS = 2;       // a "word" that lasts longer than this is a timestamp glitch
const MAX_REPEAT = 3;             // more identical words in a row than this is the speech service looping
const NEAR_SECONDS = 0.45;        // a word this close to one in the neighbouring clip is the same word, however it was spelled

const key = word => String(word).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const median = list => { const sorted = [...list].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

// Seconds of speaking between the first and last word: gaps longer than a pause allowance count as the allowance.
export function speakingSeconds(starts) {
  if (starts.length < 2) return 0;
  const gaps = starts.slice(1).map((start, i) => start - starts[i]);
  const allowance = Math.max(0.8, 1.6 * median(gaps));
  return gaps.reduce((sum, gap) => sum + Math.min(gap, allowance), 0);
}

export class WordPaceTracker {
  constructor() { this.clips = new Map(); this.words = []; this.ranges = []; }
  add(clip) {
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.end <= clip.start) return;
    if (clip.text?.trim() && !clip.words?.length) return;
    let run = 0, previous = null;
    const words = (clip.words || []).filter(w => Number.isFinite(w.start) && Number.isFinite(w.end)
      && w.start >= clip.start - 0.1 && w.start < clip.end && w.end >= w.start && w.end - w.start <= MAX_WORD_SECONDS && /[\p{L}\p{N}]/u.test(w.word))
      .filter(w => { run = key(w.word) === previous ? run + 1 : 1; previous = key(w.word); return run <= MAX_REPEAT; });
    this.clips.set(clip.index, { ...clip, words });
    const clips = [...this.clips.values()].sort((a, b) => a.start - b.start);
    this.ranges = [];
    for (const c of clips) {
      const last = this.ranges.at(-1);
      if (last && c.start <= last.end + 0.12) last.end = Math.max(last.end, c.end);
      else this.ranges.push({ start: c.start, end: c.end });
    }
    // Clips can overlap, so a stretch of speech may be heard twice, perhaps spelled differently each time. Each stretch is
    // counted from one clip only: the one that heard it farther from its edge (the midpoint of the overlap is the crossover).
    // A word is only dropped if the clip that owns that stretch also has a word right there, so a missed word is not lost.
    const overlaps = (c, d) => Math.max(c.start, d.start) < Math.min(c.end, d.end) - 0.05;
    const near = (c, w) => c.words.some(o => Math.abs(o.start - w.start) < NEAR_SECONDS);
    const kept = [];
    for (const c of clips) {
      for (const w of c.words) {
        const mid = (w.start + w.end) / 2;
        const owned = clips.every(d => {
          if (d === c || !overlaps(c, d)) return true;
          const cFirst = c.start < d.start || (c.start === d.start && c.index < d.index);
          const crossover = ((cFirst ? d.start : c.start) + (cFirst ? c.end : d.end)) / 2;
          const theirs = cFirst ? mid >= crossover : mid < crossover;
          return !(theirs && near(d, w));
        });
        if (owned) kept.push({ ...w, key: key(w.word), clip: c.index });
      }
    }
    this.words = kept.sort((a, b) => a.start - b.start);
  }
  at(t) {
    const range = this.ranges.find(r => t >= r.start && t <= r.end);
    if (!range) return null;
    const from = Math.max(range.start, t - WINDOW), to = Math.min(range.end, t + WINDOW);
    // Do not fill a gap in the middle of a recording with a tiny edge window.
    if (from > Math.max(0, t - WINDOW) + 0.12 || to - from < 2.5) return null;
    const words = this.words.filter(w => w.start >= from && w.start < to);
    if (words.length < 4) return null;
    const first = words[0].start, last = words.at(-1).start;
    if (last - first < 1.2 || t < first - 1 || t > words.at(-1).end + 1) return null;
    const seconds = speakingSeconds(words.map(w => w.start));
    return seconds > 0 ? (words.length - 1) * 60 / seconds : null;
  }
  latest(now) {
    const range = this.ranges.at(-1);
    if (!range || now - range.end > 8 || !this.words.length || this.words.at(-1).end < range.end - 1.5) return null;
    const at = Math.max(range.start, range.end - WINDOW), wpm = this.at(at);
    return Number.isFinite(wpm) ? { at, wpm, countedTo: range.end } : null;
  }
  // What the live status line shows: how many words have been recognized and how far behind the newest one is.
  stats(now) {
    const last = this.words.at(-1);
    return { words: this.words.length, behind: last ? Math.max(0, now - last.end) : null };
  }
}
