'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/team/team.js'), 'utf8');

function fixture() {
  const calls = [], context = { window: {},
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    openBriefsEntry: options => calls.push(JSON.parse(JSON.stringify(options))),
  };
  vm.runInNewContext(source, context);
  return { calls, api: context.window };
}

test('old daily-report entries route to current briefs without loading the retired team view', () => {
  const { calls, api } = fixture();
  api.openDailyPanel();
  api.openTeamPanel({ entry: 'daily' });
  api.openTeamPanel({ tab: 5 });
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ period: 'daily', scope: 'mine' })));
});

test('team and inbox keep their own routes after retiring the duplicate daily report', () => {
  const { calls, api } = fixture();
  api.openTeamPanel();
  api.openInboxPanel();
  assert.deepEqual(calls, []);
});
