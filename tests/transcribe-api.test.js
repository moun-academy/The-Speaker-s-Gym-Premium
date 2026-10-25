import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, parseMultipart, cleanTranscription } from '../api/transcribe.js';

function multipart(parts, boundary = 'xBOUNDARYx') {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n${part.filename ? 'Content-Type: audio/webm\r\n' : ''}\r\n`, 'binary'));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value), 'binary'));
    chunks.push(Buffer.from('\r\n', 'binary'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'binary'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
function request({ method = 'POST', body = Buffer.alloc(0), contentType, signedIn = true } = {}) {
  const req = Readable.from([body]);
  req.method = method; req.headers = { ...(contentType ? { 'content-type': contentType } : {}), ...(signedIn ? { authorization: 'Bearer good-token' } : {}) };
  return req;
}
function response() {
  const res = { headers: {}, statusCode: 0, body: null };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.body = value; return res; };
  res.end = () => res;
  return res;
}
const allowed = async token => { if (token !== 'good-token') throw Object.assign(new Error('bad'), { status: 401 }); return 'uid-1'; };
const fakeClient = (reply, calls = []) => ({ audio: { transcriptions: { create: async options => { calls.push(options); return typeof reply === 'function' ? reply(options) : reply; } } } });

test('the transcription endpoint returns the words with timestamps for a chunk of audio', async () => {
  const calls = [];
  const handler = createHandler(() => fakeClient({ text: ' Hello there ', duration: 2.4, words: [{ word: ' Hello', start: 0.2, end: 0.6 }, { word: 'there ', start: 0.7, end: 1.1 }] }, calls), allowed);
  const { body, contentType } = multipart([{ name: 'language', value: 'en' }, { name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3, 4, 5]) }]);
  const res = response();
  await handler(request({ body, contentType }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { text: 'Hello there', words: [{ word: 'Hello', start: 0.2, end: 0.6 }, { word: 'there', start: 0.7, end: 1.1 }], dropped: 0, duration: 2.4 });
  assert.equal(calls[0].model, 'whisper-1');
  assert.equal(calls[0].language, 'en');
  assert.deepEqual(calls[0].timestamp_granularities, ['word', 'segment'], 'segments carry the confidence figures used to drop invented words');
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('target words can be passed along as a hint, cleaned and capped', async () => {
  const calls = [];
  const handler = createHandler(() => fakeClient({ text: 'x', words: [] }, calls), allowed);
  const { body, contentType } = multipart([{ name: 'prompt', value: 'meticulous, serendipity <script>alert(1)</script> ' + 'a'.repeat(500) }, { name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3]) }]);
  await handler(request({ body, contentType }), response());
  assert.match(calls[0].prompt, /^meticulous, serendipity/);
  assert.doesNotMatch(calls[0].prompt, /[<>()]/);
  assert.ok(calls[0].prompt.length <= 300);
  const none = multipart([{ name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3]) }]);
  await handler(request({ body: none.body, contentType: none.contentType }), response());
  assert.ok(!('prompt' in calls[1]), 'no hint, no prompt');
});

test('it refuses bad requests instead of spending money on them', async () => {
  const noKey = createHandler(() => null, allowed), ok = createHandler(() => fakeClient({ text: '', words: [] }), allowed);
  let res = response(); await noKey(request(), res); assert.equal(res.statusCode, 500);
  res = response(); await ok(request({ method: 'GET' }), res); assert.equal(res.statusCode, 405);
  res = response(); await ok(request({ method: 'OPTIONS' }), res); assert.equal(res.statusCode, 200);
  res = response(); await ok(request({ body: Buffer.from('{}'), contentType: 'application/json' }), res); assert.equal(res.statusCode, 400);
  let parts = multipart([{ name: 'language', value: 'en' }]);
  res = response(); await ok(request({ body: parts.body, contentType: parts.contentType }), res); assert.equal(res.statusCode, 400, 'no audio');
  parts = multipart([{ name: 'audio', filename: 'evil.exe', value: Buffer.from([1, 2, 3]) }]);
  res = response(); await ok(request({ body: parts.body, contentType: parts.contentType }), res); assert.equal(res.statusCode, 400, 'wrong file type');
  parts = multipart([{ name: 'audio', filename: 'chunk.webm', value: Buffer.alloc(2 * 1024 * 1024, 1) }]);
  res = response(); await ok(request({ body: parts.body, contentType: parts.contentType }), res); assert.equal(res.statusCode, 413, 'too large');
});

test('a failing speech service gives a plain error and never leaks details', async () => {
  const handler = createHandler(() => fakeClient(() => { throw Object.assign(new Error('secret key sk-123 invalid'), { status: 401 }); }), allowed);
  const { body, contentType } = multipart([{ name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3]) }]);
  const res = response(); await handler(request({ body, contentType }), res);
  assert.equal(res.statusCode, 401);
  assert.doesNotMatch(JSON.stringify(res.body), /sk-123|secret/);
});

test('multipart parsing keeps binary audio intact and handles quoted boundaries', () => {
  const audio = Buffer.from([0, 255, 13, 10, 45, 45, 128, 7]);
  const { body, contentType } = multipart([{ name: 'language', value: 'fr' }, { name: 'audio', filename: 'a.webm', value: audio }]);
  const parsed = parseMultipart(body, contentType.replace('boundary=xBOUNDARYx', 'boundary="xBOUNDARYx"'));
  assert.equal(parsed.fields.language, 'fr');
  assert.deepEqual([...parsed.files.audio.data], [...audio]);
  assert.throws(() => parseMultipart(body, 'multipart/form-data'), /boundary/);
});

test('only signed-in users can use it, and nothing is spent otherwise', async () => {
  const calls = [];
  const handler = createHandler(() => fakeClient({ text: 'x', words: [] }, calls), allowed);
  const { body, contentType } = multipart([{ name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3]) }]);
  let res = response(); await handler(request({ body, contentType, signedIn: false }), res);
  assert.equal(res.statusCode, 401, 'no token');
  const wrong = request({ body, contentType }); wrong.headers.authorization = 'Bearer forged';
  res = response(); await handler(wrong, res);
  assert.equal(res.statusCode, 401, 'bad token');
  assert.equal(calls.length, 0, 'the speech service was never called');
  res = response(); await handler(request({ body, contentType }), res);
  assert.equal(res.statusCode, 200, 'good token');
  const unconfigured = createHandler(() => fakeClient({ text: 'x', words: [] }), async () => { throw Object.assign(new Error('x'), { status: 500 }); });
  res = response(); await unconfigured(request({ body, contentType }), res);
  assert.equal(res.statusCode, 500, 'a missing login setup fails closed');
  assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/);
});

const wordAt = (word, start) => ({ word, start, end: start + 0.3 });

test('words the speech service invents from silence or noise are removed before they can count as speed', () => {
  // a real sentence next to a segment the service itself doubts
  const raw = { text: 'I like coffee thank you', words: [wordAt('I', 0.2), wordAt('like', 0.5), wordAt('coffee', 0.9), wordAt('thank', 4), wordAt('you', 4.3)],
    segments: [{ start: 0, end: 1.5, no_speech_prob: 0.02, avg_logprob: -0.3, compression_ratio: 1.2 }, { start: 3.8, end: 4.8, no_speech_prob: 0.9, avg_logprob: -1.6, compression_ratio: 1.1 }] };
  const cleaned = cleanTranscription(raw);
  assert.deepEqual(cleaned.words.map(w => w.word), ['I', 'like', 'coffee']);
  assert.equal(cleaned.dropped, 2);
  // looping repetition
  const loop = cleanTranscription({ text: 'a a a a a a', words: [wordAt('a', 0.1), wordAt('a', 0.5), wordAt('a', 0.9)], segments: [{ start: 0, end: 2, no_speech_prob: 0.1, avg_logprob: -0.5, compression_ratio: 3.1 }] });
  assert.equal(loop.words.length, 0); assert.equal(loop.text, '');
  // a sentence that is only a stock phantom phrase, over barely any voiced sound
  assert.equal(cleanTranscription({ text: 'Thank you.', words: [wordAt('Thank', 0.2), wordAt('you.', 0.5)], segments: [] }, { voicedMs: 600 }).words.length, 0);
  assert.equal(cleanTranscription({ text: 'Thank you.', words: [wordAt('Thank', 0.2), wordAt('you.', 0.5)], segments: [] }, { voicedMs: 2800 }).words.length, 2, 'said over real speech it is a real sentence');
  assert.equal(cleanTranscription({ text: '[Music]', words: [wordAt('[Music]', 0)], segments: [] }).words.length, 0);
  // normal speech is untouched, with or without segment data
  assert.equal(cleanTranscription({ text: 'Hello there', words: [wordAt('Hello', 0), wordAt('there', 0.4)] }).words.length, 2);
  assert.equal(cleanTranscription(null).words.length, 0);
});

test('the endpoint passes the clip\'s voiced time to the filter and reports what it dropped', async () => {
  const handler = createHandler(() => fakeClient({ text: 'Thank you.', duration: 2, words: [wordAt('Thank', 0.2), wordAt('you.', 0.5)], segments: [] }), allowed);
  const quiet = multipart([{ name: 'voicedMs', value: '500' }, { name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3]) }]);
  let res = response(); await handler(request({ body: quiet.body, contentType: quiet.contentType }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.words, []); assert.equal(res.body.dropped, 2); assert.equal(res.body.text, '');
  const loud = multipart([{ name: 'voicedMs', value: '2900' }, { name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3]) }]);
  res = response(); await handler(request({ body: loud.body, contentType: loud.contentType }), res);
  assert.equal(res.body.words.length, 2);
});
