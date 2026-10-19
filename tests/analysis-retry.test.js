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

test('offers a mobile-friendly retry only after the current analysis fails', () => {
  assert.match(html, /id="retryAnalysisBtn" class="analysis-retry-btn" hidden>↻ Retry AI analysis/);
  assert.match(html, /\.analysis-retry-btn \{[^}]*min-height: 44px/);
  assert.match(html, /offerFailedAnalysisRetry\(\{ audioBlob, duration, acousticMetrics, speechSessionId, promptContext \}\)/);
  assert.match(html, /AI feedback could not be generated\. Your recording is ready to retry\./);
  assert.match(html, /showSpeechChat\(transcript, feedbackText, metrics\);\s+clearFailedAnalysisRetry\(speechSessionId\)/);
  assert.match(html, /currentFeedbackText = '';\s+clearFailedAnalysisRetry\(\)/);
});

test('retries the same in-memory recording once and clears it safely', async () => {
  const retryAnalysisBtn = { hidden: true, disabled: false };
  const calls = [];
  const statuses = [];
  const context = {
    failedAnalysisRequest: null,
    latestSpeechSessionId: 'speech-1',
    pendingFeedbackSessions: new Set(),
    retryAnalysisBtn,
    setAiStatus: message => statuses.push(message),
    requestFeedbackWithAudio: async (...args) => { calls.push(args); }
  };
  runInNewContext(
    sourceBetween('    function clearFailedAnalysisRetry(', '    async function requestFeedbackWithAudio('),
    context
  );

  const request = {
    audioBlob: { size: 2048, type: 'audio/webm' },
    duration: 52,
    acousticMetrics: { pace: 117 },
    speechSessionId: 'speech-1',
    promptContext: 'Should every meeting have an agenda?'
  };
  context.offerFailedAnalysisRetry(request);
  assert.equal(retryAnalysisBtn.hidden, false);

  assert.equal(await context.retryFailedAnalysis(), true);
  assert.equal(retryAnalysisBtn.disabled, false);
  assert.deepEqual(calls[0], [
    request.audioBlob,
    request.duration,
    request.acousticMetrics,
    request.speechSessionId,
    request.promptContext
  ]);
  assert.deepEqual(statuses, ['Retrying AI analysis...']);

  context.pendingFeedbackSessions.add('speech-1');
  assert.equal(await context.retryFailedAnalysis(), false);
  assert.equal(calls.length, 1);

  context.clearFailedAnalysisRetry('speech-1');
  assert.equal(retryAnalysisBtn.hidden, true);
  assert.equal(retryAnalysisBtn.disabled, false);
  assert.equal(await context.retryFailedAnalysis(), false);
});

test('uses consistent US English in learner-facing practice copy', () => {
  assert.doesNotMatch(html, /\b[Pp]ractise\b/);
  assert.match(html, /Practice for at least 30 seconds to count a speech\./);
  assert.match(html, /Choose how you want to practice/);
});
