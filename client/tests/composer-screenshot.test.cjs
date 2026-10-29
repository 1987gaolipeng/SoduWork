'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function setup(capture) {
  const frames = [], calls = [], events = {}, hideEvents = {};
  const hideButton = { disabled: false, addEventListener: (name, handler) => { hideEvents[name] = handler; } };
  const button = { disabled: false, addEventListener: (name, handler) => { events[name] = handler; } };
  button.parentElement = { querySelector: () => hideButton };
  const window = { addEventListener() {}, requestAnimationFrame: callback => frames.push(callback),
    petSay: message => calls.push(['notice', message]), ShortcutSettings: { capture } };
  vm.runInNewContext(read('components/panels/work-composer.js'), { window });
  window.WorkComposer.bindScreenshot(button, () => calls.push(['close']));
  return { api: window.WorkComposer, frames, calls, button, events, hideButton, hideEvents };
}
test('new and existing conversation menus offer the same screenshot action', () => {
  const { api } = setup(() => {});
  const html = api.screenshotRow('captureButton');
  assert.match(html, /class="wc-more-row" id="captureButton"/);
  assert.match(html, /截图与标注/);
  assert.match(html, /<svg/);
  assert.match(html, /data-screenshot-hide[^>]*aria-label="隐藏当前窗口后截图"/);
  const chat = read('components/panels/work-composer.js');
  const compose = read('components/panels/compose-surface.js');
  assert.match(chat, /screenshotRow\('nchatScreenshot'\)/);
  assert.match(compose, /WorkComposer\.screenshotRow\('cpScreenshot'\)/);
  assert.match(compose, /WorkComposer\.bindScreenshot\(p\.querySelector\('#cpScreenshot'\), ctx\._closeMore\)/);
});
test('screenshot closes and paints away the menu before opening the editor once', async () => {
  const launched = [];
  const subject = setup((mode, options) => { launched.push([mode, options.hideOwner]); return { ok: true }; });
  const pending = subject.events.click();
  await subject.events.click();
  assert.equal(subject.button.disabled, true);
  assert.deepEqual(subject.calls, [['close']]);
  assert.deepEqual(launched, []);
  subject.frames.shift()();
  assert.deepEqual(launched, []);
  subject.frames.shift()();
  await pending;
  assert.deepEqual(launched, [['edit', false]]);
  assert.equal(subject.button.disabled, false);
});

test('hide-window action requests one hidden capture and shares the normal action lock', async () => {
  const launched = [];
  const subject = setup((mode, options) => { launched.push([mode, options.hideOwner]); return { ok: true }; });
  const pending = subject.hideEvents.click(); await subject.events.click(); await subject.hideEvents.click();
  assert.equal(subject.button.disabled, true); assert.equal(subject.hideButton.disabled, true);
  assert.deepEqual(subject.calls, [['close']]); assert.deepEqual(launched, []);
  subject.frames.shift()(); subject.frames.shift()(); await pending;
  assert.deepEqual(launched, [['edit', true]]);
  assert.equal(subject.button.disabled, false); assert.equal(subject.hideButton.disabled, false);
});
test('a failed screenshot restores the menu entry and reports the failure', async () => {
  const subject = setup(() => { throw new Error('屏幕录制权限未开启'); });
  const pending = subject.events.click();
  subject.frames.shift()(); subject.frames.shift()();
  await pending;
  assert.equal(subject.button.disabled, false);
  assert.deepEqual(subject.calls, [['close'], ['notice', '屏幕录制权限未开启']]);
});
