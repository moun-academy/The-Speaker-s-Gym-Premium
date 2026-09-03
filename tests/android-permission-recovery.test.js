import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const nativePlugin = await readFile(
  new URL("../android/app/src/main/java/com/speakersgym/app/RecordingSaverPlugin.java", import.meta.url),
  "utf8"
);

test("offers Android users a direct permission recovery action", () => {
  assert.match(nativePlugin, /public void openAppSettings\(PluginCall call\)/);
  assert.match(nativePlugin, /Settings\.ACTION_APPLICATION_DETAILS_SETTINGS/);
  assert.match(nativePlugin, /package:" \+ getContext\(\)\.getPackageName\(\)/);
  assert.match(html, /function offerNativePermissionRecovery\(permissionLabel\)/);
  assert.match(html, /recordingSaver\.openAppSettings\(\)/);
  assert.match(html, /offerNativePermissionRecovery\('Microphone'\)/);
  assert.match(html, /offerNativePermissionRecovery\('Camera or microphone'\)/);
});

test("keeps Audio as the default recording mode", () => {
  assert.match(html, /<button class="mode-btn active" id="audioBtn">/);
  assert.match(html, /let currentMode = 'audio'/);
});
