'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

function loadDetails() {
  const context = { window: null };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../components/panels/task-trace-execution-details.js'), 'utf8'), context);
  return context.TaskTraceExecutionDetails;
}

function helpers(duration) {
  return {
    esc: (value) => String(value == null ? '' : value),
    tone: () => 'run',
    stateText: (value) => String(value || ''),
    dateText: (value) => String(value || ''),
    duration,
    errorText: () => '',
    live: new Set(['running']),
    eventText: {},
  };
}

test('running AI session markup stays stable between background refreshes', () => {
  const details = loadDetails();
  let durationCalls = 0;
  const h = helpers(() => { durationCalls += 1; return '变化中的耗时'; });
  const session = {
    status: 'running', startedAt: '2026-08-15T10:00:00Z',
    identity: { agentName: 'Pi', agentSessionId: 'session-1' }, items: [],
  };

  const first = details.sessionHtml(session, h);
  const second = details.sessionHtml(session, h);

  assert.equal(first, second);
  assert.equal(durationCalls, 0);
  assert.match(first, /进行中/);
});

test('finished AI session renders one fixed measured duration', () => {
  const details = loadDetails();
  let durationCalls = 0;
  const h = helpers((start, end) => {
    durationCalls += 1;
    assert.ok(Number.isFinite(start));
    assert.ok(Number.isFinite(end));
    return '4 秒';
  });
  const html = details.sessionHtml({
    status: 'done', startedAt: '2026-08-15T10:00:00Z', finishedAt: '2026-08-15T10:00:04Z',
    identity: { agentName: 'Pi', agentSessionId: 'session-1' }, items: [],
  }, h);

  assert.equal(durationCalls, 1);
  assert.match(html, /4 秒/);
});

test('structured failure explains recovery without duplicating a raw error card', () => {
  const details = loadDetails();
  const html = details.failureHtml({
    error: 'Runner 暂时离线',
    diagnosis: {
      kind: 'infrastructure', title: '执行通道暂不可用', detail: 'Runner 暂时离线',
      action: '确认 Runner 恢复后，重试本关。', retryable: true,
    },
  }, { esc: (value) => String(value || ''), errorText: (value) => String(value || '') });

  assert.match(html, /执行通道暂不可用/);
  assert.match(html, /修复后可重试/);
  assert.doesNotMatch(html, /tfd-error/);
});

test('selected failed stage is sent to the generic gate retry endpoint', () => {
  const trace = fs.readFileSync(path.join(__dirname,
    '../components/panels/task-trace-view.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
  assert.match(trace, /retryTaskPluginGate\([\s\S]*runId, retryNode\.key \|\| '', null, \{/);
  // Retry accepts an optional agentKind override while preserving the minimal body without one.
  assert.match(api, /if \(nodeKey\) body\.nodeKey = nodeKey;/);
  assert.match(api, /if \(execution && \(execution\.agentKind \|\| execution\.model\)\) body\.execution = execution;/);
  assert.match(api, /if \(options && options\.resumeRework\) body\.resumeRework = true;/);
  assert.match(trace, /actionKey[^\n]+resume-rework/);
});
