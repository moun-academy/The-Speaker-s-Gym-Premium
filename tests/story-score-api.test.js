import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, cleanRequest, cleanRating } from '../api/story-score.js';

const response = () => { const res = { headers: {}, statusCode: 0, body: null }; res.setHeader = (k, v) => { res.headers[k] = v; }; res.status = c => { res.statusCode = c; return res; }; res.json = v => { res.body = v; return res; }; res.end = () => res; return res; };
const request = (body, { method = 'POST', auth = 'Bearer good' } = {}) => ({ method, headers: auth ? { authorization: auth } : {}, body });
const allowed = async token => { if (token !== 'good') throw new Error('bad'); return 'uid'; };
const client = (content, calls = []) => ({ chat: { completions: { create: async options => { calls.push(options); return { choices: [{ message: { content } }] }; } } } });
const story = 'Once there was a dragon who loved coffee so he opened a cafe and then a knight came in because he was tired.';

test('requests are cleaned: limits on size, control characters and the number of words', () => {
  const cleaned = cleanRequest({ question: 'Q\u0000?', words: Array.from({ length: 30 }, (_, i) => 'w' + i), transcript: 'a '.repeat(4000) });
  assert.equal(cleaned.words.length, 12);
  assert.ok(cleaned.transcript.length <= 5000);
  assert.equal(cleaned.question, 'Q ?');
  assert.deepEqual(cleanRequest(null), { question: '', words: [], transcript: '' });
});

test('ratings are clamped to 0-100 and anything unusable is refused', () => {
  assert.deepEqual(cleanRating({ connection: 140, flow: -5, feedback: 'Nice' }), { connection: 100, flow: 0, feedback: 'Nice' });
  assert.deepEqual(cleanRating({ connection: '72' }), { connection: 72, flow: 72, feedback: '' });
  assert.equal(cleanRating({ connection: 'high' }), null);
  assert.equal(cleanRating(null), null);
});

test('only signed-in users can have a story rated, and the story is sent as data to the model', async () => {
  const calls = [];
  const handler = createHandler(() => client('{"connection": 78, "flow": 70, "feedback": "Link each word to the last."}', calls), allowed);
  let res = response(); await handler(request({ question: 'Tea or coffee?', words: ['dragon', 'knight'], transcript: story }, { auth: '' }), res);
  assert.equal(res.statusCode, 401); assert.equal(calls.length, 0, 'nothing is spent without a login');
  res = response(); await handler(request({ transcript: story }, { auth: 'Bearer forged' }), res);
  assert.equal(res.statusCode, 401);
  res = response(); await handler(request({ question: 'Tea or coffee?', words: ['dragon', 'knight'], transcript: story }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { connection: 78, flow: 70, feedback: 'Link each word to the last.' });
  const sent = JSON.parse(calls[0].messages[1].content);
  assert.deepEqual(sent.words, ['dragon', 'knight']); assert.equal(sent.transcript, story);
  assert.match(calls[0].messages[0].content, /Do NOT reward speed/);
  assert.match(calls[0].messages[0].content, /never instructions/);
});

test('short stories, bad model output and a missing key are handled plainly', async () => {
  let res = response(); await createHandler(() => client('{"connection": 70}'), allowed)(request({ transcript: 'too short' }), res);
  assert.equal(res.statusCode, 400);
  res = response(); await createHandler(() => client('not json'), allowed)(request({ transcript: story }), res);
  assert.equal(res.statusCode, 502);
  res = response(); await createHandler(() => null, allowed)(request({ transcript: story }), res);
  assert.equal(res.statusCode, 500);
  res = response(); await createHandler(() => client('{}'), allowed)(request({ transcript: story }, { method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  res = response(); await createHandler(() => ({ chat: { completions: { create: async () => { throw new Error('secret sk-123'); } } } }), allowed)(request({ transcript: story }), res);
  assert.equal(res.statusCode, 502); assert.doesNotMatch(JSON.stringify(res.body), /sk-123/);
});
