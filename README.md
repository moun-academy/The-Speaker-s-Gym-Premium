# The-Speaker-s-Gym

## Vocal variety arena (web preview)

Open the online app and choose **Expand Your Vocal Variety** from the menu, or use
`/#vocal-variety`. It is a practice game: the student answers a real question out loud
while a live stage shows their **volume** moving through three zones, *Whisper*,
*Steady* and *Boom*.

- **Find your range** (about 12 seconds): whisper, speak naturally, call out strongly. The
  zones are measured against the student's own voice and microphone, so a quiet laptop mic
  and a loud headset both play fair. The range is remembered for 12 hours on this device.
- **Five stages**, each with four questions: *Whisper to Boom*, *The Staircase*, *The Pulse*,
  *The Story Arc* (guided: follow a glowing volume ribbon) and *Freestyle Boss* (no ribbon,
  hit goals). A star on one stage unlocks the next.
- **Results**: a voiceprint ring, a volume map with the loudest and softest moments, zone
  mix, range in dB, swings between zones, playback with a cursor, a coaching tip, XP, ranks,
  a day streak and badges.
- Pitch (notes and semitone range) and rhythm (estimated syllables per second) are shown as
  bonus tiles only. They never change the score.

Game rules live in `vocal-variety-game.js` (pure functions, covered by
`tests/vocal-variety-game.test.js`). Signal processing is in `vocal-variety-core.js`, the
interface in `vocal-variety.js` and `vocal-variety.css`.

**Scoring.** Variety = range between quiet and loud moments (45%), swings between zones
(35%) and use of all three zones (20%). Guided rounds are 70% ribbon match, 30% variety.
Talking for under half of a round lowers the score; pauses are never penalised. Volume is
relative microphone level, not calibrated sound pressure, so keep the microphone at one
distance. Strong means energetic, never strained.

**Privacy.** Audio stays in browser memory and is replaced by the next take. Nothing is
uploaded. Stars, XP, badges and the tuned range are saved in this browser's `localStorage`
only. No measurement changes the existing coaching scores, progress, or history. Microphone
tracks stop on Finish, navigation away, backgrounding, Escape, or page close.

The pitch reference is Ashwin Lecture 5 (`week5.js`): normalized autocorrelation detects
voice pitch. Rhythm counts energy peaks over four seconds; it is not word recognition or
exact WPM.

**Web only.** The loader and module guard against native Capacitor, and `build:web` does
not package the preview modules. Do not include it in an Android release until the user
has tested and approved it.

Run `npm test` for the signal and game-rule tests plus the existing app suite. The web
deployment serves the repository root; `www/` remains the Capacitor asset output.
With a local server on port 8766 and Playwright CLI open on its index page, run
`playwright-cli run-code --filename scripts/validate-vocal-variety-ui.js` to play the game
with generated audio (about 80 seconds): example, mobile layout, tuning, a guided round,
cleanup, permission denial, a canceled request, and the native gate.
