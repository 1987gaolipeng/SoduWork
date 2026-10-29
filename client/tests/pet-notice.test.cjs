'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('pet unread badge reuses the notice store without rebuilding the dock', () => {
  const html = read('index.html');
  const dock = read('components', 'pet', 'pet-dock.js');
  assert.match(html, /id="petUnreadBadge"[^>]*hidden/);
  assert.match(dock, /function paintPetUnread\(\)/);
  assert.match(dock, /typeof noticeUnread === 'function'/);
  assert.match(dock, /setNoticeCount/);
  const paint = dock.slice(dock.indexOf('function paintDock()'));
  assert.ok(paint.indexOf('paintPetUnread()') < paint.indexOf('dock.dataset.sig === sig'));
});

test('pet double click opens notifications and a click reads only one notice', () => {
  const pet = read('components', 'pet', 'pet-ui.js');
  const store = read('core', 'store.js');
  const notice = read('components', 'panels', 'panels-desk.js');
  const dbl = pet.slice(pet.indexOf('function _onPetDblClick'), pet.indexOf('function updatePet'));
  assert.match(dbl, /openNoticeEntry/);
  assert.doesNotMatch(dbl, /openAdd\(/);
  assert.match(store, /function markNoticeRead\(ref\)/);
  assert.match(notice, /markNoticeRead\(row\.getAttribute\('data-nnotice'\)\)/);
  const open = notice.slice(notice.indexOf('function openNoticePanel'), notice.indexOf('function closeNoticePanel'));
  assert.doesNotMatch(open, /markNoticesRead\(/);
});
