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
