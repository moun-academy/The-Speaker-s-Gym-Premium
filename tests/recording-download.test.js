import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const nativePlugin = await readFile(new URL("../android/app/src/main/java/com/speakersgym/app/RecordingSaverPlugin.java", import.meta.url), "utf8");
const mainActivity = await readFile(new URL("../android/app/src/main/java/com/speakersgym/app/MainActivity.java", import.meta.url), "utf8");

test("keeps direct browser downloads for audio and video", () => {
  assert.match(html, /id="audioDownloadLink"[^>]+download="speech\.webm"/);
  assert.match(html, /id="videoDownloadLink"[^>]+download="speech\.webm"/);
});

test("saves directly to the Android Downloads folder without sharing", () => {
  assert.equal(packageJson.dependencies["@capacitor/share"], undefined);
  assert.equal(packageJson.dependencies["@capacitor/filesystem"], undefined);
  assert.match(mainActivity, /registerPlugin\(RecordingSaverPlugin\.class\)/);
  assert.match(nativePlugin, /@CapacitorPlugin\([\s\S]*name = "RecordingSaver"/);
  assert.match(nativePlugin, /MediaStore\.Downloads/);
  assert.match(nativePlugin, /Environment\.DIRECTORY_DOWNLOADS \+ "\/Speakers Gym"/);
  assert.match(nativePlugin, /Build\.VERSION_CODES\.Q/);
  assert.match(nativePlugin, /saveLegacyDownload/);
  assert.match(html, /RecordingSaver/);
  assert.match(html, /saveToDownloads\(\{/);
  assert.match(html, /Recording saved to/);
  assert.match(html, /Save Recording/);
  assert.doesNotMatch(html, /Save or Share Recording|share\.share|Plugins\?\.Share/);
});

test("saves the correct completed blob for each recording mode", () => {
  assert.match(html, /currentAudioBlob = blob/);
  assert.match(html, /currentVideoBlob = videoBlob/);
  assert.match(html, /saveNativeRecording\(currentAudioBlob,/);
  assert.match(html, /saveNativeRecording\(currentVideoBlob,/);
});
