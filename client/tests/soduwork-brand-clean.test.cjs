'use strict';

const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { scan, LEGACY } = require('../../tools/brand-keyword-gate.cjs');
const personal = require('../main/personal-plugins');
const { archivePath } = require('../main/plugin-package-name.cjs');

function apiFixture() {
  const values = new Map([
    ['soduwork_work_user_id', 'existing-device'],
    ['soduwork_work_hub_url', 'http://127.0.0.1:7777'],
    ['soduwork_work_cfg_v5', '{"theme":"dark"}'],
    ['soduwork_work_root', 'C:/existing-work'],
  ]);
  const bridge = {
    personalPlugins: {
      get: async (pluginId) => ({ pluginId, version: '1.0.0' }),
      preflight: async (body) => ({ ok: true, body }),
    },
  };
  const window = { soduWorkAPI: bridge };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), {
    window,
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    console: { log() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    URL,
    fetch: () => { throw Error('No network in branding tests'); },
  });
  return { window, values, bridge };
}

test('the repository passes the zero-retired-brand gate', () => {
  const result = scan();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.scanned.hits, 0);
});

test('the scanner detects a generated retired token', () => {
  const token = ['s', 'o', 'd', 'o'].join('');
  assert.equal(LEGACY.test(`const marker = '${token}';`), true);
  assert.equal(LEGACY.test(`client/${token}-example.js`), true);
  assert.equal(LEGACY.test('SoduWork soduWorkAPI SODUWORK_HOME .soduwork-plugin'), false);
});

test('the canonical renderer API uses one bridge and preserves current storage', async () => {
  const { window, values, bridge } = apiFixture();
  assert.equal(window.SoduWorkAPI, window.SoduWorkAPI);
  assert.equal(window.soduWorkAPI, bridge);
  assert.deepEqual(await window.SoduWorkAPI.personalPlugin('local:existing'), {
    pluginId: 'local:existing', version: '1.0.0',
  });
  assert.match(window.SoduWorkAPI.taskStorageKey('tasks'), /^soduwork_work_tasks_v5@.*@existing-device@unbound$/);
  assert.equal(window.SoduWorkAPI.hubBase(), 'http://127.0.0.1:18989');
  assert.equal(values.get('soduwork_work_cfg_v5'), '{"theme":"dark"}');
});

test('installed web plugins receive only the canonical restricted bridge', async () => {
  const exposed = {};
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/work-preview-app-preload.cjs'), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
        ipcRenderer: {
          invoke: async (channel, payload) => { calls.push({ channel, payload }); return { ok: true }; },
          on() {}, removeListener() {},
        },
      };
    },
  });
  assert.deepEqual(Object.keys(exposed), ['soduWorkAppBridge']);
  assert.equal(Object.isFrozen(exposed.soduWorkAppBridge), true);
  await exposed.soduWorkAppBridge.conversation.open({ text: 'web plugin' });
  assert.equal(calls[0].channel, 'work-preview-app-request');
  assert.equal(calls[0].payload.method, 'conversation.open');
});

test('archive names use the current SoduWork suffix', () => {
  for (const [input, expected] of [
    ['report', 'report.soduwork-plugin'],
    ['report.json', 'report.soduwork-plugin'],
    ['report.soduwork-plugin.json', 'report.soduwork-plugin'],
    ['archive.zip', 'archive.zip'],
    ['archive.zip.json', 'archive.zip'],
  ]) assert.equal(archivePath(input), expected, input);
});

test('export uses the current package name and never overwrites an existing file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-export-name-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const plugin = personal.create(app, {
    template: 'method', key: 'report', name: '报告', version: '1.0.0',
    description: '离线文件名回归', instructions: '生成报告。',
  }).plugin;
  const before = fs.readdirSync(root).sort();
  const result = await personal.exportToFile(app, {
    showSaveDialog: async (options) => {
      assert.equal(path.basename(options.defaultPath), 'report-1.0.0.soduwork-plugin');
      return { canceled: true };
    },
  }, plugin.pluginId);
  assert.equal(result.canceled, true);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  const occupied = path.join(root, 'report.soduwork-plugin');
  fs.writeFileSync(occupied, 'previous export');
  await assert.rejects(personal.exportToFile(app, {
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'report.json') }),
  }, plugin.pluginId), /已存在/);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'previous export');
});
