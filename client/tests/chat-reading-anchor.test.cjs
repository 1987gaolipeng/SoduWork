'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-message-renderer.js'), 'utf8');

function fixture() {
  const frames = [], state = { follow: false, interaction: 0 };
  const scroll = { isConnected: true, scrollTop: 500, scrollHeight: 3000, clientHeight: 600,
    __soduworkScrollFollow: state, getBoundingClientRect() { return { top: 0 }; } };
  const node = { getAttribute() { return 'msg:1'; }, getBoundingClientRect() { return { top: 100, bottom: 200, height: 100 }; } };
  const list = { children: [node], querySelector() { return node; } };
  const el = { querySelector(id) { return id === '#nchatScroll' ? scroll : list; } };
  const ctx = { _ref: 'chat-a', _viewEpoch: 1, _draftScopeEpoch: 1, _mount() { return el; } };
  const sandbox = { window: null, requestAnimationFrame(callback) { frames.push(callback); },
    ChatContextMeter: { create() { return {}; } },
    ChatMarkdown: { create() { return { reset() {} }; } } };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-scroll-follow.js'), 'utf8'), sandbox);
  // Expose the production helper only in this isolated VM, without mirroring its logic.
  vm.runInNewContext(source.replace('return { reset, _messageFooter', 'return { _captureReadingAnchor, _restoreReadingAnchor, reset, _messageFooter'), sandbox);
  const renderer = sandbox.ChatMessageRenderer.create(ctx);
  renderer._restoreReadingAnchor(scroll, list, { key: 'msg:1', top: 500, delta: 0 });
  return { ctx, el, scroll, list, state, renderer, flush() { frames.forEach(callback => callback()); } };
}

test('queued reading anchor corrects layout drift while browsing remains current', () => {
  const f = fixture(); f.flush(); assert.equal(f.scroll.scrollTop, 600);
});
for (const [name, change] of [
  ['wheel interaction', f => { f.state.interaction++; f.scroll.scrollTop = 450; }],
  ['latest button', f => { f.state.follow = true; f.scroll.scrollTop = 2400; }],
  ['scroll without an interaction event', f => { f.scroll.scrollTop = 450; }],
  ['conversation switch', f => { f.ctx._ref = 'chat-b'; }],
  ['view replacement', f => { f.ctx._viewEpoch++; }],
  ['draft owner replacement', f => { f.ctx._draftScopeEpoch++; }],
  ['scroll container replacement', f => { f.el.querySelector = () => ({}); }],
  ['renderer reset', f => { f.renderer.reset(); }],
]) {
  test('queued reading anchor yields to ' + name, () => {
    const f = fixture(); change(f); const top = f.scroll.scrollTop; f.flush(); assert.equal(f.scroll.scrollTop, top);
  });
}

test('two layout patches before paint share the original reading anchor', () => {
  const f = fixture();
  const second = f.renderer._captureReadingAnchor(f.scroll, f.list);
  assert.equal(second.delta, 0, 'do not adopt the already-shifted message as the reading baseline');
  f.renderer._restoreReadingAnchor(f.scroll, f.list, second);
  f.flush(); assert.equal(f.scroll.scrollTop, 600, 'correct the accumulated layout drift once');
});

test('a subsequent render without a replacement anchor preserves the queued correction', () => {
  const f = fixture(); f.renderer._render(); f.flush(); assert.equal(f.scroll.scrollTop, 600);
});
