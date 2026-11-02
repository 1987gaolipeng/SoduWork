'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, patchSource } = require('../scripts/patch-pi-retry-schedule.cjs');

test('Pi 1.4 retry schedule respects SDK caps and fallback without mutating unsupported layouts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-retry-14-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'core'));
  const settingsFile = path.join(dir, 'core/settings-manager.js');
  const agentFile = path.join(dir, 'core/agent-session.js');
  fs.writeFileSync(settingsFile, 'return {\n            baseDelayMs: this.settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,\n};');
  fs.writeFileSync(agentFile, '        const delayMs = retryDelayMs(settings, this._retryAttempt);\nreturn delayMs;');
  assert.equal(patchSource(settingsFile).patched, true);
  assert.equal(patchSource(agentFile).patched, true);
  const settingsText = fs.readFileSync(settingsFile, 'utf8');
  const agentText = fs.readFileSync(agentFile, 'utf8');
  assert.equal(patchSource(settingsFile).already, true);
  assert.equal(patchSource(agentFile).already, true);
  assert.equal(fs.readFileSync(agentFile, 'utf8'), agentText);
  const readSettings = new Function('SETTINGS_DEFAULTS', settingsText);
  const settings = readSettings.call({ settings: { retry: { delayScheduleMs: [10.9, -1, NaN, 5000] } } },
    { retry: { baseDelayMs: 1000 } });
  assert.deepEqual(settings.delayScheduleMs, [10, 5000]);
  assert.equal(settings.baseDelayMs, 1000);
  let fallbackCalls = 0;
  const retry = new Function('settings', 'retryDelayMs', agentText);
  const fallback = (_settings, attempt) => { fallbackCalls++; return attempt * 100; };
  settings.maxAgentDelayMs = 2000;
  assert.equal(retry.call({ _retryAttempt: 1 }, settings, fallback), 10);
  assert.equal(retry.call({ _retryAttempt: 2 }, settings, fallback), 2000);
  assert.equal(fallbackCalls, 0);
  assert.equal(retry.call({ _retryAttempt: 3 }, settings, fallback), 300);
  assert.equal(fallbackCalls, 1);
  for (const file of [settingsFile, agentFile]) {
    fs.writeFileSync(file, 'unsupported layout');
    assert.equal(patchSource(file).ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'unsupported layout');
  }
});

test('Pi retry schedule patch is idempotent and preserves exponential fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-retry-'));
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  const settingsFile = path.join(dir, 'core', 'settings-manager.js');
  const agentFile = path.join(dir, 'core', 'agent-session.js');
  fs.writeFileSync(settingsFile, [
    '    getRetrySettings() {',
    '        return {',
    '            enabled: this.getRetryEnabled(),',
    '            maxRetries: this.settings.retry?.maxRetries ?? 3,',
    '            baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,',
    '        };',
    '    }',
  ].join('\n'));
  fs.writeFileSync(agentFile, [
    '        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);',
  ].join('\n'));
  const firstSettings = patchSource(settingsFile);
  const secondSettings = patchSource(settingsFile);
  const firstAgent = patchSource(agentFile);
  const secondAgent = patchSource(agentFile);
  const settingsSource = fs.readFileSync(settingsFile, 'utf8');
  const agentSource = fs.readFileSync(agentFile, 'utf8');
  assert.equal(firstSettings.patched, true);
  assert.equal(secondSettings.already, true);
  assert.equal(firstAgent.patched, true);
  assert.equal(secondAgent.already, true);
  assert.equal(settingsSource.includes(MARKER), true);
  assert.match(settingsSource, /delayScheduleMs:/);
  assert.equal(agentSource.includes(MARKER), true);
  assert.match(agentSource, /Number\.isFinite\(scheduledDelay\)/);
  assert.match(agentSource, /settings\.baseDelayMs \* 2 \*\* \(this\._retryAttempt - 1\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});
