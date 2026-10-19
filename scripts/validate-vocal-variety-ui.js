// Run with playwright-cli run-code --filename scripts/validate-vocal-variety-ui.js
// against a local server on 127.0.0.1:8766. Uses generated audio, no real account.
async (page) => {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.reload();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: '#loginGate { display: none !important; }' });
  await page.waitForSelector('#menuVariety');
  await page.evaluate(() => { document.getElementById('loginGate').style.display = 'none'; window.navigateToPage('variety'); });
  await page.getByRole('button', { name: 'See an example ↗' }).click();
  check((await page.locator('#vvSampleLabel').innerText()).includes('EXAMPLE'), 'demo must be labeled');
  check(Number(await page.locator('#vvPitchMetric').innerText()) >= 5, 'demo should show distinct notes');
  await page.screenshot({ path: 'output/playwright/vocal-variety-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile horizontal overflow');
  const height = await page.locator('#vvStart').evaluate(el => el.getBoundingClientRect().height);
  check(height >= 44, 'mobile start target too small');
  await page.getByRole('button', { name: 'Pace', exact: true }).click();
  check((await page.locator('#vvPrompt').innerText()).includes('train'), 'pace exercise does not switch');
  await page.screenshot({ path: 'output/playwright/vocal-variety-mobile.png', fullPage: true });

  await page.evaluate(() => {
    window.fixtureStreams = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext(); await ctx.resume();
      const oscillator = ctx.createOscillator(), gain = ctx.createGain(), destination = ctx.createMediaStreamDestination();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(110, ctx.currentTime);
      oscillator.frequency.setValueAtTime(220, ctx.currentTime + 4);
      oscillator.frequency.setValueAtTime(165, ctx.currentTime + 8);
      const begin = ctx.currentTime;
      for (let t = 0; t < 20; t += 0.02) {
        const rate = t < 4 ? 2 : t < 8 ? 4 : 1.5;
        const amplitude = t < 4 ? 0.06 : t < 8 ? 0.2 : 0.12;
        gain.gain.setValueAtTime(0.015 + amplitude * (0.5 + 0.5 * Math.cos(2 * Math.PI * rate * t)), begin + t);
      }
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      const stream = destination.stream;
      const track = stream.getTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); oscillator.stop(); ctx.close(); };
      window.fixtureStreams.push(stream);
      return stream;
    };
  });
  await page.getByRole('button', { name: 'Start practicing', exact: true }).click();
  await page.waitForTimeout(11000);
  check((await page.locator('#vvMode').innerText()).includes('LIVE'), 'live state missing');
  const metrics = await page.evaluate(() => ({ pitch: document.getElementById('vvPitchMetric').textContent, volume: document.getElementById('vvVolumeMetric').textContent, pace: document.getElementById('vvPaceMetric').textContent }));
  check(Number(metrics.pitch) >= 2, 'known notes were not detected');
  check(metrics.volume !== '—', 'volume range missing');
  check(metrics.pace !== '—', 'rhythm range missing');
  await page.getByRole('button', { name: '■ Finish take', exact: true }).click();
  await page.waitForTimeout(400);
  check(await page.locator('#vvPlayback').isVisible(), 'playback missing');
  check(await page.evaluate(() => window.fixtureStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), 'microphone still active after stop');
  check(await page.evaluate(() => document.getElementById('vvAudio').src.startsWith('blob:')), 'audio must use a local blob');
  await page.screenshot({ path: 'output/playwright/vocal-variety-mic-test.png', fullPage: true });
  await page.getByRole('button', { name: 'Start practicing', exact: true }).click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.navigateToPage('main'));
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.fixtureStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), 'microphone still active after navigation');
  await page.evaluate(() => {
    window.navigateToPage('variety');
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  });
  await page.getByRole('button', { name: 'Start practicing', exact: true }).click();
  await page.waitForTimeout(100);
  check((await page.locator('#vvStatus').innerText()).includes('declined'), 'permission error missing');
  check(await page.locator('#vvStart').isEnabled(), 'permission failure locked the start button');
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.fixtureResolve = resolve; });
  });
  await page.getByRole('button', { name: 'Start practicing', exact: true }).click();
  await page.getByRole('button', { name: '■ Stop', exact: true }).click();
  const canceled = await page.evaluate(async () => {
    const ctx = new AudioContext(), dest = ctx.createMediaStreamDestination();
    const track = dest.stream.getTracks()[0];
    window.fixtureResolve(dest.stream);
    await new Promise(resolve => setTimeout(resolve, 100));
    await ctx.close();
    return track.readyState;
  });
  check(canceled === 'ended', 'canceled microphone request left a live track');
  const nativePage = await page.context().newPage();
  await nativePage.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
  const nativeAssets = [];
  nativePage.on('request', request => { if (request.url().includes('vocal-variety')) nativeAssets.push(request.url()); });
  await nativePage.goto('http://127.0.0.1:8766/index.html');
  await nativePage.waitForTimeout(700);
  check(await nativePage.locator('#menuVariety').count() === 0, 'native app must not expose the preview');
  check(nativeAssets.length === 0, 'native app must not request preview assets');
  await nativePage.close();
  if (failures.length || errors.length) throw new Error('Vocal variety UI validation failed');
  return { failures, errors, metrics, mobileStartHeight: height, nativeAssets, canceledRequestTrack: canceled };
}
