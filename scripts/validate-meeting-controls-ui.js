// Run through Playwright CLI against a local or published app. Generated audio only, no account.
async (page) => {
  const failures = [], errors = [], check = (ok, message) => { if (!ok) failures.push(message); };
  page.on('pageerror', error => errors.push(error.message));
  // Existing users may have the old toggle saved as on. Do not mistake that for a connection.
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('callAudioMode', 'true'); });
  await page.reload();
  await page.waitForSelector('#menuVariety');
  await page.addStyleTag({ content: '#loginGate { display: none !important; }' });
  await page.evaluate(() => {
    window.navigateToPage('settings');
    window.meetingControlsTest = { picks: 0, captured: [], microphones: [], fail: false };
    const audio = () => {
      const ctx = new AudioContext(), osc = ctx.createOscillator(), gain = ctx.createGain(), dest = ctx.createMediaStreamDestination();
      gain.gain.value = 0.04; osc.connect(gain).connect(dest); osc.start();
      const track = dest.stream.getAudioTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { stop(); osc.stop(); ctx.close().catch(() => {}); };
      return dest.stream;
    };
    navigator.mediaDevices.getUserMedia = async () => { const stream = audio(); meetingControlsTest.microphones.push(stream); return stream; };
    navigator.mediaDevices.getDisplayMedia = async () => {
      meetingControlsTest.picks++;
      if (meetingControlsTest.fail) throw new DOMException('Cancelled', 'NotAllowedError');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
      const track = canvas.captureStream(1).getVideoTracks()[0];
      const settings = track.getSettings.bind(track); track.getSettings = () => ({ ...settings(), displaySurface: 'browser' });
      const stream = new MediaStream([track, ...audio().getAudioTracks()]);
      meetingControlsTest.captured.push(stream); return stream;
    };
  });
  const panel = page.locator('#meetingAudioPanel');
  const toggle = panel.locator('[data-ma="toggle"]');
  check(await page.locator('#callAudioToggle, #callAudioInfoModal').count() === 0, 'legacy switch/modal still present');
  check(await page.evaluate(() => !MeetingAudio.enabled()), 'Google Meet audio must start off');
  check(!(await toggle.isChecked()), 'the switch must start off');
  check((await panel.locator('.ma-state').innerText()).startsWith('OFF'), 'the off state is unclear');
  check(await panel.locator('button').count() === 0, 'the panel must hold only the switch, no buttons');
  await page.evaluate(() => { meetingControlsTest.fail = true; });
  await toggle.check();
  check((await panel.locator('.ma-error').innerText()).includes('cancelled'), 'cancel message missing');
  check(await page.evaluate(() => !MeetingAudio.enabled()), 'cancelling the chooser must leave it off');
  await page.evaluate(() => { meetingControlsTest.fail = false; });
  await toggle.check();
  await page.waitForFunction(() => window.MeetingAudio.isConnected());
  check(await page.evaluate(() => MeetingAudio.enabled()), 'turning the switch on did not enable meeting audio');
  check(await page.evaluate(() => meetingControlsTest.picks === 2), 'turning it on should use one successful chooser after the cancelled one');
  await page.evaluate(() => window.navigateToPage('variety'));
  check(await page.locator('#varietyPage .ma-panel, #vvSource, .vv-source-note').count() === 0, 'games must not carry their own meeting controls');
  check(await page.evaluate(() => MeetingAudio.isConnected()), 'the game did not share the connection');
  await page.evaluate(() => window.navigateToPage('spot'));
  check(await page.locator('#spotChallengePage .ma-panel, #spotCallNote').count() === 0, 'Speak on the Spot must not carry a meeting control');
  await page.evaluate(() => window.navigateToPage('settings'));
  await toggle.uncheck();
  check(await page.evaluate(() => !MeetingAudio.isConnected() && !MeetingAudio.enabled()), 'turning it off must release the call and go back to the microphone');
  check(await page.evaluate(() => meetingControlsTest.captured.every(s => s.getTracks().every(t => t.readyState === 'ended'))), 'turning it off leaked a capture track');
  await page.reload();
  check(await page.evaluate(() => !MeetingAudio.enabled()), 'it must be off again after a reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout overflows');
  await panel.screenshot({ path: 'output/playwright/meeting-audio-mobile.png' });
  await page.setViewportSize({ width: 1366, height: 900 });
  await panel.screenshot({ path: 'output/playwright/meeting-audio-desktop.png' });
  if (failures.length || errors.length) throw new Error(JSON.stringify({ failures, errors }));
  return { failures, errors, directConnect: true, sharedControls: true, mobileOverflow: false };
}
