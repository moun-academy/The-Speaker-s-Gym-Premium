// Pace uses recognized, timestamped words, never sound peaks converted into invented WPM.
// Responses may arrive out of order. A missing clip is unknown, not a silent/slow speaker.
export class WordPaceTracker {
  constructor() { this.clips = new Map(); this.words = []; this.ranges = []; }
  add(clip) {
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.end <= clip.start) return;
    if (clip.text?.trim() && !clip.words?.length) return;
    const words = (clip.words || []).filter(w => Number.isFinite(w.start) && Number.isFinite(w.end)
      && w.start >= clip.start - 0.1 && w.start < clip.end && w.end >= w.start && /[\p{L}\p{N}]/u.test(w.word));
    this.clips.set(clip.index, { ...clip, words });
    const clips = [...this.clips.values()].sort((a, b) => a.start - b.start);
    this.ranges = [];
    for (const c of clips) {
      const last = this.ranges.at(-1);
      if (last && c.start <= last.end + 0.12) last.end = Math.max(last.end, c.end);
      else this.ranges.push({ start: c.start, end: c.end });
    }
    this.words = clips.flatMap(c => c.words).sort((a, b) => a.start - b.start)
      .filter((w, i, all) => !i || w.start - all[i - 1].start > 0.05 || w.word !== all[i - 1].word);
  }
  at(t) {
    const range = this.ranges.find(r => t >= r.start && t <= r.end);
    if (!range) return null;
    const from = Math.max(range.start, t - 3), to = Math.min(range.end, t + 3);
    // Do not fill a gap in the middle of a recording with a tiny edge window.
    if (from > Math.max(0, t - 3) + 0.12 || to - from < 2.5) return null;
    const words = this.words.filter(w => w.start >= from && w.start < to);
    if (words.length < 4) return null;
    const first = words[0].start, last = words.at(-1).start;
    if (last - first < 1.2 || t < first - 1 || t > words.at(-1).end + 1) return null;
    return (words.length - 1) * 60 / (last - first);
  }
  latest(now) {
    const range = this.ranges.at(-1);
    if (!range || now - range.end > 8 || !this.words.length || this.words.at(-1).end < range.end - 1.5) return null;
    const at = Math.max(range.start, range.end - 3), wpm = this.at(at);
    return Number.isFinite(wpm) ? { at, wpm, countedTo: range.end } : null;
  }
}
