import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('uses semantic buttons for the primary navigation and icon controls', () => {
  const menuButtons = html.match(/<button class="menu-item(?: active)?"[^>]+data-page="[^"]+"/g) || [];

  assert.equal(menuButtons.length, 9);
  assert.match(html, /<button class="hamburger-btn"[^>]+aria-label="Open menu"[^>]+aria-expanded="false"/);
  assert.match(html, /<button class="profile-btn"[^>]+aria-label="Open profile menu"[^>]+aria-expanded="false"/);
  assert.match(html, /<button class="menu-close"[^>]+aria-label="Close menu"/);
});

test('keeps the closed menu out of keyboard navigation and exposes state changes', () => {
  assert.match(html, /id="menuSidebar" aria-label="Main menu" aria-hidden="true" inert/);
  assert.match(html, /sidebar\.removeAttribute\('inert'\)/);
  assert.match(html, /sidebar\.setAttribute\('inert', ''\)/);
  assert.match(html, /menuButton\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(html, /event\.key === 'Escape'/);
  assert.match(html, /function setProfileMenuOpen\(isOpen\)/);
});

test('marks the current page and provides visible keyboard focus', () => {
  assert.match(html, /item\.removeAttribute\('aria-current'\)/);
  assert.match(html, /menuItem\.setAttribute\('aria-current', 'page'\)/);
  assert.match(html, /button:focus-visible,[\s\S]*outline: 3px solid #fde047 !important/);
});

test('aligns visible and Android release metadata for version 29', () => {
  const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  const serviceWorker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

  assert.match(html, /const APP_VERSION = '29'/);
  assert.match(html, /const LAST_UPDATED = 'September 21, 2026'/);
  assert.match(gradle, /versionCode 29/);
  assert.match(gradle, /versionName "29"/);
  assert.match(serviceWorker, /speakers-gym-v20/);
});
