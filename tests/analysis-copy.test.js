import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sourceBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Could not locate ${start}`);
  return html.slice(from, to);
}

test('keeps copy actions hidden until an AI report is ready and announces results', () => {
  assert.match(html, /id="analysisCopyActions" hidden/);
  assert.match(html, /id="copyTranscriptBtn">📋 Copy transcript/);
  assert.match(html, /id="copyReportBtn">📋 Copy coaching report/);
  assert.match(html, /id="analysisCopyStatus" role="status" aria-live="polite"/);
  assert.match(html, /renderFeedbackScorecard\(\{ feedbackText, metrics, report \}\);\s+updateAnalysisCopyActions\(true\)/);
  assert.match(html, /aiFeedback\.textContent = 'AI feedback could not be generated[^;]+;\s+updateAnalysisCopyActions\(false\)/);
});

test('uses the secure clipboard API when it is available', async () => {
  let copied = '';
  const context = {
    navigator: { clipboard: { writeText: async value => { copied = value; } } },
    window: { isSecureContext: true },
    document: {},
    console
  };
  runInNewContext(sourceBetween('    async function writeTextToClipboard(text)', '    function updateAnalysisCopyActions'), context);

  assert.equal(await context.writeTextToClipboard('  Useful coaching  '), true);
  assert.equal(copied, 'Useful coaching');
});

test('falls back to a temporary textarea when clipboard access is unavailable', async () => {
  let removed = false;
  let appended = false;
  const textarea = {
    value: '', style: {}, setAttribute() {}, select() {}, setSelectionRange() {},
    remove() { removed = true; }
  };
  const context = {
    navigator: {},
    window: { isSecureContext: false },
    document: {
      createElement: () => textarea,
      body: { appendChild() { appended = true; } },
      execCommand: command => command === 'copy'
    },
    console
  };
  runInNewContext(sourceBetween('    async function writeTextToClipboard(text)', '    function updateAnalysisCopyActions'), context);

  assert.equal(await context.writeTextToClipboard('Practice one clear ending.'), true);
  assert.equal(textarea.value, 'Practice one clear ending.');
  assert.equal(appended, true);
  assert.equal(removed, true);
});
