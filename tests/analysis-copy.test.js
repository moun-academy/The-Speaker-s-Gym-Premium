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
  assert.match(html, /id="downloadReportBtn">⬇ Download coaching report/);
  assert.match(html, /id="analysisCopyStatus" role="status" aria-live="polite"/);
  assert.match(html, /renderFeedbackScorecard\(\{ feedbackText, metrics, report \}\);\s+updateAnalysisCopyActions\(true\)/);
  assert.match(html, /aiFeedback\.textContent = 'AI feedback could not be generated[^;]+;\s+updateAnalysisCopyActions\(false\)/);
});

test('downloads a dated coaching report as a local UTF-8 text file on the web', async () => {
  let clicked = false;
  let removed = false;
  let appended = false;
  let revoked = '';
  let createdBlob;
  const link = {
    href: '', download: '', style: {},
    click() { clicked = true; },
    remove() { removed = true; }
  };
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
      createdBlob = this;
    }
  }
  const context = {
    Blob: FakeBlob,
    URL: {
      createObjectURL: () => 'blob:coaching-report',
      revokeObjectURL: value => { revoked = value; }
    },
    document: {
      createElement: tag => {
        assert.equal(tag, 'a');
        return link;
      },
      body: { appendChild() { appended = true; } }
    },
    isCapacitorNative: () => false,
    setTimeout: callback => callback(),
    console
  };
  runInNewContext(sourceBetween('    function coachingReportFilename', '    function updateAnalysisCopyActions'), context);

  assert.equal(context.coachingReportFilename(new Date('2026-10-12T08:00:00Z')), 'speakers-gym-coaching-report-2026-10-12.txt');
  assert.equal(await context.saveAnalysisTextFile('  Keep one clear focus.  ', 'report.txt'), '');
  assert.equal(createdBlob.parts.length, 1);
  assert.equal(createdBlob.parts[0], 'Keep one clear focus.\n');
  assert.equal(createdBlob.type, 'text/plain;charset=utf-8');
  assert.equal(link.download, 'report.txt');
  assert.equal(link.href, 'blob:coaching-report');
  assert.equal(appended, true);
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.equal(revoked, 'blob:coaching-report');
});

test('uses the existing Android Downloads bridge for coaching reports', async () => {
  let savedPayload;
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
    }
  }
  const context = {
    Blob: FakeBlob,
    isCapacitorNative: () => true,
    blobToBase64: async blob => {
      assert.equal(blob.parts.length, 1);
      assert.equal(blob.parts[0], 'Practice the ending.\n');
      return 'encoded-report';
    },
    window: {
      Capacitor: {
        Plugins: {
          RecordingSaver: {
            async saveToDownloads(payload) {
              savedPayload = payload;
              return { folder: 'Downloads/Speakers Gym' };
            }
          }
        }
      }
    },
    console
  };
  runInNewContext(sourceBetween('    function coachingReportFilename', '    function updateAnalysisCopyActions'), context);

  assert.equal(await context.saveAnalysisTextFile('Practice the ending.', 'report.txt'), 'Downloads/Speakers Gym');
  assert.equal(savedPayload.filename, 'report.txt');
  assert.equal(savedPayload.mimeType, 'text/plain');
  assert.equal(savedPayload.data, 'encoded-report');
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
