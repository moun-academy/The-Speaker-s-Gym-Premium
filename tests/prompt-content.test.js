import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractArray(name) {
  const match = html.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n    \\];`));
  assert.ok(match, `${name} should exist`);
  return [...match[1].matchAll(/^\s+"([^"]+)",?$/gm)].map(([, value]) => value);
}

test('offers exactly 30 easy personal-opinion questions', () => {
  const questions = extractArray('personalOpinionQuestions');

  assert.equal(questions.length, 30);
  assert.equal(new Set(questions).size, 30);
  assert.ok(questions.every(question => question.endsWith('?')));
  assert.match(html, /'Personal Opinions': personalOpinionQuestions/);
});

test('removes comb from every game word pool', () => {
  assert.doesNotMatch(html, /\bcomb\b/i);
});
