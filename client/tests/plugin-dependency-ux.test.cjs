'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('plugin detail personal prompt renders without an MCP dependency', () => {
  const sandbox = {window: {}};
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'components/panels/plugin-dependency-ux.js'),
    'utf8',
  );
  vm.runInNewContext(source, sandbox);
  const dependencies = sandbox.window.SoduWorkPluginDependencies;
  const escape = value => String(value);

  assert.doesNotThrow(() => dependencies.quickUse(
    {personal: true, name: 'local plugin'},
    {taskOnly: false, runtimeBlocked: false, missingMcp: []},
    escape,
  ));
  assert.match(dependencies.quickUse(
    {personal: true, name: 'connected plugin'},
    {taskOnly: false, runtimeBlocked: false, missingMcp: ['knowledge-base']},
    escape,
  ), /knowledge-base/);
});
