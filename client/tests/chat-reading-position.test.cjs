'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { limitSnapshot } = require('../main/pi-session/snapshot-window');

function setup() {
  let total = 220, start = 60;
  const scroll = { scrollTop: 250, scrollHeight: 4000, clientHeight: 600,
    __soduworkScrollFollow: { follow: false, interaction: 0 },
    getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
    querySelectorAll: () => Array.from({ length: 160 }, (_, index) => ({
      dataset: { chatNode: 'message:' + index },
      getBoundingClientRect: () => ({ top: 100 + index * 20 - scroll.scrollTop, bottom: 120 + index * 20 - scroll.scrollTop }),
    })),
  };
  const ctx = { _ref: 'chat-ref', _viewEpoch: 1, _draftScopeEpoch: 0, _messageWindowSize: 160,
    _snap: { history: { messageStart: start, totalMessages: total } },
    _mount: () => ({ querySelector: () => scroll }),
    _render: () => { start = ctx._snap.history.messageStart; },
  };
  const requests = [];
  let waitForSnapshot = null;
  let project = value => value;
  ctx._api = () => ({ snapshot: async (ref, options) => {
    requests.push({ ref, ...options });
    if (waitForSnapshot) await waitForSnapshot;
    return { ok: true, snapshot: project(limitSnapshot({ messages: Array.from({ length: total }, (_, index) => ({ text: 'message-' + index })) }, options)) };
  } });
  const global = { window: null, requestAnimationFrame: fn => fn() }; global.window = global;
  const file = path.join(__dirname, '../components/panels/chat-reading-position.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), global);
  const reading = global.ChatReadingPosition.create(ctx);
  return { ctx, scroll, requests, reading, global,
    reopen: extra => { total += extra || 0; ctx._messageWindowSize = 80;
      ctx._snap = limitSnapshot({ messages: Array.from({ length: total }, (_, index) => ({ text: 'message-' + index })) });
      start = ctx._snap.history.messageStart; scroll.scrollTop = 0; },
    pause: value => { waitForSnapshot = value; },
    project: value => { project = value; },
    visibleMessage: () => start + Math.floor(scroll.scrollTop / 20),
  };
}

test('reopening expanded history requests the saved window before restoring the visible message', async () => {
  const view = setup(), saved = view.reading.capture();
  const visible = view.visibleMessage();
  view.reopen(20);
  await view.reading.restore(saved, () => true);
  assert.equal(view.requests[0].messageLimit, 180);
  assert.equal(view.visibleMessage(), visible);
  assert.equal(view.scroll.scrollTop, 250);
  assert.equal(view.scroll.__soduworkScrollFollow.follow, false);
});

test('same-chat refresh during history loading restores the anchor and retains the newest live tail', async () => {
  const view = setup(), saved = view.reading.capture(); view.reopen();
  let finish; view.pause(new Promise(resolve => { finish = resolve; }));
  const pending = view.reading.restore(saved);
  view.ctx._snap = { ...view.ctx._snap, status: 'streaming', messages: view.ctx._snap.messages.slice() };
  view.ctx._snap.messages[79] = { text: 'newest live text' };
  view.project(snapshot => ({ ...snapshot, status: 'streaming',
    messages: snapshot.messages.slice(0, -1).concat({ text: 'newest live text' }) }));
  finish();
  assert.equal(await pending, true);
  assert.equal(view.visibleMessage(), saved.anchor.index);
  assert.equal(view.ctx._snap.messages.at(-1).text, 'newest live text');
  assert.equal(view.ctx._snap.status, 'streaming');
  assert.equal(view.ctx._snap.history.messageStart, 60);
  assert.equal(view.ctx._snap.messages.length, 160);
  assert.equal(view.requests.length, 2);
});

test('reading anchors use runtime projection indices across hidden internal messages', async () => {
  const view = setup(), acc = require('../main/pi-session/event-stream').create();
  for (let i = 0; i < 220; i++) acc.push({ type: 'message_end', message: {
    role: 'user', content: [{ type: 'text', text: 'message-' + i }],
  } });
  acc.state.auditHidden = Array.from({ length: 20 }, (_, i) => i + 80);
  const projection = acc.uiSnapshot({ messageLimit: 160 });
  view.ctx._snap = projection; view.scroll.scrollTop = 550;
  const saved = view.reading.capture();
  assert.equal(saved.messageLimit, 160);
  assert.equal(saved.anchor.index, 107);
  view.reopen(); view.project(() => projection);
  assert.equal(await view.reading.restore(saved), true);
  assert.equal(view.scroll.scrollTop, 550);
});

test('restoration corrects virtualized layout after the anchor enters the viewport', async () => {
  const view = setup(), saved = view.reading.capture(); view.reopen();
  const frames = []; view.global.requestAnimationFrame = fn => frames.push(fn);
  const pending = view.reading.restore(saved); await new Promise(resolve => setImmediate(resolve));
  assert.ok(frames.length);
  frames.shift()();
  if (frames.length) frames.shift()();
  // Content-visibility replaces estimated off-screen heights after scrolling.
  const nodes = view.scroll.querySelectorAll;
  view.scroll.querySelectorAll = () => nodes().map(node => ({ ...node, getBoundingClientRect: () => {
    const bounds = node.getBoundingClientRect(); return { top: bounds.top + 80, bottom: bounds.bottom + 80 };
  } }));
  for (let i = 0; frames.length && i < 30; i++) frames.shift()();
  assert.equal(await pending, true);
  assert.equal(view.scroll.scrollTop, 330);
});

test('reading restoration uses the current scroll helper pause policy', async () => {
  const view = setup(), saved = view.reading.capture(); view.reopen();
  let paused = false;
  view.scroll.__soduworkScrollFollow.pause = () => { paused = true; view.scroll.__soduworkScrollFollow.follow = false; };
  assert.equal(await view.reading.restore(saved), true);
  assert.equal(paused, true);
});

test('a late history response cannot restore into a different conversation', async () => {
  const view = setup(), saved = view.reading.capture();
  view.reopen();
  let finish; view.pause(new Promise(resolve => { finish = resolve; }));
  const pending = view.reading.restore(saved, () => true);
  view.ctx._ref = 'new-ref'; view.ctx._viewEpoch++;
  finish();
  assert.equal(await pending, false);
  assert.equal(view.scroll.scrollTop, 0);
  assert.equal(view.ctx._snap.history.messageStart, 140);
});

test('user scrolling while history is loading takes precedence over the old reading snapshot', async () => {
  const view = setup(), saved = view.reading.capture();
  view.reopen();
  let finish; view.pause(new Promise(resolve => { finish = resolve; }));
  const pending = view.reading.restore(saved, () => true);
  view.scroll.__soduworkScrollFollow.interaction++;
  view.scroll.scrollTop = 400;
  finish();
  assert.equal(await pending, false);
  assert.equal(view.scroll.scrollTop, 400);
});
