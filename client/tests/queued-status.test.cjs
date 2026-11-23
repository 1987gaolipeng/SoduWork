'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
const status = require('../components/panels/panels-chat-status');
const workspace = require('../components/panels/chat-workspace-info');

test('queued snapshots preserve reported status before stale thinking and tool activity', () => {
  const snapshot = {
    status: 'queued', statusText: '排队中',
    messages: [{ role: 'user' }, { role: 'assistant', blocks: [{ kind: 'thinking', text: 'old thought' }] }],
    tools: [{ name: 'bash', state: 'running', args: { command: 'npm test' } }],
    execution: { running: false, longRunning: true, stalled: true, quality: { phase: 'implementing' } },
  };
  for (const pending of ['', 'new request']) {
    assert.equal(status.work(snapshot, pending), '排队中');
    assert.equal(workspace.status(snapshot, pending), '排队中');
  }
  snapshot.statusText = '等待执行设备连接';
  assert.equal(status.work(snapshot), snapshot.statusText);
  assert.equal(workspace.status(snapshot), snapshot.statusText);
  delete snapshot.statusText;
  assert.equal(status.work(snapshot), '排队中');
  assert.equal(workspace.status(snapshot), '排队中');
});

test('metrics follow queue, running and cancellation transitions', () => {
  const current = { snap: { status: 'queued', statusText: '排队中', execution: { running: false } } };
  const view = status.createThinking(() => current);
  assert.equal(status.runtimeBusy(current.snap), true, 'queued work remains cancellable');
  assert.match(view.metricsHtml(true), /data-thinking-label>排队中</);
  current.snap.status = 'streaming';
  current.snap.execution.running = true;
  assert.match(view.metricsHtml(true), /data-thinking-label>处理中</);
  assert.equal(status.work(current.snap), '正在理解你的要求…');
  current.snap.status = 'idle';
  current.snap.execution.running = false;
  assert.equal(status.runtimeBusy(current.snap), false);
  assert.match(view.metricsHtml(false), /data-thinking-label>已处理</);
});

test('reported queue diagnostics and positions survive optimistic input without claiming execution', () => {
  const current = {pending:'new request',snap:{status:'queued',statusText:'排队中',
    messages:[{role:'assistant',blocks:[{kind:'thinking',text:'old thought'}]}],
    execution:{queuePosition:2,running:false,stalled:true,elapsedMs:808000,queueWaitMs:808000}}};
  const view = status.createThinking(() => current);
  assert.equal(status.work(current.snap,current.pending),'排队中 · 第 2 项');
  assert.equal(status.runtimeBusy(current.snap,current.pending),true);
  assert.match(view.metricsHtml(true),/排队中.*13m 28s/);
  assert.doesNotMatch(view.metricsHtml(true),/处理中|tokens/);
  assert.doesNotMatch(view.statusHtml(true),/思考|理解|团队协作/);
  current.snap.statusText='等待执行设备连接';
  assert.equal(status.work(current.snap,current.pending),'等待执行设备连接');
  assert.equal(workspace.status(current.snap,current.pending),'等待执行设备连接');
  current.snap.statusText='排队中 · 第 2 项';
  assert.equal(status.work(current.snap,current.pending),current.snap.statusText);
  assert.equal(workspace.status(current.snap,current.pending),current.snap.statusText);
});

test('a stale stalled flag cannot schedule copy rotations over queue or startup diagnostics', () => {
  const originalInterval=global.setInterval,originalClear=global.clearInterval;
  const timers=new Set();
  global.setInterval=callback=>{timers.add(callback);return callback;};
  global.clearInterval=timer=>timers.delete(timer);
  const current={snap:{status:'queued',execution:{stalled:true}}};
  const view=status.createThinking(()=>current);
  try {
    view.syncSlowStatusTicker(true);
    assert.equal(timers.size,0);
    current.snap={status:'streaming',execution:{stalled:true,waitingForStart:true}};
    view.syncSlowStatusTicker(true);
    assert.equal(timers.size,0);
    current.snap.execution.waitingForStart=false;
    view.syncSlowStatusTicker(true);
    assert.equal(timers.size,1,'a genuinely executing stalled turn retains its existing rotation');
    current.snap.status='queued';
    view.syncSlowStatusTicker(true);
    assert.equal(timers.size,0,'queue transition cancels the existing stalled-work ticker');
  } finally {view.stopSlowStatusTicker();global.setInterval=originalInterval;global.clearInterval=originalClear;}
});

test('startup guidance still refreshes after ninety seconds when a stale stalled flag remains', () => {
  const originalNow=Date.now;
  let now=1792810800000;
  Date.now=()=>now;
  const copy={textContent:'等待启动'};
  const current={ref:'stale-startup',snap:{status:'streaming',execution:{waitingForStart:true,
    executionStartedAt:0,startupWaitSince:now,stalled:true,running:false}},
    document:{querySelector:selector=>selector.includes('runtime-status')?{querySelector:()=>copy}:null}};
  const view=status.createThinking(()=>current);
  try {
    view.syncThinkingClock(true);
    now+=90000;
    view.refreshThinkingUi();
    assert.equal(copy.textContent,'执行环境启动时间较长，可停止后检查底座状态');
    current.snap.status='queued';
    current.snap.statusText='等待执行设备连接';
    now+=1000;
    view.refreshThinkingUi();
    assert.equal(copy.textContent,'等待执行设备连接');
  } finally {view.stopThinkingClock();Date.now=originalNow;}
});

test('waiting for user input retains its status and does not become active queued work', () => {
  const snapshot = { status: 'waiting-user', statusText: '等待输入',
    execution: { running: false, queued: 1, turnQueue: { activeQueueId: 'waiting' } } };
  assert.equal(status.work(snapshot), '等待输入');
  assert.equal(status.runtimeBusy(snapshot), false);
  assert.match(status.createThinking(() => ({ snap: snapshot })).statusHtml(false), /等待输入/);
});
