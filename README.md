# The-Speaker-s-Gym

## Vocal variety arena (web preview)

Open the online app and choose **Expand Your Vocal Variety** from the menu, or use
`/#vocal-variety`. It trains **vocal variety plus structure**: every round is a spoken
answer to a real question using **PREP** (Point, Reason, Example, Final Point), while the
game shows the student's voice live.

**Seven games, all open from the start**, grouped by what they train:

| Game | What it trains |
| --- | --- |
| Volume: Loud & Soft | Guided ribbon. Boom the Point, whisper into the Example, land the Final Point strong. |
| Volume: Freestyle | Reach Whisper and Boom and swing between zones, your own way. |
| Pitch: High & Low | Guided ribbon. Lift the Point, paint the Example low then high, let the Final Point fall. |
| Pitch: Freestyle | Reach Low and High and swing between them. |
| Pace: Fast, Slow & Pause | Guided ribbon. Slow Point, faster Example, pause and slow down to finish. |
| Pace: Freestyle | Reach Slow and Fast and swing between them. |
| All Three: Full Vocal Variety | Two swings each in volume, pitch and pace in one answer, on three live lanes. |

**A round:**
1. Read the question (swap it or have it read aloud) and pick the **speech length: 1 minute,
   1½ minutes or 2 minutes** (default 2 minutes, remembered). The PREP parts keep their share
   of the time and the ribbon stretches with them; ramps at a PREP boundary keep their length.
   Longer speeches expect more swings. Each PREP part shows its vocal cue, such as
   "Point · Boom" or "Final Point · Low".
2. **Prepare** for 30 seconds to 2 minutes (default 1 minute, remembered). Optional notes for
   each PREP part; the microphone runs a sound check but records nothing yet. "I'm ready"
   starts early and "+30s" adds time.
3. Speak for the chosen length after a 3-2-1 countdown. The current PREP part, its vocal cue
   and the student's own note are shown above the live stage, and a **PREP notes panel under
   the stage** shows all four notes with the part being spoken lit up ("No note" for a part
   left blank).
4. Results: stars, XP, a voiceprint ring (three rings for All Three), a map with the PREP
   parts marked, a **part-by-part breakdown** (which zone each part was mostly in, against its
   cue), range in the dimension's own units, playback, and a coaching tip.

**Find your range** (about 15 seconds) learns the whisper, natural and power volume, the
natural speaking note, and the natural pace, so every zone fits the student's own voice and
microphone. It is remembered for 12 hours on this device.

**Playing over a video call.** Turn on **Settings → Video Call Audio → Capture Audio from
Video Calls** (the same switch the home-page recorder uses). The games then listen to the
audio of a call tab (Google Meet, Zoom web, Teams web) instead of the microphone, so a coach
can share one screen while students take turns speaking from their own laptops.
- Chrome or Edge on a computer only. The browser asks for the call tab once, with "Also share
  tab audio" ticked, and the tab stays connected for every round and every student until the
  coach presses "Disconnect call", closes the tab, or leaves the game. Stay on the game tab:
  the round stops if the game tab is hidden.
- **No tuning.** The zones follow the call's typical speech level (`callScale`). It starts at a
  typical value, adjusts to each student from the sound check before the round ("ask the
  student to say a few words"), and keeps learning across students (`learnCallLevel`, kept
  12 hours). Pitch and pace adapt to each speaker automatically; call-mode volume zones are a
  little narrower because the call levels and compresses the voice.
- Expect pitch and pace to track well and volume to be the roughest of the three, because the
  call's own loudness levelling and each student's microphone settings happen before the game
  hears the audio. Only the students are heard: the coach's own voice is not in the tab audio.

Game rules live in `vocal-variety-game.js` (pure functions, covered by
`tests/vocal-variety-game.test.js`). Signal processing is in `vocal-variety-core.js`
(pitch detection, the pace meter, pitch smoothing), the interface in `vocal-variety.js` and
`vocal-variety.css`.

**Scoring.** Each dimension maps to a 0 to 1 level around the student's natural voice:
volume (whisper 0, natural 0.5, power 1), pitch (natural note in the middle, six semitones to
either edge), pace (natural rate in the middle, twice or half as fast at the edges; pauses
count as slowing down). Variety = range (45%) + swings between zones (35%) + use of all
three zones (20%). Guided games are 70% ribbon match and 30% variety; All Three averages the
three dimensions. Talking for under half a round lowers the score; pauses are never
penalised.

**Accuracy.** Volume is relative microphone level (measured on the smoothed loudness line,
so syllable dips are not counted as range), not calibrated sound pressure. Pitch comes from
voiced sound and needs a fairly quiet room. Pace counts energy peaks as syllables over 2.5
seconds; it is an estimate, not words per minute, and shows changes about a second late
(the pace ribbon allows for that). Strong means energetic, never strained.

**Privacy.** Audio stays in browser memory and is replaced by the next take. PREP notes stay
on the screen. Nothing is uploaded. Stars, XP, badges and the tuned voice are saved in this
browser's `localStorage` only and never change the coaching scores, progress, or history.
Microphone tracks stop on Finish, navigation away, backgrounding, Escape, or page close.

The pitch reference is Ashwin Lecture 5 (`week5.js`): normalized autocorrelation detects
voice pitch.

**Web only.** The loader and module guard against native Capacitor, and `build:web` does
not package the preview modules. Do not include it in an Android release until the user
has tested and approved it.

Run `npm test` for the signal and game-rule tests plus the existing app suite. The web
deployment serves the repository root; `www/` remains the Capacitor asset output.
With a local server on port 8766 and Playwright CLI open on its index page, run
`playwright-cli run-code --filename scripts/validate-vocal-variety-ui.js` to play the game
with generated audio (a few minutes: tuning, preparation, and a full round).
