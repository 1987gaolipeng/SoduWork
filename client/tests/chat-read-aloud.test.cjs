'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../components/panels/chat-read-aloud-core.js');
const marked = require('../vendor/markdown/marked.umd.js');

test('speech text follows Markdown structure and excludes code, HTML and image URLs', () => {
  const text = core.plainText('# Hello\n\nRead **this** [guide](https://example.test).\n\n```js\nsecretCode();\n```\n\n![image](https://private.test/a.png)\n\n<script>bad()</script>\n\n- First\n- Second', marked.lexer, 'Table');
  assert.match(text, /Hello/); assert.match(text, /Read this guide/);
  assert.match(text, /First\nSecond/); assert.doesNotMatch(text, /https|secretCode|bad\(\)|script|private/);
});
test('small tables read row content and large tables get a short notice', () => {
  assert.match(core.plainText('|A|B|\n|-|-|\n|1|2|', marked.lexer, 'Table'), /A, B\n1, 2/);
  assert.equal(core.plainText('|A|B|C|D|E|\n|-|-|-|-|-|\n|1|2|3|4|5|', marked.lexer, 'Table'), 'Table');
});

test('short sentences, decimals and abbreviations stay in one natural speech segment', () => {
  const text = 'Dr. Smith uses version 1.13.6. It costs 3.5 dollars. 中文短句。接着朗读。';
  assert.deepEqual(core.chunks(text), [text]);
  assert.deepEqual(core.chunks('First paragraph.\n\nSecond paragraph.'), ['First paragraph.', 'Second paragraph.']);
  const words = ('natural phrasing ' + 'word '.repeat(80)).trim();
  const parts = core.chunks(words);
  assert(parts.every(part => part.length <= 180));
  assert.equal(parts.join(' '), words);
});
test('content language and explicit default distinguish four languages', () => {
  assert.equal(core.language('中文回复', 'en-US'), 'zh-CN');
  assert.equal(core.language('中文回复', 'ja-JP'), 'zh-CN');
  assert.equal(core.language('This is English.', 'zh-CN'), 'en-US');
  assert.equal(core.language('日本語です。', 'zh-CN'), 'ja-JP');
  assert.equal(core.language('한국어입니다.', 'en-US'), 'ko-KR');
  assert.equal(core.language('123', 'ja-JP'), 'ja-JP');
  assert(core.chunks('文'.repeat(500)).every(part => part.length <= 180));
});
function setup() {
  const spoken = [], states = [], timers = new Map(); let nextTimer = 0;
  const synth = { speak: u => spoken.push(u), cancel() {}, pause() {}, resume() {} };
  const player = core.create({ synth, Utterance: function (text) { this.text = text; },
    changed: value => states.push(value), timer: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clear: id => timers.delete(id) });
  return { player, spoken, states, synth, timers };
}
const voice = { localService: true, lang: 'en-US' };
test('pause, resume, sequential completion and cancellation reject late events', () => {
  const f = setup(); f.player.start('First.\n\nSecond.', voice, 1.25);
  const first = f.spoken[0]; first.onstart(); assert.equal(f.player.state(), 'playing');
  f.player.toggle(); assert.equal(f.player.state(), 'paused');
  f.player.toggle(); assert.equal(f.player.state(), 'playing');
  first.onend(); assert.equal(f.spoken.length, 2); assert.equal(f.spoken[1].rate, 1.25);
  f.player.stop(); f.spoken[1].onend(); first.onerror();
  assert.equal(f.player.state(), 'idle'); assert.equal(f.spoken.length, 2);
});
test('remote voices, start timeouts and engine errors do not silently succeed', () => {
  const f = setup(); f.player.start('Hello', { ...voice, localService: false }, 1);
  assert.equal(f.spoken.length, 0); assert.equal(f.player.state(), 'error');
  f.player.start('Hello', voice, 1); [...f.timers.values()][0]();
  assert.equal(f.player.state(), 'error');
  f.player.start('Hello', voice, 1); f.spoken.at(-1).onerror();
  assert.equal(f.player.state(), 'error');
});
test('new playback invalidates old completion callbacks', () => {
  const f = setup(); f.player.start('Old. More.', voice, 1); const old = f.spoken[0];
  f.player.start('New.', voice, 1); old.onend(); old.onstart();
  assert.equal(f.spoken.length, 2); assert.equal(f.spoken[1].text, 'New.');
});

test('rate changes keep the current segment and latest native word boundary', () => {
  const f = setup(); f.player.start('First.\n\nSecond sentence.\n\nLast.', voice, 1);
  f.spoken[0].onend();
  const old = f.spoken[1]; old.onstart(); old.onboundary({ charIndex: 7 });
  f.player.setRate(1.5);
  assert.equal(f.spoken[2].text, 'Last.', 'The original next segment was prefetched');
  assert.equal(f.spoken[3].text, 'sentence.'); assert.equal(f.spoken[3].rate, 1.5);
  old.onend(); old.onerror(); f.spoken[2].onstart(); f.spoken[2].onend();
  assert.equal(f.spoken.length, 4, 'Canceled prefetched callbacks cannot advance playback');
  f.spoken[3].onend(); assert.equal(f.spoken[4].text, 'Last.');
  assert.equal(f.spoken[4].rate, 1.5);
});

test('rate changes preserve pause and compose offsets across repeated changes', () => {
  const f = setup(); f.player.start('One two three four.', voice, 1);
  f.spoken[0].onstart(); f.spoken[0].onboundary({ charIndex: 4 });
  f.player.toggle(); f.player.setRate(1.25); f.player.setRate(1.5);
  assert.equal(f.player.state(), 'paused'); assert.equal(f.spoken.length, 1);
  f.player.toggle(); assert.equal(f.spoken[1].text, 'two three four.');
  f.spoken[1].onstart(); f.spoken[1].onboundary({ charIndex: 4 });
  f.player.setRate(0.75); assert.equal(f.spoken[2].text, 'three four.');
  assert.equal(f.spoken[2].rate, 0.75);
});

test('engines without boundary events apply the rate at the next segment without replay', () => {
  const f = setup(); f.player.start('First.\n\nNext.', voice, 1);
  f.spoken[0].onstart(); f.player.setRate(1.5);
  assert.equal(f.spoken.length, 1);
  f.spoken[0].onend(); assert.equal(f.spoken[1].text, 'Next.');
  assert.equal(f.spoken[1].rate, 1.5);
});

test('prefetch queues one segment and hands over without duplicate speak or loading state', () => {
  const f = setup(); f.player.start('One.\n\nTwo.\n\nThree.', voice, 1);
  assert.equal(f.spoken.length, 1);
  f.spoken[0].onstart(); f.spoken[0].onboundary({ charIndex: 0 });
  assert.equal(f.spoken.length, 2);
  f.spoken[0].onboundary({ charIndex: 1 }); assert.equal(f.spoken.length, 2);
  f.spoken[0].onend(); assert.equal(f.spoken.length, 2);
  assert.equal(f.player.state(), 'playing');
  f.spoken[1].onstart(); f.spoken[1].onboundary({ charIndex: 0 });
  assert.equal(f.spoken.length, 3);
  f.spoken[1].onend(); f.spoken[2].onstart(); f.spoken[2].onend();
  assert.equal(f.player.state(), 'idle');
});

test('stop drops prefetched callbacks, and failed prefetch retries at the normal handover', () => {
  const f = setup(); f.player.start('One.\n\nTwo.', voice, 1);
  f.spoken[0].onstart(); f.spoken[0].onboundary({ charIndex: 0 });
  f.spoken[1].onerror();
  assert.equal(f.player.state(), 'playing');
  f.spoken[0].onend(); assert.equal(f.spoken[2].text, 'Two.');
  f.player.stop(); f.spoken[2].onend(); f.spoken[1].onstart();
  assert.equal(f.spoken.length, 3); assert.equal(f.player.state(), 'idle');
});

test('main-process arbitration stops other windows and rejects untrusted callers', () => {
  const path = require('node:path'), { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..');
  const url = pathToFileURL(path.join(root, 'desk.html')).href;
  const frame = { url }, sent = [], handlers = {};
  const sender = { id: 1, mainFrame: frame, getURL: () => url, isDestroyed: () => false };
  const owner = { webContents: sender, isDestroyed: () => false };
  const other = { webContents: { id: 2, send: channel => sent.push(channel) }, isDestroyed: () => false };
  require('../main/read-aloud.cjs').install({ app: { getAppPath: () => root },
    ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
    BrowserWindow: { fromWebContents: wc => wc === sender ? owner : null, getAllWindows: () => [owner, other] } });
  const claim = handlers['read-aloud-claim'];
  assert.equal(claim({ sender, senderFrame: frame }), true);
  assert.deepEqual(sent, ['read-aloud-stop']);
  assert.throws(() => claim({ sender, senderFrame: { url } }), /trusted/);
  assert.throws(() => claim({ sender: {}, senderFrame: frame }), /trusted/);
});
