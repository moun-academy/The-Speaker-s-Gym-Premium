// Vocal Variety Arena: a web-only practice game. Answer a question out loud and watch your
// volume move through three zones. Audio stays in this browser and nothing is uploaded.
import { detectPitch, rmsOf, midiOf, RhythmTracker, summarize } from './vocal-variety-core.js';
import {
  BAND, BADGES, DEFAULT_SCALE, FRAME_DT, SOFT_EDGE, STAGES, STRONG_EDGE, ZONES, EnvelopeTracker, applyRound, applyTune,
  coachingTip, countSwings, isUnlocked, normalizeScale, phaseAt, rangeLabel, rankFor, relativeDb,
  sanitizeProgress, scaleFromCalibration, scoreRound, stageById, targetAt, zoneOf
} from './vocal-variety-game.js';

const native = window.Capacitor?.isNativePlatform?.() || ['capacitor:', 'ionic:'].includes(location.protocol);

// ---------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------
const PROGRESS_KEY = 'sg-vocal-arena-v1', SCALE_KEY = 'sg-vocal-arena-scale-v1', MUTE_KEY = 'sg-vocal-arena-muted';
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
const signed = value => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(0)} dB`;
function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: progress simply is not kept */ } }

// Colour follows loudness everywhere: violet (soft) → teal (steady) → amber (strong) → coral (peak).
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
  r = Math.min(r, w / 2, h / 2);
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
  for (const level of [loLevel, 0.12, 0.5, 0.78, hiLevel]) {
    const pos = clamp((hiLevel - level) / (hiLevel - loLevel), 0, 1);
    gradient.addColorStop(pos, levelColor(level, alpha));
  }
  return gradient;
}

// ---------------------------------------------------------------------------------------
// art: a stage's volume shape as an SVG
// ---------------------------------------------------------------------------------------
function planArt(stage, { w = 260, h = 100, labels = false, id = stage.id } = {}) {
  const pad = 14, usable = h - pad * 2, plan = stage.plan;
  const yOf = level => pad + (1 - clamp(level, 0, 1)) * usable;
  const half = BAND * usable;
  let line = '', ribbon = '', marks = '';
  if (stage.kind === 'guided') {
    const upper = [], lower = [];
    for (let i = 0; i <= 90; i++) {
      const t = plan.duration * i / 90, x = (w * i / 90).toFixed(1), y = yOf(targetAt(plan, t));
      line += `${i ? 'L' : 'M'}${x} ${y.toFixed(1)}`;
      upper.push(`${x} ${Math.max(2, y - half).toFixed(1)}`); lower.unshift(`${x} ${Math.min(h - 2, y + half).toFixed(1)}`);
    }
    ribbon = `M${upper.join('L')}L${lower.join('L')}Z`;
    if (labels) {
      marks = plan.phases.map((p, i) => {
        const x = (p.from / plan.duration * w).toFixed(1);
        return `${i ? `<line x1="${x}" y1="6" x2="${x}" y2="${h - 6}" class="vv-art-divider"/>` : ''}`;
      }).join('');
    }
  } else {
    for (let i = 0; i <= 120; i++) {
      const x = w * i / 120, p = i / 120;
      const level = 0.5 + 0.34 * Math.sin(p * 17 + 0.6) * Math.sin(p * 5.3 + 1.2) + 0.1 * Math.sin(p * 41);
      line += `${i ? 'L' : 'M'}${x.toFixed(1)} ${yOf(level).toFixed(1)}`;
    }
  }
  const gradient = `<linearGradient id="vvg-${id}" x1="0" y1="${pad}" x2="0" y2="${h - pad}" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${levelColor(1.0)}"/><stop offset=".22" stop-color="${levelColor(0.78)}"/><stop offset=".55" stop-color="${levelColor(0.5)}"/><stop offset="1" stop-color="${levelColor(0.1)}"/></linearGradient>`;
  return `<svg class="vv-art" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><defs>${gradient}</defs>` +
    `${ribbon ? `<path d="${ribbon}" fill="url(#vvg-${id})" opacity=".2"/>` : ''}${marks}` +
    `<path d="${line}" fill="none" stroke="url(#vvg-${id})" stroke-width="3.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" ${stage.kind === 'free' ? 'stroke-dasharray="1 7"' : ''}/></svg>`;
}
const starsHtml = (count, extra = '') => `<span class="vv-stars ${extra}" aria-label="${count} of 3 stars">${[0, 1, 2].map(i => `<i class="${i < count ? 'on' : ''}" aria-hidden="true">★</i>`).join('')}</span>`;

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
  let view = 'home', stage = null, questionIndex = 0, notice = '';
  let tune = null, round = null, result = null, award = null, example = false;
  let micToken = 0, sfx = null, confettiFrame = null, printFrame = null, mapFrame = null, playbackFrame = null, cursor = null;
  let after = null;
  const audioEl = new Audio(); audioEl.controls = true; audioEl.preload = 'metadata'; audioEl.setAttribute('aria-label', 'Playback of your take');
  let audioUrl = null;

  // ----- audio helpers ---------------------------------------------------------------------
  async function openMic(token) {
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
  function closeMic(mic) {
    if (!mic) return;
    mic.stream.getTracks().forEach(track => track.stop());
    try { mic.source.disconnect(); } catch { /* already disconnected */ }
    if (mic.context.state !== 'closed') mic.context.close().catch(() => {});
  }
  const dbOf = rms => 20 * Math.log10(Math.max(rms, 1e-5));
  const micMessage = error => error?.name === 'NotAllowedError' ? 'Microphone access was declined. Allow it in your browser’s site settings, then try again.'
    : error?.name === 'Unsupported' ? 'Live practice needs a browser with microphone support. Try Chrome, Edge, or Safari over HTTPS.'
    : 'Could not start the microphone. Check that it is connected and not used by another app, then try again.';

  function chime(notes = [523.25, 659.25, 783.99], gap = 0.11, volume = 0.1) {
    if (muted) return;
    try {
      sfx ||= new (window.AudioContext || window.webkitAudioContext)();
      sfx.resume?.();
      const now = sfx.currentTime;
      notes.forEach((freq, i) => {
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
  function teardown() {
    micToken++;
    if (round) { clearInterval(round.interval); cancelAnimationFrame(round.raf); round.timers.forEach(clearTimeout); round.recorder?.state === 'recording' && (round.recorder.onstop = null, round.recorder.stop()); closeMic(round.mic); round = null; }
    if (tune) { clearInterval(tune.interval); closeMic(tune.mic); tune = null; }
    cancelAnimationFrame(printFrame); cancelAnimationFrame(mapFrame); cancelAnimationFrame(confettiFrame);
    confettiCanvas.getContext('2d').clearRect(0, 0, 9999, 9999);
    window.speechSynthesis?.cancel();
  }
  function go(next, options = {}) {
    teardown();
    if (next !== 'results') { releaseAudio(); }
    view = next;
    if (next === 'home') { stage = null; example = false; }
    render();
    const heading = viewEl.querySelector('[data-focus]');
    if (heading && !options.quiet) heading.focus({ preventScroll: true });
    if (!options.quiet) root.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function render() {
    $('#vvSound').setAttribute('aria-pressed', String(!muted)); $('#vvSound').classList.toggle('off', muted);
    $('#vvSound').firstElementChild.textContent = muted ? '♪̸' : '♪';
    $('#vvBack').textContent = view === 'home' ? '← Home' : '← Journey';
    viewEl.dataset.view = view;
    viewEl.innerHTML = { home: homeHtml, tune: tuneHtml, brief: briefHtml, live: liveHtml, results: resultsHtml }[view]();
    if (view === 'live') { drawStageFrame(); }
    if (view === 'results') afterResults();
  }

  // ----- HOME ------------------------------------------------------------------------------
  const nextStage = () => STAGES.find(item => isUnlocked(progress, item) && !(progress.stars[item.id] > 0))
    || STAGES.find(item => isUnlocked(progress, item) && (progress.stars[item.id] || 0) < 3) || STAGES[0];
  const totalStars = () => Object.values(progress.stars).reduce((sum, n) => sum + n, 0);

  function homeHtml() {
    const rank = rankFor(progress.xp), upNext = nextStage();
    const started = progress.rounds > 0;
    const bars = Array.from({ length: 40 }, (_, i) => `<i style="--i:${i};--d:${(i * 0.37) % 2.4}s"></i>`).join('');
    return `
    <header class="vv-hero">
      <div class="vv-hero-copy">
        <div class="vv-eyebrow">VOICE ARENA</div>
        <h1 id="vvTitle" tabindex="-1" data-focus>Expand your<br><em>vocal variety.</em></h1>
        <p class="vv-lede">Answer real questions out loud and watch your volume come alive. Whisper to pull people in. Boom to make a point land. Hit every zone and unlock every stage.</p>
        <div class="vv-hero-actions">
          <button type="button" class="vv-primary" data-act="open-stage" data-stage="${upNext.id}"><span aria-hidden="true">▶</span> ${started ? 'Continue' : 'Start'}: ${esc(upNext.title)}</button>
          <button type="button" class="vv-ghost" data-act="example">See an example ↗</button>
        </div>
      </div>
      <div class="vv-hero-art" aria-hidden="true"><div class="vv-orb"><div class="vv-orb-core"></div>${bars}</div>
        <span class="vv-zone-tag z-strong">BOOM</span><span class="vv-zone-tag z-natural">STEADY</span><span class="vv-zone-tag z-soft">WHISPER</span></div>
    </header>
    <section class="vv-player" aria-label="Your progress">
      <div class="vv-rank"><div class="vv-rank-top"><span class="vv-rank-name">${esc(rank.name)}</span><span class="vv-rank-xp">${progress.xp} XP</span></div>
        <div class="vv-bar" role="img" aria-label="${rank.nextName ? `${rank.toNext} XP to ${esc(rank.nextName)}` : 'Top rank reached'}"><i style="width:${(rank.pct * 100).toFixed(0)}%"></i></div>
        <small>${rank.nextName ? `${rank.toNext} XP to ${esc(rank.nextName)}` : 'You have reached the top rank.'}</small></div>
      <div class="vv-stat"><strong>${progress.streak.count}<span aria-hidden="true">🔥</span></strong><small>day streak</small></div>
      <div class="vv-stat"><strong>${totalStars()}<span aria-hidden="true">★</span></strong><small>of ${STAGES.length * 3} stars</small></div>
      <div class="vv-stat"><strong>${Object.keys(progress.badges).length}<span aria-hidden="true">🏅</span></strong><small>of ${BADGES.length} badges</small></div>
    </section>
    <section class="vv-tunebar" aria-label="Voice range">${scale
      ? `<div><strong>Your range is tuned</strong><small>${scaleIsDefault ? 'Using a typical range. Tune it for accurate zones.' : `Whisper to power spans about ${scale.span.toFixed(0)} dB on this microphone.`}</small></div><button type="button" class="vv-ghost" data-act="tune">Retune ↻</button>`
      : `<div><strong>Tune your range first (12 seconds)</strong><small>Every microphone is different. We learn your whisper, natural voice and power voice so the zones fit you.</small></div><button type="button" class="vv-ghost" data-act="tune">Find my range</button>`}</section>
    <section aria-labelledby="vvJourneyTitle"><div class="vv-section-head"><div class="vv-section-label">THE JOURNEY</div><h2 id="vvJourneyTitle">Five stages. One voice that moves.</h2></div>
      <div class="vv-journey">${STAGES.map(stageCard).join('')}</div></section>
    <section aria-labelledby="vvBadgesTitle"><div class="vv-section-head"><div class="vv-section-label">COLLECTION</div><h2 id="vvBadgesTitle">Badges</h2></div>
      <ul class="vv-badges">${BADGES.map(badge => {
        const got = progress.badges[badge.id];
        return `<li class="${got ? 'got' : ''}"><span class="vv-badge-icon" aria-hidden="true">${esc(badge.icon)}</span><div><strong>${esc(badge.name)}</strong><small>${esc(badge.desc)}</small></div><span class="vv-sr">${got ? 'Earned' : 'Not earned yet'}</span></li>`;
      }).join('')}</ul></section>
    <p class="vv-private">Microphone audio and playback stay in this browser and are replaced by your next take. Nothing is uploaded. Your stars, XP and badges are saved on this device only and do not change your coaching scores.</p>`;
  }
  function stageCard(item) {
    const open = isUnlocked(progress, item), stars = progress.stars[item.id] || 0, best = progress.best[item.id];
    const prev = STAGES[item.n - 2];
    return `<button type="button" class="vv-stage-card ${open ? '' : 'locked'} ${stars ? 'done' : ''}" data-act="open-stage" data-stage="${item.id}" ${open ? '' : 'aria-disabled="true"'}>
      <span class="vv-stage-n" aria-hidden="true">${item.n}</span>
      <span class="vv-stage-art">${planArt(item, { id: `card-${item.id}` })}</span>
      <span class="vv-stage-title">${esc(item.title)}</span><span class="vv-stage-tag">${esc(item.tagline)}</span>
      <span class="vv-stage-foot">${open ? starsHtml(stars) : '<span class="vv-lock" aria-hidden="true">🔒</span>'}
        <small>${open ? `${item.plan.duration}s · ${item.kind === 'guided' ? 'Follow the ribbon' : 'Free play'}${best ? ` · Best ${best}` : ''}` : `Earn a star on “${esc(prev.title)}”`}</small></span></button>`;
  }

  // ----- BRIEF (the question) --------------------------------------------------------------
  function briefHtml() {
    const question = stage.questions[questionIndex], plan = stage.plan, stars = progress.stars[stage.id] || 0;
    const speakable = 'speechSynthesis' in window;
    const side = stage.kind === 'guided'
      ? `<li><b>Follow the ribbon.</b> Keep your voice inside the glowing road. It tells you when to whisper, build and boom.</li><li><b>Make real swings.</b> Aim for ${plan.goalSwings} clear changes between zones.</li><li><b>Keep talking.</b> Pauses are good. Silence for most of the round is not.</li>`
      : `<li><b>Find a whisper</b> and stay there for over a second.</li><li><b>Hit a boom</b> and let it ring.</li><li><b>Make ${plan.goalSwings} swings</b> between zones.</li><li><b>Keep talking</b> for most of the ${plan.duration} seconds.</li>`;
    return `
    <div class="vv-brief">
      <div class="vv-brief-main">
        <div class="vv-stage-chip"><span>STAGE ${stage.n}</span> ${esc(stage.title.toUpperCase())} ${starsHtml(stars, 'small')}</div>
        <h2 class="vv-question" id="vvTitle" tabindex="-1" data-focus><span aria-hidden="true">“</span>${esc(question)}<span aria-hidden="true">”</span></h2>
        <div class="vv-brief-tools"><button type="button" class="vv-ghost" data-act="swap">↻ Different question</button>${speakable ? '<button type="button" class="vv-ghost" data-act="speak">🔊 Read it to me</button>' : ''}</div>
        <div class="vv-plan"><div class="vv-plan-head"><span class="vv-section-label">${stage.kind === 'guided' ? 'YOUR VOLUME PLAN' : 'YOUR PLAYGROUND'}</span><span class="vv-plan-time">${plan.duration} seconds</span></div>
          <div class="vv-plan-art">${stage.kind === 'guided' ? planArt(stage, { w: 640, h: 190, labels: true, id: 'brief' }) : zoneLadderHtml()}
            <span class="vv-axis a-top">BOOM</span><span class="vv-axis a-mid">STEADY</span><span class="vv-axis a-low">WHISPER</span></div>
          <ol class="vv-phases" style="--n:${plan.phases.length}">${plan.phases.map(p => `<li style="flex:${p.to - p.from}"><span aria-hidden="true">${esc(p.icon)}</span><b>${esc(p.label)}</b><small>${esc(p.cue)}</small></li>`).join('')}</ol></div>
      </div>
      <aside class="vv-brief-side">
        <div class="vv-section-label">HOW TO WIN</div><ul class="vv-rules">${side}</ul>
        <div class="vv-stars-key"><span>${starsHtml(1, 'small')} ${stage.kind === 'guided' ? '55' : '50'}+</span><span>${starsHtml(2, 'small')} ${stage.kind === 'guided' ? '72' : '68'}+</span><span>${starsHtml(3, 'small')} ${stage.kind === 'guided' ? '88' : '85'}+</span></div>
        ${notice ? `<p class="vv-warning" role="alert">${esc(notice)}</p>` : ''}
        <button type="button" class="vv-primary vv-big" data-act="start-round"><span aria-hidden="true">●</span> ${scale ? 'Start the round' : 'Tune, then start'}</button>
        <p class="vv-fine">We will ask for your microphone. Strong means energetic, never strained. Stop if your throat feels tight.</p>
      </aside>
    </div>`;
  }
  function zoneLadderHtml() {
    return `<div class="vv-ladder" aria-hidden="true"><div class="z-strong"></div><div class="z-natural"></div><div class="z-soft"></div></div>`;
  }

  // ----- TUNE (find your range) ------------------------------------------------------------
  const TUNE_STEPS = [
    { id: 'silence', word: 'Shhh…', say: 'Stay quiet for a moment so we can hear your room.', lead: 0.4, dur: 1.6 },
    { id: 'whisper', word: 'Whisper', say: '“I’m about to tell you a secret.”', lead: 1.1, dur: 2.6 },
    { id: 'normal', word: 'Natural voice', say: '“Hi, I’m here to practise my voice.”', lead: 1.1, dur: 2.6 },
    { id: 'power', word: 'Strong voice', say: '“Everyone, listen up! Let’s go!”', lead: 1.1, dur: 2.6 }
  ];
  function tuneHtml() {
    const state = tune?.state || 'intro';
    if (state === 'done') return tuneDoneHtml();
    const running = state === 'running' || state === 'waiting';
    return `
    <div class="vv-tune">
      <div class="vv-section-label">STEP 0 · FIND YOUR RANGE</div>
      <h2 id="vvTitle" tabindex="-1" data-focus>${running ? 'Show us your voice.' : 'Let’s find your range.'}</h2>
      <p class="vv-lede">Every voice and microphone is different. In about 12 seconds you will whisper, speak naturally and call out strongly. Then the zones fit you, not a stranger.</p>
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
    const s = tune.cal.scale, missing = Object.entries(tune.cal.heard).filter(([, n]) => n < 25).map(([k]) => k);
    const ok = !missing.length;
    const marks = [['Whisper', s.soft, 0.0], ['Natural', s.natural, 0.5], ['Power', s.power, 1.0]];
    return `
    <div class="vv-tune">
      <div class="vv-section-label">${ok ? 'RANGE FOUND' : 'ALMOST THERE'}</div>
      <h2 id="vvTitle" tabindex="-1" data-focus>${ok ? `You have a ${s.span.toFixed(0)} dB range to play with.` : 'We missed a part of your voice.'}</h2>
      <p class="vv-lede">${ok ? (s.widened ? 'Your whisper, natural and strong voice were close together, so we stretched your zones. Push the difference a little more next time for sharper results.' : 'These are your personal markers. From now on, “Whisper”, “Steady” and “Boom” are measured against them.')
        : `We could not hear your ${missing.map(k => k === 'normal' ? 'natural voice' : k).join(' or ')}. Move a little closer to the microphone, then try again.`}</p>
      <div class="vv-scale" role="img" aria-label="Your range: whisper ${s.soft.toFixed(0)} dB, natural ${s.natural.toFixed(0)} dB, power ${s.power.toFixed(0)} dB">
        <div class="vv-scale-bar"></div>${marks.map(([name, db, pos]) => `<div class="vv-scale-mark" style="left:${pos * 100}%"><i></i><b>${name}</b><small>${db.toFixed(0)} dBFS</small></div>`).join('')}</div>
      <div class="vv-tune-actions">${ok ? '<button type="button" class="vv-primary vv-big" data-act="tune-continue">Start playing →</button><button type="button" class="vv-ghost" data-act="tune-retry">Retune</button>'
        : '<button type="button" class="vv-primary vv-big" data-act="tune-retry">Try again</button><button type="button" class="vv-ghost" data-act="tune-skip">Use a typical range</button>'}</div>
    </div>`;
  }
  async function startTune() {
    teardown();
    tune = { state: 'waiting', data: { silence: [], whisper: [], normal: [], power: [] }, mic: null };
    notice = ''; view = 'tune'; render();
    const token = micToken; // teardown bumped it
    let mic;
    try { mic = await openMic(token); } catch (error) {
      if (token !== micToken) return;
      tune = null; notice = micMessage(error); render(); return;
    }
    if (!mic || token !== micToken) return;
    tune.mic = mic; tune.state = 'running';
    const stageEl = $('#vvTuneStage'), word = $('#vvTuneWord'), say = $('#vvTuneSay'), count = $('#vvTuneCount');
    const orb = $('#vvTuneOrb');
    stageEl.dataset.state = 'running';
    const total = TUNE_STEPS.reduce((sum, s) => sum + s.lead + s.dur, 0);
    const begin = performance.now();
    let lastIndex = -1;
    tune.interval = setInterval(() => {
      const elapsed = (performance.now() - begin) / 1000;
      mic.analyser.getFloatTimeDomainData(mic.buffer);
      const db = dbOf(rmsOf(mic.buffer));
      orb.style.setProperty('--lvl', clamp((db + 68) / 52, 0, 1).toFixed(3));
      let cursorT = 0, index = TUNE_STEPS.length;
      for (let i = 0; i < TUNE_STEPS.length; i++) {
        const stepLen = TUNE_STEPS[i].lead + TUNE_STEPS[i].dur;
        if (elapsed < cursorT + stepLen) { index = i; break; }
        cursorT += stepLen;
      }
      if (index >= TUNE_STEPS.length) { finishTune(); return; }
      const step = TUNE_STEPS[index], local = elapsed - cursorT, listening = local >= step.lead;
      if (index !== lastIndex) {
        lastIndex = index; word.textContent = step.word; say.textContent = step.say;
        stageEl.querySelectorAll('.vv-tune-steps li').forEach((li, i) => { li.classList.toggle('now', i === index); li.classList.toggle('done', i < index); });
        announce(`${step.word}. ${step.say}`);
      }
      stageEl.dataset.listening = String(listening);
      count.textContent = listening ? 'Listening…' : 'Get ready…';
      stageEl.style.setProperty('--p', clamp((local - step.lead) / step.dur, 0, 1).toFixed(3));
      if (listening) tune.data[step.id].push(db);
      stageEl.style.setProperty('--total', (elapsed / total).toFixed(3));
    }, 20);
  }
  function finishTune() {
    const finished = tune; clearInterval(finished.interval); closeMic(finished.mic); finished.mic = null;
    finished.cal = scaleFromCalibration(finished.data); finished.state = 'done';
    const ok = Object.values(finished.cal.heard).every(n => n >= 25);
    if (ok) {
      scale = finished.cal.scale; scaleIsDefault = false; write(SCALE_KEY, { scale, at: Date.now() });
      const outcome = applyTune(progress, new Date()); progress = outcome.progress; save();
      outcome.newBadges.forEach(badge => toast(`Badge unlocked: ${badge.name}`, badge.icon));
      chime([523.25, 783.99, 1046.5]);
    }
    render(); viewEl.querySelector('[data-focus]')?.focus({ preventScroll: true });
    announce(ok ? 'Your range is set.' : 'We missed part of your voice. Try again.');
  }

  // ----- LIVE ------------------------------------------------------------------------------
  function liveHtml() {
    const plan = stage.plan, guided = stage.kind === 'guided', first = plan.phases[0];
    return `
    <div class="vv-live" data-kind="${stage.kind}">
      <div class="vv-live-top">
        <div class="vv-live-q"><div class="vv-stage-chip"><span>STAGE ${stage.n}</span> ${esc(stage.title.toUpperCase())}</div><h2 id="vvTitle" tabindex="-1" data-focus>“${esc(stage.questions[questionIndex])}”</h2></div>
        <div class="vv-clock" aria-hidden="true"><strong id="vvClock">${clock(plan.duration)}</strong><small>LEFT</small></div>
        <button type="button" class="vv-stop" data-act="finish" id="vvFinish">■ Finish</button>
      </div>
      <div class="vv-stage" id="vvStage">
        <div class="vv-stage-head"><div class="vv-cue" id="vvCue"><span class="vv-cue-icon" id="vvCueIcon" aria-hidden="true">${esc(first.icon)}</span><div><strong id="vvCueLabel">${esc(first.label)}</strong><small id="vvCueText">${esc(first.cue)}</small></div></div>
          <div class="vv-hud"><div><small>${guided ? 'ON THE RIBBON' : 'ZONES HIT'}</small><strong id="vvHud1">${guided ? '—' : '0 / 3'}</strong></div><div><small>${guided ? 'STREAK' : 'LOUDNESS'}</small><strong id="vvHud2">${guided ? '0.0s' : '—'}</strong></div><div><small>SWINGS</small><strong id="vvHud3">0</strong></div></div></div>
        <div class="vv-canvas-wrap"><canvas id="vvStageCanvas" aria-hidden="true"></canvas><div class="vv-countdown" id="vvCountdown" aria-hidden="true"></div></div>
        <div class="vv-timeline" id="vvTimeline" aria-hidden="true">${plan.phases.map(p => `<div style="flex:${p.to - p.from}"><span>${esc(p.label)}</span></div>`).join('')}<i id="vvTimeFill"></i></div>
      </div>
      ${guided ? '' : `<ul class="vv-goals" id="vvGoals">${[['whisper', 'Find a whisper'], ['boom', 'Hit a boom'], ['swings', `${plan.goalSwings} swings`], ['flow', 'Keep talking']].map(([id, label]) => `<li data-goal="${id}"><span aria-hidden="true"></span>${label}</li>`).join('')}</ul>`}
      <p class="vv-status" id="vvLiveStatus" role="status">Waiting for your microphone…</p>
    </div>`;
  }

  async function startRound() {
    if (!scale) { after = 'round'; startTune(); return; }
    teardown(); notice = '';
    releaseAudio();
    view = 'live'; render();
    const token = micToken;
    let mic;
    try { mic = await openMic(token); } catch (error) {
      if (token !== micToken) return;
      notice = micMessage(error); go('brief', { quiet: true }); return;
    }
    if (!mic || token !== micToken) return;
    const plan = stage.plan, guided = stage.kind === 'guided';
    round = {
      mic, plan, guided, mode: 'countdown', t0: 0, frames: [], pitchFrames: [], rhythm: new RhythmTracker(), env: new EnvelopeTracker(scale),
      live: { t: 0, db: -90, level: null, raw: null, active: false }, display: -0.08, particles: [], timers: [], recorder: null, chunks: [],
      credit: 0, creditN: 0, streak: 0, miss: 0, lastHud: 0, lastScore: 0, partial: null, phaseKey: -1, swingToasts: new Set(), unlocked: new Set()
    };
    const r = round;
    r.interval = setInterval(analyse, 20);
    r.raf = requestAnimationFrame(drawLoop);
    $('#vvLiveStatus').textContent = 'Microphone is on. Get ready: the round starts after the countdown.';
    announce('Get ready. The round starts in three seconds.');
    const count = $('#vvCountdown');
    [['3', 0], ['2', 1000], ['1', 2000], ['Speak!', 3000]].forEach(([label, delay]) => r.timers.push(setTimeout(() => {
      if (round !== r) return;
      count.textContent = label; count.classList.remove('pop'); void count.offsetWidth; count.classList.add('pop');
      if (label === 'Speak!') beginSpeaking(r);
    }, delay)));
    r.timers.push(setTimeout(() => { if (round === r) count.textContent = ''; }, 4000));
  }
  function beginSpeaking(r) {
    r.mode = 'live'; r.t0 = performance.now(); r.env.reset(); r.rhythm.reset();
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
    $('#vvLiveStatus').textContent = 'Listening. Answer the question out loud and let your volume move.';
    announce(`Go. ${r.plan.phases[0].label}. ${r.plan.phases[0].cue}`);
  }
  function analyse() {
    const r = round; if (!r) return;
    r.mic.analyser.getFloatTimeDomainData(r.mic.buffer);
    const rms = rmsOf(r.mic.buffer), db = dbOf(rms);
    const t = r.mode === 'live' ? (performance.now() - r.t0) / 1000 : 0;
    const env = r.env.push(r.mode === 'live' ? t : performance.now() / 1000, db);
    r.live = { t, db, level: env.level, raw: env.raw, active: env.active };
    if (r.mode !== 'live') return;
    if (t >= r.plan.duration) { finishRound(); return; }
    const pace = r.rhythm.push(t, rms);
    while (r.frames.length * FRAME_DT <= t) {
      const index = r.frames.length, ft = index * FRAME_DT;
      let midi = null;
      if (index % 2 === 0) {
        midi = midiOf(detectPitch(r.mic.buffer, r.mic.context.sampleRate));
        r.pitchFrames.push({ t: ft, midi, db, pace });
      }
      r.frames.push({ t: ft, db, level: env.level, active: env.active });
      if (env.level !== null) {
        if (r.guided) {
          const distance = Math.abs(env.level - targetAt(r.plan, ft));
          const credit = distance <= BAND ? 1 : Math.max(0, 1 - (distance - BAND) / 0.25);
          r.credit += credit; r.creditN++;
          if (credit === 1) { r.streak += FRAME_DT; r.miss = 0; } else if (++r.miss > 10) r.streak = 0;
        }
        r.unlocked.add(zoneOf(env.level));
      }
    }
  }
  function finishRound() {
    const r = round; if (!r) return;
    clearInterval(r.interval); cancelAnimationFrame(r.raf); r.timers.forEach(clearTimeout);
    const frames = r.frames, pitchFrames = r.pitchFrames, played = r.mode === 'live';
    if (r.recorder?.state === 'recording') r.recorder.stop();
    closeMic(r.mic); round = null; micToken++;
    if (!played || frames.length < 20) { notice = 'That round ended before we heard enough. Try again when you are ready.'; go('brief', { quiet: true }); return; }
    result = scoreRound({ frames, stage, scale }); result.frames = frames; result.pitchFrames = pitchFrames;
    award = applyRound(progress, stage, result, new Date(), questionIndex);
    progress = award.progress; save(); example = false;
    go('results');
  }
  function liveScore(r) {
    if (r.frames.length < 10) return null;
    return scoreRound({ frames: r.frames, stage, scale });
  }

  // live canvas ---------------------------------------------------------------------------
  function drawLoop() {
    const r = round; if (!r) return;
    r.raf = requestAnimationFrame(drawLoop);
    const now = performance.now();
    if (now - r.lastHud > 100) { r.lastHud = now; updateHud(r); }
    drawStageFrame();
  }
  function updateHud(r) {
    const now = performance.now(), t = r.mode === 'live' ? r.live.t : 0, plan = r.plan;
    const left = Math.max(0, plan.duration - t);
    const clockEl = $('#vvClock'); if (!clockEl) return;
    clockEl.textContent = clock(Math.ceil(left));
    $('#vvTimeFill').style.width = `${clamp(t / plan.duration, 0, 1) * 100}%`;
    const swings = countSwings(r.frames).swings; $('#vvHud3').textContent = String(swings);
    if (r.guided) {
      $('#vvHud1').textContent = r.creditN ? `${Math.round(r.credit / r.creditN * 100)}%` : '—';
      $('#vvHud2').textContent = `${r.streak.toFixed(1)}s`;
      $('#vvStage').classList.toggle('hot', r.streak >= 2);
    } else {
      $('#vvHud1').textContent = `${r.unlocked.size} / 3`;
      $('#vvHud2').textContent = r.live.active ? `${relativeDb(r.live.db, scale) >= 0 ? '+' : '−'}${Math.abs(relativeDb(r.live.db, scale)).toFixed(0)} dB` : '—';
      if (now - r.lastScore > 500) {
        r.lastScore = now; const partial = liveScore(r);
        if (partial) partial.goals.forEach(goal => $(`#vvGoals [data-goal="${goal.id}"]`)?.classList.toggle('done', goal.done));
      }
    }
    const index = plan.phases.indexOf(phaseAt(plan, t));
    if (index !== r.phaseKey && r.mode === 'live') {
      r.phaseKey = index; const p = plan.phases[index];
      $('#vvCueIcon').textContent = p.icon; $('#vvCueLabel').textContent = p.label; $('#vvCueText').textContent = p.cue;
      const cue = $('#vvCue'); cue.classList.remove('swap'); void cue.offsetWidth; cue.classList.add('swap');
      if (t > 0.5) announce(`${p.label}. ${p.cue}`);
    }
  }
  function drawStageFrame() {
    const canvas = $('#vvStageCanvas'); if (!canvas) return;
    const wide = canvas.getBoundingClientRect().width;
    const sized = sizeCanvas(canvas, wide < 560 ? 300 : 360); if (!sized) return;
    const r = round, plan = stage.plan, guided = stage.kind === 'guided';
    const live = r ? r.live : { level: null, active: false };
    const t = r && r.mode === 'live' ? r.live.t : 0;
    if (r) {
      const goal = live.level === null ? -0.1 : live.level;
      r.display += (goal - r.display) * (live.level === null ? 0.08 : 0.35);
    }
    drawStage(sized.ctx, sized.w, sized.h, {
      t, plan, guided, frames: r?.frames || [], live, display: r ? r.display : -0.08, particles: r?.particles || [], now: performance.now(), mode: r?.mode || 'countdown'
    });
  }
  function drawStage(ctx, w, h, s) {
    const compact = w < 560, L = compact ? 54 : 84, R = 12, T = 14, B = 22;
    const pw = w - L - R, ph = h - T - B, past = compact ? 4 : 5, future = compact ? 6 : 9, span = past + future;
    const HI = 1.12, LO = -0.12;
    const yOf = level => T + (1 - (clamp(level, LO, HI) - LO) / (HI - LO)) * ph;
    const xOf = time => L + pw * (past + (time - s.t)) / span;
    const px = L + pw * past / span;
    ctx.clearRect(0, 0, w, h);

    // zone bands
    for (const [id, a, b, label] of [['strong', STRONG_EDGE, HI, 'BOOM'], ['natural', SOFT_EDGE, STRONG_EDGE, 'STEADY'], ['soft', LO, SOFT_EDGE, compact ? 'SOFT' : 'WHISPER']]) {
      const y1 = yOf(b), y2 = yOf(a), mid = (a + b) / 2;
      const g = ctx.createLinearGradient(0, y1, 0, y2);
      g.addColorStop(0, levelColor(mid, 0.2)); g.addColorStop(1, levelColor(mid, 0.06));
      ctx.fillStyle = g; roundedRect(ctx, L, y1 + 1.5, pw, y2 - y1 - 3, 14); ctx.fill();
      ctx.fillStyle = levelColor(mid, 0.95); ctx.font = `800 ${compact ? 10 : 11}px Inter, system-ui, sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(label, L - 12, (y1 + y2) / 2);
    }
    // moving time ticks
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(190,205,225,.45)'; ctx.font = '10px Inter, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let sec = Math.max(0, Math.ceil(s.t - past)); sec <= Math.min(s.plan.duration, Math.floor(s.t + future)); sec++) {
      const x = xOf(sec); if (x < L || x > L + pw) continue;
      ctx.beginPath(); ctx.moveTo(x, T + 4); ctx.lineTo(x, T + ph - 4); ctx.stroke();
      if (sec % 5 === 0) ctx.fillText(clock(sec), x, h - 6);
    }
    // phase dividers and labels
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `700 ${compact ? 10 : 11}px Inter, system-ui`;
    s.plan.phases.forEach((p, i) => {
      const xs = xOf(p.from), xe = xOf(p.to);
      if (xe < L || xs > L + pw) return;
      if (i && xs >= L && xs <= L + pw) { ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(xs, T + 6); ctx.lineTo(xs, T + ph - 6); ctx.stroke(); ctx.setLineDash([]); }
      const lx = Math.max(xs + 9, L + 10);
      if (lx < L + pw - 70) { const current = s.t >= p.from && s.t < p.to; ctx.fillStyle = current ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.5)'; ctx.fillText(`${p.icon}  ${p.label.toUpperCase()}`, lx, T + 14); }
    });

    // ribbon
    if (s.guided) {
      const t0 = Math.max(0, s.t - past), t1 = Math.min(s.plan.duration, s.t + future), step = 0.1;
      const up = [], low = [];
      for (let tt = t0; tt <= t1 + 1e-6; tt += step) { const c = targetAt(s.plan, tt), x = xOf(tt); up.push([x, yOf(c + BAND)]); low.push([x, yOf(c - BAND)]); }
      const path = () => { ctx.beginPath(); up.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); for (let i = low.length - 1; i >= 0; i--) ctx.lineTo(low[i][0], low[i][1]); ctx.closePath(); };
      const edge = () => { ctx.beginPath(); up.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.moveTo(low[0][0], low[0][1]); low.forEach(([x, y]) => ctx.lineTo(x, y)); };
      for (const [alpha, x0, x1] of [[0.45, L, px], [1, px, L + pw]]) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, h); ctx.clip(); ctx.globalAlpha = alpha;
        path(); const g = ctx.createLinearGradient(px, 0, L + pw, 0); g.addColorStop(0, 'rgba(253,224,71,.30)'); g.addColorStop(1, 'rgba(253,224,71,.10)'); ctx.fillStyle = g; ctx.fill();
        ctx.shadowColor = 'rgba(253,224,71,.55)'; ctx.shadowBlur = 10; ctx.strokeStyle = 'rgba(253,224,71,.85)'; ctx.lineWidth = 1.6; edge(); ctx.stroke();
        ctx.restore();
      }
      // stretches where you stayed on the ribbon glow brighter (one smooth shape per stretch)
      ctx.fillStyle = 'rgba(253,224,71,.2)';
      let hits = [];
      const flushHits = () => {
        if (hits.length > 1) {
          ctx.beginPath(); hits.forEach(([x, c], i) => i ? ctx.lineTo(x, yOf(c + BAND)) : ctx.moveTo(x, yOf(c + BAND)));
          for (let i = hits.length - 1; i >= 0; i--) ctx.lineTo(hits[i][0], yOf(hits[i][1] - BAND));
          ctx.closePath(); ctx.fill();
        }
        hits = [];
      };
      for (const f of s.frames) {
        if (f.t < s.t - past - 0.1) continue;
        const c = targetAt(s.plan, f.t);
        if (f.level !== null && Math.abs(f.level - c) <= BAND) hits.push([xOf(f.t), c]); else flushHits();
      }
      flushHits();
    }

    // trace
    const grad = levelGradient(ctx, yOf(HI), yOf(LO), HI, LO);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const visible = s.frames.filter(f => f.t >= s.t - past - 0.1);
    for (let from = 0; from < visible.length;) {
      let to = from; const chunk = [];
      while (to < visible.length && chunk.length < 12) { if (visible[to].level === null) break; chunk.push(visible[to]); to++; }
      if (!chunk.length) { from++; continue; }
      if (to < visible.length && visible[to].level !== null) chunk.push(visible[to]);
      const age = (s.t - chunk[0].t) / past, alpha = clamp(1 - age * 0.82, 0.12, 1);
      ctx.globalAlpha = alpha; ctx.strokeStyle = grad; ctx.lineWidth = 3.4; ctx.shadowColor = levelColor(chunk[0].level, 0.7); ctx.shadowBlur = 9;
      ctx.beginPath(); chunk.forEach((f, i) => i ? ctx.lineTo(xOf(f.t), yOf(f.level)) : ctx.moveTo(xOf(f.t), yOf(f.level))); ctx.stroke();
      from = Math.max(to, from + 1);
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    // playhead
    const ph2 = ctx.createLinearGradient(0, T, 0, T + ph); ph2.addColorStop(0, 'rgba(255,255,255,0)'); ph2.addColorStop(0.5, 'rgba(255,255,255,.28)'); ph2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = ph2; ctx.fillRect(px - 0.75, T, 1.5, ph);

    // orb
    const level = s.display, oy = yOf(level), color = levelRgb(clamp(level, 0, 1)), inBand = s.guided && s.live.level !== null && Math.abs(s.live.level - targetAt(s.plan, s.t)) <= BAND && s.mode === 'live';
    const halo = ctx.createRadialGradient(px, oy, 2, px, oy, inBand ? 56 : 40);
    halo.addColorStop(0, `rgba(${color},${s.live.active ? 0.55 : 0.2})`); halo.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(px, oy, inBand ? 56 : 40, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = s.live.active ? 1 : 0.5;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, oy, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = `rgb(${color})`; ctx.beginPath(); ctx.arc(px, oy, 12.5, 0, Math.PI * 2); ctx.stroke();
    if (inBand) { const pulse = (s.now / 600) % 1; ctx.globalAlpha = 1 - pulse; ctx.strokeStyle = 'rgb(253,224,71)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, oy, 14 + pulse * 20, 0, Math.PI * 2); ctx.stroke(); }
    ctx.globalAlpha = 1;
    if (!s.live.active && s.mode === 'live') { ctx.fillStyle = 'rgba(210,222,240,.75)'; ctx.font = '600 11px Inter, system-ui'; ctx.textAlign = 'left'; ctx.fillText('speak…', px + 24, oy - 14); }

    // sparks when you are on the ribbon
    if (!reduceMotion()) {
      if (inBand && Math.random() < 0.7) s.particles.push({ x: px, y: oy + (Math.random() - 0.5) * 10, vx: -(30 + Math.random() * 60), vy: (Math.random() - 0.5) * 50, life: 1 });
      for (let i = s.particles.length - 1; i >= 0; i--) {
        const p = s.particles[i]; p.life -= 0.025; p.x += p.vx / 60; p.y += p.vy / 60;
        if (p.life <= 0) { s.particles.splice(i, 1); continue; }
        ctx.fillStyle = `rgba(253,224,71,${p.life * 0.9})`; ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 + p.life * 1.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (!s.guided && s.t < 3 && s.mode === 'live') { ctx.fillStyle = 'rgba(230,238,250,.6)'; ctx.font = '600 13px Inter, system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('Your move. Visit every zone.', px + 50, yOf(0.5)); }
  }

  // ----- RESULTS ---------------------------------------------------------------------------
  function resultsHtml() {
    const r = result, st = stage, guided = st.kind === 'guided';
    const headline = r.stars === 3 ? 'Electric. That is real vocal variety.' : r.stars === 2 ? 'Strong contrast. Your voice is moving.' : r.stars === 1 ? 'You are on the board. Now widen it.' : 'Good start. Let’s widen the swings.';
    const shares = ['soft', 'natural', 'strong'];
    const rank = award?.rank, lvlUp = award && award.rank.index > award.rankBefore.index;
    const melody = summarize(r.pitchFrames || []);
    const paces = (r.pitchFrames || []).map(f => f.pace).filter(Number.isFinite).sort((a, b) => a - b);
    const paceText = paces.length >= 10 ? `${paces[Math.round((paces.length - 1) * 0.1)].toFixed(1)}–${paces[Math.round((paces.length - 1) * 0.9)].toFixed(1)}` : '—';
    return `
    <div class="vv-result" data-example="${example}">
      <div class="vv-result-top">
        <div class="vv-print"><canvas id="vvPrint" role="img" aria-label="Your voiceprint: a ring where taller, warmer spikes are louder moments of your take"></canvas>
          <div class="vv-print-center"><strong id="vvScore" data-score="${r.score}">0</strong><small>VARIETY SCORE</small></div></div>
        <div class="vv-result-sum">
          <div class="vv-section-label">${example ? 'EXAMPLE · NOT YOUR VOICE' : `ROUND COMPLETE · ${esc(st.title.toUpperCase())}`}</div>
          <h2 id="vvTitle" tabindex="-1" data-focus>${esc(headline)}</h2>
          <div class="vv-star-row" id="vvStarRow" data-stars="${r.stars}" role="img" aria-label="${r.stars} of 3 stars">${[0, 1, 2].map(i => `<i data-i="${i}">★</i>`).join('')}</div>
          <p class="vv-tip">${esc(coachingTip(r))}</p>
          ${award && !example ? `<div class="vv-xp"><div class="vv-xp-row"><strong>+${award.xpGained} XP</strong><span>${esc(rank.name)}${rank.nextName ? ` · ${rank.toNext} to ${esc(rank.nextName)}` : ' · top rank'}</span></div><div class="vv-bar"><i style="width:${(rank.pct * 100).toFixed(0)}%"></i></div>${lvlUp ? `<p class="vv-levelup">Rank up! You have reached ${esc(rank.name)}.</p>` : ''}${award.unlockedNext ? `<p class="vv-levelup">Stage unlocked: ${esc(award.unlockedNext.title)}</p>` : ''}${award.personalBest ? '<p class="vv-levelup">New personal best</p>' : ''}</div>` : ''}
          <ul class="vv-goal-chips">${r.goals.map(g => `<li class="${g.done ? 'done' : ''}"><span aria-hidden="true">${g.done ? '✓' : '○'}</span><b>${esc(g.label)}</b><small>${esc(g.detail)}</small></li>`).join('')}</ul>
          ${award?.newBadges.length && !example ? `<div class="vv-new-badges">${award.newBadges.map(b => `<span><i aria-hidden="true">${esc(b.icon)}</i> Badge: <b>${esc(b.name)}</b></span>`).join('')}</div>` : ''}
        </div>
      </div>

      <section class="vv-map-card" aria-labelledby="vvMapTitle">
        <div class="vv-map-head"><div><div class="vv-section-label">YOUR VOLUME MAP</div><h3 id="vvMapTitle">See exactly where your voice went.</h3></div>
          <div class="vv-legend" aria-hidden="true"><span class="z-strong">Boom</span><span class="z-natural">Steady</span><span class="z-soft">Whisper</span>${guided ? '<span class="z-ribbon">Ribbon</span>' : ''}</div></div>
        <div class="vv-playback" id="vvAudioSlot"></div>
        <canvas id="vvMap" role="img" aria-label="${esc(mapSummary(r))}"></canvas>
        <p class="vv-moment" id="vvMoment" role="status" aria-live="polite">${example ? 'This is made-up example data. ' : ''}Hover or tap the map to inspect a moment${example ? '' : ', then tap to jump there in playback'}.</p>
      </section>

      <section class="vv-tiles" aria-label="Details">
        <div class="vv-tile wide"><span class="vv-tile-k">ZONE MIX</span>
          <div class="vv-mix" role="img" aria-label="${shares.map(z => `${ZONES[z].label} ${Math.round(r.shares[z] * 100)} percent`).join(', ')}">${shares.map(z => `<i class="z-${z === 'soft' ? 'soft' : z === 'strong' ? 'strong' : 'natural'}" style="flex:${Math.max(r.shares[z], 0.001)}"><b>${r.shares[z] >= 0.08 ? Math.round(r.shares[z] * 100) + '%' : ''}</b></i>`).reverse().join('')}</div>
          <div class="vv-mix-key">${shares.slice().reverse().map(z => `<span class="z-${z === 'soft' ? 'soft' : z === 'strong' ? 'strong' : 'natural'}">${ZONES[z].label} ${r.seconds[z].toFixed(1)}s</span>`).join('')}</div></div>
        <div class="vv-tile"><span class="vv-tile-k">RANGE</span><strong>${r.rangeDb ? r.rangeDb.toFixed(0) : '—'}<small> dB</small></strong><em>${r.rangeDb ? rangeLabel(r.rangeDb) : 'Speak up to measure'}</em></div>
        <div class="vv-tile"><span class="vv-tile-k">SWINGS</span><strong>${r.swings}<small> / ${r.swingGoal}</small></strong><em>${r.swings >= r.swingGoal ? 'Goal reached' : 'changes between zones'}</em></div>
        <div class="vv-tile"><span class="vv-tile-k">${guided ? 'RIBBON MATCH' : 'ZONE BALANCE'}</span><strong>${Math.round((guided ? r.match : r.balance) * 100)}<small>%</small></strong><em>${guided ? `best streak ${r.bestStreak.toFixed(1)}s` : 'whisper, steady and boom all used'}</em></div>
        <div class="vv-tile"><span class="vv-tile-k">TALKING TIME</span><strong>${Math.round(r.activeFraction * 100)}<small>%</small></strong><em>of the round (pauses are fine)</em></div>
        <div class="vv-tile"><span class="vv-tile-k">LOUDEST MOMENT</span><strong>${r.peak ? clock(r.peak.t) : '—'}</strong><em>${r.peak ? `${signed(r.peak.rel)} vs your natural voice` : ''}</em></div>
        <div class="vv-tile"><span class="vv-tile-k">SOFTEST MOMENT</span><strong>${r.low ? clock(r.low.t) : '—'}</strong><em>${r.low ? `${signed(r.low.rel)} vs your natural voice` : ''}</em></div>
        <div class="vv-tile"><span class="vv-tile-k">MELODY · BONUS</span><strong>${melody.pitchRange === null ? '—' : melody.pitchRange.toFixed(1)}<small> semitones</small></strong><em>${melody.notes.length ? `${melody.notes.length} steady notes` : 'pitch range of your voice'}</em></div>
        <div class="vv-tile"><span class="vv-tile-k">RHYTHM · BONUS</span><strong>${paceText}</strong><em>estimated syllables / second</em></div>
      </section>

      <div class="vv-actions">
        ${example ? '<button type="button" class="vv-primary vv-big" data-act="open-stage" data-stage="whisper-boom">▶ Play it for real</button>'
          : `<button type="button" class="vv-primary vv-big" data-act="next-question">Next question →</button>
             <button type="button" class="vv-ghost" data-act="again">Try this question again</button>
             ${award?.unlockedNext ? `<button type="button" class="vv-ghost glow" data-act="open-stage" data-stage="${award.unlockedNext.id}">Play ${esc(award.unlockedNext.title)} →</button>` : ''}`}
        <button type="button" class="vv-ghost" data-act="home">Journey map</button>
      </div>
      <details class="vv-method"><summary>How these numbers work</summary>
        <p><b>Zones.</b> Your whisper, natural voice and power voice from “Find your range” set the scale: whisper is 0, natural 0.5, power 1. Soft is below 0.28, Boom above 0.72. The volume is measured relative to your microphone, not in calibrated sound pressure, so keep the microphone at the same distance.</p>
        <p><b>Variety score.</b> Range between your quiet and loud moments (45%), swings between zones (35%) and balance across all three zones (20%). Guided rounds blend in how closely you followed the ribbon (70% ribbon, 30% variety). Talking for less than half the round lowers the score; pauses themselves are never penalised.</p>
        <p><b>Melody and rhythm</b> are bonus estimates. Pitch is detected from voiced sound; rhythm counts energy peaks as syllables. Neither is a transcript or words per minute, and neither changes your score.</p>
        <p>More variety is useful when it supports your message. Nothing here changes your Speaker’s Gym coaching scores or history.</p></details>
    </div>`;
  }
  const mapSummary = r => `Volume map of your take. ${r.peak ? `Loudest at ${clock(r.peak.t)}. ` : ''}${r.low ? `Softest at ${clock(r.low.t)}. ` : ''}${Math.round(r.shares.soft * 100)} percent whisper, ${Math.round(r.shares.natural * 100)} percent steady, ${Math.round(r.shares.strong * 100)} percent boom.`;

  function afterResults() {
    attachAudio();
    const r = result, row = $('#vvStarRow'), scoreEl = $('#vvScore');
    const animate = !reduceMotion();
    drawMap();
    // voiceprint sweep
    const canvas = $('#vvPrint');
    const startPrint = performance.now();
    const step = now => {
      if (view !== 'results') return;
      const p = animate ? clamp((now - startPrint) / 1100, 0, 1) : 1;
      drawPrint(canvas, r, 1 - Math.pow(1 - p, 3));
      scoreEl.textContent = String(Math.round(r.score * (1 - Math.pow(1 - p, 3))));
      if (p < 1) printFrame = requestAnimationFrame(step);
    };
    printFrame = requestAnimationFrame(step);
    // stars
    const stars = [...row.children];
    stars.forEach((el, i) => {
      if (i >= r.stars) return;
      setTimeout(() => { if (view !== 'results') return; el.classList.add('on'); chime([523.25 * Math.pow(1.122, i * 2)], 0.1, 0.09); }, animate ? 700 + i * 380 : 0);
    });
    if (r.stars === 3 && animate) setTimeout(() => { if (view === 'results') { confetti(); chime([659.25, 783.99, 1046.5, 1318.5], 0.1); } }, 1500);
    if (award && !example) award.newBadges.forEach((badge, i) => setTimeout(() => toast(`Badge unlocked: ${badge.name}`, badge.icon), 900 + i * 500));
    announce(`Round complete. Variety score ${r.score}. ${r.stars} of 3 stars. ${coachingTip(r)}`);
  }
  function attachAudio() {
    const slot = $('#vvAudioSlot'); if (!slot) return;
    if (example || !audioUrl) { slot.hidden = true; if (!example && view === 'results') { slot.hidden = false; slot.innerHTML = '<span class="vv-fine">Playback is preparing, or your browser does not support recording.</span>'; } return; }
    slot.hidden = false; slot.innerHTML = '<label for="vvAudioEl">Listen back. Follow the line.</label>'; audioEl.id = 'vvAudioEl'; slot.append(audioEl);
  }
  function drawPrint(canvas, r, progressFraction) {
    const size = canvas.getBoundingClientRect().width; if (size < 1) return;
    const sized = sizeCanvas(canvas, size); if (!sized) return;
    const { ctx } = sized, c = size / 2, rIn = size * 0.28, rMax = size * 0.475, bins = 150;
    ctx.clearRect(0, 0, size, size);
    ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
    for (const [level, label] of [[SOFT_EDGE, 'soft'], [STRONG_EDGE, 'strong']]) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.arc(c, c, rIn + (rMax - rIn) * clamp((level + 0.1) / 1.1, 0, 1), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.arc(c, c, rIn - 5, 0, Math.PI * 2); ctx.stroke();
    const duration = Math.max(r.elapsed, 1), width = Math.max(1.6, 2 * Math.PI * rIn / bins * 0.58);
    ctx.lineCap = 'round'; ctx.lineWidth = width;
    for (let k = 0; k < bins * progressFraction; k++) {
      const from = k / bins * duration, to = (k + 1) / bins * duration;
      let sum = 0, n = 0;
      for (let i = Math.floor(from / FRAME_DT); i < Math.min(r.frames.length, Math.ceil(to / FRAME_DT)); i++) { const lv = r.frames[i].level; if (lv !== null) { sum += lv; n++; } }
      const angle = -Math.PI / 2 + k / bins * Math.PI * 2, level = n ? sum / n : null;
      const len = level === null ? 3 : 5 + (rMax - rIn - 5) * clamp((level + 0.1) / 1.1, 0.02, 1);
      ctx.strokeStyle = level === null ? 'rgba(160,175,200,.28)' : levelColor(level, 0.95);
      if (level !== null && level > STRONG_EDGE) { ctx.shadowColor = levelColor(level, 0.8); ctx.shadowBlur = 8; } else ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.moveTo(c + Math.cos(angle) * rIn, c + Math.sin(angle) * rIn); ctx.lineTo(c + Math.cos(angle) * (rIn + len), c + Math.sin(angle) * (rIn + len)); ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }
  function drawMap() {
    const canvas = $('#vvMap'); if (!canvas || !result) return;
    const r = result, st = stage, compact = canvas.getBoundingClientRect().width < 560;
    const sized = sizeCanvas(canvas, compact ? 240 : 300); if (!sized) return;
    const { ctx, w, h } = sized, L = compact ? 48 : 74, R = 14, T = 16, B = 28, pw = w - L - R, ph = h - T - B;
    const HI = 1.12, LO = -0.12, duration = st.plan.duration;
    const yOf = level => T + (1 - (clamp(level, LO, HI) - LO) / (HI - LO)) * ph, xOf = time => L + time / duration * pw;
    for (const [a, b, label] of [[STRONG_EDGE, HI, 'BOOM'], [SOFT_EDGE, STRONG_EDGE, 'STEADY'], [LO, SOFT_EDGE, compact ? 'SOFT' : 'WHISPER']]) {
      const mid = (a + b) / 2, y1 = yOf(b), y2 = yOf(a), g = ctx.createLinearGradient(0, y1, 0, y2);
      g.addColorStop(0, levelColor(mid, 0.2)); g.addColorStop(1, levelColor(mid, 0.06));
      ctx.fillStyle = g; roundedRect(ctx, L, y1 + 1.5, pw, y2 - y1 - 3, 12); ctx.fill();
      ctx.fillStyle = levelColor(mid, 0.95); ctx.font = `800 ${compact ? 9 : 10.5}px Inter, system-ui`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(label, L - 10, (y1 + y2) / 2);
    }
    ctx.fillStyle = 'rgba(190,205,225,.55)'; ctx.font = '10px Inter, system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const every = duration > 40 ? 10 : 5;
    for (let sec = 0; sec <= duration; sec += every) { ctx.fillText(clock(sec), xOf(sec), h - 8); ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.beginPath(); ctx.moveTo(xOf(sec), T + 3); ctx.lineTo(xOf(sec), T + ph - 3); ctx.stroke(); }
    if (st.kind === 'guided') {
      const up = [], low = [];
      for (let tt = 0; tt <= duration + 1e-6; tt += 0.25) { const c = targetAt(st.plan, tt); up.push([xOf(tt), yOf(c + BAND)]); low.push([xOf(tt), yOf(c - BAND)]); }
      ctx.beginPath(); up.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); for (let i = low.length - 1; i >= 0; i--) ctx.lineTo(low[i][0], low[i][1]); ctx.closePath();
      ctx.fillStyle = 'rgba(253,224,71,.09)'; ctx.fill(); ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(253,224,71,.6)'; ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
    }
    const grad = levelGradient(ctx, yOf(HI), yOf(LO), HI, LO), fill = levelGradient(ctx, yOf(HI), yOf(LO), HI, LO, 0.22);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        ctx.beginPath(); run.forEach((f, i) => i ? ctx.lineTo(xOf(f.t), yOf(f.level)) : ctx.moveTo(xOf(f.t), yOf(f.level)));
        ctx.lineTo(xOf(run.at(-1).t), yOf(LO)); ctx.lineTo(xOf(run[0].t), yOf(LO)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
        ctx.beginPath(); run.forEach((f, i) => i ? ctx.lineTo(xOf(f.t), yOf(f.level)) : ctx.moveTo(xOf(f.t), yOf(f.level)));
        ctx.strokeStyle = grad; ctx.lineWidth = 3; ctx.shadowColor = 'rgba(255,255,255,.25)'; ctx.shadowBlur = 6; ctx.stroke(); ctx.shadowBlur = 0;
      }
      run = [];
    };
    for (const f of r.frames) { if (f.level === null) flush(); else run.push(f); }
    flush();
    // swing ticks and markers
    for (const m of r.swingMoments) { ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(xOf(m.t), T + ph + 2, 2.4, 0, Math.PI * 2); ctx.fill(); }
    const marker = (point, text, above) => {
      if (!point) return;
      const x = xOf(point.t), y = yOf(point.level);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = levelColor(point.level); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.font = '700 10.5px Inter, system-ui'; const tw = ctx.measureText(text).width + 16, bx = clamp(x - tw / 2, L + 2, L + pw - tw - 2), by = above ? y - 30 : y + 12;
      ctx.fillStyle = 'rgba(8,13,28,.88)'; roundedRect(ctx, bx, Math.max(2, Math.min(h - 40, by)), tw, 20, 10); ctx.fill();
      ctx.fillStyle = '#f3f6fc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + tw / 2, Math.max(2, Math.min(h - 40, by)) + 10);
    };
    marker(r.peak, `▲ ${signed(r.peak?.rel ?? 0)}`, true);
    if (r.low && r.peak && Math.abs(r.low.t - r.peak.t) > 1) marker(r.low, `▼ ${signed(r.low.rel)}`, false);
    if (cursor !== null) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(xOf(cursor), T); ctx.lineTo(xOf(cursor), T + ph); ctx.stroke(); ctx.setLineDash([]); }
    canvas.dataset.left = L; canvas.dataset.width = pw; canvas.dataset.duration = duration;
  }
  function inspect(event, seek = false) {
    const canvas = $('#vvMap'); if (!canvas || !result) return;
    const rect = canvas.getBoundingClientRect(), L = Number(canvas.dataset.left), pw = Number(canvas.dataset.width), duration = Number(canvas.dataset.duration);
    const ratio = clamp((event.clientX - rect.left - L) / pw, 0, 1);
    cursor = Math.min(result.elapsed, ratio * duration);
    const frame = result.frames[Math.min(result.frames.length - 1, Math.round(cursor / FRAME_DT))];
    if (frame) {
      const zone = frame.level === null ? 'a pause' : ZONES[zoneOf(frame.level)].label;
      $('#vvMoment').textContent = `${clock(frame.t)} · ${zone}${frame.active ? ` · ${signed(relativeDb(frame.db, scale))} vs your natural voice` : ''}`;
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
        b.vy += 22 * dt * 10; b.x += b.vx * dt * 60; b.y += b.vy * dt * 60 * 0.1 * 10; b.vx *= 0.99; b.r += 0.2; b.life -= dt * 0.45;
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
    stage = stageById('whisper-boom'); scale = scale || normalizeScale(DEFAULT_SCALE); scaleIsDefault = scaleIsDefault || !savedScale;
    const s = scale; let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const dbAt = level => level <= 0.5 ? s.soft + level / 0.5 * (s.natural - s.soft) : s.natural + (level - 0.5) / 0.5 * (s.power - s.natural);
    const env = new EnvelopeTracker(s), frames = [], pitchFrames = [];
    for (let i = 0; i < stage.plan.duration / FRAME_DT; i++) {
      const t = i * FRAME_DT, pause = (t > 9.1 && t < 9.7) || (t > 21.6 && t < 22.3) || (t > 14.8 && t < 15.1);
      const wobble = Math.sin(t * 2.3) * 0.05 + (rand() - 0.5) * 0.06 + (t > 11 && t < 12.3 ? -0.22 : 0) + (t > 24 && t < 25 ? 0.2 : 0);
      const level = targetAt(stage.plan, t - 0.45) + wobble;
      const db = pause ? -80 : dbAt(level), out = env.push(t, db);
      frames.push({ t, db, level: out.level, active: out.active });
      if (i % 2 === 0) pitchFrames.push({ t, midi: pause ? null : Math.round((48 + level * 9 + Math.sin(t * 1.3) * 3) * 2) / 2, db, pace: pause ? null : 2.4 + level * 2 });
    }
    result = scoreRound({ frames, stage, scale: s }); result.frames = frames; result.pitchFrames = pitchFrames;
    award = null; example = true; questionIndex = 0; go('results');
  }

  // ----- events ----------------------------------------------------------------------------
  const openStage = id => {
    const item = stageById(id); if (!item) return;
    if (!isUnlocked(progress, item)) { toast(`Earn a star on “${STAGES[item.n - 2].title}” to unlock this stage.`, '🔒'); return; }
    stage = item; questionIndex = progress.seen[item.id] ?? 0; notice = ''; example = false; go('brief');
  };
  root.addEventListener('click', event => {
    const target = event.target.closest('[data-act]'); if (!target) return;
    const act = target.dataset.act;
    switch (act) {
      case 'back': if (view === 'home') window.navigateToPage('main'); else go('home'); break;
      case 'sound': muted = !muted; write(MUTE_KEY, muted); render(); if (!muted) chime([660], 0.1, 0.08); break;
      case 'open-stage': openStage(target.dataset.stage); break;
      case 'example': showExample(); break;
      case 'tune': after = null; notice = ''; tune = null; view = 'tune'; go('tune'); break;
      case 'tune-start': startTune(); break;
      case 'tune-retry': startTune(); break;
      case 'tune-cancel': after = null; go('home'); break;
      case 'tune-skip': scale = normalizeScale(DEFAULT_SCALE); scaleIsDefault = true; tune = null; if (after === 'round') { after = null; startRound(); } else go(stage ? 'brief' : 'home'); break;
      case 'tune-continue': tune = null; if (after === 'round') { after = null; startRound(); } else go(stage ? 'brief' : 'home'); break;
      case 'swap': questionIndex = (questionIndex + 1) % stage.questions.length; window.speechSynthesis?.cancel(); render(); viewEl.querySelector('[data-focus]')?.focus({ preventScroll: true }); break;
      case 'speak': if ('speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(stage.questions[questionIndex]), { rate: 0.95 })); } break;
      case 'start-round': startRound(); break;
      case 'finish': finishRound(); break;
      case 'next-question': questionIndex = progress.seen[stage.id] ?? (questionIndex + 1) % stage.questions.length; notice = ''; go('brief'); break;
      case 'again': notice = ''; go('brief'); break;
      case 'home': go('home'); break;
      default: break;
    }
  });
  const mapEl = () => $('#vvMap');
  root.addEventListener('pointermove', event => { if (event.target === mapEl() && audioEl.paused) inspect(event); });
  root.addEventListener('click', event => { if (event.target === mapEl()) inspect(event, true); });
  audioEl.addEventListener('play', () => {
    cancelAnimationFrame(playbackFrame);
    const tick = () => { cursor = audioEl.currentTime; drawMap(); if (!audioEl.paused) playbackFrame = requestAnimationFrame(tick); };
    tick();
  });
  audioEl.addEventListener('pause', () => { cursor = audioEl.ended ? null : cursor; });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && (round || tune)) { event.preventDefault(); notice = 'Stopped. Your microphone is off.'; round ? go('brief', { quiet: true }) : go('home'); } });
  menu.addEventListener('click', () => { window.navigateToPage('variety'); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !(round || tune)) return;
    notice = 'We paused because the page was hidden. Your microphone is off. Start again when you are ready.';
    if (round) go('brief', { quiet: true }); else { tune = null; go('tune', { quiet: true }); }
  });
  window.addEventListener('pagehide', () => { teardown(); releaseAudio(); try { sfx?.close(); } catch { /* ignore */ } });
  new ResizeObserver(() => { if (view === 'results') { drawMap(); } if (view === 'live') drawStageFrame(); }).observe(root);

  // Used by the app's navigation (see index.html).
  window.VocalVariety = {
    stop() { audioEl.pause(); if (round || tune) { notice = ''; go('home', { quiet: true }); } },
    render() { if (view === 'live' || view === 'tune') return; render(); }
  };
  render();
  if (location.hash === '#vocal-variety') window.navigateToPage('variety');
}

// Start last, so every top-level constant above exists before mount() runs.
if (!native) mount();
