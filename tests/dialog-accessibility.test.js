import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('exposes the tutorial as a labelled modal and isolates it while hidden', () => {
  assert.match(html, /id="tutorialOverlay" aria-hidden="true" inert/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="tutorialTitle" aria-describedby="tutorialCopy"/);
  assert.match(html, /tutorialOverlay\.removeAttribute\('inert'\)/);
  assert.match(html, /tutorialOverlay\.setAttribute\('inert', ''\)/);
  assert.match(html, /tutorialNextBtn\.focus\(\)/);
});

test('makes confidence rating understandable and keyboard reachable', () => {
  assert.match(html, /id="ratingModal" role="dialog" aria-modal="true" aria-labelledby="ratingTitle" aria-describedby="ratingSubtitle" aria-hidden="true" inert/);
  assert.match(html, /class="rating-stars" role="group" aria-label="Confidence rating from 1 to 5"/);
  for (let rating = 1; rating <= 5; rating++) {
    assert.match(html, new RegExp(`data-rating="${rating}" aria-label="${rating} out of 5"`));
  }
  assert.match(html, /ratingModal\.querySelector\('\.star'\)\?\.focus\(\)/);
});

test('contains modal focus, supports Escape, and restores focus', () => {
  assert.match(html, /function trapDialogFocus\(event, dialog\)/);
  assert.match(html, /event\.shiftKey && document\.activeElement === first/);
  assert.match(html, /!event\.shiftKey && document\.activeElement === last/);
  assert.match(html, /event\.key === 'Escape'[\s\S]+finishTutorial\(\)/);
  assert.match(html, /event\.key === 'Escape'[\s\S]+submitRating\(null\)/);
  assert.match(html, /restoreDialogFocus\(tutorialReturnFocus, 'newWordBtn'\)/);
  assert.match(html, /restoreDialogFocus\(ratingReturnFocus, 'newWordBtn'\)/);
});
