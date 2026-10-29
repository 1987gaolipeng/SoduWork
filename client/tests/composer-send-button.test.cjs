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

test('stop and queue-send retain their meaning across text and attachment changes', () => {
  const classes = new Set();
  const send = { disabled: false, attrs: {}, classList: {
    toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
  }, setAttribute(name, value) { this.attrs[name] = value; } };
  const input = { value: '' };
  const root = { querySelector: id => id === '#nchatSend' ? send : input };
  let files = [];
  const attachments = { names: () => files };
  const paint = (busy, expected) => {
    window.ChatTools.paintSendButton(root, busy, attachments);
    assert.equal(send.title, expected);
    assert.equal(send.attrs['aria-label'], expected);
    assert.equal(classes.has('stop'), expected === '停止生成');
    assert.equal(send.disabled, false, 'stop must remain actionable');
  };
  paint(false, '发送');
  paint(true, '停止生成');
  assert.match(send.innerHTML, /<rect/);
  input.value = '继续处理';
  paint(true, '排队发送');
  assert.doesNotMatch(send.innerHTML, /<rect/);
  input.value = '   '; files = ['screenshot.png'];
  paint(true, '排队发送');
  files = [];
  paint(true, '停止生成');
  paint(false, '发送');
  window.ChatTools.paintSendButton(null, true, null);
});

test('all work composers share compact circular geometry, including task conversations', () => {
  const css = read('components/panels/work-composer.css');
  assert.match(css, /\.work-composer \.wc-send\{width:30px;height:30px;padding:0;border-radius:50%/);
  assert.match(css, /\.work-composer \.wc-send\.stop svg\{fill:currentColor;stroke:none;transform:none\}/);
  assert.match(css, /\.work-composer \.wc-send:focus-visible\{outline:2px/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\s*\.work-composer \.wc-send,/);
  assert.doesNotMatch(read('components/panels/panels-desk-session.css'),
    /(?:\.dks-compose \.dks-send\.nsend|\.dks-send)\{[^}]*(?:width|height|border-radius|!important)/);
});

test('streaming snapshots retain the send/stop SVG until the action changes', () => {
  let paints = 0;
  const send = {classList:{toggle(){}},setAttribute(){},set innerHTML(_value){paints++;}};
  const root = {querySelector:id=>id==='#nchatSend'?send:{value:''}};
  for(let i=0;i<100;i++) window.ChatTools.paintSendButton(root,true,null);
  assert.equal(paints,1);
  window.ChatTools.paintSendButton(root,false,null); assert.equal(paints,2);
});
