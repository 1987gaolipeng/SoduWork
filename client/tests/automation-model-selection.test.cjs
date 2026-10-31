'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modelConfig = require('../main/pi-session/model-config');

test('the local model catalog still resolves explicit model selections', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  modelConfig.writeModels(path.join(root, 'pi-agent'), {
    id: 'soduwork-prd-large', label: 'GLM5.3Flash', baseUrl: 'https://example.invalid',
    key: 'ticket', input: ['text'], contextWindow: 128000,
  });
  assert.equal(modelConfig.configuredModel(app), 'soduwork-prd-large');
});

test('automation opening does not copy the ordinary composer model implicitly', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');
  assert.doesNotMatch(source, /automationContext[\s\S]{0,300}configuredModel\(app\)/,
    'automation must receive its model from the schedule envelope');
});

test('a missing or malformed local model profile leaves the server default path intact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-automation-model-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  assert.equal(modelConfig.configuredModel(app), '');
  fs.mkdirSync(path.join(root, 'pi-agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pi-agent', 'models.json'), '{');
  assert.equal(modelConfig.configuredModel(app), '');
});
