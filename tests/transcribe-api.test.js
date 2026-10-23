import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, parseMultipart } from '../api/transcribe.js';

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
function request({ method = 'POST', body = Buffer.alloc(0), contentType } = {}) {
  const req = Readable.from([body]);
  req.method = method; req.headers = contentType ? { 'content-type': contentType } : {};
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
const fakeClient = (reply, calls = []) => ({ audio: { transcriptions: { create: async options => { calls.push(options); return typeof reply === 'function' ? reply(options) : reply; } } } });

test('the transcription endpoint returns the words with timestamps for a chunk of audio', async () => {
  const calls = [];
  const handler = createHandler(() => fakeClient({ text: ' Hello there ', duration: 2.4, words: [{ word: ' Hello', start: 0.2, end: 0.6 }, { word: 'there ', start: 0.7, end: 1.1 }] }, calls));
  const { body, contentType } = multipart([{ name: 'language', value: 'en' }, { name: 'audio', filename: 'chunk.webm', value: Buffer.from([1, 2, 3, 4, 5]) }]);
  const res = response();
  await handler(request({ body, contentType }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { text: 'Hello there', words: [{ word: 'Hello', start: 0.2, end: 0.6 }, { word: 'there', start: 0.7, end: 1.1 }], duration: 2.4 });
  assert.equal(calls[0].model, 'whisper-1');
  assert.equal(calls[0].language, 'en');
  assert.deepEqual(calls[0].timestamp_granularities, ['word']);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});

test('target words can be passed along as a hint, cleaned and capped', async () => {
  const calls = [];
  const handler = createHandler(() => fakeClient({ text: 'x', words: [] }, calls));
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
  const noKey = createHandler(() => null), ok = createHandler(() => fakeClient({ text: '', words: [] }));
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
  const handler = createHandler(() => fakeClient(() => { throw Object.assign(new Error('secret key sk-123 invalid'), { status: 401 }); }));
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
