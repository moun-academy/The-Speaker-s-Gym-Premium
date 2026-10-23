# Play vocal variety together on Google Meet

Use the online app in Chrome or Edge on a computer. Participants can join Meet from their usual devices.

1. Open Meet and Speaker's Gym in separate tabs.
2. In Meet, present the Speaker's Gym tab. Leave presentation audio off so participants do not hear their own voices played back.
3. In Expand Your Vocal Variety, select Use meeting audio, then Connect meeting audio.
4. In the browser's picker, select the Google Meet tab and turn on Also share tab audio. Return to the game.
5. Ask a participant to unmute and say hello. The audio bar should move and the panel should say Hearing the call.
6. Choose a game and take turns. Everyone except the current speaker should stay muted. Each speaker starts a new round with a short sound check.

To take a turn as the host, select Include my microphone and reconnect. Grant microphone access when asked. Use headphones to reduce echo.

The connection is shared across rounds. Finishing a round releases its recording, while keeping meeting audio connected. Stopping the browser share or losing the source interrupts the active round without scoring it. Reconnect and retry the same question.

## If there is no sound

- Capture the Meet tab's audio, not the game's own tab. Sharing the game's picture in Meet is a separate step from capturing Meet's sound in the game.
- Check that the participant is unmuted and that the audio-sharing checkbox was enabled in the browser picker.
- On Windows, Entire Screen with system audio is an alternative when tab audio is unavailable. It can include sounds from other applications, so tab audio is preferable.
- If local microphone access is denied, remote participants can still play. The panel explains how to reconnect with the host microphone.
- A silent connection cannot start a vocal-variety round. Ask the speaker to say a few words first.

During the sound check, speak normally for a few seconds. Background noise alone cannot set the scale. Each speaker gets a fresh midpoint, fixed during the round, so a normal voice stays near Steady and deliberate louder/softer speech moves above/below it.

Meet can smooth loudness and filter sound. Volume feedback reflects what reaches the host through the call, not calibrated loudness in the participant's room. Pitch and volume are analyzed locally. Pace games send short audio clips to the signed-in speech service to count words. Tell participants before playing.

Pace updates after recognition, roughly every three seconds plus network/processing time. Its dot and trace appear behind the white time line, at the time those words were spoken. WPM uses the time between recognized words, with pauses between them included. Unrecognized or missing clips are not guessed. If recognition fails or covers too little of the speech, the round is not scored; sign in again or check the connection as the message indicates.

## Verification

`npm test` covers connection lifetime, missing audio, cancellation, reconnect, host microphone mixing, permission denial, game scoring, and API authentication.

`scripts/validate-vocal-variety-ui.js` runs microphone and simulated-call rounds, measured pace, permission recovery, playback, mobile layout, and the native-app gate through Playwright CLI.

`scripts/validate-meeting-capture-ui.js` uses actual Chrome tab capture from a separate generated-sound tab, verifies that no host microphone is opened, and checks that closing the source stops the round without scoring it. Use a dedicated browser configuration with `--auto-select-tab-capture-source-by-title=Speaker Gym Meeting Fixture`, `--autoplay-policy=no-user-gesture-required`, and `ignoreDefaultArgs: ["--mute-audio"]`. These flags are for the isolated test browser only.

These checks do not replace a live call test with human participants on their own devices.
