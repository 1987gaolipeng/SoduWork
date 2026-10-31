'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function zIndex(source, selector) {
  const re = new RegExp('\\.' + selector + '\\s*\\{[^}]*z-index:\\s*(\\d+)', 's');
  const match = source.match(re);
  assert.ok(match, selector + ' must define a fixed stacking level');
  return Number(match[1]);
}

test('feedback bubbles stay above plugin and application modal overlays', () => {
  const petZ = zIndex(read('components/pet/pet.css'), 'pet-bubble');
  const deskZ = zIndex(read('desk.html'), 'desk-toast');
  const pluginZ = zIndex(read('components/panels/plugin-ui-host.css'), 'pui-layer');
  const appZ = zIndex(read('components/panels/panels-apps.css'), 'apps-modal-layer');

  assert.ok(petZ > pluginZ, 'pet bubble must remain visible above plugin dialogs');
  assert.ok(deskZ > pluginZ, 'desk toast must remain visible above plugin dialogs');
  assert.ok(petZ > appZ, 'pet bubble must remain visible above app dialogs');
  assert.ok(deskZ > appZ, 'desk toast must remain visible above app dialogs');
});
