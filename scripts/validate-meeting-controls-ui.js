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
  check(await page.locator('#callAudioToggle, #callAudioInfoModal').count() === 0, 'legacy switch/modal still present');
  check((await panel.innerText()).includes('Not connected'), 'saved mode must not claim a connected meeting');
  check(await panel.locator('.ma-head strong').count() === 1, 'meeting audio should have one heading');
  check(await panel.getByRole('button', { name: 'Use meeting audio', exact: true }).count() === 0, 'unnecessary enable step remains');
  await panel.getByRole('button', { name: 'Use the microphone instead', exact: true }).click();
  check((await panel.locator('.ma-state').innerText()) === 'Using microphone', 'microphone status is unclear');
  await page.evaluate(() => { meetingControlsTest.fail = true; });
  await panel.getByRole('button', { name: 'Connect meeting audio', exact: true }).click();
  check((await panel.locator('.ma-error').innerText()).includes('cancelled'), 'cancel message missing');
  check(await page.evaluate(() => !MeetingAudio.enabled()), 'cancelling first connection changed the source');
  await page.evaluate(() => { meetingControlsTest.fail = false; });
  await panel.locator('[data-ma="host"]').check();
  await panel.getByRole('button', { name: 'Connect meeting audio', exact: true }).click();
  await page.waitForFunction(() => window.MeetingAudio.isConnected());
  check(await page.evaluate(() => MeetingAudio.enabled() && MeetingAudio.status().includeHost), 'direct connect did not enable the selected sources');
  check(await page.evaluate(() => meetingControlsTest.picks === 2), 'direct connection should use one successful picker after the cancelled picker');
  await page.evaluate(() => window.navigateToPage('variety'));
  check((await page.locator('#vvSource .ma-state').innerText()).includes('Connected') || (await page.locator('#vvSource .ma-state').innerText()).includes('Hearing'), 'game did not share the connection');
  await page.evaluate(() => window.navigateToPage('spot'));
  await page.locator('#spotMeetingPanel').getByRole('button', { name: 'Disconnect', exact: true }).click();
  check(await page.evaluate(() => !MeetingAudio.isConnected() && MeetingAudio.enabled()), 'disconnect must stop capture without silently switching to a microphone');
  check(await page.evaluate(() => meetingControlsTest.captured.every(s => s.getTracks().every(t => t.readyState === 'ended'))), 'disconnect leaked a capture track');
  await page.evaluate(() => window.navigateToPage('settings'));
  check((await panel.locator('.ma-state').innerText()) === 'Not connected', 'settings did not follow the game disconnect');
  await panel.getByRole('button', { name: 'Use the microphone instead', exact: true }).click();
  check(await page.evaluate(() => !MeetingAudio.enabled()), 'microphone choice was not shared');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout overflows');
  await panel.screenshot({ path: 'output/playwright/meeting-audio-mobile.png' });
  await page.setViewportSize({ width: 1366, height: 900 });
  await panel.screenshot({ path: 'output/playwright/meeting-audio-desktop.png' });
  if (failures.length || errors.length) throw new Error(JSON.stringify({ failures, errors }));
  return { failures, errors, directConnect: true, sharedControls: true, mobileOverflow: false };
}
