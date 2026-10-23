// Run with playwright-cli run-code --filename scripts/validate-vocal-variety-ui.js
// against a local server on 127.0.0.1:8766. Uses generated audio and a fake speech service, no real account.
// Plays the whole thing: example result, mobile layout, all games open with no tuning step, one microphone
// round with PREP notes, meeting audio (panel messages, one picker, Speak on the Spot, a Pace round counted in
// words a minute), cleanup, and the native gate.
async (page) => {
  const baseUrl = new URL(page.url()).origin;
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: '#loginGate { display: none !important; }' });
  await page.waitForSelector('#menuVariety');
  await page.evaluate(() => { localStorage.clear(); document.getElementById('loginGate').style.display = 'none'; window.navigateToPage('variety'); });
  const view = () => page.evaluate(() => document.getElementById('vvView').dataset.view);

  // 1. The example result is clearly labeled and fully drawn.
  await page.getByRole('button', { name: 'See an example ↗' }).click();
  check(await view() === 'results', 'example should open the results view');
  check((await page.locator('.vv-result-sum .vv-section-label').innerText()).includes('EXAMPLE'), 'example must be labeled');
  check(Number(await page.locator('#vvScore').innerText()) > 0, 'example score missing');
  check(await page.locator('#vvMap').evaluate(el => el.width > 0 && el.height > 0), 'volume map was not drawn');

  // 2. Mobile: nothing overflows. All seven games are open and nobody is asked to be tuned.
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile horizontal overflow (results)');
  await page.getByRole('button', { name: 'All games', exact: true }).click();
  check(await page.locator('.vv-stage-card').count() === 7, 'all seven games should be listed');
  check(await page.locator('.vv-stage-card[aria-disabled], .vv-stage-card.locked').count() === 0, 'every game must be open');
  check(await page.locator('[data-act^="tune"]').count() === 0, 'there must be no voice tuning step');
  check((await page.locator('.vv-dim-pace .vv-zone-row').innerText()).includes('140'), 'the pace bands should show words a minute');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile horizontal overflow (home)');
  await page.setViewportSize({ width: 1280, height: 900 });

  // 3. Fixtures: a microphone, a fake Meet tab, and a fake speech service that returns words at a speed the test sets.
  await page.evaluate(() => {
    window.fixture = { amp: 0.00005, hz: 150, streams: [], picks: 0, t0: 0, wpmAt: () => 120, fetches: [] };
    const makeTone = () => {
      const ctx = new AudioContext(); const osc = ctx.createOscillator(), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
      osc.type = 'sawtooth'; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; osc.frequency.value = 150; gain.gain.value = 0; osc.connect(lp); lp.connect(gain); gain.connect(dest); osc.start();
      const timer = setInterval(() => { gain.gain.setTargetAtTime(window.fixture.amp, ctx.currentTime, 0.005); osc.frequency.setTargetAtTime(window.fixture.hz, ctx.currentTime, 0.01); }, 10);
      const track = dest.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); clearInterval(timer); osc.stop(); ctx.close().catch(() => {}); track.dispatchEvent(new Event('ended')); };
      return track;
    };
    navigator.mediaDevices.getUserMedia = async () => { const stream = new MediaStream([makeTone()]); window.fixture.streams.push(stream); return stream; };
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.fixture.picks++;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const video = canvas.captureStream(1).getVideoTracks()[0]; const real = video.getSettings.bind(video); video.getSettings = () => ({ ...real(), displaySurface: 'browser' });
      const out = new MediaStream([video, makeTone()]); window.fixture.streams.push(out); return out;
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (!String(url).includes('/api/transcribe')) return realFetch(url, init);
      const t = (performance.now() - window.fixture.t0) / 1000, prompt = init.body.get('prompt') || '';
      window.fixture.fetches.push({ t, prompt });
      const n = Math.round(window.fixture.wpmAt(t - 1.5) * 3 / 60);
      const words = Array.from({ length: n }, (_, i) => ({ word: 'word', start: (i + 0.5) * 3 / Math.max(n, 1) - 0.15, end: (i + 0.5) * 3 / Math.max(n, 1) + 0.1 }));
      return new Response(JSON.stringify({ text: words.map(() => 'word').join(' ') + (prompt ? ` ${prompt}` : ''), words, duration: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  });
  const allEnded = () => page.evaluate(() => window.fixture.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));

  // 4. One microphone round of Volume: Loud & Soft, with PREP notes and a sound check.
  await page.locator('.vv-stage-card[data-stage="volume-ribbon"]').click();
  check((await page.locator('.vv-question').innerText()).length > 10, 'question missing');
  check(await page.locator('[data-act="speech-time"][data-seconds="120"]').getAttribute('aria-checked') === 'true', 'speech length should default to 2 minutes');
  await page.locator('[data-act="speech-time"][data-seconds="60"]').click();
  await page.locator('[data-act="prep-time"][data-seconds="30"]').click();
  await page.evaluate(() => { window.fixture.amp = 0.05; });
  await page.getByRole('button', { name: /Start preparing/ }).click();
  for (const key of ['point', 'reason', 'example', 'finalPoint']) await page.locator(`[data-note="${key}"]`).fill(`my ${key}`);
  await page.waitForFunction(() => document.getElementById('vvMicText')?.textContent.startsWith('✓ Voice level set'), null, { timeout: 8000 });
  await page.getByRole('button', { name: /I’m ready/ }).click();
  await page.waitForSelector('#vvStageCanvas');
  check(await page.locator('#vvNotes li').count() === 4, 'PREP notes panel missing under the stage');
  await page.waitForTimeout(6000);
  check((await page.locator('#vvCueNote').innerText()).includes('my '), 'the PREP note should show while speaking');
  await page.getByRole('button', { name: /Finish/ }).click();
  await page.waitForFunction(() => document.getElementById('vvView').dataset.view === 'results', null, { timeout: 10000 });
  const first = await page.evaluate(() => ({ progress: JSON.parse(localStorage.getItem('sg-vocal-arena-v1')), audio: document.querySelector('#vvAudioSlot audio')?.src || '' }));
  check(first.progress.rounds === 1 && first.progress.badges.prepared, 'progress and the Prepared badge should be saved');
  check(await page.locator('.vv-parts li').count() === 4, 'part-by-part PREP breakdown missing');
  check(await allEnded(), 'microphone still active after the round');

  // 5. Permission denied keeps the game usable; a microphone request canceled by leaving leaves no live track.
  await page.getByRole('button', { name: 'Try this question again' }).click();
  await page.evaluate(() => { window.realGetUserMedia = navigator.mediaDevices.getUserMedia; navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError')); });
  await page.getByRole('button', { name: /Start preparing/ }).click();
  await page.waitForTimeout(300);
  check((await page.locator('.vv-warning').innerText()).includes('declined'), 'permission error missing');
  check(await page.locator('[data-act="start-prep"]').isEnabled(), 'permission failure locked the start button');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.fixtureResolve = resolve; }); });
  await page.getByRole('button', { name: /Start preparing/ }).click();
  await page.getByRole('button', { name: '← All games' }).click();
  const canceled = await page.evaluate(async () => {
    const ctx = new AudioContext(), dest = ctx.createMediaStreamDestination(), track = dest.stream.getTracks()[0];
    window.fixtureResolve(dest.stream);
    await new Promise(resolve => setTimeout(resolve, 150)); await ctx.close();
    return track.readyState;
  });
  check(canceled === 'ended', 'canceled microphone request left a live track');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.realGetUserMedia; });

  // 6. Meeting audio: the panel, its messages, one picker for every game.
  await page.evaluate(() => window.navigateToPage('settings'));
  const panel = page.locator('#meetingAudioPanel');
  await panel.getByRole('button', { name: 'Use meeting audio' }).click();
  check(await page.locator('#callAudioToggle').isChecked(), 'the Settings switch should follow the meeting audio control');
  await page.evaluate(() => { const real = navigator.mediaDevices.getDisplayMedia; navigator.mediaDevices.getDisplayMedia = async () => { window.fixture.picks++; throw new DOMException('Denied', 'NotAllowedError'); }; window.realDisplay = real; });
  await panel.getByRole('button', { name: 'Connect meeting audio' }).click();
  check((await panel.locator('.ma-error').innerText()).includes('cancelled'), 'a cancelled picker should say so');
  await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = window.realDisplay; window.fixture.picks = 0; });
  await panel.getByRole('button', { name: 'Connect meeting audio' }).click();
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.MeetingAudio.isConnected()), 'meeting audio should connect');
  await page.evaluate(() => { window.fixture.amp = 0.06; });
  await page.waitForFunction(() => document.querySelector('#meetingAudioPanel .ma-state')?.textContent === 'Hearing the call', null, { timeout: 4000 });

  // 7. Speak on the Spot hears the call: words come from the speech service, with no second picker.
  await page.evaluate(() => {
    window.navigateToPage('spot');
    for (const [id, value] of [['spotThinkTime', '3'], ['spotSpeechDuration', '30'], ['spotNumWords', '3']]) { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); }
    window.fixture.t0 = performance.now();
  });
  await page.locator('#spotStartBtn').click();
  await page.waitForFunction(() => document.getElementById('spotResultsPhase')?.classList.contains('active'), null, { timeout: 45000 });
  check((await page.locator('#spotWordsUsedValue').innerText()).startsWith('3/'), 'Speak on the Spot should detect the words said on the call');
  check(await page.evaluate(() => window.fixture.picks) === 1, 'meeting audio should be picked once for every game');

  // 8. A Pace round counted in words a minute: 100 / 125 / 150 / 100 in the four PREP parts reaches Slow, Steady and Fast.
  await page.evaluate(() => { window.navigateToPage('variety'); document.querySelector('[data-act="open-stage"][data-stage="pace-ribbon"]').click(); });
  await page.locator('[data-act="speech-time"][data-seconds="60"]').click();
  await page.locator('[data-act="prep-time"][data-seconds="30"]').click();
  await page.getByRole('button', { name: /Start preparing/ }).click();
  await page.waitForFunction(() => document.getElementById('vvMicText')?.textContent.startsWith('✓ Voice level set'), null, { timeout: 8000 });
  await page.evaluate(() => { window.fixture.wpmAt = t => t < 12 ? 100 : t < 27 ? 125 : t < 48 ? 150 : 100; });
  await page.getByRole('button', { name: /I’m ready/ }).click();
  await page.evaluate(() => { window.fixture.t0 = performance.now() + 3050; });
  await page.waitForFunction(() => document.getElementById('vvView').dataset.view === 'results', null, { timeout: 90000 });
  const paceParts = await page.locator('.vv-parts li').allInnerTexts();
  check(/Slow/.test(paceParts[0]) && /Steady/.test(paceParts[1]) && /Fast/.test(paceParts[2]), `pace parts should read Slow, Steady, Fast: ${JSON.stringify(paceParts)}`);
  check(Number(await page.locator('#vvStarRow').getAttribute('data-stars')) >= 2, 'speaking at 100, 125 and 150 words a minute should earn stars');
  check(await page.evaluate(() => document.querySelector('.vv-tile.wide ~ .vv-tile')?.textContent.includes('WPM')), 'the pace range should be in WPM');
  check(await page.evaluate(() => window.fixture.picks) === 1, 'the pace round must reuse the connection');

  // 9. Disconnect releases the call, and the preview stays web-only.
  await page.evaluate(() => { window.navigateToPage('settings'); });
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  check(await page.evaluate(() => !window.MeetingAudio.isConnected()), 'disconnect should end the meeting audio');
  await page.evaluate(() => localStorage.setItem('callAudioMode', 'false'));
  const nativePage = await page.context().newPage();
  await nativePage.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
  const nativeAssets = [];
  nativePage.on('request', request => { if (/vocal-variety|meeting-audio/.test(request.url())) nativeAssets.push(request.url()); });
  await nativePage.goto(`${baseUrl}/index.html`);
  await nativePage.waitForTimeout(700);
  check(await nativePage.locator('#menuVariety').count() === 0, 'native app must not expose the preview');
  check(nativeAssets.length === 0, 'native app must not request preview or meeting audio assets');
  await nativePage.close();

  if (failures.length || errors.length) throw new Error(`Vocal variety UI validation failed: ${JSON.stringify({ failures, errors })}`);
  return { failures, errors, nativeAssets };
}
