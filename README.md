# The-Speaker-s-Gym

## Vocal variety web preview

Open the online app and choose **Expand Your Vocal Variety** from the menu, or use
`/#vocal-variety`. The preview provides one-minute microphone practice, pitch/note
and relative-loudness timelines, experimental syllable-rhythm estimates, and local
playback. The example button uses clearly labeled illustrative data.

The reference is Ashwin Lecture 5 (`week5.js`): normalized autocorrelation detects
voice pitch. The preview reports sustained distinct notes separately from pitch
span. Pace estimates energy peaks over four seconds; it is not word recognition or
exact WPM. Volume is microphone level, not calibrated sound pressure. No measurement
changes the existing coaching scores, progress, or history.

Audio stays in browser memory and is replaced by the next take. Microphone tracks
stop on Stop, navigation away, backgrounding, or page close. This feature is
intentionally web-only: the loader and module guard against native Capacitor, and
`build:web` does not package the preview modules. Do not include it in an Android
release until the user has tested and approved it. Android version metadata and
previous AABs were not changed for this preview.

Run `npm test` for the signal regression tests and existing app suite. The web
deployment serves the repository root; `www/` remains the Capacitor asset output.
With the local server running on port 8766 and Playwright CLI open on its index
page, run `playwright-cli run-code --filename scripts/validate-vocal-variety-ui.js`
for generated-audio, playback, cleanup, permission, mobile, and native-gate checks.
