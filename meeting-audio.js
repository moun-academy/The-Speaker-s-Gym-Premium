// Meeting audio: lets the games hear the people in a video call while the coach shares their screen.
//
// ONE switch in Settings controls it for every game. It is OFF every time the app opens and is never remembered. Turning it
// on opens the browser's own share picker: the coach picks the Google Meet tab (or the entire screen with system audio).
// From then on every game that listens (Think Fast, Speak on the Spot, the home-page recorder, the vocal variety games)
// takes its audio from that connection instead of the microphone, until the switch is turned off or the share stops
// (which also turns the switch off).
// Web only: the native app does not load this file.

let enabledNow = false;                    // the one switch; in memory only, so every launch starts with it off
let hostNow = false;                       // mixing the coach's microphone in has no control in the app, so it is always off
let stopNotice = '';
// older versions remembered the choice: forget it, so nothing is ever switched on by an old setting
for (const key of ['callAudioMode', 'meetingAudioIncludeHost']) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } }
const HEARING_DB = -62;                    // above this is "sound"; below is silence or faint noise
const listeners = new Set();
let connection = null;                     // { stream, surface }
let monitor = null;                        // { context, source, analyser, buffer, timer, element }
let level = -100, lastSound = 0;
let connectionToken = 0, sourceId = 0;

function releaseConnection(value) {
  if (!value) return;
  value.copies.forEach(stream => stream.getTracks().forEach(track => track.stop()));
  value.stream.getTracks().forEach(track => track.stop());
  value.capture.getTracks().forEach(track => track.stop());
  value.microphone?.getTracks().forEach(track => track.stop());
  value.sources.forEach(source => { try { source.disconnect(); } catch { /* already disconnected */ } });
  value.context?.close().catch(() => {});
}

const read = () => enabledNow;
const notify = () => { for (const fn of [...listeners]) { try { fn(MeetingAudio.status()); } catch { /* a listener failed */ } } };

function surfaceName(surface) {
  return surface === 'browser' ? 'a browser tab' : surface === 'monitor' ? 'the entire screen' : surface === 'window' ? 'a window' : 'your share';
}

function startMonitor(stream) {
  stopMonitor();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const context = new Ctx(), analyser = context.createAnalyser(); analyser.fftSize = 1024;
  const source = context.createMediaStreamSource(stream); source.connect(analyser);
  // Some browsers only feed Web Audio from a captured stream once something is playing it: a muted
  // audio element does that without any sound reaching the speakers (no feedback into the share).
  const element = new Audio(); element.muted = true; element.srcObject = stream; element.play?.().catch(() => {});
  context.resume?.().catch(() => {});
  const buffer = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    let energy = 0; for (const sample of buffer) energy += sample * sample;
    const db = 20 * Math.log10(Math.max(Math.sqrt(energy / buffer.length), 1e-5));
    level = Math.max(db, level - 3);       // fast attack, slow release, for a steady meter
    if (db > HEARING_DB) lastSound = Date.now();
  }, 120);
  monitor = { context, source, analyser, buffer, timer, element };
}
function stopMonitor() {
  if (!monitor) return;
  clearInterval(monitor.timer);
  try { monitor.source.disconnect(); } catch { /* already disconnected */ }
  monitor.element.srcObject = null;
  monitor.context.close().catch(() => {});
  monitor = null; level = -100; lastSound = 0;
}

export const MeetingAudio = {
  supported: () => Boolean(navigator.mediaDevices?.getDisplayMedia),
  enabled: read,
  includeHost: () => hostNow,
  setIncludeHost(value) { hostNow = Boolean(value); notify(); },
  setEnabled(value, notice = '') {
    enabledNow = Boolean(value); stopNotice = value ? '' : notice;
    window.dispatchEvent(new CustomEvent('meetingaudio:enabled', { detail: Boolean(value) }));
    if (!value) this.disconnect();
    notify();
  },
  isConnected: () => Boolean(connection && connection.stream.getAudioTracks().some(track => track.readyState === 'live')),
  status() {
    const connected = this.isConnected();
    return {
      enabled: read(), supported: this.supported(), connected, surface: connection?.surface || null, level: connected ? level : -100,
      hearing: connected && lastSound > 0 && Date.now() - lastSound < 6000, silentSeconds: connected && lastSound ? Math.round((Date.now() - lastSound) / 1000) : null,
      notice: stopNotice, sourceId: connected ? connection.id : null, includeHost: Boolean(connected && connection.microphone), hostError: connected ? connection.hostError : ''
    };
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  // Must be called from a click: the browser only opens its share picker for a user action.
  async connect() {
    if (!this.supported()) throw Object.assign(new Error('unsupported'), { name: 'UnsupportedCall' });
    const token = ++connectionToken;
    const controller = typeof window.CaptureController === 'function' ? new window.CaptureController() : null;
    controller?.setFocusBehavior?.('no-focus-change');
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true },
      ...(controller ? { controller } : {}),
      // Chrome and Edge options: hide this very tab from the picker (it is silent, and picking it is the
      // most common mistake), offer the system audio of a screen share, and allow switching the shared tab.
      selfBrowserSurface: 'exclude', systemAudio: 'include', surfaceSwitching: 'include', monitorTypeSurfaces: 'include'
    });
    const surface = display.getVideoTracks()[0]?.getSettings?.().displaySurface || 'unknown';
    const tracks = display.getAudioTracks();
    if (!tracks.some(track => track.readyState === 'live') || token !== connectionToken) {
      display.getTracks().forEach(track => track.stop());
      throw Object.assign(new Error('no audio'), { name: token === connectionToken ? 'NoCallAudio' : 'AbortError', surface });
    }
    const next = { capture: display, stream: new MediaStream(tracks), surface, id: ++sourceId, copies: new Set(), microphone: null, sources: [], context: null, hostError: '' };
    try {
      if (this.includeHost()) {
        try {
          next.microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
        } catch {
          next.hostError = 'Students are connected, but your microphone is unavailable. Allow microphone access and reconnect to include your voice.';
        }
        if (next.microphone) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          next.context = new Ctx();
          await next.context.resume();
          const destination = next.context.createMediaStreamDestination();
          for (const stream of [new MediaStream(tracks), next.microphone]) {
            const source = next.context.createMediaStreamSource(stream);
            source.connect(destination); next.sources.push(source);
          }
          next.stream = destination.stream;
        }
      }
      if (token !== connectionToken) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const previous = connection; connection = null;
      stopMonitor(); releaseConnection(previous);
      connection = next; lastSound = 0;
      // Retain Stop sharing and source-ended events. Games receive audio only.
      display.getVideoTracks().forEach(track => { track.enabled = false; });
      // the share ended (Stop sharing, or the tab closed): the switch goes back off, so the games are plainly on the microphone again
      const ended = () => { if (connection === next) this.setEnabled(false, 'The share ended, so Google Meet audio is off and the games are using your microphone again. Switch it on to share again.'); };
      display.getTracks().forEach(track => track.addEventListener('ended', ended));
      next.microphone?.getTracks().forEach(track => track.addEventListener('ended', ended));
      startMonitor(connection.stream);
      this.setEnabled(true);
      return this.status();
    } catch (error) {
      if (connection === next) { connection = null; stopMonitor(); }
      releaseConnection(next); notify(); throw error;
    }
  },
  // Connects if needed. Returns true when meeting audio is ready.
  async ensure() { if (!this.isConnected()) await this.connect(); return this.isConnected(); },
  // A copy of the call audio for one game to record or analyse. Stopping the copy leaves the share running.
  clone() {
    if (!this.isConnected()) return null;
    for (const stream of connection.copies) if (stream.getTracks().every(track => track.readyState === 'ended')) connection.copies.delete(stream);
    const copy = new MediaStream(connection.stream.getAudioTracks().filter(track => track.readyState === 'live').map(track => track.clone()));
    connection.copies.add(copy);
    return copy;
  },
  disconnect(quiet = false) {
    connectionToken++;
    const previous = connection; connection = null;
    stopMonitor(); releaseConnection(previous);
    if (!quiet) notify();
  },

  // A short plain-language message for a failed connection.
  describeError(error) {
    const name = error?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') return 'Sharing was cancelled, so Google Meet audio stayed off. Switch it on again, then choose your Google Meet tab or the entire screen.';
    if (name === 'NoCallAudio') {
      if (error.surface === 'window') return 'A shared window cannot include sound. Choose “Chrome Tab” (your Google Meet tab), or “Entire Screen” and tick “Also share system audio”.';
      if (error.surface === 'monitor') return 'The screen was shared without sound. Choose “Entire Screen” again and tick “Also share system audio” (Windows), or share the Meet tab instead.';
      return 'The tab was shared without sound. Choose your Google Meet tab again and tick “Also share tab audio”.';
    }
    if (name === 'CallNotConnected') return 'Google Meet audio is on but not connected. In Settings, switch it off and on again, then choose your Google Meet tab.';
    if (name === 'UnsupportedCall') return 'Meeting audio needs Chrome or Edge on a computer. In Safari, Firefox or on a phone, leave it off and use the microphone.';
    return 'Could not connect to the meeting audio. Switch it on again to try once more.';
  },

  // The one control, shown in Settings and nowhere else: a single switch. Off every time the app opens; on only when the
  // coach turns it on. Turning it on opens the browser's chooser for the Google Meet tab; turning it off lets go of the call.
  mountPanel(element) {
    if (!element) return () => {};
    injectStyle();
    let message = '', busy = false;
    const draw = () => {
      const status = MeetingAudio.status();
      const on = status.enabled || busy;
      element.className = `ma-panel ${status.connected ? 'on' : ''}`;
      const stateText = !status.supported ? 'Not available in this browser.'
        : busy ? 'Choose your Google Meet tab in the box your browser shows, and tick “Also share tab audio”.'
        : status.connected ? (status.hearing ? 'ON: hearing the call.' : status.silentSeconds !== null ? 'ON: connected, quiet right now.' : 'ON: connected. Nothing heard yet, so ask a student to say hello.')
        : status.enabled ? 'ON, but not connected. Switch it off and on again to choose the Meet tab.'
        : 'OFF: every game listens to your microphone.';
      const stateClass = status.connected ? (status.hearing || status.silentSeconds !== null ? 'good' : 'wait') : busy || status.enabled ? 'wait' : 'off';
      element.innerHTML = `
        <label class="ma-switch">
          <input type="checkbox" role="switch" data-ma="toggle" ${on ? 'checked' : ''} ${busy || !status.supported ? 'disabled' : ''} aria-describedby="maState">
          <span class="ma-track" aria-hidden="true"></span>
          <span class="ma-switch-text"><strong>Use Google Meet audio in every game</strong><span>Off: the games listen to your microphone. On: they listen to your Google Meet call instead.</span></span>
        </label>
        <p class="ma-state ${stateClass}" id="maState" role="status">${stateText}</p>
        ${!status.supported ? '<p class="ma-text">Google Meet audio needs Chrome or Edge on a computer.</p>' : ''}
        ${status.connected ? `<div class="ma-meter" aria-hidden="true"><i data-ma-meter></i></div>
          <p class="ma-text" id="maHear">${status.hearing || status.silentSeconds !== null ? `Listening to ${surfaceName(status.surface)}. The bar moves when someone speaks in the call.` : `Listening to ${surfaceName(status.surface)}, but nothing has been heard yet. If the bar stays flat, switch this off and on again and pick the Google Meet tab${/Windows/.test(navigator.userAgent) ? ' (or Entire Screen with system audio)' : ''}. Picking the game’s own tab stays silent.`}</p>` : ''}
        ${status.supported ? `<details class="ma-guide"><summary>How to use it on Google Meet</summary><ol><li>In Meet, present the <b>Speaker’s Gym tab</b>. Leave presentation audio off to prevent echo.</li><li>Turn the switch on, then choose the separate <b>Google Meet tab</b> and tick <b>Also share tab audio</b>.</li><li>Take turns in any game. Everyone except the speaker stays muted.</li><li>To pick a different tab, or to go back to your microphone, turn the switch off.</li></ol><p class="ma-text">Use Chrome or Edge on a computer. Headphones help prevent echo.${/Windows/.test(navigator.userAgent) ? ' If tab audio is unavailable, choose Entire Screen with system audio.' : ''} Pitch and volume stay on this computer; the pace games send short clips for word counting. Tell participants before you switch it on.</p></details>` : ''}
        ${status.notice ? `<p class="ma-text">${status.notice}</p>` : ''}
        ${status.hostError ? `<p class="ma-error" role="alert">${status.hostError}</p>` : ''}
        ${message ? `<p class="ma-error" role="alert">${message}</p>` : ''}`;
    };
    const onChange = async event => {
      if (event.target?.dataset?.ma !== 'toggle' || busy) return;
      message = '';
      if (!event.target.checked) { MeetingAudio.setEnabled(false); draw(); return; }
      busy = true; draw();
      try { await MeetingAudio.connect(); } catch (error) { message = MeetingAudio.describeError(error); }
      busy = false; draw();
    };
    element.addEventListener('change', onChange);
    const off = MeetingAudio.onChange(draw);
    const meter = setInterval(() => {
      const bar = element.querySelector('[data-ma-meter]'); if (!bar) return;
      const status = MeetingAudio.status();
      bar.style.width = `${Math.max(0, Math.min(100, (status.level + 70) / 50 * 100)).toFixed(0)}%`;
      const phase = `${status.hearing}|${status.silentSeconds !== null}`;
      if (element.dataset.phase !== phase) { element.dataset.phase = phase; draw(); }
    }, 150);
    draw();
    return () => { off(); clearInterval(meter); element.removeEventListener('change', onChange); };
  }
};

// ---------------------------------------------------------------------------------------------
// ChunkTranscriber: sends the last few seconds of an audio stream to /api/transcribe, again and
// again, and reports the words with their time in the session. Used where the browser's own speech
// recognition cannot hear the stream (a video call), and for counting words a minute.
// ---------------------------------------------------------------------------------------------
export class ChunkTranscriber {
  // `getPrompt` may return a few words the speaker is likely to say; the service then spells them right.
  // `overlapMs` makes each clip run that much past the start of the next one, so a word cut by one clip's edge is whole in the next.
  constructor(stream, { chunkMs = 3000, overlapMs = 0, endpoint = '/api/transcribe', language = 'en', voicedDb = -58, minVoicedMs = 400, getPrompt, getToken = force => window.getSpeechAuthToken?.(force), onResult, onFail } = {}) {
    Object.assign(this, { stream, chunkMs, overlapMs, endpoint, language, voicedDb, minVoicedMs, getPrompt, getToken, onResult, onFail });
    this.active = new Set();
    this.alive = false; this.index = 0; this.pending = 0; this.failures = 0; this.chunk = null; this.recorder = null;
    this.controllers = new Set(); this.acceptResults = true; this.stopping = null;
  }
  get supported() { return typeof MediaRecorder !== 'undefined'; }
  start() {
    if (!this.supported || this.alive) return false;
    this.alive = true; this.t0 = performance.now();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      this.context = new Ctx(); this.context.resume?.().catch(() => {}); this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 1024;
      this.source = this.context.createMediaStreamSource(this.stream); this.source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);
      this.sampler = setInterval(() => {
        if (!this.active.size) return;
        this.analyser.getFloatTimeDomainData(this.buffer);
        let energy = 0; for (const sample of this.buffer) energy += sample * sample;
        if (20 * Math.log10(Math.max(Math.sqrt(energy / this.buffer.length), 1e-5)) > this.voicedDb) for (const running of this.active) running.voiced++;
      }, 50);
    }
    this.cycle();
    return true;
  }
  cycle() {
    if (!this.alive) return;
    const chunk = { index: this.index++, startedAt: performance.now(), parts: [], voiced: 0 };
    let recorder;
    try { recorder = new MediaRecorder(this.stream); } catch {
      this.alive = false; clearInterval(this.sampler);
      try { this.source?.disconnect(); } catch { /* already disconnected */ }
      this.context?.close().catch(() => {});
      this.onFail?.({ index: chunk.index, start: this.seconds(chunk), end: this.seconds(chunk), status: 0, failures: ++this.failures, message: 'Audio recording is unavailable.' });
      return;
    }
    recorder.ondataavailable = event => { if (event.data?.size) chunk.parts.push(event.data); };
    recorder.onstop = () => { chunk.endedAt = performance.now(); this.active.delete(chunk); this.finish(chunk, recorder.mimeType); chunk.resolveStopped?.(); };
    recorder.start();
    chunk.recorder = recorder; this.active.add(chunk);
    this.chunk = chunk; this.recorder = recorder;
    // The next recorder is already running before this one stops, so no word falls in a gap; with an overlap it keeps
    // going a little longer, so the words at the join are heard whole in two clips.
    chunk.stopTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, this.chunkMs + this.overlapMs);
    this.timer = setTimeout(() => this.cycle(), this.chunkMs);
  }
  seconds(chunk, offset = 0) { return (chunk.startedAt - this.t0) / 1000 + offset; }
  async finish(chunk, mime) {
    if (!this.acceptResults) return;
    const base = { index: chunk.index, start: this.seconds(chunk), end: (chunk.endedAt - this.t0) / 1000 };
    if (chunk.voiced * 50 < this.minVoicedMs || !chunk.parts.length) { this.onResult?.({ ...base, text: '', words: [], silent: true }); return; }
    const blob = new Blob(chunk.parts, { type: mime || 'audio/webm' });
    const extension = /mp4/.test(blob.type) ? 'mp4' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
    const body = new FormData(); body.append('audio', blob, `chunk.${extension}`); body.append('language', this.language);
    const prompt = this.getPrompt?.(); if (prompt) body.append('prompt', String(prompt).slice(0, 300));
    body.append('voicedMs', String(Math.round(chunk.voiced * 50)));
    this.pending++;
    const attempt = async force => {
      let token = null;
      try { token = await this.getToken?.(force); } catch { /* not signed in: the server answers 401 */ }
      if (!this.acceptResults) return null;
      const controller = new AbortController(), abort = setTimeout(() => controller.abort(), 15000);
      this.controllers.add(controller);
      try {
        const response = await fetch(this.endpoint, { method: 'POST', body, headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        return await response.json();
      } finally { clearTimeout(abort); this.controllers.delete(controller); }
    };
    try {
      let data;
      try { data = await attempt(false); } catch (error) {
        if (!this.acceptResults) return;
        if (error.status === 401) data = await attempt(true);                       // the login may just have expired: refresh it and try once more
        else if (!error.status || error.status === 429 || (error.status >= 500 && error.status !== 501)) {   // a network blip or a busy service: try once more
          await new Promise(resolve => setTimeout(resolve, 400));
          if (!this.acceptResults) return;
          data = await attempt(false);
        } else throw error;
      }
      if (!this.acceptResults || !data) return;
      this.failures = 0; this.lastOkAt = performance.now();
      const words = (data.words || []).map(word => ({ word: String(word.word), start: this.seconds(chunk, Number(word.start)), end: this.seconds(chunk, Number(word.end)) }));
      this.onResult?.({ ...base, text: String(data.text || ''), words, silent: false });
    } catch (error) {
      if (this.acceptResults) {
        this.failures++;
        this.onFail?.({ ...base, status: error.status || 0, failures: this.failures, message: String(error.message || error) });
      }
    } finally {
      this.pending--;
    }
  }
  // Stops recording and waits (up to `waitMs`) for the last chunks to come back.
  async stop(waitMs = 6000) {
    if (this.stopping) return this.stopping;
    this.stopping = this.drain(waitMs);
    return this.stopping;
  }
  async drain(waitMs) {
    this.alive = false; clearTimeout(this.timer); clearInterval(this.sampler);
    if (!waitMs) this.acceptResults = false;
    const running = [...this.active];
    const stopped = Promise.all(running.map(chunk => new Promise(resolve => { chunk.resolveStopped = resolve; })));
    running.forEach(chunk => { clearTimeout(chunk.stopTimer); if (chunk.recorder.state === 'recording') chunk.recorder.stop(); });
    const until = Date.now() + waitMs;
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, Math.max(0, waitMs)))]);
    await new Promise(resolve => { const check = () => (this.pending === 0 && this.active.size === 0) || Date.now() > until ? resolve() : setTimeout(check, 100); setTimeout(check, 250); });
    this.acceptResults = false;
    this.controllers.forEach(controller => controller.abort()); this.controllers.clear();
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    this.context?.close().catch(() => {});
  }
}

// Speaking speed from words with times: the words that started in the last `windowSeconds`, as a
// number of words a minute (pauses included). Returns null when nothing has been transcribed yet.
export function wpmFromWords(words, at, windowSeconds = 6) {
  const from = at - windowSeconds;
  const inside = words.filter(word => word.start >= from && word.start < at);
  return inside.length / windowSeconds * 60;
}

let styled = false;
function injectStyle() {
  if (styled) return; styled = true;
  const style = document.createElement('style'); style.id = 'maStyle';
  style.textContent = `
  .ma-panel{border:1px solid rgba(148,163,184,.22);border-radius:18px;padding:16px 18px;background:rgba(15,23,42,.6);color:#e5e7eb;text-align:left;font-family:inherit}
  .ma-panel.on{border-color:rgba(45,212,191,.5);background:linear-gradient(135deg,rgba(45,212,191,.08),rgba(167,139,250,.05))}
  .ma-switch{display:flex;align-items:center;gap:14px;cursor:pointer;margin:0 0 10px}
  .ma-switch input{position:absolute;opacity:0;width:0;height:0}
  .ma-track{flex:none;position:relative;width:58px;height:34px;border-radius:99px;background:#334155;border:1px solid rgba(148,163,184,.3);transition:background .25s}
  .ma-track::after{content:'';position:absolute;top:4px;left:4px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.4);transition:transform .25s}
  .ma-switch input:checked+.ma-track{background:linear-gradient(135deg,#2dd4bf,#22d3ee);border-color:transparent;box-shadow:0 0 16px rgba(45,212,191,.4)}
  .ma-switch input:checked+.ma-track::after{transform:translateX(24px)}
  .ma-switch input:focus-visible+.ma-track{outline:3px solid #fde047;outline-offset:3px}
  .ma-switch input:disabled+.ma-track{opacity:.6}
  .ma-switch-text{display:flex;flex-direction:column;gap:3px}
  .ma-switch-text strong{font-size:16px;color:#f8fafc}
  .ma-switch-text span{font-size:13px;line-height:1.45;color:#94a3b8}
  .ma-state{font-size:13px;font-weight:800;margin:0 0 10px;padding:8px 12px;border-radius:12px;border:1px solid rgba(148,163,184,.3);color:#94a3b8;background:rgba(8,13,26,.4)}
  .ma-state.good{color:#5eead4;border-color:rgba(94,234,212,.5);background:rgba(94,234,212,.1)}
  .ma-state.wait{color:#fde68a;border-color:rgba(253,230,138,.5);background:rgba(253,230,138,.08)}
  .ma-text{font-size:13px;line-height:1.6;color:#a3b2c8;margin:0 0 10px}
  .ma-text b{color:#e5e7eb}
  .ma-guide{font-size:13px;line-height:1.6;margin-bottom:6px}.ma-guide summary{cursor:pointer;color:#fde68a;font-weight:700}.ma-guide ol{padding-left:22px}.ma-guide li{margin:7px 0}
  .ma-error{font-size:13px;line-height:1.55;color:#ffd3da;background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.35);border-radius:10px;padding:10px 12px;margin:10px 0 0}
  .ma-meter{height:8px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;margin:4px 0 10px}
  .ma-meter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#a78bfa,#2dd4bf,#fbbf24);transition:width .12s linear}`;
  document.head.append(style);
}

window.MeetingAudio = MeetingAudio;
window.ChunkTranscriber = ChunkTranscriber;
window.dispatchEvent(new Event('meetingaudio:ready'));
window.addEventListener('pagehide', () => MeetingAudio.disconnect());
