// Vocal Variety Arena: a web-only practice game. Answer a question with PREP (Point, Reason,
// Example, Final Point) and vary your volume, pitch or pace while you speak.
// Audio stays in this browser and nothing is uploaded.
import { detectPitch, rmsOf, midiOf, noteName, PaceMeter } from './vocal-variety-core.js';
import {
  BADGES, CALL_DEFAULT_NATURAL, DEFAULT_SCALE, DEFAULT_SPEECH, DIMENSIONS, DIM_ORDER, FRAME_DT, PREP_PARTS, QUESTIONS, SOFT_EDGE, SPEECH_LENGTHS, STAGES, STRONG_EDGE,
  VoiceTracker, applyRound, applyTune, callScale, coachingTip, learnCallLevel, countSwings, lengthLabel, normalizeScale, phaseAt, prepBreakdown, questionIndexFor,
  rangeLabel, rankFor, ribbonCredit, sanitizeProgress, scaleFromCalibration, scaleStage, scoreRound, stageById, targetAt, zoneLabel, zoneOf
} from './vocal-variety-game.js';

const native = window.Capacitor?.isNativePlatform?.() || ['capacitor:', 'ionic:'].includes(location.protocol);

// ---------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------
const PROGRESS_KEY = 'sg-vocal-arena-v1', SCALE_KEY = 'sg-vocal-arena-scale-v1', MUTE_KEY = 'sg-vocal-arena-muted', PREP_KEY = 'sg-vocal-arena-prep', SPEECH_KEY = 'sg-vocal-arena-speech', CALL_KEY = 'sg-vocal-arena-call-v1';
const PREP_CHOICES = [30, 60, 90, 120];
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: progress simply is not kept */ } }
const DIM_INFO = {
  volume: { icon: '🔊', blurb: 'How loud you are.', map: 'See exactly where your volume went.' },
  pitch: { icon: '🎵', blurb: 'How high or low your voice is.', map: 'See your melody: where your voice went up and down.' },
  pace: { icon: '⏱️', blurb: 'How fast you speak, and your pauses.', map: 'See your speed: where you sped up, slowed down and paused.' },
  all: { icon: '👑', blurb: 'Volume, pitch and pace together.', map: 'All three dimensions of your voice, side by side.' }
};
const dimsOf = stage => stage.dim === 'all' ? DIM_ORDER : [stage.dim];
const zoneNames = dim => [zoneLabel(dim, 'strong'), zoneLabel(dim, 'natural'), zoneLabel(dim, 'soft')];

// Colour follows the level everywhere: violet (low zone) → teal (middle) → amber (high zone) → coral (peak).
const STOPS = [[-0.1, [139, 124, 246]], [0.12, [167, 139, 250]], [0.5, [45, 212, 191]], [0.78, [251, 191, 36]], [1.05, [251, 113, 133]]];
function levelRgb(level) {
  if (level <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    if (level <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], k = (level - a) / (b - a);
      return ca.map((v, n) => Math.round(v + (cb[n] - v) * k));
    }
  }
  return STOPS.at(-1)[1];
}
const levelColor = (level, alpha = 1) => `rgba(${levelRgb(level).join(',')},${alpha})`;

function roundedRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function sizeCanvas(canvas, height) {
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (rect.width < 1) return null;
  const pixelW = Math.round(rect.width * dpr), pixelH = Math.round(height * dpr);
  if (canvas.width !== pixelW) canvas.width = pixelW;   // assigning a size clears the canvas, so only when it changed
  if (canvas.height !== pixelH) canvas.height = pixelH;
  if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: height };
}
function levelGradient(ctx, top, bottom, hiLevel, loLevel, alpha = 1) {
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  for (const level of [loLevel, 0.12, 0.5, 0.78, hiLevel]) gradient.addColorStop(clamp((hiLevel - level) / (hiLevel - loLevel), 0, 1), levelColor(level, alpha));
  return gradient;
}

// Lanes: one full-height lane for a single dimension, three stacked lanes for All Three.
const HI = 1.12, LO = -0.12;
function lanesFor(stage, top, height) {
  if (stage.dim !== 'all') return [{ dim: stage.dim, y0: top, h: height, guided: stage.kind === 'guided', solo: true }];
  const gap = 10, each = (height - gap * 2) / 3;
  return DIM_ORDER.map((dim, i) => ({ dim, y0: top + i * (each + gap), h: each, guided: false, solo: false }));
}
const laneY = lane => level => lane.y0 + (1 - (clamp(level, LO, HI) - LO) / (HI - LO)) * lane.h;
function drawLaneBands(ctx, lane, L, pw, compact) {
  const yOf = laneY(lane);
  const names = { strong: zoneLabel(lane.dim, 'strong').toUpperCase(), natural: zoneLabel(lane.dim, 'natural').toUpperCase(), soft: zoneLabel(lane.dim, 'soft').toUpperCase() };
  for (const [zone, a, b] of [['strong', STRONG_EDGE, HI], ['natural', SOFT_EDGE, STRONG_EDGE], ['soft', LO, SOFT_EDGE]]) {
    const y1 = yOf(b), y2 = yOf(a), mid = (a + b) / 2, g = ctx.createLinearGradient(0, y1, 0, y2);
    g.addColorStop(0, levelColor(mid, 0.2)); g.addColorStop(1, levelColor(mid, 0.06));
    ctx.fillStyle = g; roundedRect(ctx, L, y1 + 1.5, pw, y2 - y1 - 3, lane.solo ? 14 : 8); ctx.fill();
    if (lane.solo) {
      ctx.fillStyle = levelColor(mid, 0.95); ctx.font = `800 ${compact ? 10 : 11}px Inter, system-ui, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(compact && names[zone] === 'WHISPER' ? 'SOFT' : names[zone], L - 10, (y1 + y2) / 2);
    }
  }
  if (!lane.solo) {
    ctx.fillStyle = 'rgba(235,240,250,.9)'; ctx.font = '800 10px Inter, system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(DIMENSIONS[lane.dim].name.toUpperCase(), L - 10, lane.y0 + lane.h / 2 - 6);
    ctx.fillStyle = 'rgba(160,175,200,.8)'; ctx.font = '600 9px Inter, system-ui';
    ctx.fillText(`${zoneLabel(lane.dim, 'soft')} → ${zoneLabel(lane.dim, 'strong')}`, L - 10, lane.y0 + lane.h / 2 + 7);
  }
}
function traceRuns(frames, dim) {
  const runs = []; let run = [];
  for (const frame of frames) { if (Number.isFinite(frame[dim])) run.push(frame); else { if (run.length) runs.push(run); run = []; } }
  if (run.length) runs.push(run);
  return runs;
}

// ---------------------------------------------------------------------------------------
// art: a game's shape as an SVG
// ---------------------------------------------------------------------------------------
function planArt(stage, { w = 260, h = 100, labels = false, id = stage.id } = {}) {
  const pad = 14, usable = h - pad * 2, plan = stage.plan;
  const yOf = level => pad + (1 - clamp(level, 0, 1)) * usable;
  let line = '', ribbon = '', marks = '';
  if (stage.kind === 'guided') {
    const half = DIMENSIONS[stage.dim].band * usable, upper = [], lower = [];
    for (let i = 0; i <= 90; i++) {
      const t = plan.duration * i / 90, x = (w * i / 90).toFixed(1), y = yOf(targetAt(plan, t));
      line += `${i ? 'L' : 'M'}${x} ${y.toFixed(1)}`;
      upper.push(`${x} ${Math.max(2, y - half).toFixed(1)}`); lower.unshift(`${x} ${Math.min(h - 2, y + half).toFixed(1)}`);
    }
    ribbon = `M${upper.join('L')}L${lower.join('L')}Z`;
  } else {
    const seed = { volume: 0.6, pitch: 2.1, pace: 3.7, all: 1.3 }[stage.dim];
    const waves = stage.dim === 'all' ? [0.26, 0.5, 0.74] : [0.5];
    for (const base of waves) {
      for (let i = 0; i <= 120; i++) {
        const x = w * i / 120, p = i / 120;
        const level = base + (stage.dim === 'all' ? 0.14 : 0.34) * Math.sin(p * 17 + seed + base * 9) * Math.sin(p * 5.3 + 1.2) + 0.06 * Math.sin(p * 41 + seed);
        line += `${i ? 'L' : 'M'}${x.toFixed(1)} ${yOf(level).toFixed(1)}`;
      }
    }
  }
  if (labels) marks = plan.phases.map((p, i) => i ? `<line x1="${(p.from / plan.duration * w).toFixed(1)}" y1="6" x2="${(p.from / plan.duration * w).toFixed(1)}" y2="${h - 6}" class="vv-art-divider"/>` : '').join('');
  const gradient = `<linearGradient id="vvg-${id}" x1="0" y1="${pad}" x2="0" y2="${h - pad}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${levelColor(1.0)}"/><stop offset=".22" stop-color="${levelColor(0.78)}"/><stop offset=".55" stop-color="${levelColor(0.5)}"/><stop offset="1" stop-color="${levelColor(0.1)}"/></linearGradient>`;
  return `<svg class="vv-art" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><defs>${gradient}</defs>` +
    `${ribbon ? `<path d="${ribbon}" fill="url(#vvg-${id})" opacity=".2"/>` : ''}${marks}` +
    `<path d="${line}" fill="none" stroke="url(#vvg-${id})" stroke-width="3.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" ${stage.kind === 'free' ? 'stroke-dasharray="1 7"' : ''}/></svg>`;
}
const starsHtml = (count, extra = '') => `<span class="vv-stars ${extra}" aria-label="${count} of 3 stars">${[0, 1, 2].map(i => `<i class="${i < count ? 'on' : ''}" aria-hidden="true">★</i>`).join('')}</span>`;
const modeTag = stage => stage.kind === 'guided' ? 'GUIDED · FOLLOW THE RIBBON' : stage.dim === 'all' ? 'FREESTYLE · ALL THREE' : 'FREESTYLE · HIT THE GOALS';

// ---------------------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------------------
function mount() {
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/vocal-variety.css'; document.head.append(css);
  const menu = document.createElement('button');
  menu.type = 'button'; menu.className = 'menu-item'; menu.dataset.page = 'variety'; menu.id = 'menuVariety';
  menu.innerHTML = '<span class="menu-item-icon" aria-hidden="true">🎚️</span><span>Expand Your Vocal Variety</span>';
  document.querySelector('#menuAnalytics').before(menu);

  const root = document.createElement('section');
  root.id = 'varietyPage'; root.className = 'container page vv-page'; root.setAttribute('aria-label', 'Expand your vocal variety');
  root.innerHTML = `
    <div class="vv-topline"><button type="button" class="vv-back" id="vvBack" data-act="back">← Home</button><span class="vv-beta">WEB BETA</span>
      <button type="button" class="vv-sound" id="vvSound" data-act="sound" aria-pressed="false" aria-label="Sound effects"><span aria-hidden="true">♪</span></button><span class="vv-brand">SPEAKER’S GYM</span></div>
    <div id="vvView" class="vv-viewport"></div>
    <p class="vv-sr" id="vvAnnounce" role="status" aria-live="polite"></p>`;
  document.querySelector('#mainPage').after(root);
  // Toasts and confetti live on <body>: the page container has a blur filter, which would trap position:fixed.
  const toasts = Object.assign(document.createElement('div'), { className: 'vv-toasts', role: 'status' });
  toasts.setAttribute('aria-live', 'polite');
  const confettiCanvas = Object.assign(document.createElement('canvas'), { className: 'vv-confetti' });
  confettiCanvas.setAttribute('aria-hidden', 'true');
  document.body.append(toasts, confettiCanvas);
  const $ = selector => root.querySelector(selector);
  const viewEl = $('#vvView');

  // ----- state ---------------------------------------------------------------------------
  let progress = sanitizeProgress(read(PROGRESS_KEY));
  let scale = null, scaleIsDefault = false;
  const savedScale = read(SCALE_KEY);
  if (savedScale?.scale && Date.now() - savedScale.at < 12 * 3600e3) scale = normalizeScale(savedScale.scale);
  let muted = read(MUTE_KEY) === true;
  let prepSeconds = PREP_CHOICES.includes(read(PREP_KEY)) ? read(PREP_KEY) : 60;
  let speechSeconds = SPEECH_LENGTHS.includes(read(SPEECH_KEY)) ? read(SPEECH_KEY) : DEFAULT_SPEECH;
  let view = 'home', stage = null, questionIndex = 0, notice = '';
  let notes = { point: '', reason: '', example: '', finalPoint: '' };
  let tune = null, prep = null, round = null, result = null, award = null, example = false, after = null;
  let micToken = 0, sfx = null, confettiFrame = null, printFrame = null, playbackFrame = null, cursor = null;
  const audioEl = new Audio(); audioEl.controls = true; audioEl.preload = 'metadata'; audioEl.setAttribute('aria-label', 'Playback of your answer');
  let audioUrl = null;
  const question = () => QUESTIONS[questionIndex];
  const clearNotes = () => { notes = { point: '', reason: '', example: '', finalPoint: '' }; };
  const prepared = () => PREP_PARTS.every(part => notes[part.key].trim().length > 0);

  // ----- audio helpers ---------------------------------------------------------------------
  // The audio source is the microphone, or, when "Capture Audio from Video Calls" is on in Settings
  // (the same switch the home-page recorder uses), the audio of a call tab such as Google Meet.
  const callOn = () => { try { return localStorage.getItem('callAudioMode') === 'true'; } catch { return false; } };
  let callNatural = CALL_DEFAULT_NATURAL;
  const savedCall = read(CALL_KEY);
  if (Number.isFinite(savedCall?.natural) && Date.now() - savedCall.at < 12 * 3600e3) callNatural = savedCall.natural;
  const learnCall = (dbs, weight) => { callNatural = learnCallLevel(callNatural, dbs, weight); write(CALL_KEY, { natural: callNatural, at: Date.now() }); };
  // The tuned range for a microphone; zones that follow the call's typical level for a call tab.
  const activeScale = () => callOn() ? callScale(callNatural) : scale;
  let callStream = null;   // the shared call-tab audio, kept for the session so the picker shows once

  async function openMic(token) {
    return callOn() ? openCall(token) : openMicrophone(token);
  }
  async function openMicrophone(token) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices?.getUserMedia || !Ctx) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (token !== micToken) { stream.getTracks().forEach(track => track.stop()); return null; }
    const context = new Ctx(); await context.resume();
    if (token !== micToken) { stream.getTracks().forEach(track => track.stop()); context.close().catch(() => {}); return null; }
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    const source = context.createMediaStreamSource(stream); source.connect(analyser);
    return { stream, context, analyser, source, buffer: new Float32Array(analyser.fftSize) };
  }
  async function openCall(token) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices?.getDisplayMedia || !Ctx) throw Object.assign(new Error('unsupported'), { name: 'UnsupportedCall' });
    if (!callStream || callStream.getAudioTracks().every(track => track.readyState !== 'live')) {
      // getDisplayMedia needs a video track in most browsers; only the audio is kept.
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      display.getVideoTracks().forEach(track => track.stop());
      const tracks = display.getAudioTracks();
      if (!tracks.length) throw Object.assign(new Error('no audio'), { name: 'NoCallAudio' });
      if (token !== micToken) { tracks.forEach(track => track.stop()); return null; }
      callStream = new MediaStream(tracks);
      tracks[0].addEventListener('ended', () => {
        if (!callStream || callStream.getAudioTracks()[0] !== tracks[0]) return;
        callStream = null;
        toast('Call audio stopped. The tab may have been closed.', '📞');
        if (round || prep || tune) { notice = 'The call audio stopped. Press Start preparing and choose your Meet tab again.'; if (tune) { tune = null; go('home', { quiet: true }); } else go('brief', { quiet: true }); }
        else render();
      });
    }
    const context = new Ctx(); await context.resume();
    if (token !== micToken) { context.close().catch(() => {}); return null; }
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    const source = context.createMediaStreamSource(callStream); source.connect(analyser);
    return { stream: callStream, context, analyser, source, buffer: new Float32Array(analyser.fftSize), shared: true };
  }
  function disconnectCall() {
    callStream?.getTracks().forEach(track => track.stop());
    callStream = null;
  }
  function closeMic(mic) {
    if (!mic) return;
    if (!mic.shared) mic.stream.getTracks().forEach(track => track.stop());   // the call tab stays connected between rounds
    try { mic.source.disconnect(); } catch { /* already disconnected */ }
    if (mic.context.state !== 'closed') mic.context.close().catch(() => {});
  }
  const dbOf = rms => 20 * Math.log10(Math.max(rms, 1e-5));
  const micMessage = error => error?.name === 'NotAllowedError'
    ? (callOn() ? 'The call tab was not shared. Press Start preparing again and choose your Google Meet tab.' : 'Microphone access was declined. Allow it in your browser’s site settings, then try again.')
    : error?.name === 'NoCallAudio' ? 'No audio was shared. Choose your Google Meet tab and tick “Also share tab audio”, then try again.'
    : error?.name === 'UnsupportedCall' ? 'Call audio needs Chrome or Edge on a computer. Turn off “Capture Audio from Video Calls” in Settings to use the microphone.'
    : error?.name === 'Unsupported' ? 'Live practice needs a browser with microphone support. Try Chrome, Edge, or Safari over HTTPS.'
    : 'Could not start the microphone. Check that it is connected and not used by another app, then try again.';

  function chime(notesHz = [523.25, 659.25, 783.99], gap = 0.11, volume = 0.1) {
    if (muted) return;
    try {
      sfx ||= new (window.AudioContext || window.webkitAudioContext)();
      sfx.resume?.();
      const now = sfx.currentTime;
      notesHz.forEach((freq, i) => {
        const osc = sfx.createOscillator(), gain = sfx.createGain(), start = now + i * gap;
        osc.type = 'triangle'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(volume, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
        osc.connect(gain).connect(sfx.destination); osc.start(start); osc.stop(start + 0.5);
      });
    } catch { /* sound is optional */ }
  }
  function releaseAudio() {
    audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null; cancelAnimationFrame(playbackFrame); cursor = null;
  }
  function announce(message) { $('#vvAnnounce').textContent = ''; setTimeout(() => { $('#vvAnnounce').textContent = message; }, 30); }
  function toast(message, icon = '✦') {
    const el = document.createElement('div'); el.className = 'vv-toast';
    el.innerHTML = `<span aria-hidden="true">${esc(icon)}</span><span>${esc(message)}</span>`;
    toasts.append(el); setTimeout(() => el.remove(), 5200);
  }
  function save() { write(PROGRESS_KEY, progress); }

  // ----- navigation ------------------------------------------------------------------------
  function teardown({ keepMic = false } = {}) {
    micToken++;
    if (round) { clearInterval(round.interval); cancelAnimationFrame(round.raf); round.timers.forEach(clearTimeout); if (round.recorder?.state === 'recording') { round.recorder.onstop = null; round.recorder.stop(); } closeMic(round.mic); round = null; }
    if (tune) { clearInterval(tune.interval); closeMic(tune.mic); tune = null; }
    if (prep) { clearInterval(prep.interval); if (!keepMic) closeMic(prep.mic); prep = null; }
    cancelAnimationFrame(printFrame); cancelAnimationFrame(confettiFrame);
    confettiCanvas.getContext('2d').clearRect(0, 0, 9999, 9999);
    window.speechSynthesis?.cancel();
  }
  function go(next, options = {}) {
    teardown();
    if (next !== 'results') releaseAudio();
    view = next;
    if (next === 'home') { example = false; }
    render();
    const heading = viewEl.querySelector('[data-focus]');
    if (heading && !options.quiet) heading.focus({ preventScroll: true });
    if (!options.quiet) root.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function render() {
    $('#vvSound').setAttribute('aria-pressed', String(!muted)); $('#vvSound').classList.toggle('off', muted);
    $('#vvSound').firstElementChild.textContent = muted ? '♪̸' : '♪';
    $('#vvBack').textContent = view === 'home' ? '← Home' : '← All games';
    viewEl.dataset.view = view;
    viewEl.innerHTML = { home: homeHtml, tune: tuneHtml, brief: briefHtml, prep: prepHtml, live: liveHtml, results: resultsHtml }[view]();
    if (view === 'live') drawStageFrame();
    if (view === 'results') afterResults();
  }

  // ----- HOME ------------------------------------------------------------------------------
  const nextStage = () => STAGES.find(item => !(progress.stars[item.id] > 0)) || STAGES.find(item => (progress.stars[item.id] || 0) < 3) || STAGES[0];
  const totalStars = () => STAGES.reduce((sum, item) => sum + (progress.stars[item.id] || 0), 0);

  function homeHtml() {
    const rank = rankFor(progress.xp), upNext = nextStage(), started = progress.rounds > 0;
    const bars = Array.from({ length: 40 }, (_, i) => `<i style="--i:${i};--d:${(i * 0.37) % 2.4}s"></i>`).join('');
    const group = dim => {
      const games = STAGES.filter(item => item.dim === dim);
      return `<section class="vv-dim vv-dim-${dim}" aria-labelledby="vvDim-${dim}">
        <div class="vv-dim-head"><span class="vv-dim-icon" aria-hidden="true">${DIM_INFO[dim].icon}</span><div><h3 id="vvDim-${dim}">${dim === 'all' ? 'All three together' : DIMENSIONS[dim].name}</h3>
          <p>${esc(DIM_INFO[dim].blurb)} ${dim === 'all' ? '' : `<span class="vv-zone-row">${zoneNames(dim).reverse().map((name, i) => `<b class="${['z-soft', 'z-natural', 'z-strong'][i]}">${esc(name)}</b>`).join('')}</span>`}</p></div></div>
        <div class="vv-games">${games.map(gameCard).join('')}</div></section>`;
    };
    return `
    <header class="vv-hero">
      <div class="vv-hero-copy">
        <div class="vv-eyebrow">VOICE ARENA · VOCAL VARIETY + STRUCTURE</div>
        <h1 id="vvTitle" tabindex="-1" data-focus>Expand your<br><em>vocal variety.</em></h1>
        <p class="vv-lede">Answer a real question with <b>PREP</b>: Point, Reason, Example, Final Point. Take time to prepare, then speak while the game shows your <b>volume</b>, <b>pitch</b> and <b>pace</b> moving live.</p>
        <div class="vv-hero-actions">
          <button type="button" class="vv-primary" data-act="open-stage" data-stage="${upNext.id}"><span aria-hidden="true">▶</span> ${started ? 'Continue' : 'Start'}: ${esc(upNext.title)}</button>
          <button type="button" class="vv-ghost" data-act="example">See an example ↗</button>
        </div>
      </div>
      <div class="vv-hero-art" aria-hidden="true"><div class="vv-orb"><div class="vv-orb-core"></div>${bars}</div>
        <span class="vv-zone-tag z-strong">VOLUME</span><span class="vv-zone-tag z-natural">PITCH</span><span class="vv-zone-tag z-soft">PACE</span></div>
    </header>
    <ol class="vv-how" aria-label="How every round works">
      <li><b>1</b><span><strong>Pick a game</strong><small>Volume, pitch, pace, or all three.</small></span></li>
      <li><b>2</b><span><strong>Plan with PREP</strong><small>${prepSeconds} seconds to prepare your Point, Reason, Example and Final Point.</small></span></li>
      <li><b>3</b><span><strong>Speak with variety</strong><small>Each PREP part has its own vocal cue.</small></span></li>
      <li><b>4</b><span><strong>See every part</strong><small>Stars, a voice map and a part-by-part breakdown.</small></span></li>
    </ol>
    <section class="vv-player" aria-label="Your progress">
      <div class="vv-rank"><div class="vv-rank-top"><span class="vv-rank-name">${esc(rank.name)}</span><span class="vv-rank-xp">${progress.xp} XP</span></div>
        <div class="vv-bar" role="img" aria-label="${rank.nextName ? `${rank.toNext} XP to ${esc(rank.nextName)}` : 'Top rank reached'}"><i style="width:${(rank.pct * 100).toFixed(0)}%"></i></div>
        <small>${rank.nextName ? `${rank.toNext} XP to ${esc(rank.nextName)}` : 'You have reached the top rank.'}</small></div>
      <div class="vv-stat"><strong>${progress.streak.count}<span aria-hidden="true">🔥</span></strong><small>day streak</small></div>
      <div class="vv-stat"><strong>${totalStars()}<span aria-hidden="true">★</span></strong><small>of ${STAGES.length * 3} stars</small></div>
      <div class="vv-stat"><strong>${Object.keys(progress.badges).filter(id => BADGES.some(b => b.id === id)).length}<span aria-hidden="true">🏅</span></strong><small>of ${BADGES.length} badges</small></div>
    </section>
    <section class="vv-tunebar ${callOn() ? 'call' : ''}" aria-label="Audio source">${callOn()
      ? `<div><strong>📞 Listening to your video call</strong><small>${callStream ? 'The call tab is connected. Students can take turns: no tuning needed, the zones adjust to the call as you play.' : 'Press Start on any game, then choose your Google Meet tab and tick “Also share tab audio”. No tuning needed: the zones adjust to the call as you play.'}</small></div>${callStream ? '<button type="button" class="vv-ghost" data-act="disconnect-call">Disconnect call</button>' : '<button type="button" class="vv-ghost" data-act="open-settings">Call audio settings</button>'}`
      : scale
      ? `<div><strong>Your voice is tuned</strong><small>${scaleIsDefault ? 'Using a typical range. Tune it so the zones fit your voice and microphone.' : `Volume range about ${scale.span.toFixed(0)} dB${scale.pitchCenter ? ` · natural note ${noteName(scale.pitchCenter)}` : ''}${scale.pace ? ` · natural pace ${scale.pace.toFixed(1)} syllables/s` : ''}.`}</small></div><button type="button" class="vv-ghost" data-act="tune">Retune ↻</button>`
      : `<div><strong>Tune your voice first (15 seconds)</strong><small>We learn your whisper, natural and strong voice, your natural pitch and your natural pace, so every zone fits you.</small></div><button type="button" class="vv-ghost" data-act="tune">Find my range</button>`}</section>
    <section aria-labelledby="vvGamesTitle"><div class="vv-section-head"><div class="vv-section-label">ALL GAMES · ALL OPEN</div><h2 id="vvGamesTitle">Choose what to train.</h2></div>
      ${['volume', 'pitch', 'pace', 'all'].map(group).join('')}</section>
    <section aria-labelledby="vvBadgesTitle"><div class="vv-section-head"><div class="vv-section-label">COLLECTION</div><h2 id="vvBadgesTitle">Badges</h2></div>
      <ul class="vv-badges">${BADGES.map(badge => {
        const got = progress.badges[badge.id];
        return `<li class="${got ? 'got' : ''}"><span class="vv-badge-icon" aria-hidden="true">${esc(badge.icon)}</span><div><strong>${esc(badge.name)}</strong><small>${esc(badge.desc)}</small></div><span class="vv-sr">${got ? 'Earned' : 'Not earned yet'}</span></li>`;
      }).join('')}</ul></section>
    <p class="vv-private">Microphone audio and playback stay in this browser and are replaced by your next answer. Nothing is uploaded, including your PREP notes. Stars, XP and badges are saved on this device only and do not change your coaching scores.</p>`;
  }
  function gameCard(item) {
    const stars = progress.stars[item.id] || 0, best = progress.best[item.id];
    return `<button type="button" class="vv-stage-card ${stars ? 'done' : ''} ${item.dim === 'all' ? 'wide' : ''}" data-act="open-stage" data-stage="${item.id}">
      <span class="vv-stage-mode">${modeTag(item)}</span>
      <span class="vv-stage-art">${planArt(item, { id: `card-${item.id}` })}</span>
      <span class="vv-stage-title">${esc(item.title)}</span><span class="vv-stage-tag">${esc(item.what)}</span>
      <span class="vv-stage-foot">${starsHtml(stars)}<small>1 to 2 min answer${best ? ` · Best ${best}` : ''}</small></span></button>`;
  }

  // ----- BRIEF (the game and the question) ---------------------------------------------------
  function briefHtml() {
    const plan = stage.plan, stars = progress.stars[stage.id] || 0, speakable = 'speechSynthesis' in window;
    const dims = dimsOf(stage);
    const rules = stage.kind === 'guided'
      ? `<li><b>Follow the ribbon.</b> Keep your ${DIMENSIONS[stage.dim].name.toLowerCase()} inside the glowing road. It changes for each PREP part.</li><li><b>Make real swings.</b> Aim for ${plan.goalSwings} clear changes between zones.</li><li><b>Keep talking.</b> Pauses are good. Silence for most of the round is not.</li>`
      : stage.dim === 'all'
        ? `<li><b>Vary all three.</b> At least ${plan.goalSwings} swings in volume, in pitch and in pace.</li><li><b>Use the PREP cues.</b> Each part suggests a different voice.</li><li><b>Keep talking</b> for most of your ${lengthLabel(plan.duration)}.</li>`
        : `<li><b>Reach ${zoneLabel(stage.dim, 'soft')}</b> and <b>${zoneLabel(stage.dim, 'strong')}</b>, each for over a second.</li><li><b>Make ${plan.goalSwings} swings</b> between zones.</li><li><b>Keep talking</b> for most of your ${lengthLabel(plan.duration)}.</li>`;
    return `
    <div class="vv-brief">
      <div class="vv-brief-main">
        <div class="vv-stage-chip"><span>${esc(modeTag(stage))}</span>${starsHtml(stars, 'small')}</div>
        <h2 class="vv-game-title" id="vvTitle" tabindex="-1" data-focus>${esc(stage.title)}</h2>
        <p class="vv-lede">${esc(stage.what)}</p>
        <div class="vv-qcard"><div class="vv-section-label">YOUR QUESTION</div>
          <p class="vv-question"><span aria-hidden="true">“</span>${esc(question())}<span aria-hidden="true">”</span></p>
          <div class="vv-brief-tools"><button type="button" class="vv-ghost" data-act="swap">↻ Different question</button>${speakable ? '<button type="button" class="vv-ghost" data-act="speak">🔊 Read it to me</button>' : ''}</div></div>
        <div class="vv-plan"><div class="vv-plan-head"><span class="vv-section-label">${stage.kind === 'guided' ? 'YOUR PREP PLAN AND RIBBON' : 'YOUR PREP PLAN'}</span><span class="vv-plan-time">${lengthLabel(plan.duration)} of speaking</span></div>
          ${stage.dim === 'all' ? '' : `<div class="vv-plan-art">${stage.kind === 'guided' ? planArt(stage, { w: 640, h: 170, labels: true, id: 'brief' }) : zoneLadderHtml()}
            ${zoneNames(stage.dim).map((name, i) => `<span class="vv-axis ${['a-top', 'a-mid', 'a-low'][i]}">${esc(name.toUpperCase())}</span>`).join('')}</div>`}
          <ol class="vv-phases">${plan.phases.map(p => `<li style="flex:${p.to - p.from}"><span class="vv-letter">${p.letter}</span><b>${esc(p.label)}</b><em>${esc(p.zone)}</em><small>${esc(p.cue)}</small><time>${clock(p.from)}–${clock(p.to)}</time></li>`).join('')}</ol>
          ${dims.length > 1 ? '<p class="vv-fine">Three lanes will show your volume, pitch and pace at the same time.</p>' : ''}</div>
      </div>
      <aside class="vv-brief-side">
        <div class="vv-section-label">HOW TO WIN</div><ul class="vv-rules">${rules}</ul>
        <div class="vv-stars-key"><span>${starsHtml(1, 'small')} ${stage.kind === 'guided' ? '55' : '50'}+</span><span>${starsHtml(2, 'small')} ${stage.kind === 'guided' ? '72' : '68'}+</span><span>${starsHtml(3, 'small')} ${stage.kind === 'guided' ? '88' : '85'}+</span></div>
        <div class="vv-section-label">SPEECH LENGTH</div>
        <div class="vv-seg vv-seg-3" role="radiogroup" aria-label="Speech length">${SPEECH_LENGTHS.map(s => `<button type="button" role="radio" aria-checked="${s === speechSeconds}" data-act="speech-time" data-seconds="${s}">${lengthLabel(s)}</button>`).join('')}</div>
        <div class="vv-section-label">PREPARATION TIME</div>
        <div class="vv-seg" role="radiogroup" aria-label="Preparation time">${PREP_CHOICES.map(s => `<button type="button" role="radio" aria-checked="${s === prepSeconds}" data-act="prep-time" data-seconds="${s}">${s < 60 ? `${s}s` : `${s / 60} min`.replace('1.5 min', '1½ min')}</button>`).join('')}</div>
        ${notice ? `<p class="vv-warning" role="alert">${esc(notice)}</p>` : ''}
        <button type="button" class="vv-primary vv-big" data-act="start-prep"><span aria-hidden="true">✎</span> ${callOn() || scale ? `Start preparing (${prepSeconds}s)` : 'Tune my voice, then prepare'}</button>
        <p class="vv-fine">${callOn()
          ? '📞 Call audio is on. Your browser will ask you to choose the call tab once (tick “Also share tab audio”). Stay on this tab so the class sees the game. Nothing is recorded until the student starts speaking.'
          : 'You will plan your PREP answer first. The microphone turns on for a sound check, and nothing is recorded until you start speaking. Strong means energetic, never strained.'}</p>
      </aside>
    </div>`;
  }
  const zoneLadderHtml = () => '<div class="vv-ladder" aria-hidden="true"><div class="z-strong"></div><div class="z-natural"></div><div class="z-soft"></div></div>';

  // ----- PREP (preparation time) --------------------------------------------------------------
  function prepHtml() {
    return `
    <div class="vv-prep">
      <div class="vv-prep-top">
        <div><div class="vv-stage-chip"><span>PREPARE · ${esc(stage.title.toUpperCase())}</span></div>
          <h2 class="vv-question" id="vvTitle" tabindex="-1" data-focus><span aria-hidden="true">“</span>${esc(question())}<span aria-hidden="true">”</span></h2>
          <p class="vv-lede">Plan your answer with PREP. Notes are optional, private, and stay on this screen. You will see them while you speak.</p></div>
        <div class="vv-prep-timer" id="vvPrepTimer" style="--p:1"><strong id="vvPrepClock">${clock(prepSeconds)}</strong><small>TO PREPARE</small></div>
      </div>
      <div class="vv-prep-grid">${stage.plan.phases.map(p => `
        <label class="vv-prep-card" for="vvNote-${p.key}">
          <span class="vv-prep-head"><span class="vv-letter">${p.letter}</span><b>${esc(p.label)}</b><em>${esc(p.zone)}</em></span>
          <span class="vv-prep-ask">${esc(p.ask)} <small>Try: ${esc(p.starters)}</small></span>
          <span class="vv-prep-cue">Voice: ${esc(p.cue)}</span>
          <textarea id="vvNote-${p.key}" data-note="${p.key}" rows="2" maxlength="160" placeholder="Your ${esc(p.label.toLowerCase())} in a few words">${esc(notes[p.key])}</textarea>
        </label>`).join('')}</div>
      <div class="vv-prep-bottom">
        <div class="vv-miccheck" id="vvMicCheck" aria-live="polite"><span class="vv-mic-dot" aria-hidden="true"></span><span id="vvMicText">Connecting your microphone…</span><span class="vv-mic-meter" aria-hidden="true"><i id="vvMicLevel"></i></span></div>
        <div class="vv-prep-actions"><button type="button" class="vv-ghost" data-act="prep-more" aria-label="Add 30 seconds">+30s</button><button type="button" class="vv-primary" data-act="prep-ready" id="vvReady">I’m ready: start speaking →</button></div>
      </div>
    </div>`;
  }
  async function startPrep() {
    if (!callOn() && !scale) { after = 'prep'; startTune(); return; }
    teardown(); releaseAudio(); notice = '';
    view = 'prep'; render();
    root.scrollIntoView({ block: 'start', behavior: 'instant' });
    viewEl.querySelector('[data-focus]')?.focus({ preventScroll: true });
    announce(`Prepare your answer. You have ${prepSeconds} seconds.`);
    const token = micToken;
    prep = { mic: null, endsAt: performance.now() + prepSeconds * 1000, total: prepSeconds, call: callOn(), dbs: [] };
    const state = prep;
    if (state.call) $('#vvMicText').textContent = callStream ? 'Connecting the call audio…' : 'Choose your Google Meet tab and tick “Also share tab audio”…';
    state.interval = setInterval(() => tickPrep(state), 100);
    let mic;
    try { mic = await openMic(token); } catch (error) {
      if (token !== micToken) return;
      notice = micMessage(error); go('brief', { quiet: true }); return;
    }
    if (!mic || token !== micToken) return;
    state.mic = mic;
    $('#vvMicText').textContent = state.call
      ? 'Call check: ask the student to say a few words in their normal voice. The zones adjust to them. Nothing is recorded yet.'
      : 'Mic check: say a few words. Nothing is recorded yet.';
  }
  function tickPrep(state) {
    if (prep !== state) return;
    const left = (state.endsAt - performance.now()) / 1000;
    const clockEl = $('#vvPrepClock'); if (!clockEl) return;
    clockEl.textContent = clock(Math.ceil(Math.max(0, left)));
    $('#vvPrepTimer').style.setProperty('--p', clamp(left / state.total, 0, 1).toFixed(3));
    $('#vvPrepTimer').classList.toggle('soon', left <= 10);
    if (state.mic) {
      state.mic.analyser.getFloatTimeDomainData(state.mic.buffer);
      const db = dbOf(rmsOf(state.mic.buffer));
      if (state.call && state.dbs.length < 3000) state.dbs.push(db);   // the sound check teaches the zones this speaker's level
      const level = clamp((db + 70) / 50, 0, 1);
      $('#vvMicLevel').style.width = `${(level * 100).toFixed(0)}%`;
      $('#vvMicCheck').classList.toggle('hearing', level > 0.35);
    }
    if (left <= 0 && state.mic) beginRound();
  }
  function beginRound() {
    const state = prep; if (!state?.mic) return;
    const mic = state.mic;
    if (state.call) learnCall(state.dbs, 0.85);   // the sound check is this very student, so trust it most
    teardown({ keepMic: true });
    view = 'live'; render();
    root.scrollIntoView({ block: 'start', behavior: 'instant' });
    startRound(mic);
  }

  // ----- TUNE (find your range) ------------------------------------------------------------
  const TUNE_STEPS = [
    { id: 'silence', word: 'Shhh…', say: 'Stay quiet for a moment so we can hear your room.', lead: 0.4, dur: 1.6 },
    { id: 'whisper', word: 'Whisper', say: '“I’m about to tell you a secret.”', lead: 1.1, dur: 2.6 },
    { id: 'normal', word: 'Natural voice', say: '“Hi, I’m here to practise my voice, and today I want to speak clearly and with confidence.”', lead: 1.1, dur: 4.2 },
    { id: 'power', word: 'Strong voice', say: '“Everyone, listen up! Let’s go!”', lead: 1.1, dur: 2.6 }
  ];
  function tuneHtml() {
    const state = tune?.state || 'intro';
    if (state === 'done') return tuneDoneHtml();
    const running = state === 'running' || state === 'waiting';
    return `
    <div class="vv-tune">
      <div class="vv-section-label">FIND YOUR RANGE</div>
      <h2 id="vvTitle" tabindex="-1" data-focus>${running ? 'Show us your voice.' : 'Let’s tune the game to your voice.'}</h2>
      <p class="vv-lede">In about 15 seconds you will whisper, read one sentence in your natural voice, and call out strongly. We learn your volume range, your natural pitch and your natural pace, so every zone fits you.</p>
      <div class="vv-tune-stage" id="vvTuneStage" data-state="${state}">
        <div class="vv-tune-orb" id="vvTuneOrb"><i></i></div>
        <div class="vv-tune-copy"><div class="vv-tune-count" id="vvTuneCount">${running ? '' : '4 quick steps'}</div><strong id="vvTuneWord">${running ? 'Getting ready…' : 'Ready when you are'}</strong><span id="vvTuneSay">${running ? 'Waiting for your microphone…' : 'Find a quiet spot and hold your device at the distance you will normally use.'}</span></div>
        <ol class="vv-tune-steps" aria-hidden="true">${TUNE_STEPS.map((s, i) => `<li data-i="${i}"><i></i><span>${['Quiet', 'Whisper', 'Natural', 'Strong'][i]}</span></li>`).join('')}</ol>
      </div>
      ${notice ? `<p class="vv-warning" role="alert">${esc(notice)}</p>` : ''}
      <div class="vv-tune-actions">${running ? '<button type="button" class="vv-ghost" data-act="tune-cancel">Cancel</button>'
        : '<button type="button" class="vv-primary vv-big" data-act="tune-start"><span aria-hidden="true">●</span> Start tuning</button><button type="button" class="vv-ghost" data-act="tune-skip">Use a typical range</button>'}</div>
    </div>`;
  }
  function tuneDoneHtml() {
    const s = tune.cal.scale, missing = ['whisper', 'normal', 'power'].filter(k => tune.cal.heard[k] < 25);
    const ok = !missing.length;
    const marks = [['Whisper', s.soft, 0.0], ['Natural', s.natural, 0.5], ['Power', s.power, 1.0]];
    return `
    <div class="vv-tune">
      <div class="vv-section-label">${ok ? 'VOICE TUNED' : 'ALMOST THERE'}</div>
      <h2 id="vvTitle" tabindex="-1" data-focus>${ok ? `You have a ${s.span.toFixed(0)} dB volume range to play with.` : 'We missed a part of your voice.'}</h2>
      <p class="vv-lede">${ok ? (s.widened ? 'Your whisper, natural and strong voice were close together, so we stretched your zones. Push the difference a little more next time.' : 'These are your personal markers. Every zone in every game is measured against them.')
        : `We could not hear your ${missing.map(k => k === 'normal' ? 'natural voice' : k).join(' or ')}. Move a little closer to the microphone, then try again.`}</p>
      <div class="vv-scale" role="img" aria-label="Your volume range: whisper ${s.soft.toFixed(0)} dB, natural ${s.natural.toFixed(0)} dB, power ${s.power.toFixed(0)} dB">
        <div class="vv-scale-bar"></div>${marks.map(([name, db, pos]) => `<div class="vv-scale-mark" style="left:${pos * 100}%"><i></i><b>${name}</b><small>${db.toFixed(0)} dBFS</small></div>`).join('')}</div>
      ${ok ? `<div class="vv-tune-facts"><div><span>🎵</span><b>${s.pitchCenter ? `${noteName(s.pitchCenter)} · ${(440 * Math.pow(2, (s.pitchCenter - 69) / 12)).toFixed(0)} Hz` : 'Not clear yet'}</b><small>${s.pitchCenter ? 'your natural speaking note' : 'pitch games will learn your note as you speak'}</small></div>
        <div><span>⏱️</span><b>${s.pace ? `${s.pace.toFixed(1)} syllables/s` : 'Typical'}</b><small>${s.pace ? 'your natural pace' : 'we will use a typical pace'}</small></div></div>` : ''}
      <div class="vv-tune-actions">${ok ? `<button type="button" class="vv-primary vv-big" data-act="tune-continue">${after === 'prep' ? 'Continue to preparation →' : 'Choose a game →'}</button><button type="button" class="vv-ghost" data-act="tune-retry">Retune</button>`
        : '<button type="button" class="vv-primary vv-big" data-act="tune-retry">Try again</button><button type="button" class="vv-ghost" data-act="tune-skip">Use a typical range</button>'}</div>
    </div>`;
  }
  async function startTune() {
    teardown();
    tune = { state: 'waiting', data: { silence: [], whisper: [], normal: [], power: [] }, pitches: [], mic: null };
    notice = ''; view = 'tune'; render();
    root.scrollIntoView({ block: 'start', behavior: 'instant' });
    const token = micToken;
    let mic;
    try { mic = await openMic(token); } catch (error) {
      if (token !== micToken) return;
      tune = null; notice = micMessage(error); render(); return;
    }
    if (!mic || token !== micToken) return;
    tune.mic = mic; tune.state = 'running';
    const stageEl = $('#vvTuneStage'), word = $('#vvTuneWord'), say = $('#vvTuneSay'), count = $('#vvTuneCount'), orb = $('#vvTuneOrb');
    stageEl.dataset.state = 'running';
    const total = TUNE_STEPS.reduce((sum, s) => sum + s.lead + s.dur, 0), begin = performance.now();
    let lastIndex = -1, tick = 0;
    tune.interval = setInterval(() => {
      const elapsed = (performance.now() - begin) / 1000;
      mic.analyser.getFloatTimeDomainData(mic.buffer);
      const rms = rmsOf(mic.buffer), db = dbOf(rms);
      orb.style.setProperty('--lvl', clamp((db + 68) / 52, 0, 1).toFixed(3));
      let start = 0, index = TUNE_STEPS.length;
      for (let i = 0; i < TUNE_STEPS.length; i++) {
        const len = TUNE_STEPS[i].lead + TUNE_STEPS[i].dur;
        if (elapsed < start + len) { index = i; break; }
        start += len;
      }
      if (index >= TUNE_STEPS.length) { finishTune(); return; }
      const step = TUNE_STEPS[index], local = elapsed - start, listening = local >= step.lead;
      if (index !== lastIndex) {
        lastIndex = index; word.textContent = step.word; say.textContent = step.say;
        stageEl.querySelectorAll('.vv-tune-steps li').forEach((li, i) => { li.classList.toggle('now', i === index); li.classList.toggle('done', i < index); });
        announce(`${step.word}. ${step.say}`);
        if (step.id === 'normal') {
          const floor = tune.data.silence.length ? tune.data.silence.slice().sort((a, b) => a - b)[Math.floor(tune.data.silence.length * 0.9)] : -66;
          tune.meter = new PaceMeter({ window: 99, gateDb: floor + 8 });
        }
      }
      stageEl.dataset.listening = String(listening);
      count.textContent = listening ? 'Listening…' : 'Get ready…';
      stageEl.style.setProperty('--p', clamp((local - step.lead) / step.dur, 0, 1).toFixed(3));
      if (listening) {
        tune.data[step.id].push(db);
        if (step.id === 'normal') {
          tune.meter.push(local, rms); tune.normalSeconds = local - step.lead;
          if (tick++ % 2 === 0) tune.pitches.push(midiOf(detectPitch(mic.buffer, mic.context.sampleRate)));
        }
      }
      stageEl.style.setProperty('--total', (elapsed / total).toFixed(3));
    }, 20);
  }
  function finishTune() {
    const finished = tune; clearInterval(finished.interval); closeMic(finished.mic); finished.mic = null;
    const paceRate = finished.meter && finished.normalSeconds > 2 ? finished.meter.peaks.length / finished.normalSeconds : null;
    finished.cal = scaleFromCalibration({ ...finished.data, pitches: finished.pitches, paceRate: paceRate && paceRate >= 1 ? paceRate : null });
    finished.state = 'done';
    const ok = ['whisper', 'normal', 'power'].every(k => finished.cal.heard[k] >= 25);
    if (ok) {
      scale = finished.cal.scale; scaleIsDefault = false; write(SCALE_KEY, { scale, at: Date.now() });
      const outcome = applyTune(progress, new Date()); progress = outcome.progress; save();
      outcome.newBadges.forEach(badge => toast(`Badge unlocked: ${badge.name}`, badge.icon));
      chime([523.25, 783.99, 1046.5]);
    }
    render(); viewEl.querySelector('[data-focus]')?.focus({ preventScroll: true });
    announce(ok ? 'Your voice is tuned.' : 'We missed part of your voice. Try again.');
  }

  // ----- LIVE ------------------------------------------------------------------------------
  function liveHtml() {
    const plan = stage.plan, guided = stage.kind === 'guided', first = plan.phases[0];
    const hud = stage.dim === 'all'
      ? DIM_ORDER.map((dim, i) => `<div><small>${DIMENSIONS[dim].name.toUpperCase()} SWINGS</small><strong id="vvHud${i + 1}">0</strong></div>`).join('')
      : `<div><small>${guided ? 'ON THE RIBBON' : 'ZONES HIT'}</small><strong id="vvHud1">${guided ? '—' : '0 / 3'}</strong></div><div><small>${guided ? 'STREAK' : 'RIGHT NOW'}</small><strong id="vvHud2">${guided ? '0.0s' : '—'}</strong></div><div><small>SWINGS</small><strong id="vvHud3">0</strong></div>`;
    const goals = stage.kind === 'free' ? scoreRound({ frames: [], stage, scale: activeScale() || normalizeScale(DEFAULT_SCALE) }).goals : [];
    return `
    <div class="vv-live" data-kind="${stage.kind}" data-dim="${stage.dim}">
      <div class="vv-live-top">
        <div class="vv-live-q"><div class="vv-stage-chip"><span>${esc(stage.title.toUpperCase())}</span></div><h2 id="vvTitle" tabindex="-1" data-focus>“${esc(question())}”</h2></div>
        <div class="vv-clock" aria-hidden="true"><strong id="vvClock">${clock(plan.duration)}</strong><small>LEFT</small></div>
        <button type="button" class="vv-stop" data-act="finish" id="vvFinish">■ Finish</button>
      </div>
      <div class="vv-stage" id="vvStage">
        <div class="vv-stage-head"><div class="vv-cue" id="vvCue"><span class="vv-cue-letter" id="vvCueLetter" aria-hidden="true">${first.letter}</span>
          <div><strong><span id="vvCueLabel">${esc(first.label)}</span> · <em id="vvCueZone">${esc(first.zone)}</em></strong><small id="vvCueText">${esc(first.cue)}</small><span class="vv-cue-note" id="vvCueNote" ${notes[first.key] ? '' : 'hidden'}>Your note: <b>${esc(notes[first.key])}</b></span></div></div>
          <div class="vv-hud">${hud}</div></div>
        <div class="vv-canvas-wrap"><canvas id="vvStageCanvas" aria-hidden="true"></canvas><div class="vv-countdown" id="vvCountdown" aria-hidden="true"></div></div>
        <div class="vv-timeline" id="vvTimeline" aria-hidden="true">${plan.phases.map(p => `<div style="flex:${p.to - p.from}"><span>${p.letter} · ${esc(p.label)}</span></div>`).join('')}<i id="vvTimeFill"></i></div>
      </div>
      <section class="vv-notes" id="vvNotes" aria-label="Your PREP notes">
        <div class="vv-notes-head"><span class="vv-section-label">YOUR PREP NOTES</span><small>The part you are on is lit.</small></div>
        <ol>${plan.phases.map((p, i) => `<li data-part="${i}" ${i === 0 ? 'class="now" aria-current="step"' : ''}><span class="vv-letter">${p.letter}</span><div><b>${esc(p.label)}</b><p ${notes[p.key].trim() ? '' : 'class="empty"'}>${notes[p.key].trim() ? esc(notes[p.key]) : 'No note'}</p></div></li>`).join('')}</ol>
      </section>
      ${goals.length ? `<ul class="vv-goals" id="vvGoals">${goals.map(goal => `<li data-goal="${goal.id}"><span aria-hidden="true"></span>${esc(goal.label)}</li>`).join('')}</ul>` : ''}
      <p class="vv-status" id="vvLiveStatus" role="status">Get ready…</p>
    </div>`;
  }
  function startRound(mic) {
    const plan = stage.plan, roundScale = activeScale();
    round = {
      mic, plan, guided: stage.kind === 'guided', mode: 'countdown', t0: 0, frames: [], scale: roundScale, call: callOn(), tracker: new VoiceTracker(roundScale), tick: 0, lastMidi: null,
      live: { t: 0, volume: null, pitch: null, pace: null, active: false, db: -90 }, display: { volume: -0.1, pitch: -0.1, pace: -0.1 },
      particles: [], timers: [], recorder: null, chunks: [], credit: 0, creditN: 0, streak: 0, miss: 0, lastHud: 0, lastScore: 0, phaseKey: -1, unlocked: new Set()
    };
    const r = round;
    r.interval = setInterval(analyse, 20);
    r.raf = requestAnimationFrame(drawLoop);
    $('#vvLiveStatus').textContent = 'Get ready: you start speaking after the countdown.';
    announce('Get ready. You start speaking in three seconds.');
    const count = $('#vvCountdown');
    [['3', 0], ['2', 1000], ['1', 2000], ['Speak!', 3000]].forEach(([label, delay]) => r.timers.push(setTimeout(() => {
      if (round !== r) return;
      count.textContent = label; count.classList.remove('pop'); void count.offsetWidth; count.classList.add('pop');
      if (label === 'Speak!') beginSpeaking(r);
    }, delay)));
    r.timers.push(setTimeout(() => { if (round === r) count.textContent = ''; }, 4000));
  }
  function beginSpeaking(r) {
    r.mode = 'live'; r.t0 = performance.now(); r.tracker.reset();
    if (window.MediaRecorder) {
      try {
        r.recorder = new MediaRecorder(r.mic.stream);
        r.recorder.ondataavailable = event => { if (event.data.size) r.chunks.push(event.data); };
        r.recorder.onstop = () => {
          if (!r.chunks.length) return;
          releaseAudio(); audioUrl = URL.createObjectURL(new Blob(r.chunks, { type: r.chunks[0].type })); audioEl.src = audioUrl;
          if (view === 'results') attachAudio();
        };
        r.recorder.start();
      } catch { r.recorder = null; }
    }
    $('#vvLiveStatus').textContent = 'Listening. Answer with PREP and follow the vocal cue for each part.';
    announce(`Go. ${r.plan.phases[0].label}: ${r.plan.phases[0].zone}. ${r.plan.phases[0].cue}`);
  }
  function analyse() {
    const r = round; if (!r) return;
    r.mic.analyser.getFloatTimeDomainData(r.mic.buffer);
    const rms = rmsOf(r.mic.buffer);
    if (r.tick++ % 2 === 0) r.lastMidi = midiOf(detectPitch(r.mic.buffer, r.mic.context.sampleRate));
    const live = r.mode === 'live';
    const t = live ? (performance.now() - r.t0) / 1000 : 0;
    const out = r.tracker.push(live ? t : performance.now() / 1000, rms, r.tick % 2 === 1 ? r.lastMidi : null);
    r.live = { ...out, t };
    if (!live) return;
    if (t >= r.plan.duration) { finishRound(); return; }
    while (r.frames.length * FRAME_DT <= t) {
      const ft = r.frames.length * FRAME_DT;
      r.frames.push({ t: ft, db: out.db, active: out.active, volume: out.volume, midi: out.midi, pitch: out.pitch, rate: out.rate, pace: out.pace });
      if (r.guided && Number.isFinite(out[stage.dim])) {
        const credit = ribbonCredit(stage.dim, out[stage.dim], r.plan, ft);
        r.credit += credit; r.creditN++;
        if (credit === 1) { r.streak += FRAME_DT; r.miss = 0; } else if (++r.miss > 10) r.streak = 0;
      }
      if (stage.dim !== 'all' && Number.isFinite(out[stage.dim])) r.unlocked.add(zoneOf(out[stage.dim]));
    }
  }
  function finishRound() {
    const r = round; if (!r) return;
    clearInterval(r.interval); cancelAnimationFrame(r.raf); r.timers.forEach(clearTimeout);
    const frames = r.frames, played = r.mode === 'live';
    if (r.recorder?.state === 'recording') r.recorder.stop();
    closeMic(r.mic); round = null; micToken++;
    if (!played || frames.length < 20) { notice = 'That round ended before we heard enough. Try again when you are ready.'; go('brief', { quiet: true }); return; }
    result = scoreRound({ frames, stage, scale: r.scale }); result.frames = frames; result.notes = { ...notes };
    if (r.call) learnCall(frames.filter(frame => frame.active).map(frame => frame.db), 0.5);   // the next student starts from what this call sounded like
    award = applyRound(progress, stage, result, new Date(), questionIndex, { prepared: prepared() });
    progress = award.progress; save(); example = false;
    go('results');
  }

  // live canvas ---------------------------------------------------------------------------
  function drawLoop() {
    const r = round; if (!r) return;
    r.raf = requestAnimationFrame(drawLoop);
    const now = performance.now();
    if (now - r.lastHud > 100) { r.lastHud = now; updateHud(r, now); }
    drawStageFrame();
  }
  function updateHud(r, now) {
    const t = r.mode === 'live' ? r.live.t : 0, plan = r.plan;
    const clockEl = $('#vvClock'); if (!clockEl) return;
    clockEl.textContent = clock(Math.ceil(Math.max(0, plan.duration - t)));
    $('#vvTimeFill').style.width = `${clamp(t / plan.duration, 0, 1) * 100}%`;
    if (stage.dim === 'all') {
      DIM_ORDER.forEach((dim, i) => { $(`#vvHud${i + 1}`).textContent = String(countSwings(r.frames.map(f => ({ t: f.t, level: f[dim] }))).swings); });
    } else {
      $('#vvHud3').textContent = String(countSwings(r.frames.map(f => ({ t: f.t, level: f[stage.dim] }))).swings);
      if (r.guided) {
        $('#vvHud1').textContent = r.creditN ? `${Math.round(r.credit / r.creditN * 100)}%` : '—';
        $('#vvHud2').textContent = `${r.streak.toFixed(1)}s`;
        $('#vvStage').classList.toggle('hot', r.streak >= 2);
      } else {
        $('#vvHud1').textContent = `${r.unlocked.size} / 3`;
        const level = r.live[stage.dim];
        $('#vvHud2').textContent = Number.isFinite(level) ? zoneLabel(stage.dim, zoneOf(level)) : '—';
      }
    }
    if (stage.kind === 'free' && now - r.lastScore > 500 && r.frames.length >= 10) {
      r.lastScore = now;
      scoreRound({ frames: r.frames, stage, scale: r.scale }).goals.forEach(goal => $(`#vvGoals [data-goal="${goal.id}"]`)?.classList.toggle('done', goal.done));
    }
    const index = plan.phases.indexOf(phaseAt(plan, t));
    if (index !== r.phaseKey && r.mode === 'live') {
      r.phaseKey = index; const p = plan.phases[index];
      $('#vvCueLetter').textContent = p.letter; $('#vvCueLabel').textContent = p.label; $('#vvCueZone').textContent = p.zone; $('#vvCueText').textContent = p.cue;
      const note = $('#vvCueNote'); note.hidden = !notes[p.key]; note.innerHTML = `Your note: <b>${esc(notes[p.key])}</b>`;
      viewEl.querySelectorAll('#vvNotes li').forEach((li, i) => { li.classList.toggle('now', i === index); if (i === index) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
      const cue = $('#vvCue'); cue.classList.remove('swap'); void cue.offsetWidth; cue.classList.add('swap');
      // No sound here: the microphone is open, and a beep would end up in the measurement.
      if (t > 0.5) announce(`${p.label}: ${p.zone}. ${p.cue}`);
    }
  }
  function drawStageFrame() {
    const canvas = $('#vvStageCanvas'); if (!canvas) return;
    const wide = canvas.getBoundingClientRect().width;
    const height = stage.dim === 'all' ? (wide < 560 ? 390 : 420) : (wide < 560 ? 300 : 360);
    const sized = sizeCanvas(canvas, height); if (!sized) return;
    const r = round;
    const live = r ? r.live : { volume: null, pitch: null, pace: null, active: false };
    const t = r && r.mode === 'live' ? r.live.t : 0;
    if (r) for (const dim of DIM_ORDER) {
      const goal = Number.isFinite(live[dim]) ? live[dim] : -0.1;
      r.display[dim] += (goal - r.display[dim]) * (Number.isFinite(live[dim]) ? 0.3 : 0.08);
    }
    drawStage(sized.ctx, sized.w, sized.h, { t, frames: r?.frames || [], live, display: r ? r.display : { volume: -0.1, pitch: -0.1, pace: -0.1 }, particles: r?.particles || [], now: performance.now(), mode: r?.mode || 'countdown' });
  }
  function drawStage(ctx, w, h, s) {
    const plan = stage.plan, compact = w < 560, solo = stage.dim !== 'all';
    const L = solo ? (compact ? 54 : 84) : (compact ? 66 : 92), R = 12, T = 24, B = 22;
    const pw = w - L - R, ph = h - T - B, past = compact ? 4 : 5, future = compact ? 6 : 9, span = past + future;
    const xOf = time => L + pw * (past + (time - s.t)) / span, px = L + pw * past / span;
    ctx.clearRect(0, 0, w, h);
    const lanes = lanesFor(stage, T, ph);
    lanes.forEach(lane => drawLaneBands(ctx, lane, L, pw, compact));

    // moving time ticks, PREP dividers and labels
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(190,205,225,.45)'; ctx.font = '10px Inter, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let sec = Math.max(0, Math.ceil(s.t - past)); sec <= Math.min(plan.duration, Math.floor(s.t + future)); sec++) {
      const x = xOf(sec); if (x < L || x > L + pw) continue;
      ctx.beginPath(); ctx.moveTo(x, T + 4); ctx.lineTo(x, T + ph - 4); ctx.stroke();
      if (sec % 5 === 0) ctx.fillText(clock(sec), x, h - 6);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `800 ${compact ? 10 : 11}px Inter, system-ui`;
    plan.phases.forEach((p, i) => {
      const xs = xOf(p.from), xe = xOf(p.to);
      if (xe < L || xs > L + pw) return;
      if (i && xs >= L && xs <= L + pw) { ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.moveTo(xs, 4); ctx.lineTo(xs, T + ph - 4); ctx.stroke(); ctx.setLineDash([]); }
      const lx = Math.max(xs + 8, L + 8);
      if (lx < L + pw - 80) { const current = s.t >= p.from && s.t < p.to; ctx.fillStyle = current ? 'rgba(253,230,138,1)' : 'rgba(255,255,255,.5)'; ctx.fillText(`${p.letter} · ${p.label.toUpperCase()} · ${p.zone.toUpperCase()}`, lx, 12); }
    });

    for (const lane of lanes) {
      const yOf = laneY(lane), dim = lane.dim;
      // ribbon
      if (lane.guided) {
        const band = DIMENSIONS[dim].band, t0 = Math.max(0, s.t - past), t1 = Math.min(plan.duration, s.t + future), up = [], low = [];
        for (let tt = t0; tt <= t1 + 1e-6; tt += 0.1) { const c = targetAt(plan, tt), x = xOf(tt); up.push([x, yOf(c + band)]); low.push([x, yOf(c - band)]); }
        const path = () => { ctx.beginPath(); up.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); for (let i = low.length - 1; i >= 0; i--) ctx.lineTo(low[i][0], low[i][1]); ctx.closePath(); };
        const edge = () => { ctx.beginPath(); up.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.moveTo(low[0][0], low[0][1]); low.forEach(([x, y]) => ctx.lineTo(x, y)); };
        for (const [alpha, x0, x1] of [[0.45, L, px], [1, px, L + pw]]) {
          ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, h); ctx.clip(); ctx.globalAlpha = alpha;
          path(); const g = ctx.createLinearGradient(px, 0, L + pw, 0); g.addColorStop(0, 'rgba(253,224,71,.26)'); g.addColorStop(1, 'rgba(253,224,71,.09)'); ctx.fillStyle = g; ctx.fill();
          ctx.shadowColor = 'rgba(253,224,71,.55)'; ctx.shadowBlur = 10; ctx.strokeStyle = 'rgba(253,224,71,.85)'; ctx.lineWidth = 1.6; edge(); ctx.stroke();
          ctx.restore();
        }
        // stretches where you stayed on the ribbon glow brighter (one smooth shape per stretch)
        ctx.fillStyle = 'rgba(253,224,71,.2)';
        let hits = [];
        const flushHits = () => {
          if (hits.length > 1) {
            ctx.beginPath(); hits.forEach(([x, c], i) => i ? ctx.lineTo(x, yOf(c + band)) : ctx.moveTo(x, yOf(c + band)));
            for (let i = hits.length - 1; i >= 0; i--) ctx.lineTo(hits[i][0], yOf(hits[i][1] - band));
            ctx.closePath(); ctx.fill();
          }
          hits = [];
        };
        for (const f of s.frames) {
          if (f.t < s.t - past - 0.1) continue;
          if (Number.isFinite(f[dim]) && ribbonCredit(dim, f[dim], plan, f.t) === 1) hits.push([xOf(f.t), targetAt(plan, f.t)]); else flushHits();
        }
        flushHits();
      }
      // trace (colour follows the level; older parts fade)
      const grad = levelGradient(ctx, yOf(HI), yOf(LO), HI, LO);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = grad; ctx.lineWidth = lane.solo ? 3.4 : 2.6;
      for (const run of traceRuns(s.frames.filter(f => f.t >= s.t - past - 0.1), dim)) {
        for (let from = 0; from < run.length - 1; from += 12) {
          const chunk = run.slice(from, from + 13);
          ctx.globalAlpha = clamp(1 - ((s.t - chunk[0].t) / past) * 0.82, 0.12, 1); ctx.shadowColor = levelColor(chunk[0][dim], 0.7); ctx.shadowBlur = 9;
          ctx.beginPath(); chunk.forEach((f, i) => i ? ctx.lineTo(xOf(f.t), yOf(f[dim])) : ctx.moveTo(xOf(f.t), yOf(f[dim]))); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      // orb
      const level = s.display[dim], oy = yOf(level), color = levelRgb(clamp(level, 0, 1)), present = Number.isFinite(s.live[dim]);
      const inBand = lane.guided && present && s.mode === 'live' && ribbonCredit(dim, s.live[dim], plan, s.t) === 1;
      const radius = lane.solo ? 1 : 0.75;
      const halo = ctx.createRadialGradient(px, oy, 2, px, oy, (inBand ? 56 : 40) * radius);
      halo.addColorStop(0, `rgba(${color},${present ? 0.55 : 0.2})`); halo.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(px, oy, (inBand ? 56 : 40) * radius, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = present ? 1 : 0.5;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, oy, 7.5 * radius, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = `rgb(${color})`; ctx.beginPath(); ctx.arc(px, oy, 12.5 * radius, 0, Math.PI * 2); ctx.stroke();
      if (inBand) { const pulse = (s.now / 600) % 1; ctx.globalAlpha = 1 - pulse; ctx.strokeStyle = 'rgb(253,224,71)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, oy, 14 + pulse * 20, 0, Math.PI * 2); ctx.stroke(); }
      ctx.globalAlpha = 1;
      if (!present && s.mode === 'live' && lane.solo) { ctx.fillStyle = 'rgba(210,222,240,.75)'; ctx.font = '600 11px Inter, system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(dim === 'pitch' && s.live.active ? 'finding your note…' : 'speak…', px + 24, oy - 14); }
      if (inBand && !reduceMotion() && Math.random() < 0.7) s.particles.push({ x: px, y: oy + (Math.random() - 0.5) * 10, vx: -(30 + Math.random() * 60), vy: (Math.random() - 0.5) * 50, life: 1 });
    }
    // playhead and sparks
    const ph2 = ctx.createLinearGradient(0, T, 0, T + ph); ph2.addColorStop(0, 'rgba(255,255,255,0)'); ph2.addColorStop(0.5, 'rgba(255,255,255,.28)'); ph2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ph2; ctx.fillRect(px - 0.75, T, 1.5, ph);
    for (let i = s.particles.length - 1; i >= 0; i--) {
      const p = s.particles[i]; p.life -= 0.025; p.x += p.vx / 60; p.y += p.vy / 60;
      if (p.life <= 0) { s.particles.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(253,224,71,${p.life * 0.9})`; ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 + p.life * 1.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ----- RESULTS ---------------------------------------------------------------------------
  function resultsHtml() {
    const r = result, st = stage, all = st.dim === 'all', main = r.main;
    const headline = r.stars === 3 ? 'Electric. Real variety, clear structure.' : r.stars === 2 ? 'Strong contrast. Your voice is moving.' : r.stars === 1 ? 'You are on the board. Now widen it.' : 'Good start. Let’s widen the swings.';
    const rank = award?.rank, lvlUp = award && award.rank.index > award.rankBefore.index;
    const parts = prepBreakdown(r.frames, st);
    const mixTile = dim => {
      const d = r.dims[dim], order = ['strong', 'natural', 'soft'];
      return `<div class="vv-mix" role="img" aria-label="${DIMENSIONS[dim].name}: ${order.map(z => `${zoneLabel(dim, z)} ${Math.round(d.shares[z] * 100)} percent`).join(', ')}">${order.map(z => `<i class="z-${z === 'strong' ? 'strong' : z === 'soft' ? 'soft' : 'natural'}" style="flex:${Math.max(d.shares[z], 0.001)}"><b>${d.shares[z] >= 0.1 ? `${zoneLabel(dim, z)} ${Math.round(d.shares[z] * 100)}%` : ''}</b></i>`).join('')}</div>`;
    };
    const rangeTile = (dim, label = `${DIMENSIONS[dim].name.toUpperCase()} RANGE`) => {
      const d = r.dims[dim], v = d.range.value;
      const big = dim === 'volume' ? `${v ? v.toFixed(0) : '—'}<small> dB</small>` : dim === 'pitch' ? `${v ? v.toFixed(1) : '—'}<small> semitones</small>` : `${d.range.text === '—' ? '—' : `${d.range.low.toFixed(1)}–${d.range.high.toFixed(1)}`}<small> syl/s</small>`;
      return `<div class="vv-tile"><span class="vv-tile-k">${label}</span><strong>${big}</strong><em>${v ? rangeLabel(dim, v) : 'Speak more to measure'}</em></div>`;
    };
    const extremes = { volume: ['LOUDEST MOMENT', 'SOFTEST MOMENT'], pitch: ['HIGHEST NOTE', 'LOWEST NOTE'], pace: ['FASTEST MOMENT', 'SLOWEST MOMENT'] };
    const tiles = all
      ? `<div class="vv-tile wide"><span class="vv-tile-k">ZONE MIX</span>${DIM_ORDER.map(dim => `<div class="vv-mix-row"><span>${DIMENSIONS[dim].name}</span>${mixTile(dim)}</div>`).join('')}</div>
         ${DIM_ORDER.map(dim => rangeTile(dim)).join('')}
         <div class="vv-tile"><span class="vv-tile-k">TALKING TIME</span><strong>${Math.round(r.activeFraction * 100)}<small>%</small></strong><em>of the round (pauses are fine)</em></div>
         ${DIM_ORDER.map(dim => `<div class="vv-tile"><span class="vv-tile-k">${DIMENSIONS[dim].name.toUpperCase()} SWINGS</span><strong>${r.dims[dim].swings}<small> / ${st.plan.goalSwings}</small></strong><em>${r.dims[dim].swings >= st.plan.goalSwings ? 'Goal reached' : 'changes between zones'}</em></div>`).join('')}
         <div class="vv-tile"><span class="vv-tile-k">FOCUS NEXT</span><strong class="vv-small-strong">${DIMENSIONS[DIM_ORDER.reduce((a, b) => r.dims[b].varietyFraction < r.dims[a].varietyFraction ? b : a)].name}</strong><em>your least varied dimension</em></div>`
      : `<div class="vv-tile wide"><span class="vv-tile-k">ZONE MIX</span>${mixTile(st.dim)}</div>
         ${rangeTile(st.dim, 'RANGE')}
         <div class="vv-tile"><span class="vv-tile-k">SWINGS</span><strong>${main.swings}<small> / ${main.swingGoal}</small></strong><em>${main.swings >= main.swingGoal ? 'Goal reached' : 'changes between zones'}</em></div>
         <div class="vv-tile"><span class="vv-tile-k">${st.kind === 'guided' ? 'RIBBON MATCH' : 'ZONE BALANCE'}</span><strong>${Math.round((st.kind === 'guided' ? main.match : main.balance) * 100)}<small>%</small></strong><em>${st.kind === 'guided' ? `best streak ${main.bestStreak.toFixed(1)}s` : `${zoneNames(st.dim).reverse().join(', ')} all used`}</em></div>
         <div class="vv-tile"><span class="vv-tile-k">TALKING TIME</span><strong>${Math.round(r.activeFraction * 100)}<small>%</small></strong><em>of the round (pauses are fine)</em></div>
         <div class="vv-tile"><span class="vv-tile-k">${extremes[st.dim][0]}</span><strong>${main.peak ? clock(main.peak.t) : '—'}</strong><em>${main.peak ? esc(main.peak.text) : ''}</em></div>
         <div class="vv-tile"><span class="vv-tile-k">${extremes[st.dim][1]}</span><strong>${main.low ? clock(main.low.t) : '—'}</strong><em>${main.low ? esc(main.low.text) : ''}</em></div>
         ${DIM_ORDER.filter(dim => dim !== st.dim).map(dim => rangeTile(dim, `${DIMENSIONS[dim].name.toUpperCase()} · ALSO MEASURED`)).join('')}`;
    return `
    <div class="vv-result" data-example="${example}" data-dim="${st.dim}">
      <div class="vv-result-top">
        <div class="vv-print ${all ? 'triple' : ''}"><canvas id="vvPrint" role="img" aria-label="Your voiceprint: ${all ? 'three rings for volume, pitch and pace; ' : ''}taller, warmer spikes are the higher zone"></canvas>
          <div class="vv-print-center"><strong id="vvScore" data-score="${r.score}">0</strong><small>VARIETY SCORE</small></div></div>
        <div class="vv-result-sum">
          <div class="vv-section-label">${example ? 'EXAMPLE · NOT YOUR VOICE' : `ROUND COMPLETE · ${esc(st.title.toUpperCase())}`}</div>
          <h2 id="vvTitle" tabindex="-1" data-focus>${esc(headline)}</h2>
          <div class="vv-star-row" id="vvStarRow" data-stars="${r.stars}" role="img" aria-label="${r.stars} of 3 stars">${[0, 1, 2].map(i => `<i data-i="${i}">★</i>`).join('')}</div>
          <p class="vv-tip">${esc(coachingTip(r))}</p>
          ${award && !example ? `<div class="vv-xp"><div class="vv-xp-row"><strong>+${award.xpGained} XP</strong><span>${esc(rank.name)}${rank.nextName ? ` · ${rank.toNext} to ${esc(rank.nextName)}` : ' · top rank'}</span></div><div class="vv-bar"><i style="width:${(rank.pct * 100).toFixed(0)}%"></i></div>${lvlUp ? `<p class="vv-levelup">Rank up! You have reached ${esc(rank.name)}.</p>` : ''}${award.personalBest ? '<p class="vv-levelup">New personal best</p>' : ''}</div>` : ''}
          <ul class="vv-goal-chips">${r.goals.map(g => `<li class="${g.done ? 'done' : ''}"><span aria-hidden="true">${g.done ? '✓' : '○'}</span><b>${esc(g.label)}</b><small>${esc(g.detail)}</small></li>`).join('')}</ul>
          ${award?.newBadges.length && !example ? `<div class="vv-new-badges">${award.newBadges.map(b => `<span><i aria-hidden="true">${esc(b.icon)}</i> Badge: <b>${esc(b.name)}</b></span>`).join('')}</div>` : ''}
        </div>
      </div>

      <section class="vv-map-card" aria-labelledby="vvMapTitle">
        <div class="vv-map-head"><div><div class="vv-section-label">YOUR ${all ? 'VOICE' : DIMENSIONS[st.dim].name.toUpperCase()} MAP</div><h3 id="vvMapTitle">${esc(DIM_INFO[st.dim].map)}</h3></div>
          <div class="vv-legend" aria-hidden="true">${all ? '<span class="z-strong">High zone</span><span class="z-natural">Middle</span><span class="z-soft">Low zone</span>' : zoneNames(st.dim).map((name, i) => `<span class="${['z-strong', 'z-natural', 'z-soft'][i]}">${esc(name)}</span>`).join('')}${st.kind === 'guided' ? '<span class="z-ribbon">Ribbon</span>' : ''}</div></div>
        <div class="vv-playback" id="vvAudioSlot"></div>
        <canvas id="vvMap" role="img" aria-label="${esc(mapSummary(r))}"></canvas>
        <p class="vv-moment" id="vvMoment" role="status" aria-live="polite">${example ? 'This is made-up example data. ' : ''}Hover or tap the map to inspect a moment${example ? '' : ', then tap to jump there in playback'}.</p>
      </section>

      <section class="vv-parts" aria-labelledby="vvPartsTitle">
        <div class="vv-section-label">STRUCTURE + VARIETY</div><h3 id="vvPartsTitle">Your PREP answer, part by part.</h3>
        <ol>${parts.map((part, i) => {
          const phase = st.plan.phases[i], note = r.notes?.[part.key];
          return `<li><div class="vv-part-head"><span class="vv-letter">${part.letter}</span><b>${esc(part.label)}</b><small>${clock(phase.from)}–${clock(phase.to)}</small></div>
            ${note ? `<p class="vv-part-note">“${esc(note)}”</p>` : ''}
            <p class="vv-part-goal">Cue: <b>${esc(part.goal)}</b></p>
            <div class="vv-part-chips">${Object.entries(part.dims).map(([dim, d]) => d.zone
              ? `<span class="z-${d.zone === 'strong' ? 'strong' : d.zone === 'soft' ? 'soft' : 'natural'}">${all ? `${DIMENSIONS[dim].name}: ` : 'Mostly '}${esc(d.label)} ${Math.round(d.share * 100)}%</span>${d.match !== null ? `<span class="z-ribbon">Ribbon ${Math.round(d.match * 100)}%</span>` : ''}`
              : `<span>${all ? `${DIMENSIONS[dim].name}: ` : ''}not enough voice</span>`).join('')}</div>
            ${part.talking < 0.4 ? '<p class="vv-part-warn">Mostly silent: did you skip this part?</p>' : ''}</li>`;
        }).join('')}</ol>
      </section>

      <section class="vv-tiles" aria-label="Details">${tiles}</section>

      <div class="vv-actions">
        ${example ? '<button type="button" class="vv-primary vv-big" data-act="open-stage" data-stage="volume-ribbon">▶ Play it for real</button>'
          : `<button type="button" class="vv-primary vv-big" data-act="next-question">Next question →</button>
             <button type="button" class="vv-ghost" data-act="again">Try this question again</button>`}
        <button type="button" class="vv-ghost" data-act="home">All games</button>
      </div>
      <details class="vv-method"><summary>How these numbers work</summary>
        <p><b>Zones.</b> “Find your range” sets your personal scale. Volume: your whisper is 0, natural voice 0.5, power voice 1. Pitch: your natural note is the middle; six semitones up or down reaches the edges. Pace: your natural speed is the middle; twice as fast or half as fast reaches the edges, and pauses count as slowing down. The low zone is below 0.28, the high zone above 0.72.</p>
        <p><b>Variety score.</b> Range between your lowest and highest moments (45%), swings between zones (35%) and balance across all three zones (20%). Guided games blend in how closely you followed the ribbon (70% ribbon, 30% variety). All Three averages volume, pitch and pace. Talking for less than half the round lowers the score; pauses are never penalised.</p>
        <p><b>Accuracy.</b> Volume is relative microphone level, not calibrated sound pressure, so keep the microphone at one distance. Pitch is detected from voiced sound and needs a fairly quiet room. Pace counts energy peaks as syllables over the last 2.5 seconds: it is an estimate, not a transcript or words per minute, and it shows changes about a second late.</p>
        <p>Your PREP notes never leave this screen. Nothing here changes your Speaker’s Gym coaching scores or history.</p></details>
    </div>`;
  }
  const mapSummary = r => r.dim === 'all'
    ? `Three lanes for volume, pitch and pace. ${DIM_ORDER.map(dim => `${DIMENSIONS[dim].name}: ${r.dims[dim].swings} swings`).join('. ')}.`
    : `${DIMENSIONS[r.dim].name} map of your answer. ${r.main.peak ? `Highest at ${clock(r.main.peak.t)}. ` : ''}${r.main.low ? `Lowest at ${clock(r.main.low.t)}. ` : ''}${ZONE_LIST(r.dim).map(z => `${Math.round(r.main.shares[z] * 100)} percent ${zoneLabel(r.dim, z)}`).join(', ')}.`;
  const ZONE_LIST = () => ['soft', 'natural', 'strong'];

  function afterResults() {
    attachAudio();
    const r = result, row = $('#vvStarRow'), scoreEl = $('#vvScore'), animate = !reduceMotion();
    drawMap();
    const canvas = $('#vvPrint'), startPrint = performance.now();
    const step = now => {
      if (view !== 'results') return;
      const p = animate ? clamp((now - startPrint) / 1100, 0, 1) : 1, eased = 1 - Math.pow(1 - p, 3);
      drawPrint(canvas, r, eased);
      scoreEl.textContent = String(Math.round(r.score * eased));
      if (p < 1) printFrame = requestAnimationFrame(step);
    };
    printFrame = requestAnimationFrame(step);
    [...row.children].forEach((el, i) => {
      if (i >= r.stars) return;
      setTimeout(() => { if (view !== 'results') return; el.classList.add('on'); chime([523.25 * Math.pow(1.122, i * 2)], 0.1, 0.09); }, animate ? 700 + i * 380 : 0);
    });
    if (r.stars === 3 && animate) setTimeout(() => { if (view === 'results') { confetti(); chime([659.25, 783.99, 1046.5, 1318.5], 0.1); } }, 1500);
    // New badges are listed on the results card itself, so no pop-ups here.
    announce(`Round complete. Variety score ${r.score}. ${r.stars} of 3 stars. ${coachingTip(r)}`);
  }
  function attachAudio() {
    const slot = $('#vvAudioSlot'); if (!slot) return;
    if (example) { slot.hidden = true; return; }
    slot.hidden = false;
    if (!audioUrl) { slot.innerHTML = '<span class="vv-fine">Playback is preparing, or your browser does not support recording.</span>'; return; }
    slot.innerHTML = '<label for="vvAudioEl">Listen back. Follow the line.</label>'; audioEl.id = 'vvAudioEl'; slot.append(audioEl);
  }
  function drawPrint(canvas, r, progressFraction) {
    const size = canvas.getBoundingClientRect().width; if (size < 1) return;
    const sized = sizeCanvas(canvas, size); if (!sized) return;
    const { ctx } = sized, c = size / 2;
    ctx.clearRect(0, 0, size, size);
    const rings = r.dim === 'all'
      ? [['volume', 0.255, 0.335], ['pitch', 0.35, 0.42], ['pace', 0.435, 0.495]]
      : [[r.dim, 0.28, 0.475]];
    const duration = Math.max(r.elapsed, 1);
    for (const [dim, a, b] of rings) {
      const rIn = size * a, rMax = size * b, bins = r.dim === 'all' ? 110 : 150;
      ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
      if (r.dim !== 'all') for (const level of [SOFT_EDGE, STRONG_EDGE]) { ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.arc(c, c, rIn + (rMax - rIn) * clamp((level + 0.1) / 1.1, 0, 1), 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(c, c, rIn - 4, 0, Math.PI * 2); ctx.stroke();
      ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.4, 2 * Math.PI * rIn / bins * 0.58);
      for (let k = 0; k < bins * progressFraction; k++) {
        const from = k / bins * duration, to = (k + 1) / bins * duration;
        let sum = 0, n = 0;
        for (let i = Math.floor(from / FRAME_DT); i < Math.min(r.frames.length, Math.ceil(to / FRAME_DT)); i++) { const lv = r.frames[i][dim]; if (Number.isFinite(lv)) { sum += lv; n++; } }
        const angle = -Math.PI / 2 + k / bins * Math.PI * 2, level = n ? sum / n : null;
        const len = level === null ? 2 : 3 + (rMax - rIn - 3) * clamp((level + 0.1) / 1.1, 0.02, 1);
        ctx.strokeStyle = level === null ? 'rgba(160,175,200,.25)' : levelColor(level, 0.95);
        if (level !== null && level > STRONG_EDGE) { ctx.shadowColor = levelColor(level, 0.8); ctx.shadowBlur = 8; } else ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.moveTo(c + Math.cos(angle) * rIn, c + Math.sin(angle) * rIn); ctx.lineTo(c + Math.cos(angle) * (rIn + len), c + Math.sin(angle) * (rIn + len)); ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }
  function drawMap() {
    const canvas = $('#vvMap'); if (!canvas || !result) return;
    const r = result, st = stage, compact = canvas.getBoundingClientRect().width < 560, all = st.dim === 'all';
    const sized = sizeCanvas(canvas, all ? (compact ? 360 : 400) : (compact ? 250 : 310)); if (!sized) return;
    const { ctx, w, h } = sized, L = all ? (compact ? 66 : 92) : (compact ? 48 : 74), R = 14, T = 24, B = 28, pw = w - L - R, ph = h - T - B;
    const duration = st.plan.duration, xOf = time => L + time / duration * pw;
    const lanes = lanesFor(st, T, ph);
    lanes.forEach(lane => drawLaneBands(ctx, lane, L, pw, compact));
    ctx.fillStyle = 'rgba(190,205,225,.55)'; ctx.font = '10px Inter, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let sec = 0; sec <= duration; sec += duration > 90 ? 20 : duration > 40 ? 10 : 5) { ctx.fillText(clock(sec), xOf(sec), h - 8); ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.beginPath(); ctx.moveTo(xOf(sec), T + 3); ctx.lineTo(xOf(sec), T + ph - 3); ctx.stroke(); }
    // PREP parts across the top
    ctx.textBaseline = 'middle';
    st.plan.phases.forEach((p, i) => {
      const xs = xOf(p.from), xe = xOf(p.to);
      if (i) { ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.moveTo(xs, 4); ctx.lineTo(xs, T + ph - 2); ctx.stroke(); ctx.setLineDash([]); }
      ctx.fillStyle = 'rgba(253,230,138,.95)'; ctx.font = `800 ${compact ? 10 : 11}px Inter, system-ui`; ctx.textAlign = 'center';
      ctx.fillText(compact || xe - xs < 90 ? p.letter : `${p.letter} · ${p.label.toUpperCase()}`, (xs + xe) / 2, 11);
    });
    for (const lane of lanes) {
      const yOf = laneY(lane), dim = lane.dim;
      if (lane.guided) {
        const band = DIMENSIONS[dim].band, up = [], low = [];
        for (let tt = 0; tt <= duration + 1e-6; tt += 0.25) { const c = targetAt(st.plan, tt); up.push([xOf(tt), yOf(c + band)]); low.push([xOf(tt), yOf(c - band)]); }
        ctx.beginPath(); up.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); for (let i = low.length - 1; i >= 0; i--) ctx.lineTo(low[i][0], low[i][1]); ctx.closePath();
        ctx.fillStyle = 'rgba(253,224,71,.09)'; ctx.fill(); ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(253,224,71,.6)'; ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
      }
      const grad = levelGradient(ctx, yOf(HI), yOf(LO), HI, LO), fill = levelGradient(ctx, yOf(HI), yOf(LO), HI, LO, 0.22);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const run of traceRuns(r.frames, dim)) {
        if (run.length < 2) continue;
        ctx.beginPath(); run.forEach((f, i) => i ? ctx.lineTo(xOf(f.t), yOf(f[dim])) : ctx.moveTo(xOf(f.t), yOf(f[dim])));
        ctx.lineTo(xOf(run.at(-1).t), yOf(LO)); ctx.lineTo(xOf(run[0].t), yOf(LO)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
        ctx.beginPath(); run.forEach((f, i) => i ? ctx.lineTo(xOf(f.t), yOf(f[dim])) : ctx.moveTo(xOf(f.t), yOf(f[dim])));
        ctx.strokeStyle = grad; ctx.lineWidth = lane.solo ? 3 : 2.4; ctx.shadowColor = 'rgba(255,255,255,.25)'; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
      }
      for (const m of r.dims[dim].swingMoments) { ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(xOf(m.t), lane.y0 + lane.h - 3, 2.2, 0, Math.PI * 2); ctx.fill(); }
      if (lane.solo) {
        const marker = (point, text, above) => {
          if (!point) return;
          const x = xOf(point.t), y = yOf(point.level);
          ctx.fillStyle = '#fff'; ctx.strokeStyle = levelColor(point.level); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.font = '700 10.5px Inter, system-ui'; const tw = ctx.measureText(text).width + 16, bx = clamp(x - tw / 2, L + 2, L + pw - tw - 2), by = clamp(above ? y - 30 : y + 12, T, h - 40);
          ctx.fillStyle = 'rgba(8,13,28,.88)'; roundedRect(ctx, bx, by, tw, 20, 10); ctx.fill();
          ctx.fillStyle = '#f3f6fc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + tw / 2, by + 10);
        };
        const short = point => dim === 'volume' ? `${point.rel >= 0 ? '+' : '−'}${Math.abs(point.rel).toFixed(0)} dB` : dim === 'pitch' ? `${noteName(r.frames[Math.round(point.t / FRAME_DT)]?.midi)}` : `${point.rel.toFixed(1)} syl/s`;
        const main = r.dims[dim];
        marker(main.peak, main.peak ? `▲ ${short(main.peak)}` : '', true);
        if (main.low && main.peak && Math.abs(main.low.t - main.peak.t) > 1) marker(main.low, `▼ ${short(main.low)}`, false);
      }
    }
    if (cursor !== null) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(xOf(cursor), T); ctx.lineTo(xOf(cursor), T + ph); ctx.stroke(); ctx.setLineDash([]); }
    canvas.dataset.left = L; canvas.dataset.width = pw; canvas.dataset.duration = duration;
  }
  function inspect(event, seek = false) {
    const canvas = $('#vvMap'); if (!canvas || !result) return;
    const rect = canvas.getBoundingClientRect(), L = Number(canvas.dataset.left), pw = Number(canvas.dataset.width), duration = Number(canvas.dataset.duration);
    cursor = Math.min(result.elapsed, clamp((event.clientX - rect.left - L) / pw, 0, 1) * duration);
    const frame = result.frames[Math.min(result.frames.length - 1, Math.round(cursor / FRAME_DT))];
    if (frame) {
      const part = phaseAt(stage.plan, frame.t);
      const bits = dimsOf(stage).map(dim => Number.isFinite(frame[dim]) ? `${DIMENSIONS[dim].name} ${zoneLabel(dim, zoneOf(frame[dim]))}` : `${DIMENSIONS[dim].name}: —`);
      $('#vvMoment').textContent = `${clock(frame.t)} · ${part.label} · ${frame.volume === null ? 'a pause' : bits.join(' · ')}${frame.midi ? ` · note ${noteName(frame.midi)}` : ''}${Number.isFinite(frame.rate) ? ` · ${frame.rate.toFixed(1)} syllables/s` : ''}`;
    }
    if (seek && audioUrl) audioEl.currentTime = cursor;
    drawMap();
  }

  // confetti -------------------------------------------------------------------------------
  function confetti() {
    const canvas = confettiCanvas, dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#facc15', '#fb7185', '#2dd4bf', '#a78bfa', '#fde68a'];
    const bits = Array.from({ length: 110 }, () => ({ x: innerWidth * (0.2 + Math.random() * 0.6), y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 11, vy: -Math.random() * 12 - 3, r: Math.random() * 6, s: 4 + Math.random() * 5, c: colors[Math.floor(Math.random() * colors.length)], life: 1 }));
    let last = performance.now();
    const frame = now => {
      const dt = Math.min(0.04, (now - last) / 1000); last = now;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      let alive = 0;
      for (const b of bits) {
        b.vy += 220 * dt; b.x += b.vx * dt * 60; b.y += b.vy * dt * 6; b.vx *= 0.99; b.r += 0.2; b.life -= dt * 0.45;
        if (b.life <= 0) continue; alive++;
        ctx.save(); ctx.globalAlpha = clamp(b.life, 0, 1); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore();
      }
      if (alive) confettiFrame = requestAnimationFrame(frame); else { ctx.clearRect(0, 0, innerWidth, innerHeight); canvas.style.width = '0'; canvas.style.height = '0'; }
    };
    confettiFrame = requestAnimationFrame(frame);
  }

  // ----- example (illustrative data, never saved) --------------------------------------------
  function showExample() {
    teardown(); releaseAudio();
    stage = stageById('volume-ribbon'); scale = scale || normalizeScale(DEFAULT_SCALE); scaleIsDefault = scaleIsDefault || !savedScale;
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const frames = [];
    let held = null, lastVoice = -1;
    for (let i = 0; i < stage.plan.duration / FRAME_DT; i++) {
      const t = i * FRAME_DT, pause = (t > 8.2 && t < 8.8) || (t > 17.8 && t < 18.5) || (t > 31.6 && t < 32.4);
      const level = targetAt(stage.plan, t - 0.45) + Math.sin(t * 2.3) * 0.05 + (rand() - 0.5) * 0.06 + (t > 26 && t < 27.5 ? -0.24 : 0);
      if (!pause) { held = level; lastVoice = t; } else if (t - lastVoice > 0.35) held = null;
      const talking = held !== null, midi = talking ? 50 + Math.sin(t * 1.1) * 2.5 + (t > 20 && t < 30 ? 3 : 0) : null, rate = 2.6 + (t > 18 && t < 31 ? 1.4 : 0) + Math.sin(t) * 0.3;
      frames.push({ t, db: pause ? -80 : scale.soft + clamp(level, 0, 1) * (scale.power - scale.soft), active: !pause, volume: held, midi, pitch: talking ? 0.5 + (midi - 50) / 12 : null, rate, pace: 0.5 + 0.5 * Math.log2(rate / 3.2) });
    }
    result = scoreRound({ frames, stage, scale }); result.frames = frames;
    result.notes = { point: 'Yes: every student should learn it', reason: 'Confidence opens doors', example: 'My first class presentation', finalPoint: 'Speaking is a life skill' };
    award = null; example = true; questionIndex = 0; go('results');
  }

  // ----- events ----------------------------------------------------------------------------
  const openStage = id => {
    const item = stageById(id); if (!item) return;
    if (stage?.id !== item.id) clearNotes();
    stage = scaleStage(item, speechSeconds); questionIndex = questionIndexFor(progress, item); notice = ''; example = false; go('brief');
  };
  const continueAfterTune = () => { tune = null; if (after === 'prep' && stage) { after = null; startPrep(); } else { after = null; go('home'); } };
  root.addEventListener('click', event => {
    const target = event.target.closest('[data-act]'); if (!target) return;
    switch (target.dataset.act) {
      case 'back': if (view === 'home') window.navigateToPage('main'); else go('home'); break;
      case 'sound': muted = !muted; write(MUTE_KEY, muted); render(); if (!muted) chime([660], 0.1, 0.08); break;
      case 'open-stage': openStage(target.dataset.stage); break;
      case 'example': showExample(); break;
      case 'tune': after = null; notice = ''; tune = null; go('tune'); break;
      case 'tune-start': case 'tune-retry': startTune(); break;
      case 'tune-cancel': after = null; go('home'); break;
      case 'disconnect-call': disconnectCall(); toast('Call tab disconnected.', '📞'); render(); break;
      case 'open-settings': window.navigateToPage('settings'); break;
      case 'tune-skip': scale = normalizeScale(DEFAULT_SCALE); scaleIsDefault = true; continueAfterTune(); break;
      case 'tune-continue': continueAfterTune(); break;
      case 'swap': questionIndex = (questionIndex + 1) % QUESTIONS.length; clearNotes(); window.speechSynthesis?.cancel(); render(); viewEl.querySelector('[data-focus]')?.focus({ preventScroll: true }); break;
      case 'speak': if ('speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(question()), { rate: 0.95 })); } break;
      case 'speech-time': speechSeconds = Number(target.dataset.seconds); write(SPEECH_KEY, speechSeconds); stage = scaleStage(stageById(stage.id), speechSeconds); render(); viewEl.querySelector(`[data-act="speech-time"][data-seconds="${speechSeconds}"]`)?.focus(); break;
      case 'prep-time': prepSeconds = Number(target.dataset.seconds); write(PREP_KEY, prepSeconds); render(); viewEl.querySelector(`[data-act="prep-time"][data-seconds="${prepSeconds}"]`)?.focus(); break;
      case 'start-prep': startPrep(); break;
      case 'prep-more': if (prep) { prep.endsAt += 30000; prep.total += 30; } break;
      case 'prep-ready': if (prep?.mic) beginRound(); else $('#vvMicText').textContent = 'Still connecting your microphone…'; break;
      case 'finish': finishRound(); break;
      case 'next-question': questionIndex = questionIndexFor(progress, stage); clearNotes(); notice = ''; go('brief'); break;
      case 'again': notice = ''; go('brief'); break;
      case 'home': go('home'); break;
      default: break;
    }
  });
  root.addEventListener('input', event => { const key = event.target.dataset?.note; if (key) notes[key] = event.target.value; });
  const mapEl = () => $('#vvMap');
  root.addEventListener('pointermove', event => { if (event.target === mapEl() && audioEl.paused) inspect(event); });
  root.addEventListener('click', event => { if (event.target === mapEl()) inspect(event, true); });
  audioEl.addEventListener('play', () => {
    cancelAnimationFrame(playbackFrame);
    const tick = () => { cursor = audioEl.currentTime; drawMap(); if (!audioEl.paused) playbackFrame = requestAnimationFrame(tick); };
    tick();
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !(round || tune || prep)) return;
    event.preventDefault(); notice = 'Stopped. Your microphone is off.';
    if (tune) go('home'); else go('brief', { quiet: true });
  });
  menu.addEventListener('click', () => { window.navigateToPage('variety'); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !(round || tune || prep)) return;
    notice = 'We paused because the page was hidden. Your microphone is off. Start again when you are ready.';
    if (tune) { tune = null; go('tune', { quiet: true }); } else go('brief', { quiet: true });
  });
  window.addEventListener('pagehide', () => { teardown(); disconnectCall(); releaseAudio(); try { sfx?.close(); } catch { /* ignore */ } });
  new ResizeObserver(() => { if (view === 'results') drawMap(); if (view === 'live') drawStageFrame(); }).observe(root);

  // Used by the app's navigation (see index.html).
  window.VocalVariety = {
    stop() { audioEl.pause(); if (round || tune || prep) { notice = ''; go('home', { quiet: true }); } disconnectCall(); },
    render() { if (view === 'live' || view === 'tune' || view === 'prep') return; render(); }
  };
  render();
  if (location.hash === '#vocal-variety') window.navigateToPage('variety');
}

// Start last, so every top-level constant above exists before mount() runs.
if (!native) mount();
