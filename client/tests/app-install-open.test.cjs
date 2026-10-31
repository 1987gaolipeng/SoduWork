'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-capabilities.js'), 'utf8');
function trial(lineEnding) {
  const text = source.replace(/\r?\n/g, lineEnding).replace(/\r\n/g, '\n');
  const start = text.indexOf('tryPlugin: async function (item) {') + 'tryPlugin: '.length;
  const end = text.indexOf('\n      },\n    };', start) + '\n      }'.length;
  assert.ok(start >= 'tryPlugin: '.length && end > start, 'production app opener must be present');
  const calls = [];
  const host = { openContribution: async (page, context) => { calls.push({ page, context }); } };
  const open = vm.runInNewContext('(' + text.slice(start, end) + ')', {
    window: { PluginUIHost: host }, PluginUIHost: host, closeModal() {},
  });
  return { calls, open };
}
for (const lineEnding of ['\n', '\r\n']) {
for (const type of ['package', 'external']) test(JSON.stringify(lineEnding) + ': installation opens the declared ' + type + ' application entry', async () => {
  const { calls, open } = trial(lineEnding);
  const page = { id: 'main', slot: 'workspace.navigation', source: { type, openMode: 'workspace' } };
  const item = { pluginId: 'local:example', template: 'app', ui: { contributions: [page] } };
  await open(item);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].page, page);
  assert.equal(calls[0].context.item, item);
  assert.equal(calls[0].context.detached, true);
});
test(JSON.stringify(lineEnding) + ': installation never chooses an external browser link, unsupported source or non-navigation contribution', async () => {
  const { calls, open } = trial(lineEnding);
  const pages = [
    { slot: 'workspace.navigation', source: { type: 'external', openMode: 'external' } },
    { slot: 'workspace.navigation', source: { type: 'unknown' } },
    { slot: 'task.detail.tab', source: { type: 'package' } },
  ];
  await assert.rejects(open({ pluginId: 'local:example', template: 'app', ui: { contributions: pages } }), /即用页面暂时不可用/);
  assert.equal(calls.length, 0);
});
}
