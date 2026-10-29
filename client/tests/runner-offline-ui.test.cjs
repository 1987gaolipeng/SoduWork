'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(status, result = {}) {
  const values = new Map();
  const window = { soduWorkAPI: { runnerStatus: async () => status }, dispatchEvent() {} };
  const context = { window, URL, AbortController, setTimeout, clearTimeout,
    CustomEvent: class {}, console,
    localStorage: { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(result) }) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../api.js'), 'utf8'), context);
  return window.SoduWorkAPI;
}

test('all three empty surfaces report the actual local Runner error', async () => {
  const reason = '本机 Runner 已启动，但后台尚未确认上线，正在自动重连。';
  const api = fixture({ running: true, connected: false, error: reason });
  assert.equal((await api.listAIAgents()).reason, reason);
  assert.equal((await api.agentSetup()).env.why, reason);
  assert.equal((await api.runners()).localRunnerReason, reason);
});

test('ready Runner preserves authoritative model and permission errors', async () => {
  const api = fixture({ running: true, connected: true, error: '' }, { agents: [], reason: '尚未配置可用模型' });
  assert.equal((await api.listAIAgents()).reason, '尚未配置可用模型');
});
