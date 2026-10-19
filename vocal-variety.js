import { detectPitch, rmsOf, midiOf, noteName, quantile, RhythmTracker, summarize } from './vocal-variety-core.js';

const native = window.Capacitor?.isNativePlatform?.() || ['capacitor:', 'ionic:'].includes(location.protocol);
if (!native) mount();

function mount() {
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/vocal-variety.css'; document.head.append(css);
  const menu = document.createElement('button');
  menu.type = 'button'; menu.className = 'menu-item'; menu.dataset.page = 'variety'; menu.id = 'menuVariety';
  menu.innerHTML = '<span class="menu-item-icon" aria-hidden="true">〰</span><span>Expand Your Vocal Variety</span>';
  document.querySelector('#menuAnalytics').before(menu);
  const root = document.createElement('section');
  root.id = 'varietyPage'; root.className = 'container page vv-page'; root.setAttribute('aria-labelledby', 'vvTitle');
  root.innerHTML = `
    <div class="vv-topline"><button type="button" class="vv-back" id="vvBack">← Home</button><span class="vv-beta">WEB PREVIEW</span><span class="vv-brand">SPEAKER’S GYM</span></div>
    <header class="vv-hero"><div class="vv-eyebrow">YOUR VOICE. MORE POSSIBILITIES.</div><h1 id="vvTitle" tabindex="-1">Expand your<br><em>vocal variety.</em></h1><p>See your melody. Feel your energy.<br>Find the moments that make people listen.</p><div class="vv-hero-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></header>
    <div class="vv-workbench">
      <section class="vv-practice" aria-labelledby="vvPracticeTitle"><div class="vv-section-label">01 / TRY A SMALL SHIFT</div><h2 id="vvPracticeTitle">Same words. More expression.</h2><div class="vv-exercise-tabs" role="group" aria-label="Practice focus"><button type="button" data-exercise="mix" aria-pressed="true">Mix all three</button><button type="button" data-exercise="pitch" aria-pressed="false">Pitch</button><button type="button" data-exercise="volume" aria-pressed="false">Volume</button><button type="button" data-exercise="pace" aria-pressed="false">Pace</button></div><p id="vvPrompt" class="vv-script"></p><p id="vvInstruction" class="vv-instruction"></p><div class="vv-record-row"><button type="button" id="vvStart" class="vv-primary"><span aria-hidden="true">●</span> Start practicing</button><button type="button" id="vvStop" class="vv-stop" hidden>■ Stop</button><span class="vv-timer" id="vvTimer">0:00 <small>/ 1:00</small></span></div><p id="vvStatus" class="vv-status" role="status" aria-live="polite">Ready when you are. Allow your microphone to begin.</p><div class="vv-demo-row"><button type="button" id="vvDemo">See an example ↗</button><span id="vvMode">No session yet</span></div><p class="vv-private">Microphone practice and playback stay in this browser. Nothing is uploaded or saved to your account. A new take replaces the last one.</p></section>
      <aside class="vv-listen-card"><div class="vv-section-label">MAKE IT MEAN SOMETHING</div><h2>Variety is a choice.</h2><p>Lift a word that matters. Get softer to draw someone in. Slow down to land an idea.</p><div class="vv-cue"><span>↗</span><div><strong>Lift</strong><small>Bring energy to the key word.</small></div></div><div class="vv-cue"><span>◌</span><div><strong>Soften</strong><small>Give the quiet moment room.</small></div></div><div class="vv-cue"><span>↘</span><div><strong>Land</strong><small>Slow down. Let the ending fall.</small></div></div><p class="vv-gentle">Stay comfortable. You never need to shout or strain.</p></aside>
    </div>
    <section class="vv-results" aria-labelledby="vvResultsTitle"><div class="vv-results-heading"><div><div class="vv-section-label">02 / SEE WHAT CHANGED</div><h2 id="vvResultsTitle">Your voice, unfolded.</h2></div><span id="vvSampleLabel" class="vv-sample-label">Waiting for your voice</span></div>
      <div class="vv-playback" id="vvPlayback" hidden><label for="vvAudio">Listen back. Follow the line.</label><audio id="vvAudio" controls preload="metadata"></audio><span>Move your pointer or tap a graph to inspect a moment.</span></div>
      <div class="vv-livebar" id="vvLivebar" hidden><span><i aria-hidden="true"></i> Listening to your voice</span><strong id="vvLiveTimer">0:00</strong><button type="button" id="vvLiveStop">■ Finish take</button></div>
      <div class="vv-charts">${card('pitch', '01', 'Pitch', 'Your melody', 'Higher notes rise. Lower notes fall.', 'Higher', 'Lower', 'Different notes', 'Lift an important word, then let the ending fall.')}${card('volume', '02', 'Volume', 'Your energy', 'See the contrast between softer and stronger.', 'Stronger', 'Softer', 'Loudness range', 'Keep the microphone at the same distance. Change your voice, not your position.')}${card('pace', '03', 'Pace', 'Your rhythm', 'See where you speed up and slow down.', 'Faster', 'Slower', 'Estimated rhythm', 'Build energy in the story. Slow down for the point.')}</div>
      <div class="vv-moment" id="vvMoment" role="status" aria-live="polite">The three graphs share the same timeline. Gaps in pitch mean no clear note was detected.</div>
      <div class="vv-takeaway"><span aria-hidden="true">✦</span><div><h3 id="vvTakeawayTitle">Make one deliberate change.</h3><p id="vvTakeaway">Try the sentence above, then listen for the word you chose to bring to life.</p></div><button type="button" id="vvAgain">Try another take ↗</button></div>
      <details class="vv-method"><summary>What these measurements mean</summary><p><strong>Pitch:</strong> estimated musical notes in voiced sound. “Different notes” counts notes held across at least two samples, not the number of words. Range uses the middle 80% of detected pitches to reduce outliers. Speech is not singing; you do not need to hit exact notes.</p><p><strong>Volume:</strong> relative microphone level, not calibrated sound pressure. Automatic microphone gain, room noise, and moving your head can affect it. Compare moments in the same take.</p><p><strong>Pace:</strong> an experimental estimate of syllable rhythm from energy peaks over four seconds, including pauses. It is not a transcript or words per minute. Noise and articulation can affect it. Silence is shown as a gap; use playback to check what you hear.</p><p>Charts show measurements, not a score. More variation is useful when it supports your message.</p></details>
    </section>`;
  document.querySelector('#mainPage').after(root);
  const $ = selector => root.querySelector(selector);
  const exercises = {
    mix: ['“At first, I thought it was impossible. Then we found a way. And that changed everything.”', 'Start low and soft. Lift “found a way.” Slow down and land the final sentence.'],
    pitch: ['“I didn’t expect THAT. But now, I know exactly what to do.”', 'Lift “THAT” a little higher. Let “what to do” come down. Use your comfortable range.'],
    volume: ['“Let me tell you a secret. This is the moment we’ve been waiting for.”', 'Soften the secret. Give the second sentence more presence. Keep the microphone still.'],
    pace: ['“We packed our bags, grabbed the keys, and ran for the train. Then… everything stopped.”', 'Move quickly through the action. Pause after “Then.” Deliver the ending slowly.']
  };
  let frames = [], running = false, pending = false, generation = 0, stream, context, source, analyser, interval, recorder, audioUrl, startTime, sampleCount = 0;
  let rhythm = new RhythmTracker(), pitch = null, demo = false, cursor = null, playbackFrame = null;
  function selectExercise(key) {
    $('#vvPrompt').textContent = exercises[key][0]; $('#vvInstruction').textContent = exercises[key][1];
    root.querySelectorAll('[data-exercise]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.exercise === key)));
  }
  root.querySelectorAll('[data-exercise]').forEach(button => button.addEventListener('click', () => selectExercise(button.dataset.exercise)));
  selectExercise('mix');
  const status = message => { $('#vvStatus').textContent = message; };
  function releaseAudio() {
    $('#vvAudio').pause(); $('#vvAudio').removeAttribute('src'); $('#vvAudio').load();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null; $('#vvPlayback').hidden = true;
    cancelAnimationFrame(playbackFrame); cursor = null;
  }
  function controls() {
    $('#vvStart').hidden = running; $('#vvStart').disabled = pending;
    $('#vvStop').hidden = !running && !pending;
    $('#vvDemo').disabled = running || pending;
    $('#vvAgain').disabled = running || pending;
    $('#vvLivebar').hidden = !running;
  }
  async function stop() {
    generation++; pending = false;
    const wasRunning = running; running = false;
    clearInterval(interval);
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    source?.disconnect(); source = null;
    const oldContext = context; context = null;
    if (oldContext && oldContext.state !== 'closed') await oldContext.close().catch(() => {});
    controls();
    if (wasRunning) {
      $('#vvMode').textContent = 'TAKE COMPLETE · microphone';
      $('#vvSampleLabel').textContent = 'YOUR COMPLETED TAKE';
      status('Take complete. Choose one thing to vary next. Playback is available below when your browser supports recording.');
      render(true);
    }
  }
  async function start() {
    if (running || pending) return;
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
      status('Live practice needs a browser with microphone support. Try Chrome, Edge, or Safari on HTTPS. You can still view the example.'); return;
    }
    pending = true; const token = ++generation; controls(); status('Waiting for microphone access…');
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (token !== generation || !root.classList.contains('active')) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      context = new (window.AudioContext || window.webkitAudioContext)(); await context.resume();
      if (token !== generation) return;
      analyser = context.createAnalyser(); analyser.fftSize = 2048;
      source = context.createMediaStreamSource(stream); source.connect(analyser);
      releaseAudio(); frames = []; rhythm.reset(); sampleCount = 0; pitch = null; demo = false;
      pending = false; running = true; startTime = performance.now();
      $('#vvMode').textContent = 'LIVE · microphone'; $('#vvSampleLabel').textContent = 'YOUR LIVE TAKE';
      $('#vvTakeawayTitle').textContent = 'Make one deliberate change.';
      $('#vvTakeaway').textContent = 'Watch the lines move as you speak. Keep it comfortable.';
      status('Listening. Try your sentence with expression. Stops at one minute.'); controls();
      $('.vv-results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      const chunks = []; const recordingToken = generation;
      if (window.MediaRecorder) {
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
          if (!chunks.length || recordingToken + 1 !== generation) return;
          audioUrl = URL.createObjectURL(new Blob(chunks, { type: chunks[0].type }));
          $('#vvAudio').src = audioUrl; $('#vvPlayback').hidden = false;
        };
        recorder.start();
      }
      const buffer = new Float32Array(analyser.fftSize);
      interval = setInterval(() => {
        const t = (performance.now() - startTime) / 1000;
        if (t >= 60) { stop(); return; }
        analyser.getFloatTimeDomainData(buffer);
        const rms = rmsOf(buffer), pace = rhythm.push(t, rms);
        if (sampleCount++ % 5 === 0) {
          pitch = detectPitch(buffer, context.sampleRate);
          frames.push({ t, midi: midiOf(pitch), db: 20 * Math.log10(Math.max(rms, 0.00001)), pace });
          $('#vvTimer').innerHTML = `${time(t)} <small>/ 1:00</small>`;
          $('#vvLiveTimer').textContent = time(t);
          render(false);
        }
      }, 20);
    } catch (error) {
      if (token !== generation) return;
      await stop();
      status(error.name === 'NotAllowedError' ? 'Microphone access was declined. Allow it in your browser’s site settings, then try again. The example works without a microphone.' : 'Could not start the microphone. Check that it is connected and available, then try again.');
    }
  }
  function showDemo() {
    if (running || pending) return;
    releaseAudio(); demo = true;
    frames = Array.from({ length: 300 }, (_, i) => {
      const t = i / 10, gap = (t > 9 && t < 10.4) || (t > 20 && t < 21);
      const midi = 49 + Math.sin(t * 0.6) * 3 + (t > 10 && t < 19 ? 5 : 0);
      return { t, midi: gap ? null : Math.round(midi * 2) / 2, db: gap ? -65 : -31 + Math.sin(t * 0.7) * 5 + (t > 10 && t < 19 ? 7 : 0), pace: gap ? null : (t < 10 ? 2.3 : t < 20 ? 4.3 : 1.8) + Math.sin(t) * 0.3 };
    });
    $('#vvMode').textContent = 'EXAMPLE · illustrative data'; $('#vvSampleLabel').textContent = 'EXAMPLE — NOT YOUR VOICE';
    $('#vvTimer').innerHTML = '0:00 <small>/ 1:00</small>';
    status('Example only: notice the lifted pitch, stronger voice, and faster rhythm in the middle.');
    render(true);
  }
  function render(final) {
    const summary = summarize(frames);
    const enough = summary.voicedSeconds >= 1;
    $('#vvPitchMetric').textContent = enough ? String(summary.notes.length) : '—';
    $('#vvPitchDetail').textContent = summary.pitchRange === null ? 'Speak to reveal your range' : `${summary.pitchRange.toFixed(1)} semitones of range`;
    $('#vvNotes').textContent = enough ? summary.notes.map(noteName).join(' · ') || 'Finding steady notes…' : 'Notes appear as you speak';
    $('#vvVolumeMetric').textContent = summary.volumeRange === null ? '—' : `${summary.volumeRange.toFixed(1)} dB`;
    $('#vvVolumeDetail').textContent = 'Softer ↔ stronger · relative mic level';
    $('#vvPaceMetric').textContent = summary.paceLow === null ? '—' : `${summary.paceLow.toFixed(1)}–${summary.paceHigh.toFixed(1)}`;
    $('#vvPaceDetail').textContent = 'Estimated syllables / second';
    ['pitch', 'volume', 'pace'].forEach(draw);
    if (final && frames.length) {
      $('#vvTakeawayTitle').textContent = demo ? 'Hear the intention behind each change.' : enough ? 'Choose one moment to make more expressive.' : 'We need a little more of your voice.';
      $('#vvTakeaway').textContent = demo ? 'The middle carries energy; the ending settles down. Try the same shape with your own words.' : enough ? `You explored ${summary.notes.length} steady notes${summary.pitchRange !== null ? ` across ${summary.pitchRange.toFixed(1)} semitones` : ''}. Listen back. Try lifting one key word, softening one phrase, or slowing the final sentence.` : 'Speak for at least five seconds in a quiet place, with the microphone close and still. Humming can show pitch, but pace needs spoken words.';
    }
  }
  function draw(kind) {
    const canvas = $(`#vv${capitalize(kind)}Canvas`), rect = canvas.getBoundingClientRect();
    if (rect.width < 1) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), width = rect.width, height = 200;
    canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const colors = { pitch: '#c4b5fd', volume: '#5eead4', pace: '#fbbf24' };
    const color = colors[kind], left = 42, top = 17, plotW = width - 56, plotH = 150;
    const total = Math.max(10, Math.ceil((frames.at(-1)?.t || 0) / 10) * 10);
    const center = quantile(frames.map(f => f.midi), 0.5) ?? 55;
    const pitchValues = frames.map(f => f.midi);
    const low = kind === 'pitch' ? Math.floor(Math.min(center - 6, (quantile(pitchValues, 0.02) ?? center) - 1)) : kind === 'volume' ? -60 : 0;
    const high = kind === 'pitch' ? Math.ceil(Math.max(center + 6, (quantile(pitchValues, 0.98) ?? center) + 1)) : kind === 'volume' ? 0 : 7;
    const x = t => left + t / total * plotW, y = v => top + (1 - (Math.max(low, Math.min(high, v)) - low) / (high - low)) * plotH;
    ctx.font = '10px system-ui'; ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const value = low + (high - low) * i / 3;
      ctx.strokeStyle = 'rgba(148,163,184,.12)'; ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(width - 14, y(value)); ctx.stroke();
      ctx.fillStyle = '#8b9bb3'; ctx.fillText(kind === 'pitch' ? noteName(value) : kind === 'volume' ? `${Math.round(value)}` : value.toFixed(1), left - 7, y(value) + 3);
    }
    ctx.textAlign = 'center';
    for (let i = 0; i <= 3; i++) ctx.fillText(`${Math.round(total * i / 3)}s`, x(total * i / 3), height - 9);
    let drawing = false;
    ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.beginPath();
    for (const frame of frames) {
      const value = kind === 'pitch' ? frame.midi : kind === 'volume' ? (frame.midi === null && frame.db < -48 ? null : frame.db) : frame.pace;
      if (!Number.isFinite(value)) { drawing = false; continue; }
      if (drawing) ctx.lineTo(x(frame.t), y(value)); else { ctx.moveTo(x(frame.t), y(value)); drawing = true; }
    }
    ctx.stroke();
    if (!frames.length) {
      ctx.fillStyle = '#8795ab'; ctx.textAlign = 'center'; ctx.font = '12px system-ui';
      ctx.fillText('Your voice will draw this line', left + plotW / 2, top + plotH / 2);
    }
    if (cursor !== null) { ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x(cursor), top); ctx.lineTo(x(cursor), top + plotH); ctx.stroke(); }
    canvas.setAttribute('aria-label', `${capitalize(kind)} timeline. ${$(`#vv${capitalize(kind)}Metric`).textContent}. ${$(`#vv${capitalize(kind)}Detail`).textContent}. ${demo ? 'Illustrative example.' : ''}`);
    canvas.dataset.duration = total;
  }
  function inspect(event, canvas, seek = false) {
    if (!frames.length) return;
    const rect = canvas.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 42) / (rect.width - 56)));
    cursor = Math.min(frames.at(-1).t, ratio * Number(canvas.dataset.duration));
    const frame = frames.reduce((best, f) => Math.abs(f.t - cursor) < Math.abs(best.t - cursor) ? f : best);
    $('#vvMoment').textContent = `${time(frame.t)} · Pitch ${frame.midi === null ? 'no clear note' : noteName(frame.midi)} · Mic level ${frame.db.toFixed(0)} dBFS · Rhythm ${frame.pace === null ? 'not enough evidence' : frame.pace.toFixed(1) + ' estimated syllables/sec'}`;
    if (seek && audioUrl) $('#vvAudio').currentTime = cursor;
    ['pitch', 'volume', 'pace'].forEach(draw);
  }
  root.querySelectorAll('canvas').forEach(canvas => {
    canvas.addEventListener('pointermove', event => { if (!running) inspect(event, canvas); });
    canvas.addEventListener('click', event => inspect(event, canvas, true));
    canvas.addEventListener('pointerleave', () => { if ($('#vvAudio').paused) { cursor = null; ['pitch', 'volume', 'pace'].forEach(draw); } });
  });
  $('#vvAudio').addEventListener('play', () => {
    cancelAnimationFrame(playbackFrame);
    const tick = () => { cursor = $('#vvAudio').currentTime; ['pitch', 'volume', 'pace'].forEach(draw); if (!$('#vvAudio').paused) playbackFrame = requestAnimationFrame(tick); };
    tick();
  });
  menu.addEventListener('click', () => { window.navigateToPage('variety'); $('#vvTitle').focus(); render(false); });
  $('#vvBack').addEventListener('click', () => window.navigateToPage('main'));
  $('#vvStart').addEventListener('click', start); $('#vvStop').addEventListener('click', stop);
  $('#vvLiveStop').addEventListener('click', stop);
  $('#vvDemo').addEventListener('click', showDemo);
  $('#vvAgain').addEventListener('click', () => { $('#vvPrompt').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); $('#vvStart').focus({ preventScroll: true }); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', () => { stop(); releaseAudio(); });
  window.VocalVariety = { stop: () => { if (running || pending) stop(); $('#vvAudio').pause(); }, render: () => render(false) };
  new ResizeObserver(() => ['pitch', 'volume', 'pace'].forEach(draw)).observe(root);
  render(false);
  if (location.hash === '#vocal-variety') window.navigateToPage('variety');
}

function time(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
function capitalize(value) { return value[0].toUpperCase() + value.slice(1); }
function card(kind, n, title, subtitle, description, upper, lower, metricLabel, hint) {
  const key = capitalize(kind);
  return `<article class="vv-chart-card vv-${kind}"><div class="vv-card-head"><div><span class="vv-section-label">${n} / ${title.toUpperCase()}</span><h3>${subtitle}</h3></div><span class="vv-card-icon" aria-hidden="true">${kind === 'pitch' ? '♫' : kind === 'volume' ? '◖' : '»'}</span></div><p class="vv-chart-desc">${description}</p><div class="vv-metric-row"><strong id="vv${key}Metric">—</strong><span>${metricLabel}<small id="vv${key}Detail">Waiting for a take</small></span></div><div class="vv-axis-hints"><span>${upper} ↑</span><span>${lower} ↓</span></div><canvas id="vv${key}Canvas" height="200" role="img" aria-label="${title} timeline, no take yet"></canvas>${kind === 'pitch' ? '<div id="vvNotes" class="vv-notes">Notes appear as you speak</div>' : ''}<p class="vv-chart-hint">${hint}</p></article>`;
}
