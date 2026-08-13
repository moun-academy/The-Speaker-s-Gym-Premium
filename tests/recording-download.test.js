import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("keeps direct browser downloads for audio and video", () => {
  assert.match(html, /id="audioDownloadLink"[^>]+download="speech\.webm"/);
  assert.match(html, /id="videoDownloadLink"[^>]+download="speech\.webm"/);
});

test("uses native file saving and the Android share sheet", () => {
  assert.equal(packageJson.dependencies["@capacitor/filesystem"], "^6.0.0");
  assert.equal(packageJson.dependencies["@capacitor/share"], "^6.0.0");
  assert.match(html, /window\.Capacitor\?\.Plugins\?\.Filesystem/);
  assert.match(html, /window\.Capacitor\?\.Plugins\?\.Share/);
  assert.match(html, /filesystem\.writeFile\(\{/);
  assert.match(html, /files: \[fileUrl\]/);
  assert.match(html, /Save or Share Recording/);
});

test("saves the correct completed blob for each recording mode", () => {
  assert.match(html, /currentAudioBlob = blob/);
  assert.match(html, /currentVideoBlob = videoBlob/);
  assert.match(html, /saveNativeRecording\(currentAudioBlob,/);
  assert.match(html, /saveNativeRecording\(currentVideoBlob,/);
});
