'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('live reasoning opens, respects manual collapse, closes on completion and can be reopened', () => {
  const previousWindow = global.window;
  global.window = {};
  try {
    for (const helper of ['chat-context-meter', 'chat-scroll-follow', 'chat-markdown']) {
      delete require.cache[require.resolve('../components/panels/' + helper + '.js')];
      require('../components/panels/' + helper + '.js');
    }
    delete require.cache[require.resolve('../components/panels/chat-acceptance-results.js')];
    require('../components/panels/chat-acceptance-results.js');
    delete require.cache[require.resolve('../components/panels/chat-message-renderer.js')];
    require('../components/panels/chat-message-renderer.js');
    const ctx = {
      _openThink: new Set(),
      _closedThink: new Set(),
      _snap: { status: 'streaming', messages: [{ role: 'assistant', done: false, blocks: [{ kind:'thinking', done:false }] }] },
      _openTool: new Set(),
      _openToolGroup: new Set(),
      _liveTextKey: '',
      esc: value => String(value == null ? '' : value),
    };
    const renderer = global.window.ChatMessageRenderer.create(ctx);
    const live = renderer._blockHtml(0, {
      kind: 'thinking', index: 0, text: 'partial reasoning', done: false,
    }, 0);
    assert.match(live, /class="nthink open is-live"/);
    assert.match(live, /aria-expanded="true"/);
    ctx._closedThink.add("0:0");
    assert.match(renderer._blockHtml(0, {kind:"thinking",index:0,text:"partial",done:false}, 0), /class="nthink is-live"/);
    ctx._closedThink.clear();

    ctx._openThink.add('0:0');
    const opened = renderer._blockHtml(0, {
      kind: 'thinking', index: 0, text: 'partial reasoning', done: false,
    }, 0);
    assert.match(opened, /class="nthink open is-live"/);
    assert.match(opened, /aria-expanded="true"/);

    ctx._snap = { status: 'idle' };
    const settled = renderer._blockHtml(0, {
      kind: 'thinking', index: 0, text: 'complete reasoning', done: true,
    }, 0);
    assert.match(settled, /class="nthink"/);
    assert.match(settled, /aria-expanded="false"/);
    ctx._openThink.add("0:0");
    assert.match(renderer._blockHtml(0, {kind:"thinking",index:0,text:"complete",done:true},0), /class="nthink open"/);
  } finally {
    global.window = previousWindow;
  }
});

test('conversation copy controls use the compact copy/check icon', () => {
  const previousWindow = global.window;
  global.window = {};
  try {
    for (const helper of ['chat-context-meter', 'chat-scroll-follow', 'chat-markdown']) {
      delete require.cache[require.resolve('../components/panels/' + helper + '.js')];
      require('../components/panels/' + helper + '.js');
    }
    delete require.cache[require.resolve('../components/panels/chat-acceptance-results.js')];
    require('../components/panels/chat-acceptance-results.js');
    delete require.cache[require.resolve('../components/panels/chat-message-renderer.js')];
    require('../components/panels/chat-message-renderer.js');
    const ctx = {
      _openThink: new Set(),
      _snap: { status: 'idle' },
      _openTool: new Set(),
      _openToolGroup: new Set(),
      _liveTextKey: '',
      esc: value => String(value == null ? '' : value),
      rich: value => '<span class="nmd">' + String(value) + '</span>',
    };
    const renderer = global.window.ChatMessageRenderer.create(ctx);
    const html = renderer._messageFooter({ role: 'assistant', done: true }, 'answer');
    assert.match(html, /class="ntext-copy"/);
    assert.match(html, /ncopy-default/);
    assert.match(html, /ncopy-check/);
    assert.equal(renderer._tokenText(12034), '12,034');
  } finally {
    global.window = previousWindow;
  }
});

test('answer actions belong only to the final completed reply of each user turn', () => {
  const previousWindow = global.window;
  global.window = {};
  try {
    for (const helper of ['chat-context-meter', 'chat-scroll-follow', 'chat-markdown']) {
      delete require.cache[require.resolve('../components/panels/' + helper + '.js')];
      require('../components/panels/' + helper + '.js');
    }
    delete require.cache[require.resolve('../components/panels/chat-acceptance-results.js')];
    require('../components/panels/chat-acceptance-results.js');
    delete require.cache[require.resolve('../components/panels/chat-message-renderer.js')];
    require('../components/panels/chat-message-renderer.js');
    const renderer = global.window.ChatMessageRenderer.create({});
    const select = (messages, tools = [], settled = true) => [...renderer._finalReplyIndexes(messages, tools, settled)];
    const user = { role: 'user', text: 'Request' };
    const answer = (text, extra = {}) => ({ role: 'assistant', done: true, blocks: [{ kind: 'text', text }], ...extra });
    const messages = [user, answer('I will inspect it'), answer('Here is the result'), user, answer('Working on the next request')];
    assert.deepEqual(select(messages, [{ id: 'read', after: 1, state: 'done' }], false), [2]);
    assert.deepEqual(select(messages, [], true), [2, 4]);
    assert.deepEqual(select([user, answer('Still working')], [{ after: 1, state: 'done' }]), []);
    assert.deepEqual(select([user, answer('Result'), { role: 'assistant', done: true, blocks: [], usage: { output: 4 } }]), [1]);
    assert.deepEqual(select([user, answer('Plan'), { role: 'assistant', done: true, blocks: [{ kind: 'thinking', text: 'More work' }] }]), []);
    for (const stopReason of ['toolUse', 'error', 'aborted', 'length', 'max_tokens']) {
      assert.deepEqual(select([user, answer('Partial response', { stopReason }), user]), []);
    }
    assert.deepEqual(select([user, answer('Incomplete', { done: false }), user]), []);
    assert.deepEqual(select([user, answer('Interrupted', { errorMessage: 'Unavailable' }), user]), []);
    assert.deepEqual(select([user, answer('Plan'), { role: 'assistant', done: false, blocks: [] }, user]), []);
    assert.deepEqual(select([user, answer('Plan'), { role: 'assistant', done: true, blocks: [], stopReason: 'error' }, user]), []);
    const merged = answer('unused', { stopReason: 'stop', blocks: [
      { kind: 'text', text: 'Before the tool' }, { kind: 'toolcall', toolCall: { id: 'read' } },
      { kind: 'thinking', text: 'Reviewing' }, { kind: 'text', text: 'Final result' },
    ] });
    assert.deepEqual(select([user, merged], [{ id: 'read', after: 1, state: 'done' }]), [1]);
    assert.deepEqual(select([user, merged], [{ id: 'read', after: 1, state: 'running' }]), []);
    assert.deepEqual(select([user, merged], [{ id: 'other', after: 1, state: 'done' }]), []);
    assert.deepEqual(select([user, merged], [{ id: 'read', after: 2, state: 'done' }]), []);
  } finally { global.window = previousWindow; }
});
