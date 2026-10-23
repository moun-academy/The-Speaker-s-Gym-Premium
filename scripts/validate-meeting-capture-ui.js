// Uses Chrome's actual tab capture, not a getDisplayMedia mock. The captured tab plays generated
// sound to model another participant; no real meeting or personal recording is used.
async (page) => {
  const base = new URL(page.url()).origin;
  const errors = [];
  await page.reload();
  page.on('pageerror', error => errors.push(error.message));
  await page.addStyleTag({ content: '#loginGate { display: none !important; }' });
  await page.evaluate(() => {
    localStorage.clear();
    window.navigateToPage('variety');
    window.micRequests = 0;
    const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (...args) => { window.testCapture = await capture(...args); return window.testCapture; };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.micRequests++; return original(...args); };
  });
  const remote = await page.context().newPage();
  await remote.goto(`${base}/index.html`);
  await remote.evaluate(async () => {
    document.title = 'Speaker Gym Meeting Fixture';
    window.testContext = new AudioContext();
    const oscillator = testContext.createOscillator(), gain = testContext.createGain();
    oscillator.frequency.value = 180; gain.gain.value = 0.08;
    window.testAnalyser = testContext.createAnalyser();
    oscillator.connect(gain).connect(testAnalyser).connect(testContext.destination); oscillator.start();
    await testContext.resume();
  });
  await page.bringToFront();
  await page.locator('#vvSource').getByRole('button', { name: 'Use meeting audio', exact: true }).click();
  await page.locator('#vvSource').getByRole('button', { name: 'Connect meeting audio', exact: true }).click();
  await page.waitForFunction(() => window.MeetingAudio.status().hearing, null, { timeout: 15000 });
  const initial = await page.evaluate(() => ({ ...window.MeetingAudio.status(), micRequests: window.micRequests }));
  if (initial.surface !== 'browser' || initial.micRequests !== 0) throw new Error(`Wrong audio source: ${JSON.stringify(initial)}`);
  await page.locator('.vv-stage-card[data-stage="pitch-ribbon"]').click();
  await page.getByRole('button', { name: /Start preparing/ }).click();
  await page.waitForFunction(() => document.getElementById('vvMicText')?.textContent.startsWith('✓ Voice level set'), null, { timeout: 10000 });
  await page.getByRole('button', { name: /I’m ready/ }).click();
  await page.waitForTimeout(6000);
  const live = await page.locator('#vvLiveStatus').innerText();
  if (!live.includes('Listening')) throw new Error(`The game did not listen: ${live}`);
  // Changing or ending the shared source must stop this take without awarding a score.
  await remote.close();
  await page.waitForFunction(() => document.getElementById('vvView').dataset.view === 'brief', null, { timeout: 10000 });
  const stopped = await page.locator('.vv-warning').innerText();
  if (!stopped.includes('not scored')) throw new Error(stopped);
  const progress = await page.evaluate(() => JSON.parse(localStorage.getItem('sg-vocal-arena-v1') || '{"rounds":0}'));
  if (progress.rounds) throw new Error('Disconnected round was incorrectly awarded progress');
  if (errors.length) throw new Error(errors.join('; '));
  return { actualTabCapture: initial.surface, hearing: initial.hearing, microphoneRequests: initial.micRequests, interruptedRoundNotScored: true, errors };
}
