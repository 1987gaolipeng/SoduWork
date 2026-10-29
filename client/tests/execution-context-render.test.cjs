'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(
  __dirname, '..', 'components', 'panels', 'task-trace-execution-details.js'), 'utf8');

test('task detail renders the persisted execution location in the existing route row', () => {
  assert.match(source, /item\.executionContext/);
  assert.match(source, /location\.label/);
  assert.match(source, /tfd-route-reason/);
});
