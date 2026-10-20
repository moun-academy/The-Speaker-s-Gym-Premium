// Run with playwright-cli run-code --filename scripts/validate-vocal-variety-ui.js
// against a local server on 127.0.0.1:8766. Uses generated audio, no real account.
// Plays the whole game: example result, mobile layout, all games open, find-your-range (volume,
// pitch), PREP preparation with notes, one guided volume round, microphone cleanup, permission
// denial, a canceled microphone request, and the native gate.
async (page) => {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.reload();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: '#loginGate { display: none !important; }' });
  await page.waitForSelector('#menuVariety');
  await page.evaluate(() => {
    localStorage.removeItem('sg-vocal-arena-v1'); localStorage.removeItem('sg-vocal-arena-scale-v1');
    document.getElementById('loginGate').style.display = 'none'; window.navigateToPage('variety');
  });
  const view = () => page.evaluate(() => document.getElementById('vvView').dataset.view);

  // 1. The example result is clearly labeled and fully drawn.
  await page.getByRole('button', { name: 'See an example ↗' }).click();
  check(await view() === 'results', 'example should open the results view');
  check((await page.locator('.vv-result-sum .vv-section-label').innerText()).includes('EXAMPLE'), 'example must be labeled');
  check(Number(await page.locator('#vvScore').innerText()) > 0, 'example score missing');
  check(await page.locator('#vvMap').evaluate(el => el.width > 0 && el.height > 0), 'volume map was not drawn');
  await page.screenshot({ path: 'output/playwright/vocal-variety-example-desktop.png', fullPage: true });

  // 2. Mobile: nothing overflows and touch targets are large enough.
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile horizontal overflow (results)');
  await page.getByRole('button', { name: 'All games', exact: true }).click();
  check(await page.locator('.vv-stage-card').count() === 7, 'all seven games should be listed');
  check(await page.locator('.vv-stage-card[aria-disabled], .vv-stage-card.locked').count() === 0, 'every game must be open');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile horizontal overflow (home)');
  const startHeight = await page.locator('.vv-hero-actions .vv-primary').evaluate(el => el.getBoundingClientRect().height);
  check(startHeight >= 44, 'mobile start target too small');
  await page.screenshot({ path: 'output/playwright/vocal-variety-home-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // 3. Generated microphone: a 150 Hz tone whose level the test controls.
  await page.evaluate(() => {
    window.fixture = { amp: 0.00005, streams: [] };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext(); await ctx.resume();
      const osc = ctx.createOscillator(), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
      osc.frequency.value = 150; gain.gain.value = window.fixture.amp; osc.connect(gain); gain.connect(dest); osc.start();
      const timer = setInterval(() => { gain.gain.value = window.fixture.amp; }, 20);
      const stream = dest.stream, track = stream.getTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); clearInterval(timer); osc.stop(); ctx.close().catch(() => {}); };
      window.fixture.streams.push(stream);
      return stream;
    };
  });
  const allEnded = () => page.evaluate(() => window.fixture.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')));

  // 4. Find your range: quiet, whisper, natural sentence (pitch and pace), strong.
  await page.getByRole('button', { name: 'Find my range' }).click();
  await page.getByRole('button', { name: /Start tuning/ }).click();
  for (const [seconds, amp] of [[0, 0.00005], [2.2, 0.0045], [5.9, 0.045], [11.2, 0.2], [15, 0.00005]]) {
    setTimeout(() => page.evaluate(value => { window.fixture.amp = value; }, amp), seconds * 1000);
  }
  await page.waitForFunction(() => document.querySelector('[data-act="tune-continue"]'), null, { timeout: 25000 });
  const tuned = await page.evaluate(() => JSON.parse(localStorage.getItem('sg-vocal-arena-scale-v1')).scale);
  check(Math.abs(tuned.soft + 49.9) < 2 && Math.abs(tuned.natural + 29.9) < 2 && Math.abs(tuned.power + 17) < 3, `range was not measured: ${JSON.stringify(tuned)}`);
  check(Math.abs(tuned.pitchCenter - 50.2) < 0.5, `natural pitch (150 Hz, about D3) was not measured: ${tuned.pitchCenter}`);
  check(await allEnded(), 'microphone still active after tuning');
  await page.getByRole('button', { name: /Choose a game/ }).click();

  // 5. One guided volume round: prepare with PREP notes, then follow the ribbon.
  await page.locator('[data-stage="volume-ribbon"]').click();
  check((await page.locator('.vv-question').innerText()).length > 10, 'question missing');
  await page.getByRole('radio', { name: '30s' }).click();
  await page.getByRole('button', { name: /Start preparing/ }).click();
  for (const key of ['point', 'reason', 'example', 'finalPoint']) await page.locator(`[data-note="${key}"]`).fill(`my ${key}`);
  await page.waitForFunction(() => document.getElementById('vvMicText')?.textContent.startsWith('Mic check'), null, { timeout: 5000 });
  check((await page.locator('#vvPrepClock').innerText()).startsWith('0:'), 'preparation timer missing');
  await page.getByRole('button', { name: /I’m ready/ }).click();
  await page.waitForSelector('#vvStageCanvas');
  const plan = await page.evaluate(async () => (await import('/vocal-variety-game.js')).stageById('volume-ribbon').plan.keys);
  const goAt = Date.now() + 3050;
  const drive = setInterval(async () => {
    const t = (Date.now() - goAt) / 1000;
    if (t < 0) return;
    let level = plan.at(-1)[1];
    for (let i = 1; i < plan.length; i++) if (t <= plan[i][0]) { const [t0, v0] = plan[i - 1], [t1, v1] = plan[i], s = (t - t0) / (t1 - t0); level = v0 + (v1 - v0) * s * s * (3 - 2 * s); break; }
    const db = level <= 0.5 ? -49.9 + level / 0.5 * 20 : -29.9 + (level - 0.5) / 0.5 * 13;
    await page.evaluate(amp => { window.fixture.amp = amp; }, Math.pow(10, db / 20) * Math.SQRT2).catch(() => {});
  }, 50);
  await page.waitForTimeout(8000);
  check(await page.locator('#vvHud1').innerText() !== '—', 'live ribbon match missing');
  check((await page.locator('#vvCueNote').innerText()).includes('my '), 'the PREP note should show while speaking');
  await page.screenshot({ path: 'output/playwright/vocal-variety-live.png' });
  await page.waitForFunction(() => document.getElementById('vvView').dataset.view === 'results', null, { timeout: 50000 });
  clearInterval(drive);
  await page.waitForTimeout(500);
  const result = await page.evaluate(() => ({ score: Number(document.getElementById('vvScore').dataset.score), stars: Number(document.getElementById('vvStarRow').dataset.stars), progress: JSON.parse(localStorage.getItem('sg-vocal-arena-v1')), audio: document.querySelector('#vvAudioSlot audio')?.src || '' }));
  check(result.score >= 55 && result.stars >= 1, `a ribbon-following take should earn a star: ${JSON.stringify({ score: result.score, stars: result.stars })}`);
  check(result.progress.rounds === 1 && result.progress.xp > 0, 'progress was not saved');
  check(result.progress.badges.prepared, 'writing all four PREP notes should earn the Prepared badge');
  check(await page.locator('.vv-parts li').count() === 4, 'part-by-part PREP breakdown missing');
  check(result.audio.startsWith('blob:'), 'playback must use a local blob');
  check(await allEnded(), 'microphone still active after the round');
  await page.screenshot({ path: 'output/playwright/vocal-variety-results.png', fullPage: true });

  // 6. Permission denied keeps the game usable.
  await page.getByRole('button', { name: 'Try this question again' }).click();
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError')); });
  await page.getByRole('button', { name: /Start preparing/ }).click();
  await page.waitForTimeout(300);
  check((await page.locator('.vv-warning').innerText()).includes('declined'), 'permission error missing');
  check(await page.locator('[data-act="start-prep"]').isEnabled(), 'permission failure locked the start button');

  // 7. A microphone request canceled by navigating away must not leave a live track.
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.fixtureResolve = resolve; }); });
  await page.getByRole('button', { name: /Start preparing/ }).click();
  await page.getByRole('button', { name: '← All games' }).click();
  const canceled = await page.evaluate(async () => {
    const ctx = new AudioContext(), dest = ctx.createMediaStreamDestination();
    const track = dest.stream.getTracks()[0];
    window.fixtureResolve(dest.stream);
    await new Promise(resolve => setTimeout(resolve, 150));
    await ctx.close();
    return track.readyState;
  });
  check(canceled === 'ended', 'canceled microphone request left a live track');

  // 8. The preview stays web-only.
  const nativePage = await page.context().newPage();
  await nativePage.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
  const nativeAssets = [];
  nativePage.on('request', request => { if (request.url().includes('vocal-variety')) nativeAssets.push(request.url()); });
  await nativePage.goto('http://127.0.0.1:8766/index.html');
  await nativePage.waitForTimeout(700);
  check(await nativePage.locator('#menuVariety').count() === 0, 'native app must not expose the preview');
  check(nativeAssets.length === 0, 'native app must not request preview assets');
  await nativePage.close();

  if (failures.length || errors.length) throw new Error(`Vocal variety UI validation failed: ${JSON.stringify({ failures, errors })}`);
  return { failures, errors, tuned, result: { score: result.score, stars: result.stars }, startHeight, nativeAssets, canceledRequestTrack: canceled };
}
