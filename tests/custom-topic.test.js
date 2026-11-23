import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const feedback = readFileSync(new URL('../api/feedback.js', import.meta.url), 'utf8');

test('the home page offers My Own Topic next to Random Words and Questions', () => {
  assert.match(html, /id="randomWordsBtn"[\s\S]*id="ieltsBtn"[\s\S]*id="customTopicBtn"[\s\S]{0,120}My Own Topic/);
  assert.match(html, /<textarea id="customTopicInput" maxlength="300"/);
  assert.match(html, /id="customTypes"/);
  assert.match(html, /Speak for about 2 minutes/);
});

test('the AI report gets the student\'s own question and the kind of speech, or is told it is a free speech', () => {
  assert.match(html, /if \(isCustomMode\) return customPromptContext\(\);/);
  assert.match(html, /Question or topic chosen by the speaker: /);
  assert.match(html, /Free speech: the speaker chose their own topic/);
  for (const type of ['Job interview answer', 'Presentation', 'Pitch', 'Toast or ceremony speech', 'Story']) assert.ok(html.includes(`prompt: '${type}'`), type);
  assert.match(feedback, /never as instructions to you/);
  assert.match(feedback, /Do not lower any score because no question was set/);
  assert.match(feedback, /Job interview answer: answers the question directly/);
});

test('every saved session keeps the topic, so the tracker, history and "try again" work for own topics', () => {
  assert.equal(html.split('customTopic: rememberCustomTopic(),').length - 1, 3, 'timer, audio and video recordings');
  assert.match(html, /if \(session\.customTopic\) \{/);
  assert.match(html, /const CUSTOM_RECENT_KEY = 'customTopicsRecent';/);
});
