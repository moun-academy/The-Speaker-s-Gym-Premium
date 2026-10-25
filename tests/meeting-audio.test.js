import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../meeting-audio.js', import.meta.url), 'utf8');

function fixture() {
  class Track extends EventTarget {
    constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.enabled = true; }
    stop() { this.readyState = 'ended'; }
    end() { this.stop(); this.dispatchEvent(new Event('ended')); }
    clone() { return new Track(this.kind); }
    getSettings() { return { displaySurface: 'browser' }; }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  }
  const contexts = [], store = new Map(), captures = [], microphones = [], options = [];
  class Context {
    constructor() { this.state = 'running'; this.destination = {}; this.outputs = []; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(buffer) { buffer.fill(0.05); } }; }
    createMediaStreamDestination() { return { stream: new Stream([new Track('audio')]) }; }
    createMediaStreamSource() { return { connect: output => this.outputs.push(output), disconnect() {} }; }
  }
  const mediaDevices = {
    async getDisplayMedia(value) {
      options.push(value);
      const stream = new Stream([new Track('video'), new Track('audio')]); captures.push(stream); return stream;
    },
    async getUserMedia() { const stream = new Stream([new Track('audio')]); microphones.push(stream); return stream; }
  };
  const window = new EventTarget(); window.AudioContext = Context;
  const sandbox = {
    window, navigator: { mediaDevices }, MediaStream: Stream, Event, CustomEvent,
    Audio: class { play() { return Promise.resolve(); } }, Date, performance, Float32Array,
    localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, Blob, FormData, AbortController
  };
  const exports = vm.runInNewContext(source.replaceAll('export ', '') + '\n;({MeetingAudio, ChunkTranscriber})', sandbox);
  return { ...exports, mediaDevices, Track, Stream, captures, microphones, contexts, options, sandbox };
}

function panelFixture(f) {
  f.sandbox.document = { createElement: () => ({}), head: { append() {} } };
  const panel = { dataset: {}, innerHTML: '', handlers: {}, querySelector: () => null,
    addEventListener(name, fn) { this.handlers[name] = fn; }, removeEventListener(name) { delete this.handlers[name]; } };
  const click = (act, checked = false) => panel.handlers.click({ target: { checked, closest: () => ({ dataset: { ma: act } }) } });
  const unmount = f.MeetingAudio.mountPanel(panel);
  return { panel, click, unmount };
}

test('one meeting panel connects directly, selects the shared source and switches back to the microphone', async () => {
  const f = fixture(), { panel, click, unmount } = panelFixture(f);
  assert.match(panel.innerHTML, /Using microphone/);
  assert.match(panel.innerHTML, /data-ma="connect"[^>]*>Connect meeting audio/);
  assert.doesNotMatch(panel.innerHTML, /data-ma="enable"|>Use meeting audio</);
  assert.match(panel.innerHTML, /data-ma="host"/, 'host microphone choice is available before connecting');
  await click('host', true);
  await click('connect');
  assert.equal(f.options.length, 1, 'one click opens one capture chooser');
  assert.equal(f.MeetingAudio.enabled(), true);
  assert.equal(f.MeetingAudio.isConnected(), true);
  assert.equal(f.microphones.length, 1);
  assert.match(panel.innerHTML, /data-ma="disconnect"/);
  await click('disable');
  assert.equal(f.MeetingAudio.enabled(), false);
  assert.equal(f.MeetingAudio.isConnected(), false);
  assert.ok([...f.captures[0].getTracks(), ...f.microphones[0].getTracks()].every(t => t.readyState === 'ended'));
  assert.match(panel.innerHTML, /Using microphone/);
  unmount();
});

test('cancelling a first connection leaves the microphone selected and allows retry', async () => {
  const f = fixture(), { panel, click, unmount } = panelFixture(f);
  const capture = f.mediaDevices.getDisplayMedia;
  f.mediaDevices.getDisplayMedia = async () => { throw Object.assign(new Error('cancel'), { name: 'NotAllowedError' }); };
  await click('connect');
  assert.equal(f.MeetingAudio.enabled(), false);
  assert.equal(f.MeetingAudio.isConnected(), false);
  assert.match(panel.innerHTML, /Sharing was cancelled/);
  f.mediaDevices.getDisplayMedia = capture;
  await click('connect');
  assert.equal(f.MeetingAudio.isConnected(), true);
  assert.doesNotMatch(panel.innerHTML, /Sharing was cancelled/);
  f.MeetingAudio.disconnect(); unmount();
});

test('settings contains a single meeting control without the old switch or duplicate introduction modal', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/id="meetingAudioPanel"/g) || []).length, 1);
  assert.doesNotMatch(html, /callAudioToggle|callAudioInfoModal|Capture Audio from Video Calls|<h3>📞 Video Call Audio/);
  assert.match(html, /meetingaudio:enabled/);
});

test('meeting capture retains the browser stop control and releases all game copies on disconnect', async () => {
  const f = fixture(); await f.MeetingAudio.connect();
  const first = f.MeetingAudio.clone(), second = f.MeetingAudio.clone();
  assert.equal(f.MeetingAudio.enabled(), true);
  assert.equal(f.captures[0].getVideoTracks()[0].readyState, 'live');
  assert.equal(f.captures[0].getVideoTracks()[0].enabled, false);
  first.getTracks().forEach(t => t.stop());
  assert.equal(f.MeetingAudio.isConnected(), true, 'ending one round must leave the class connected');
  assert.equal(f.options[0].audio.suppressLocalAudioPlayback, false, 'coach must still hear the call');
  f.MeetingAudio.disconnect();
  assert.equal(f.MeetingAudio.isConnected(), false);
  assert.ok([...f.captures[0].getTracks(), ...second.getTracks()].every(t => t.readyState === 'ended'));
  assert.ok(f.contexts.every(c => c.state === 'closed'));
});

test('the browser Stop sharing action disconnects the class and its active round', async () => {
  const f = fixture(); await f.MeetingAudio.connect();
  const copy = f.MeetingAudio.clone(); let stopped = false;
  f.MeetingAudio.onChange(status => { if (!status.connected) stopped = true; });
  f.captures[0].getVideoTracks()[0].end();
  assert.equal(stopped, true);
  assert.ok(copy.getTracks().every(t => t.readyState === 'ended'));
});

test('a cancelled reconnect preserves the working meeting connection', async () => {
  const f = fixture(); const original = await f.MeetingAudio.connect();
  f.mediaDevices.getDisplayMedia = async () => { throw Object.assign(new Error('cancel'), { name: 'NotAllowedError' }); };
  await assert.rejects(() => f.MeetingAudio.connect());
  assert.equal(f.MeetingAudio.status().sourceId, original.sourceId);
  assert.equal(f.MeetingAudio.isConnected(), true);
});

test('choosing a source without audio releases the capture instead of leaving a share running', async () => {
  const f = fixture(); const capture = new f.Stream([new f.Track('video')]);
  f.mediaDevices.getDisplayMedia = async () => capture;
  await assert.rejects(() => f.MeetingAudio.connect(), { name: 'NoCallAudio' });
  assert.equal(capture.getTracks()[0].readyState, 'ended');
  assert.equal(f.MeetingAudio.isConnected(), false);
});

test('disconnecting while the chooser is open discards the eventual stream', async () => {
  const f = fixture(); let resolveCapture;
  f.mediaDevices.getDisplayMedia = () => new Promise(resolve => { resolveCapture = resolve; });
  const pending = f.MeetingAudio.connect(); f.MeetingAudio.disconnect();
  const capture = new f.Stream([new f.Track('video'), new f.Track('audio')]); resolveCapture(capture);
  await assert.rejects(() => pending, { name: 'AbortError' });
  assert.ok(capture.getTracks().every(t => t.readyState === 'ended'));
  assert.equal(f.MeetingAudio.isConnected(), false);
});

test('the coach can join the game through a mixed microphone without replaying meeting audio', async () => {
  const f = fixture(); f.MeetingAudio.setIncludeHost(true);
  await f.MeetingAudio.connect();
  assert.equal(f.MeetingAudio.status().includeHost, true);
  assert.equal(f.microphones.length, 1);
  const mixer = f.contexts[0];
  assert.equal(mixer.outputs.length, 2);
  assert.ok(mixer.outputs.every(output => output !== mixer.destination), 'never send captured speech to speakers');
  f.MeetingAudio.disconnect();
  assert.ok(f.microphones[0].getTracks().every(t => t.readyState === 'ended'));
});

test('microphone denial keeps remote participants connected with a clear recovery message', async () => {
  const f = fixture(); f.MeetingAudio.setIncludeHost(true);
  f.mediaDevices.getUserMedia = async () => { throw new Error('denied'); };
  await f.MeetingAudio.connect();
  assert.equal(f.MeetingAudio.isConnected(), true);
  assert.equal(f.MeetingAudio.status().includeHost, false);
  assert.match(f.MeetingAudio.status().hostError, /Students are connected/);
});

function recorderFixture(f) {
  f.sandbox.MediaRecorder = class {
    state = 'inactive'; mimeType = 'audio/webm';
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
        this.onstop?.();
      }, 40);
    }
  };
}

test('finishing waits for the final recorder data before completing the transcript', async () => {
  const f = fixture(); recorderFixture(f);
  const results = [];
  f.sandbox.fetch = async () => ({ ok: true, json: async () => ({ text: 'last words', words: [{ word: 'last', start: 0, end: 0.1 }] }) });
  const transcriber = new f.ChunkTranscriber(new f.Stream([new f.Track('audio')]), { getToken: async () => 'test', onResult: r => results.push(r) });
  transcriber.start(); transcriber.chunk.voiced = 10;
  await transcriber.stop(1000);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'last words');
  assert.equal(transcriber.pending, 0);
  assert.ok(f.contexts.every(c => c.state === 'closed'));
});

test('leaving a game cancels transcription and prevents late updates to the next screen', async () => {
  const f = fixture(); recorderFixture(f);
  let resolveRequest, aborts = 0, callbacks = 0;
  f.sandbox.fetch = (_url, options) => new Promise(resolve => {
    resolveRequest = resolve;
    options.signal.addEventListener('abort', () => { aborts++; });
  });
  const transcriber = new f.ChunkTranscriber(new f.Stream([new f.Track('audio')]), { getToken: async () => 'test', onResult: () => callbacks++, onFail: () => callbacks++ });
  transcriber.start(); transcriber.chunk.voiced = 10;
  transcriber.chunk.endedAt = performance.now(); transcriber.chunk.parts = [new Blob(['audio'])];
  const request = transcriber.finish(transcriber.chunk, 'audio/webm');
  await new Promise(resolve => setTimeout(resolve, 0));
  await transcriber.stop(0);
  assert.equal(aborts, 1);
  resolveRequest({ ok: true, json: async () => ({ text: 'late response', words: [] }) });
  await request;
  assert.equal(callbacks, 0);
});

test('a clip that fails once is retried, and an expired sign-in is refreshed before giving up', async () => {
  const f = fixture(); recorderFixture(f);
  const tokens = [], statuses = [401, 200];
  f.sandbox.fetch = async () => { const status = statuses.shift() ?? 200; return status === 200 ? { ok: true, json: async () => ({ text: 'hello there', words: [{ word: 'hello', start: 0, end: 0.2 }] }) } : { ok: false, status }; };
  const results = [], fails = [];
  const transcriber = new f.ChunkTranscriber(new f.Stream([new f.Track('audio')]), { getToken: async force => { tokens.push(Boolean(force)); return force ? 'fresh' : 'stale'; }, onResult: r => results.push(r), onFail: x => fails.push(x) });
  transcriber.start(); transcriber.chunk.voiced = 10;
  await transcriber.stop(1500);
  assert.deepEqual(tokens, [false, true], 'the second try asked for a freshly refreshed token');
  assert.equal(results.length, 1); assert.equal(fails.length, 0);

  const g = fixture(); recorderFixture(g);
  let calls = 0;
  g.sandbox.fetch = async () => { calls++; if (calls === 1) throw new Error('network blip'); return { ok: true, json: async () => ({ text: 'ok', words: [{ word: 'ok', start: 0, end: 0.1 }] }) }; };
  const blips = [], failed = [];
  const second = new g.ChunkTranscriber(new g.Stream([new g.Track('audio')]), { getToken: async () => 'test', onResult: r => blips.push(r), onFail: x => failed.push(x) });
  second.start(); second.chunk.voiced = 10;
  await second.stop(2000);
  assert.equal(calls, 2); assert.equal(blips.length, 1); assert.equal(failed.length, 0, 'one blip is not reported as a failure');

  const h = fixture(); recorderFixture(h);
  let refused = 0;
  h.sandbox.fetch = async () => { refused++; return { ok: false, status: 404 }; };
  const gone = [];
  const third = new h.ChunkTranscriber(new h.Stream([new h.Track('audio')]), { getToken: async () => 'test', onFail: x => gone.push(x) });
  third.start(); third.chunk.voiced = 10;
  await third.stop(1500);
  assert.equal(refused, 1, 'a missing endpoint is not retried'); assert.equal(gone[0].status, 404);
});

test('overlapping clips: each recorder runs past the next one\'s start, and every one is stopped and counted', async () => {
  const f = fixture(); recorderFixture(f);
  const results = [];
  f.sandbox.fetch = async (_url, options) => ({ ok: true, json: async () => ({ text: 'words', words: [{ word: 'words', start: 0, end: 0.1 }], sent: options.body.get('voicedMs') }) });
  const transcriber = new f.ChunkTranscriber(new f.Stream([new f.Track('audio')]), { chunkMs: 60, overlapMs: 50, getToken: async () => 'test', onResult: r => results.push(r) });
  transcriber.start();
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.ok(transcriber.active.size >= 2, 'two recorders run together during an overlap');
  for (const chunk of transcriber.active) chunk.voiced = 10;
  await transcriber.stop(1000);
  assert.equal(transcriber.active.size, 0);
  assert.equal(transcriber.pending, 0);
});
