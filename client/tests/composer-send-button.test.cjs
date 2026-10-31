'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const window = { addEventListener() {} };
vm.runInNewContext(read('components/panels/work-composer.js'), { window });
vm.runInNewContext(read('components/panels/panels-chat-tools.js'), { window });

test('shared send button is labelled and cannot accidentally submit an enclosing form', () => {
  for (const sendClass of ['cp-go', 'nsend', 'dks-send nsend']) {
    const html = window.WorkComposer.html({ inputId: 'input', sendId: 'send', sendClass });
    assert.match(html, /<button type="button" class="wc-send /);
    assert.match(html, /aria-label="发送"/);
  }
});

test('running chats keep one primary action and turn it into stop even with a draft', () => {
  const classes = new Set();
  const send = { disabled: false, attrs: {}, title: '', innerHTML: '', classList: {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
  }, setAttribute(name, value) { this.attrs[name] = value; } };
  const input = { value: '' };
  const root = { dataset: {}, querySelector: id => id === '#nchatSend' ? send :
    input };
  const attachments = { names: () => [] };
  const paint = (busy, expected, stopState = 'idle') => {
    window.ChatTools.paintSendButton(root, busy, attachments, stopState);
    assert.equal(send.title, expected);
    assert.equal(send.attrs['aria-label'], expected);
    assert.equal(classes.has('stop'), expected === '\u505c\u6b62\u751f\u6210');
  };
  paint(false, '\u53d1\u9001');
  paint(true, '\u505c\u6b62\u751f\u6210');
  assert.match(send.innerHTML, /<rect/);
  input.value = '\u7ee7\u7eed\u5904\u7406';
  paint(true, '\u505c\u6b62\u751f\u6210');
  assert.match(send.innerHTML, /<rect/);
  paint(false, '\u53d1\u9001');
  assert.doesNotMatch(send.innerHTML, /<rect/);
  window.ChatTools.paintSendButton(null, true, null);
});

test('stop states stay on the same single primary button', () => {
  const classes = new Set();
  const send = { disabled: false, attrs: {}, title: '', innerHTML: '', classList: {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
  }, setAttribute(name, value) { this.attrs[name] = value; } };
  const root = { dataset: {}, querySelector: id => id === '#nchatSend' ? send :
    { value: '' } };
  window.ChatTools.paintSendButton(root, false, null, 'idle', undefined, 'sending');
  assert.equal(send.disabled, true);
  assert.equal(send.title, '\u53d1\u9001\u4e2d\u2026');
  assert.equal(send.attrs['aria-label'], '\u53d1\u9001\u4e2d\u2026');
  assert.equal(send.attrs['aria-busy'], 'true');
  assert.ok(classes.has('stop-pending'));
  assert.match(send.innerHTML, /spinner/);

  window.ChatTools.paintSendButton(root, true, null, 'requested');
  assert.equal(send.disabled, true);
  assert.equal(send.title, '\u505c\u6b62\u4e2d\u2026');
  assert.equal(send.attrs['aria-label'], '\u505c\u6b62\u4e2d\u2026');
  assert.equal(send.attrs['aria-busy'], 'true');
  assert.ok(classes.has('stop-pending'));
  assert.match(send.innerHTML, /spinner|circle/i);

  window.ChatTools.paintSendButton(root, true, null, 'timeout');
  assert.equal(send.disabled, false);
  assert.equal(send.title, '\u505c\u6b62\u751f\u6210');
  assert.equal(send.attrs['aria-label'], '\u505c\u6b62\u751f\u6210');
  assert.equal(send.attrs['aria-busy'], 'false');
  assert.ok(classes.has('stop'));
  assert.equal(classes.has('stop-retry'), false);
  assert.match(send.innerHTML, /<rect/);

  window.ChatTools.paintSendButton(root, false, null, 'timeout');
  assert.equal(send.title, '\u53d1\u9001');
  assert.equal(classes.has('stop'), false);
  assert.equal(classes.has('stop-retry'), false);
  assert.match(send.innerHTML, /<path/);
});

test('chat composer markup has no second stop button', () => {
  const source = read('components/panels/chat-composer-bindings.js');
  assert.doesNotMatch(source, /id="nchatStop"/);
  assert.match(source, /id="nchatSend"/);
});

test('all work composers share compact circular geometry, including task conversations', () => {
  const css = read('components/panels/work-composer.css');
  assert.match(css, /\.work-composer \.wc-send\{width:30px;height:30px;padding:0;border-radius:50%/);
  assert.match(css, /\.work-composer \.wc-send\.stop svg\{fill:currentColor;stroke:none;transform:none\}/);
  assert.match(css, /\.work-composer \.wc-send:focus-visible\{outline:2px/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\s*\.work-composer \.wc-send,/);
  assert.match(css, /\.work-composer \.wc-send\.stop-pending/);
  assert.doesNotMatch(read('components/panels/panels-desk-session.css'),
    /(?:\.dks-compose \.dks-send\.nsend|\.dks-send)\{[^}]*(?:width|height|border-radius|!important)/);
});

test('streaming snapshots retain the send/stop SVG until the action changes', () => {
  let paints = 0;
  const send = {classList:{toggle(){}},setAttribute(){},set innerHTML(_value){paints++;}};
  const root = {dataset:{},querySelector:id=>id==='#nchatSend'?send:{value:''}};
  for(let i=0;i<100;i++) window.ChatTools.paintSendButton(root,true,null);
  assert.equal(paints,1);
  window.ChatTools.paintSendButton(root,false,null); assert.equal(paints,2);
});
