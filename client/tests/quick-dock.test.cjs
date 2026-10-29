'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('quick dock keeps four daily entries; confirmations live inside tasks', () => {
  const dock = read('components', 'pet', 'pet-dock.js');
  const items = dock.slice(dock.indexOf('const items = ['), dock.indexOf("dock.innerHTML ="));
  const order = ['workspace', 'schedules', 'requirements', 'notices'];
  const positions = order.map((act) => items.indexOf('data-act="' + act + '"'));

  assert.ok(positions.every((position) => position >= 0), 'every daily entry should exist');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.doesNotMatch(items, /data-act="(?:newtask|aidesk|skin|approvals)"/);
});

test('quick dock icons share an optical system and accessible names', () => {
  const dock = read('components', 'pet', 'pet-dock.js');
  const css = read('components', 'pet', 'pet.css');

  for (const label of ['对话', '自动化', '需求池', '通知']) {
    assert.match(dock, new RegExp('aria-label="' + label + '"'));
  }
  assert.match(dock, /openDeskWindow\(\{ panel: 'workspace', view: 'create' \}\)/);
  assert.match(css, /\.edge-dock \.ed-view svg\{[\s\S]*?width:18px;height:18px;[\s\S]*?stroke-width:1\.75;/);
  assert.match(css, /vector-effect:non-scaling-stroke/);
});
