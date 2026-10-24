# The-Speaker-s-Gym

## Vocal variety arena (web preview)

Open the online app and choose **Expand Your Vocal Variety** from the menu, or use
`/#vocal-variety`. It trains **vocal variety plus structure**: every round is a spoken
answer to a real question using **PREP** (Point, Reason, Example, Final Point), while the
game shows the speaker's voice live.

**Seven games, all open from the start**, grouped by what they train:

| Game | What it trains |
| --- | --- |
| Volume: Loud & Soft | Guided ribbon. Boom the Point, whisper into the Example, land the Final Point strong. |
| Volume: Freestyle | Reach Whisper and Boom and swing between zones, your own way. |
| Pitch: High & Low | Guided ribbon. Lift the Point, paint the Example low then high, let the Final Point fall. |
| Pitch: Freestyle | Reach Low and High and swing between them. |
| Pace: Fast, Slow & Pause | Guided ribbon in words a minute: Slow for the Point, Fast for the Example, then pause and slow down. |
| Pace: Freestyle | Reach Slow and Fast and swing between them. |
| All Three: Full Vocal Variety | Swings in volume, pitch and pace in one answer, on three live lanes. |

**Pace is counted in words a minute, the same for every speaker:** **Slow is under 110,
Steady is 110 to 139, Fast is 140 or more** (pauses count as slowing down; the ribbon aims at
100, 125 and 150). Common published figures put conversation at roughly 120 to 150 and
presentations at roughly 100 to 160, so 140 is an ordinary quick pace, not a strain.
Words are counted from the speech itself: a few seconds of audio at a time go to
`/api/transcribe` (Whisper, the same service the AI feedback uses), which returns the words
with their times. Readings appear a few seconds late on screen but are filed at the moment
the words were spoken, so scoring is exact. If the service cannot be reached, pace falls back
to an estimate from the sound alone (peaks in the vowel energy, `wpmFromSound`, fitted to
recordings of known speed) and the results say so. Measured against recordings from 60 to
320 WPM, the sound-only estimate separates Slow, Steady and Fast only roughly, which is why
words are counted whenever the service is available.

**A round:**
1. Read the question (swap it or have it read aloud) and pick the **speech length: 1 minute,
   1½ minutes or 2 minutes** (default 2 minutes, remembered). The PREP parts keep their share
   of the time and the ribbon stretches with them; ramps at a PREP boundary keep their length.
   Longer speeches expect more swings. Each PREP part shows its vocal cue, such as
   "Point · Boom" or "Final Point · Low".
2. **Prepare** for 30 seconds to 2 minutes (default 1 minute, remembered). Optional notes for
   each PREP part. A **sound check** runs at the same time: whoever speaks now ("say a few
   words in your normal voice") sets the zones. "I'm ready" starts early and "+30s" adds time.
3. Speak for the chosen length after a 3-2-1 countdown. The current PREP part, its vocal cue
   and the student's own note are shown above the live stage, and a **PREP notes panel under
   the stage** shows all four notes with the part being spoken lit up ("No note" for a part
   left blank).
4. Results: stars, XP, a voiceprint ring (three rings for All Three), a map with the PREP
   parts marked, a **part-by-part breakdown** (which zone each part was mostly in, against its
   cue), range in the dimension's own units, playback, and a coaching tip.

**Nobody is tuned.** There is no "whisper, then shout" step. The zones follow whoever is
speaking: the sound check sets the speaker's typical loudness (Whisper is more than about
6 dB under it, Boom more than about 5 dB over it) and natural note (six semitones either way
reaches High and Low), the loudness carries on from one student to the next, and pace is
absolute words a minute. This also covers microphones that are louder or quieter than usual
and the levelling a video call applies.

## Think Fast (reaction arena)

Pick **Analogy Blitz** ("A battery is like a jacuzzi, because…"), **Hot Take** (agree or disagree, and why), **Sell It**
(pitch a strange product) or **Wild Mix** (all three). Choose 2 to 5 seconds a prompt and 5 to 20 prompts. All modes are
open from the start. A 3-2-1 countdown, then each prompt shows a draining ring; start talking at once.

**Hear me** (a switch in Settings, on by default; the games have no listening controls of their own) listens through the microphone, or through the meeting audio when that is on, and times
how long it takes to start speaking. It learns the room's quiet during the countdown, so nobody is tuned or asked to shout.
Each prompt scores up to 100: up to 80 for a fast start (full marks within 0.6 s, falling to 25 at the buzzer) and up to
20 for talking through the rest of the time. Answer 35 points or more to keep a combo going; the session score is the
average, with stars at 35, 65 and 85. XP builds ranks (Rookie, Sprinter, Quick Draw, Lightning, Thunder, Mind Reader) and
eight badges. Without a microphone it is a practice run: the prompts and timer only, no scores.

Sounds are skipped in meeting mode (they would be heard as answers). Nothing is recorded or uploaded. Progress is
kept in this browser (`sg-think-fast-v1`), and sessions and prompts still add to the old Think Fast totals and the account
sync. Files: `think-fast-core.js` (prompts, listening maths, scoring, ranks, badges; covered by
`tests/think-fast-core.test.js`), `think-fast.js` and `think-fast.css` (screen), `think-fast-words.js` (analogy words).

## Speak on the Spot

Answer a question while surprise words appear one at a time; work each word into what you are saying before its timer
runs out. Pick **Quick Spark** (30 s, 4 words), **Classic** (60 s, 6 words), **Pressure** (8 words, 6 s each),
**Endurance** (90 s, 10 words) or **Custom**. The question can be shuffled or typed in ("Write my own"), which suits a
coach running a session. Words are detected with the browser's speech recognition, or through the meeting audio when it
is on (see below); detection, call mode and recording are unchanged.

The score is out of 100 for every challenge: 15 points a word, up to 10 more for using it quickly, 10 for finishing, minus
10 for each missed word (and 5 for stopping early), all divided by what a perfect run could earn, so a 4-word spark can
reach 100 like a 10-word marathon. The results screen shows the score, grade (S to D), stars, a word-by-word timeline, and
a line-by-line breakdown. XP builds ranks (Newcomer to Spotlight Star) and eight badges, saved in this browser
(`sg-spot-v1`). The old Games, Best Score, Avg Words and Fastest counters keep counting. Rules and scoring live in
`spot-core.js` (tested by `tests/spot-core.test.js`) with the look in `spot.css`.

## Performance Tracker

Opens with a score hero (the speaking score ring and its two ingredients), four numbers at a glance (speeches, day streak,
time spoken, average words a minute) and jump chips to the AI review, progress, charts and milestones. The sections below
are unchanged in what they measure: the AI vocal and verbal review with history, weekly insight, track record by week or
month, practice patterns, personal records, three trend charts and milestone badges. Signed-out visitors see what the page
offers and a Sign in button. Styles are in `tracker.css`; every number still comes from the same speech records.

## Settings

One place for everything you set up: a row of "your setup at a glance" chips (microphone, Google Meet, Hear me, reminders,
account) that jump to each section, then **Microphone** (device picker and a **Test my microphone** level meter),
**Google Meet** (the only place meeting audio is controlled, plus the Think Fast Hear me switch), **Daily reminders**,
**Account and sync**, and **About**. Styles are in `settings.css`.

## Playing over a video call (every game)

The coach shares their screen in a Google Meet and students speak from their own laptops. The
games listen to the call instead of the microphone:

1. Turn on **Meeting audio** in **Settings** ("Play with students on Google Meet"). It is off by default, it lives only
   there, and once it is on every game that listens uses it: the games show a short note instead of their own controls.
2. Press **Connect meeting audio** once. In the box the browser shows, choose your **Google Meet
   tab** and tick **Also share tab audio**, or (Windows) choose **Entire Screen** and tick
   **Also share system audio**, which also works when the call is in another window or app.
3. A live meter says **Hearing the call** when a student speaks. If it stays flat, the panel
   says what to try (picked the wrong tab, shared without sound, a window, and so on).
4. Every game now uses that one connection until it is disconnected or the share stops:
   - **Speak on the Spot** sends a few seconds of the call's audio at a time to `/api/transcribe`
     (with the target words as a spelling hint) and runs its existing word detection on the text.
   - **Home-page recorder** records the call without asking for the tab each time.
   - **Vocal variety** reads loudness and pitch from the call audio and counts words a minute
     for the pace games.
   - **Think Fast** listens through its "Hear me" switch (the Think Fast section above) and times how fast each student starts.
   - **Warm Up** does not listen to anyone, so it needs nothing.

Chrome or Edge on a computer only. The coach stays on the game tab (a round stops if the tab is
hidden). Only the students are heard: the coach's own voice is not in the shared audio. Pitch
and pace track well over a call; volume is the roughest, because the call levels and compresses
voices before the game hears them, and each student's microphone settings apply as well.

Files: `meeting-audio.js` (connection, panel, `ChunkTranscriber`), `api/transcribe.js` (short
speech to text), `vocal-variety-game.js` (rules, pure functions, covered by
`tests/vocal-variety-game.test.js`), `vocal-variety-core.js` (pitch, vowel filter, sound-only
pace estimate), `vocal-variety.js` and `vocal-variety.css` (interface).

**Scoring.** Each dimension maps to a 0 to 1 level. Variety = range (45%) + swings between
zones (35%) + use of all three zones (20%). Guided games are 70% ribbon match and 30% variety;
All Three averages the three dimensions. Talking for under half a round lowers the score;
pauses are never penalised. Volume is relative level, not calibrated sound pressure. Strong
means energetic, never strained.

**Privacy.** Audio and PREP notes stay in the browser. In meeting mode, and in the Pace games,
a few seconds of speech at a time are sent to the app's speech service to be turned into words
(nothing is stored by the app); the other games and the microphone-only Volume and Pitch games
send nothing. Stars, XP, badges and the learned loudness are saved in this browser's
`localStorage` only and never change the coaching scores, progress, or history. Capture stops
on Finish, navigation away, backgrounding, Escape, or page close; the meeting connection stays
open until it is disconnected (the browser shows its sharing indicator while it is).

`api/transcribe.js` only answers signed-in users: the browser sends its Firebase login token and the
server checks it against the app's Firebase project (no secret needed, only the public project id).
It is also limited to short audio chunks (1.5 MB) of known
audio types. Every chunk with speech costs a little on the OpenAI account.

**Web only.** The loader and modules guard against native Capacitor, and `build:web` does
not package them. Do not include them in an Android release until the user has tested and
approved them.

Run `npm test` for the signal, rules and endpoint tests plus the existing app suite. The web
deployment serves the repository root; `www/` remains the Capacitor asset output.
With a local server on port 8766 and Playwright CLI open on its index page, run
`playwright-cli run-code --filename scripts/validate-vocal-variety-ui.js` to play the game
with generated audio.
