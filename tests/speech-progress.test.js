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

const recordsContext = {};
runInNewContext(sourceBetween('    function isCompletedSpeechRecord(data)', '    // Calculate stats from Firestore'), recordsContext);

function snapshot(items) {
  return { forEach(callback) { items.forEach(([id, data]) => callback({ id, data: () => data })); } };
}

test('cloud progress ignores analysis-only and unconfirmed records', () => {
  const date = new Date('2026-09-24T10:00:00Z');
  const records = recordsContext.completedSpeechRecords(snapshot([
    ['analysis-only', { report: { version: 6 }, createdAt: date }],
    ['short', { completed: false, mode: 'audio', word: 'Coffee', duration: 9, createdAt: date }],
    ['confirmed', { completed: true, mode: 'audio', word: 'Coffee', duration: 45, completedAt: date.toISOString() }],
    ['legacy', { mode: 'video', word: 'Books', duration: 0, createdAt: date }]
  ]));
  assert.deepEqual(Array.from(records, record => record._id), ['confirmed', 'legacy']);
});

test('AI analysis never creates a speech before confirmation', async () => {
  let updates = 0;
  const pendingSpeechAnalyses = new Map();
  const completedSpeechSessionIds = new Set();
  const syncedSpeechSessionIds = new Set();
  const context = {
    syncEnabled: true,
    currentUser: { uid: 'user-1' },
    speechSessionOwners: new Map([['speech-1', 'user-1']]),
    completedSpeechSessionIds,
    syncedSpeechSessionIds,
    pendingSpeechAnalyses,
    pendingSpeechCompletion: { id: 'speech-1' },
    db: { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ update: async () => { updates++; } }) }) }) }) },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'now' } } },
    console
  };
  runInNewContext(sourceBetween('    async function syncSpeechAnalysisToFirebase(', '    function isCompletedSpeechRecord(data)'), context);
  const analysis = { transcript: 'A real answer', report: { version: 6 } };
  await context.syncSpeechAnalysisToFirebase('speech-1', analysis);
  assert.equal(updates, 0);
  assert.equal(pendingSpeechAnalyses.get('speech-1'), analysis);
  completedSpeechSessionIds.add('speech-1');
  await context.syncSpeechAnalysisToFirebase('speech-1', analysis);
  assert.equal(updates, 0);
  syncedSpeechSessionIds.add('speech-1');
  await context.syncSpeechAnalysisToFirebase('speech-1', analysis);
  assert.equal(updates, 1);
  assert.equal(pendingSpeechAnalyses.has('speech-1'), false);
});

test('legacy duplicate ratings count as one session while separate practice stays', () => {
  const start = Date.parse('2026-09-24T10:00:00Z');
  const records = recordsContext.completedSpeechRecords(snapshot([
    ['first', { mode: 'audio', word: 'Coffee', duration: 0, createdAt: new Date(start) }],
    ['duplicate', { mode: 'audio', word: 'Coffee', duration: 0, createdAt: new Date(start + 1000) }],
    ['next-practice', { mode: 'audio', word: 'Coffee', duration: 0, createdAt: new Date(start + 4000) }]
  ]));
  assert.deepEqual(Array.from(records, record => record._id), ['first', 'next-practice']);
});

test('one eligible recording increments progress once and saves its own rating', () => {
  const stats = { todaySpeeches: 0, totalSpeeches: 0, ratings: [], weekHistory: {} };
  const context = {
    stats,
    completedSpeechSessionIds: new Set(),
    pendingSpeechAnalyses: new Map(),
    calculatePracticeStreak: () => 1,
    checkNewDay() {}, saveStats() {}, updateStats() {}, updateWeekCalendar() {}, updateNudge() {}, showAchievement() {}
  };
  runInNewContext(sourceBetween('    function completeSpeech(session, rating)', '    // Main recording modes'), context);
  const short = { id: 'short', mode: 'audio', duration: 12, stopped: true };
  const finished = { id: 'finished', mode: 'audio', duration: 42, stopped: true };
  assert.equal(context.completeSpeech(short, 5), false);
  assert.equal(context.completeSpeech(finished, 4), true);
  assert.equal(context.completeSpeech(finished, 4), false);
  assert.equal(stats.todaySpeeches, 1);
  assert.equal(stats.totalSpeeches, 1);
  assert.deepEqual(Array.from(stats.ratings), [4]);
});

test('rating dialog cannot submit a second completion', () => {
  const calls = [];
  const attrs = new Map();
  const ratingModal = {
    classList: { contains: name => attrs.get(name) === true, remove: name => attrs.set(name, false) },
    setAttribute() {}
  };
  attrs.set('show', true);
  const context = {
    ratingModal,
    pendingSpeechCompletion: { id: 'one', duration: 42 },
    completeSpeech: (...args) => calls.push(args),
    restoreDialogFocus() {}, ratingReturnFocus: null
  };
  runInNewContext(sourceBetween('    function submitRating(rating)', '    function completeSpeech(session, rating)'), context);
  context.submitRating(3);
  context.submitRating(3);
  assert.equal(calls.length, 1);
});

test('streak waits for a completed speech today', () => {
  const context = {};
  runInNewContext(sourceBetween('    function calculatePracticeStreak(weekHistory', '    function saveStats()'), context);
  const today = new Date('2026-09-24T12:00:00');
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const history = { [yesterday.toDateString()]: true };
  assert.equal(context.calculatePracticeStreak(history, today), 1);
  history[today.toDateString()] = true;
  assert.equal(context.calculatePracticeStreak(history, today), 2);
});

test('the retry step shows a concrete focus only for a completed latest speech', () => {
  const elements = { retryFocus: { textContent: '' }, retryPractice: { hidden: true } };
  const context = {
    completedSpeechSessionIds: new Set(['latest']),
    latestPracticeSession: { id: 'latest' },
    document: { getElementById: id => elements[id] },
    parseFeedbackSections: () => ({ nextFocus: '' })
  };
  runInNewContext(sourceBetween('    function showRetryPractice(sessionId, report, feedbackText)', '    function retryPracticePrompt()'), context);
  context.showRetryPractice('old', { nextFocus: { action: 'Pause before the final point.' } }, '');
  assert.equal(elements.retryPractice.hidden, true);
  context.showRetryPractice('latest', { nextFocus: { action: 'Pause before the final point.' } }, '');
  assert.equal(elements.retryPractice.hidden, false);
  assert.match(elements.retryFocus.textContent, /Pause before the final point/);
});

test('retry restores the same personal question and makes recording ready', () => {
  let focused = false;
  let activePill = '';
  const elements = {
    retryPractice: { hidden: false },
    startAudioBtn: { focus: () => { focused = true; } }
  };
  const context = {
    latestPracticeSession: {
      id: 'latest', word: 'Personal Opinions', definition: 'What makes a day off feel well spent?',
      category: 'Personal Opinions', conversationQuestion: 'What makes a day off feel well spent?'
    },
    currentMode: 'audio',
    localStorage: { setItem() {} },
    updatePromptModeUI() {}, resetPrompt() {}, updateStructure() {},
    categoryPillsContainer: { querySelectorAll: () => [{
      dataset: { category: 'Personal Opinions' },
      classList: { toggle: (_, selected) => { if (selected) activePill = 'Personal Opinions'; } }
    }] },
    conversationQuestionText: { textContent: '' },
    wordBox: { scrollIntoView() {} },
    document: { getElementById: id => elements[id] },
    requestAnimationFrame: callback => callback()
  };
  runInNewContext(sourceBetween('    function retryPracticePrompt()', '    function percentile(values, ratio)'), context);
  context.retryPracticePrompt();
  assert.equal(context.currentWord.definition, 'What makes a day off feel well spent?');
  assert.equal(context.conversationQuestionText.textContent, 'What makes a day off feel well spent?');
  assert.equal(activePill, 'Personal Opinions');
  assert.equal(elements.retryPractice.hidden, true);
  assert.equal(focused, true);
});
