// Think Fast: the screen. Rules, scoring and prompts live in think-fast-core.js.
import {
  MODES, TIME_OPTIONS, ROUND_OPTIONS, BADGES, GRADES, CUES, COMBO_MIN, MIN_REACTION_MS,
  modeById, makeDeck, estimateFloorDb, analyseRound, scoreRound, summarize, rankFor, applyResult,
  normalizeProfile, coachingTip, clamp
} from './think-fast-core.js';

const STORE = 'sg-think-fast-v1';
const RING = 2 * Math.PI * 54;
const MIN_SAVED_ROUNDS = 3;                       // ending earlier than this is just a peek, not a session

const $ = selector => document.querySelector(selector);
const esc = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const seconds = ms => (ms / 1000).toFixed(1);

function loadProfile() { try { return normalizeProfile(JSON.parse(localStorage.getItem(STORE))); } catch { return normalizeProfile(null); } }
function saveProfile() { try { localStorage.setItem(STORE, JSON.stringify(profile)); } catch { /* private mode: the game still works */ } }

let profile = loadProfile();
let view = 'lobby';                                // lobby | countdown | round | results
let session = null;
let notice = '';
let cue = CUES[Math.floor(Math.random() * CUES.length)];
let lastResult = null;
let sfx = null;

const meeting = () => window.MeetingAudio;
const callOn = () => !!meeting()?.enabled?.();
const host = () => window.ThinkFastHost || {};
const pageActive = () => !!$('#rapidFirePage')?.classList.contains('active');

// ---------------------------------------------------------------- sound (never in meeting mode: it would be heard as an answer)
function blip(notes, { gap = 0.09, volume = 0.08, type = 'sine' } = {}) {
  if (profile.settings.muted || callOn()) return;
  try {
    sfx ||= new (window.AudioContext || window.webkitAudioContext)();
    sfx.resume?.();
    const now = sfx.currentTime;
    notes.forEach((freq, i) => {
      const osc = sfx.createOscillator(), gain = sfx.createGain(), start = now + i * gap;
      osc.type = type; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(volume, start + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(sfx.destination); osc.start(start); osc.stop(start + 0.25);
    });
  } catch { /* sound is a bonus */ }
}
const buzz = pattern => { try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(pattern); } catch { /* not every device */ } };

// ---------------------------------------------------------------- listening
async function openMic() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let stream;
  if (callOn()) {
    const ma = meeting();
    if (!ma.supported() || !Ctx) throw Object.assign(new Error('unsupported'), { name: 'UnsupportedCall' });
    if (!ma.isConnected()) throw Object.assign(new Error('not connected'), { name: 'CallNotConnected' });   // only the Settings switch opens the chooser
    stream = ma.clone();
    if (!stream) throw Object.assign(new Error('no audio'), { name: 'NoCallAudio' });
  } else {
    if (!navigator.mediaDevices?.getUserMedia || !Ctx) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }
  const context = new Ctx(); await context.resume();
  const analyser = context.createAnalyser(); analyser.fftSize = 1024;
  const source = context.createMediaStreamSource(stream); source.connect(analyser);
  return { stream, context, analyser, source, buffer: new Float32Array(analyser.fftSize) };
}
function closeMic(mic) {
  if (!mic) return;
  mic.stream.getTracks().forEach(track => track.stop());
  try { mic.source.disconnect(); } catch { /* already disconnected */ }
  if (mic.context.state !== 'closed') mic.context.close().catch(() => {});
}
const micProblem = error => callOn() ? meeting().describeError(error)
  : error?.name === 'NotAllowedError' ? 'The microphone was declined, so this was a practice run without timing. Allow it in your browser’s site settings to get reaction times.'
  : 'No microphone could be started, so this was a practice run without timing.';
function dbNow(mic) {
  mic.analyser.getFloatTimeDomainData(mic.buffer);
  let sum = 0; for (let i = 0; i < mic.buffer.length; i++) sum += mic.buffer[i] * mic.buffer[i];
  return 20 * Math.log10(Math.max(Math.sqrt(sum / mic.buffer.length), 1e-5));
}

// ---------------------------------------------------------------- views
function statChips() {
  const legacy = host().stats?.() || {};
  const sessions = Math.max(profile.sessions, legacy.totalSessions || 0);
  const chips = [['Sessions', sessions], ['Prompts', legacy.totalAnalogies || 0], ['Best score', profile.bestScore || '–'], ['Fastest start', profile.bestReactionMs ? `${seconds(profile.bestReactionMs)}s` : '–']];
  return chips.map(([label, value]) => `<div class="tf-chipstat"><b>${esc(value)}</b><span>${label}</span></div>`).join('');
}

function lobbyHtml() {
  const rank = rankFor(profile.xp), s = profile.settings, mode = modeById(s.mode);
  const modes = MODES.map(m => `<button type="button" class="tf-mode" role="radio" aria-checked="${m.id === s.mode}" data-act="mode" data-id="${m.id}">
      <span class="tf-mode-icon" aria-hidden="true">${m.icon}</span><span class="tf-mode-name">${m.name}</span>
      <span class="tf-mode-blurb">${m.blurb}</span><span class="tf-mode-eg">${esc(m.example)}</span></button>`).join('');
  const times = TIME_OPTIONS.map(o => `<button type="button" class="tf-opt" role="radio" aria-checked="${o.seconds === s.limit}" data-act="limit" data-v="${o.seconds}"><b>${o.label}</b><i>${o.hint}</i></button>`).join('');
  const counts = ROUND_OPTIONS.map(o => `<button type="button" class="tf-opt" role="radio" aria-checked="${o.rounds === s.rounds}" data-act="rounds" data-v="${o.rounds}"><b>${o.label}</b><i>${o.hint}</i></button>`).join('');
  const badges = BADGES.map(b => `<li class="tf-badge${profile.badges.includes(b.id) ? ' on' : ''}" title="${esc(b.hint)}"><span aria-hidden="true">${b.icon}</span><b>${esc(b.name)}</b><i>${esc(b.hint)}</i></li>`).join('');
    const how = `<section class="tf-card tf-how" aria-label="How ${esc(mode.name)} works"><h3 class="tf-h flat">How ${esc(mode.name)} works</h3><ol>${mode.how.map(step => `<li>${esc(step)}</li>`).join('')}</ol><p class="tf-how-eg">Example: <b>${esc(mode.example)}</b></p></section>`;
  return `<div class="tf">
    <header class="tf-hero"><div class="tf-bolt" aria-hidden="true">⚡</div><h2>Think Fast</h2><p>Say it before you think it. The faster you start, the more you score.</p></header>
    <section class="tf-card tf-rank" aria-label="Your rank">
      <div class="tf-rank-top"><span class="tf-rank-icon" aria-hidden="true">${rank.current.icon}</span>
        <div><b>${rank.current.name}</b><span>${profile.xp} XP${rank.next ? ` · ${rank.toNext} to ${rank.next.name}` : ' · top rank'}</span></div></div>
      <div class="tf-xp" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(rank.progress * 100)}"><i style="width:${(rank.progress * 100).toFixed(1)}%"></i></div>
      <div class="tf-chipstats">${statChips()}</div>
    </section>
    <h3 class="tf-h">Pick your game</h3>
    <div class="tf-modes" role="radiogroup" aria-label="Game mode">${modes}</div>
    ${how}
    <section class="tf-card tf-setup">
      <div class="tf-field"><span class="tf-label">Time for each prompt</span><div class="tf-opts" role="radiogroup" aria-label="Time per prompt">${times}</div></div>
      <div class="tf-field"><span class="tf-label">Number of prompts</span><div class="tf-opts" role="radiogroup" aria-label="Number of prompts">${counts}</div></div>
    </section>
    ${notice ? `<p class="tf-notice" role="status">${esc(notice)}</p>` : ''}
    <p class="tf-cue">“${esc(cue)}”</p>
    <button type="button" class="tf-start" data-act="start"><span aria-hidden="true">▶</span> Start ${esc(mode.name)}</button>
    <h3 class="tf-h">Badges <small>${profile.badges.length} of ${BADGES.length}</small></h3>
    <ul class="tf-badges">${badges}</ul>
  </div>`;
}

function dotsHtml() {
  return session.deck.map((_, i) => `<i class="tf-dot${i === session.index ? ' now' : ''}" data-g="${session.results[i]?.grade || ''}"></i>`).join('');
}
function promptHtml(prompt) {
  if (prompt.kind === 'analogy') {
    const match = /^(.*?) (IS|ARE) LIKE (.*)$/.exec(prompt.text);
    if (match) return `<span class="tf-thing">${esc(match[1])}</span><span class="tf-link">${match[2] === 'IS' ? 'is like' : 'are like'}</span><span class="tf-thing">${esc(match[3])}</span>`;
  }
  return `<span class="tf-thing">${esc(prompt.text)}</span>`;
}

function roundHtml() {
  const prompt = session.deck[session.index], total = session.deck.length;
  return `<div class="tf tf-play" data-kind="${prompt.kind}">
    <div class="tf-hud">
      <span class="tf-pill">Prompt <b>${session.index + 1}</b> / ${total}</span>
      <span class="tf-combo" id="tfCombo" data-on="${session.combo >= 2 ? 1 : 0}">🔥 ×${session.combo}</span>
      <span class="tf-pill">${session.listening ? 'Points' : 'Done'} <b id="tfPoints">${session.listening ? session.points : session.results.length}</b></span>
      <button type="button" class="tf-icon" data-act="mute" aria-label="${profile.settings.muted ? 'Turn sound on' : 'Mute sound'}" ${callOn() ? 'hidden' : ''}>${profile.settings.muted ? '🔇' : '🔊'}</button>
    </div>
    <div class="tf-dots" aria-hidden="true">${dotsHtml()}</div>
    <div class="tf-stage" id="tfStage" data-state="live">
      <div class="tf-lead">${esc(prompt.lead)}</div>
      <div class="tf-prompt">${promptHtml(prompt)}</div>
      <div class="tf-tail">${esc(prompt.tail)}</div>
      <div class="tf-hint">${esc(modeById(prompt.kind).hint)}</div>
      <div class="tf-clock" aria-hidden="true">
        <svg viewBox="0 0 120 120" class="tf-ring"><circle class="tf-ring-bg" cx="60" cy="60" r="54"/><circle class="tf-ring-fg" id="tfRing" cx="60" cy="60" r="54" stroke-dasharray="${RING.toFixed(2)}" stroke-dashoffset="0"/></svg>
        <div class="tf-count" id="tfCount">${session.limit}</div>
      </div>
      ${session.listening ? '<div class="tf-voice" id="tfVoice"><span class="tf-voice-bar"><i id="tfLevel"></i></span><span id="tfVoiceText">Waiting for your voice…</span></div>' : '<div class="tf-voice off">Practice run: just say it out loud.</div>'}
      <div class="tf-reveal" id="tfReveal" role="status" aria-live="polite"></div>
    </div>
    <div class="tf-actions"><button type="button" class="tf-ghost" data-act="next">Next prompt ▶</button><button type="button" class="tf-ghost danger" data-act="end">End session</button></div>
    <p class="tf-keys">Space or → for the next prompt · Esc to end</p>
  </div>`;
}

function countdownHtml(n) {
  const mode = modeById(session.mode);
  return `<div class="tf tf-play"><div class="tf-stage tf-ready" data-state="ready">
    <div class="tf-lead">${mode.icon} ${esc(mode.name)}</div>
    <div class="tf-bignum" id="tfBig" key="${n}">${n === 0 ? 'GO!' : n}</div>
    <p class="tf-readyhint">${esc(mode.hint || 'Anything can come next. Start talking the moment it appears.')}</p>
    <p class="tf-readytext">${session.listening ? (session.call ? 'Getting ready to hear the meeting audio…' : 'Stay quiet for a moment while I learn your room…') : 'Practice run: speak out loud, there is no timing.'}</p>
    ${session.listening ? '<div class="tf-voice"><span class="tf-voice-bar"><i id="tfLevel"></i></span><span>Listening</span></div>' : ''}
  </div></div>`;
}

function resultsHtml() {
  const { summary, rank, gained, earned, rankedUp, newBest, rounds } = lastResult;
  const listening = summary.listening;
  const strip = rounds.map((round, i) => {
    const grade = GRADES.find(g => g.id === round.grade);
    return `<li data-g="${round.grade}"><span class="tf-n">${i + 1}</span><span class="tf-gi" aria-hidden="true">${grade?.icon || '✓'}</span><span class="tf-bar"><i style="width:${listening ? clamp(round.points, 4, 100) : 100}%"></i></span><span class="tf-rt">${listening ? (Number.isFinite(round.onsetMs) ? `${seconds(round.onsetMs)}s` : '—') : 'done'}</span></li>`;
  }).join('');
  const stars = [1, 2, 3].map(n => `<span class="tf-star${n <= summary.stars ? ' on' : ''}" style="--i:${n}">★</span>`).join('');
  const badges = earned.map(b => `<li class="tf-badge on new"><span aria-hidden="true">${b.icon}</span><b>${esc(b.name)}</b><i>${esc(b.hint)}</i></li>`).join('');
  const stat = (label, value) => `<div class="tf-chipstat"><b>${value}</b><span>${label}</span></div>`;
  return `<div class="tf tf-results">
    <header class="tf-hero small"><h2>${summary.completed ? 'Session complete' : 'Session ended early'}</h2><p>${esc(modeById(lastResult.mode).name)} · ${lastResult.limit}s a prompt</p></header>
    <section class="tf-card tf-score">
      ${listening ? `<div class="tf-dial" style="--p:${summary.score}"><b>${summary.score}</b><span>score</span></div>
        <div class="tf-stars" aria-label="${summary.stars} of 3 stars">${stars}</div>` : `<div class="tf-dial practice"><b>${summary.rounds}</b><span>prompts spoken</span></div>`}
      <div class="tf-gain"><b>+${gained} XP</b>${newBest ? '<span class="tf-new">New best score!</span>' : ''}</div>
      ${rankedUp ? `<div class="tf-rankup">${rank.current.icon} Rank up: <b>${rank.current.name}</b></div>` : `<div class="tf-rankline">${rank.current.icon} ${rank.current.name}${rank.next ? ` · ${rank.toNext} XP to ${rank.next.name}` : ''}</div>`}
    </section>
    ${listening ? `<div class="tf-chipstats four">${stat('Answered', `${summary.answered}/${summary.rounds}`)}${stat('Average start', summary.avgReactionMs ? `${seconds(summary.avgReactionMs)}s` : '–')}${stat('Fastest start', summary.bestReactionMs ? `${seconds(summary.bestReactionMs)}s` : '–')}${stat('Best streak', `×${summary.longestCombo}`)}</div>` : ''}
    ${lastResult.note ? `<p class="tf-notice">${esc(lastResult.note)}</p>` : ''}
    <section class="tf-card"><h3 class="tf-h flat">Prompt by prompt</h3><ol class="tf-strip">${strip}</ol></section>
    ${earned.length ? `<h3 class="tf-h">New badges</h3><ul class="tf-badges">${badges}</ul>` : ''}
    <p class="tf-tip"><b>Coach:</b> ${esc(coachingTip(summary, lastResult.limit))}</p>
    <div class="tf-actions col"><button type="button" class="tf-start" data-act="again"><span aria-hidden="true">↻</span> Play again</button><button type="button" class="tf-ghost" data-act="lobby">Change game or settings</button></div>
  </div>`;
}

let lastPainted = '';
function paint() {
  const root = $('#thinkFastRoot'); if (!root) return;
  root.innerHTML = view === 'lobby' ? lobbyHtml() : view === 'countdown' ? countdownHtml(session.count) : view === 'round' ? roundHtml() : resultsHtml();
  // fade a screen in when it changes, but never between prompts: every millisecond of the round counts
  if (view !== lastPainted && view !== 'round') root.querySelector('.tf')?.classList.add('tf-in');
  lastPainted = view;
}

// ---------------------------------------------------------------- session flow
function clearTimers() {
  if (!session) return;
  clearInterval(session.sampler); clearInterval(session.clock); clearTimeout(session.next);
  session.timeouts?.forEach(clearTimeout);
}
function endSession() {            // no saving: used when leaving the page or restarting
  if (!session) return;
  clearTimers(); closeMic(session.mic); session = null;
}

async function start() {
  if (session) return;
  const s = profile.settings;
  notice = '';
  session = {
    mode: s.mode, limit: s.limit, deck: makeDeck(s.mode, s.rounds), results: [], index: 0, combo: 0, longestCombo: 0, points: 0,
    listening: s.listen, call: callOn(), mic: null, quiet: [], frames: [], phase: 'ready', timeouts: [], floorDb: -65, count: 3, token: Symbol()
  };
  const mine = session;
  if (mine.listening) {
    const startBtn = $('.tf-start'); if (startBtn) { startBtn.disabled = true; startBtn.textContent = mine.call && !meeting().isConnected() ? 'Choose the meeting tab in the box your browser shows…' : 'Starting the microphone…'; }
    try { mine.mic = await openMic(); } catch (error) { mine.listening = false; mine.problem = micProblem(error); }
    if (session !== mine) { closeMic(mine.mic); return; }
  }
  view = 'countdown'; mine.count = 3; paint();
  mine.sampler = setInterval(() => sample(mine), 25);
  const tick = n => {
    if (session !== mine) return;
    mine.count = n; if (n < 3) paint();
    blip(n === 0 ? [880, 1175] : [440]);
    if (n === 0) { mine.floorDb = estimateFloorDb(mine.quiet); mine.timeouts.push(setTimeout(() => runRound(mine), 550)); }
    else mine.timeouts.push(setTimeout(() => tick(n - 1), 800));
  };
  tick(3);
}

function sample(mine) {
  if (session !== mine || !mine.mic) return;
  const db = dbNow(mine.mic);
  if (mine.phase === 'ready') { mine.quiet.push(db); if (mine.quiet.length > 240) mine.quiet.shift(); }
  const level = $('#tfLevel'); if (level) level.style.width = `${clamp((db + 65) / 45, 0, 1) * 100}%`;
  if (mine.phase === 'round') {
    mine.frames.push({ t: performance.now() - mine.roundStart, db });
    const voiced = db >= Math.max(mine.floorDb + 9, -56);
    const text = $('#tfVoiceText'), voice = $('#tfVoice');
    if (voice && voice.dataset.on !== String(voiced)) { voice.dataset.on = String(voiced); if (text) text.textContent = voiced ? 'Hearing you!' : (mine.heard ? 'Keep going…' : 'Waiting for your voice…'); }
    if (voiced) mine.heard = true;
  }
}

function runRound(mine) {
  if (session !== mine) return;
  mine.phase = 'round'; mine.frames = []; mine.heard = false; mine.shown = mine.limit;
  view = 'round'; paint();
  mine.roundStart = performance.now();
  // a plain interval, not requestAnimationFrame: the round must still end if the tab is in the background
  const frame = () => {
    if (session !== mine || mine.phase !== 'round') return;
    const elapsed = performance.now() - mine.roundStart, left = mine.limit * 1000 - elapsed;
    const ring = $('#tfRing'), count = $('#tfCount'), stage = $('#tfStage');
    if (ring) ring.style.strokeDashoffset = (RING * (1 - clamp(left / (mine.limit * 1000), 0, 1))).toFixed(2);
    const whole = Math.max(Math.ceil(left / 1000), 0);
    if (count && mine.shown !== whole) { mine.shown = whole; count.textContent = whole; if (whole <= 1 && stage) stage.dataset.state = 'hurry'; }
    if (left <= 0) finishRound(mine, 'time');
  };
  mine.clock = setInterval(frame, 50);
}

function finishRound(mine, reason) {
  if (session !== mine || mine.phase !== 'round') return;
  clearInterval(mine.clock);
  const elapsed = Math.min(performance.now() - mine.roundStart, mine.limit * 1000);
  mine.phase = 'reveal';
  let result;
  if (mine.listening) {
    const heard = analyseRound(mine.frames, { limitMs: Math.max(elapsed, MIN_REACTION_MS + 300), floorDb: mine.floorDb });
    const scored = scoreRound(heard, mine.limit * 1000);
    result = { ...heard, ...scored };
  } else result = { points: null, onsetMs: null, grade: 'steady', talkShare: 0 };
  mine.results.push(result);
  if (mine.listening) {
    mine.points += result.points;
    mine.combo = result.points >= COMBO_MIN ? mine.combo + 1 : 0;
    mine.longestCombo = Math.max(mine.longestCombo, mine.combo);
  }
  const grade = GRADES.find(g => g.id === result.grade);
  const reveal = $('#tfReveal'), stage = $('#tfStage');
  if (stage) stage.dataset.state = 'reveal';
  if (reveal) reveal.innerHTML = mine.listening
    ? `<span class="tf-rv-icon" aria-hidden="true">${grade.icon}</span><b>${grade.label}</b><span>${Number.isFinite(result.onsetMs) ? `started in ${seconds(result.onsetMs)}s · ` : 'no answer · '}+${result.points}</span>`
    : '<span class="tf-rv-icon" aria-hidden="true">✓</span><b>Next one…</b>';
  const dots = document.querySelectorAll('.tf-dot'); if (dots[mine.index]) dots[mine.index].dataset.g = result.grade;
  const points = $('#tfPoints'); if (points) points.textContent = mine.listening ? mine.points : mine.results.length;
  const combo = $('#tfCombo'); if (combo) { combo.textContent = `🔥 ×${mine.combo}`; combo.dataset.on = mine.combo >= 2 ? 1 : 0; }
  if (mine.listening) { blip(result.points >= 65 ? [660, 880, 1100] : result.points >= COMBO_MIN ? [600, 760] : result.points > 0 ? [420] : [200], { type: result.points > 0 ? 'sine' : 'triangle' }); buzz(result.points > 0 ? 25 : [60, 40, 60]); }
  mine.next = setTimeout(() => {
    if (session !== mine) return;
    mine.index++;
    if (mine.index >= mine.deck.length) finishSession(mine, true); else runRound(mine);
  }, mine.listening ? 1150 : 500);
}

function finishSession(mine, completed) {
  if (session !== mine) return;
  clearTimers(); closeMic(mine.mic);
  const rounds = mine.results;
  if (!completed && rounds.length < MIN_SAVED_ROUNDS) { session = null; view = 'lobby'; notice = rounds.length ? 'That ended before it could count. Do at least three prompts to save progress.' : ''; paint(); return; }
  const summary = summarize(rounds, { listening: mine.listening, completed });
  const before = profile;
  const outcome = applyResult(profile, { summary, rounds, mode: mine.mode, limit: mine.limit, roundCount: mine.deck.length });
  profile = outcome.profile; saveProfile();
  lastResult = { summary, rounds, mode: mine.mode, limit: mine.limit, gained: outcome.gained, earned: outcome.earned, rankedUp: outcome.rankedUp, newBest: outcome.newBest, rank: rankFor(profile.xp), note: mine.problem || '' };
  try { host().record?.({ rounds: rounds.length, limit: mine.limit, mode: mine.mode, score: summary.score, completed, before: before.sessions }); } catch (error) { console.warn('Think Fast stats could not be saved', error); }
  session = null; view = 'results'; paint();
  blip(summary.stars >= 2 ? [523, 659, 784, 1047] : [523, 659], { gap: 0.12 });
  if (outcome.earned.length) host().toast?.(`${outcome.earned[0].icon} Badge earned: ${outcome.earned[0].name}`);
}

// ---------------------------------------------------------------- input
function onClick(event) {
  const target = event.target.closest('[data-act]'); if (!target) return;
  const act = target.dataset.act, s = profile.settings;
  if (act === 'mode') { s.mode = target.dataset.id; saveProfile(); paint(); }
  else if (act === 'limit') { s.limit = Number(target.dataset.v); saveProfile(); paint(); }
  else if (act === 'rounds') { s.rounds = Number(target.dataset.v); saveProfile(); paint(); }
  else if (act === 'start' || act === 'again') { endSession(); start(); }
  else if (act === 'lobby') { view = 'lobby'; notice = ''; cue = CUES[Math.floor(Math.random() * CUES.length)]; paint(); }
  else if (act === 'next') { if (session?.phase === 'round') finishRound(session, 'skip'); }
  else if (act === 'end') { if (session) finishSession(session, false); }
  else if (act === 'mute') { s.muted = !s.muted; saveProfile(); target.textContent = s.muted ? '🔇' : '🔊'; }
}
function onKey(event) {
  if (!pageActive() || !session) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  if (event.key === 'Escape') { finishSession(session, false); event.preventDefault(); }
  else if ((event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowRight') && session.phase === 'round') { finishRound(session, 'skip'); event.preventDefault(); }
}

function mountStyles() {
  if ($('#thinkFastCss')) return;
  const link = document.createElement('link');
  link.id = 'thinkFastCss'; link.rel = 'stylesheet'; link.href = new URL('./think-fast.css', import.meta.url).href;
  document.head.append(link);
}

function mount() {
  const root = $('#thinkFastRoot'); if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  mountStyles();
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  window.addEventListener('meetingaudio:ready', () => { if (view === 'lobby') paint(); });
  window.addEventListener('meetingaudio:enabled', () => { if (view === 'lobby') paint(); });
  paint();
}

// "Hear me" is a Settings option, not a game option: the app's Settings page reads and writes it here.
window.ThinkFast = {
  getListen: () => profile.settings.listen,
  setListen(value) { profile.settings.listen = Boolean(value); saveProfile(); },
  render() { endSession(); view = 'lobby'; notice = ''; cue = CUES[Math.floor(Math.random() * CUES.length)]; paint(); },
  stop() { endSession(); view = 'lobby'; }
};
window.dispatchEvent(new Event('thinkfast:ready'));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
