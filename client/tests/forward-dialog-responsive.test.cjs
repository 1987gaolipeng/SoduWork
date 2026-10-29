'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const detail = fs.readFileSync(path.join(root, 'components', 'requirements', 'requirement-assignment.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'components', 'panels', 'panels-forward-plugin.css'), 'utf8');

test('dispatch dialog keeps its footer reachable on short screens', () => {
  assert.match(detail, /class="fwd-scroll"/);
  const requirementCss = fs.readFileSync(path.join(root, 'components/requirements/requirements-board.css'), 'utf8');
  assert.match(requirementCss, /\.rq-assignment-backdrop \.fwd-pop\{[^}]*display:flex/);
  assert.match(css, /\.fwd-pop\{[^}]*max-height:min\(740px,calc\(100dvh - 32px\)\)[^}]*flex-direction:column[^}]*overflow:hidden/);
  assert.match(css, /\.fwd-scroll\{[^}]*min-height:0[^}]*flex:1 1 auto[^}]*overflow:hidden/);
  assert.match(detail, /class="frw-main"/);
  assert.match(detail, /class="fwd-settings"/);
  assert.ok(detail.indexOf('id="fwdNote"') < detail.indexOf('class="fwd-settings"'));
  assert.ok(detail.indexOf('id="fwdList"') > detail.indexOf('class="fwd-settings"'));
  assert.doesNotMatch(detail, /核对安排|fwd-decision-copy/);
  assert.match(css, /\.fwd-actions\{[^}]*flex:0 0 auto/);
  assert.match(css, /@media\(max-width:680px\)\{\.fwd-pop\{[^}]*max-height:calc\(100dvh - 16px\)/);
});

test('retrying dispatch always refreshes options and presents a structured coworker picker', () => {
  const options = fs.readFileSync(path.join(root, 'components', 'panels', 'panels-forward-picker.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(root, 'components', 'panels', 'panels-forward-options.js'), 'utf8');

  assert.match(detail, /_fwdSwitch\(task\.id, tab \|\| 'ai', \{fresh: true\}\)/);
  assert.match(options, /function _fwdNormalizeMates\(raw\)/);
  assert.match(options, /function _fwdRenderMatePanel\(box, tid\)/);
  assert.match(options, /data-fwd-mate-filter/);
  assert.match(options, /_fwdLoadSeq/);
  assert.match(css, /\.fwd-mate-toolbar/);
  assert.match(css, /\.fwd-mate-group/);

  const context = { window: {addEventListener() {}} };
  vm.runInNewContext(options, context);
  const rows = context._fwdNormalizeMates([
    { id: ' u-2 ', name: 'Bob', org: 'Engineering', hasBox: false, deviceCount: 1 },
    { id: 'u-1', name: 'Alice', org: 'Engineering', hasBox: true, devices: [{}, {}] },
    { id: 'u-2', name: 'Bob', org: 'Engineering', hasBox: false, deviceCount: 2 },
    { id: 'u-3', name: 'Carol', org: 'Sales', hasBox: true, canReceive: false },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(row => [
    row.id, row.name, row.org, row.hasBox, row.deviceCount,
  ]))), [
    ['u-1', 'Alice', 'Engineering', true, 2],
    ['u-2', 'Bob', 'Engineering', false, 2],
    ['u-3', 'Carol', 'Sales', false, 0],
  ]);
});
