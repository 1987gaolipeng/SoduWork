'use strict';
// Real installed pi-subagents result delivery, isolated data and no model calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
  const { pathToFileURL } = require('node:url'), { app } = electron;
  const installed = process.argv[2];
  if (!installed || !path.isAbsolute(installed)) throw Error('Pass the absolute installed pi-subagents directory');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-watch-recovery-'));
  const resultsDir = path.join(root, 'results');
  const out = path.resolve(__dirname, '../../outputs/client-idle-cpu/pi-extension-recovery.json');
  app.setPath('userData', path.join(root, 'profile'));
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  const report = { ok: false, cases: [], cpu: [], delivered: [], completionEvents: [],
    boundary: 'Installed pi-subagents source; production Windows watcher guard; real Electron native fs events and original 3-second extension restart. Test-only temporary files, session identity and notifier; no user data, model, external platform or notification calls.' };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await check()) return; await delay(25); }
    throw Error('Timed out: ' + label);
  };
  const removeTestDirectory = target => {
    const resolved = path.resolve(target);
    assert.ok(resolved.startsWith(root + path.sep) && resolved !== root);
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  let watcher, state;
  async function cpu(phase) {
    const start = process.cpuUsage(), at = performance.now(); await delay(1800);
    const value = process.cpuUsage(start), percent = (value.user + value.system) / (performance.now() - at) / 10;
    report.cpu.push({ phase, oneCorePercent: percent });
    assert.ok(percent < 20, 'Idle CPU spin after ' + phase + ': ' + percent);
  }
  async function deliver(id) {
    fs.writeFileSync(path.join(resultsDir, id + '.json'), JSON.stringify({
      sessionId: state.currentSessionId, completionOwnerId: state.completionOwnerId,
      id, runId: id, timestamp: Date.now(), state: 'done', agent: 'fixture',
      success: true, output: 'isolated completion ' + id, nestedChildren: [],
    }));
    await until(() => report.delivered.includes(id), 'extension result ' + id);
    await until(() => !fs.existsSync(path.join(resultsDir, id + '.json')), 'acknowledged result cleanup');
    assert.equal(report.delivered.filter(value => value === id).length, 1);
  }
  app.whenReady().then(async () => {
    require('../main/windows-fs-watch-guard.cjs').install();
    const entry = path.join(installed, 'src/runs/background/result-watcher.js');
    assert.ok(fs.existsSync(entry), 'Installed result-watcher is required');
    const { createResultWatcher } = await import(pathToFileURL(entry).href);
    fs.mkdirSync(resultsDir);
    state = { currentSessionId: 'resource-fixture-session', completionOwnerId: 'resource-fixture-owner',
      completionSeen: new Map(), asyncJobs: new Map(), watcher: null, watcherRestartTimer: null,
      resultFileCoalescer: { clear() {} } };
    const events = new EventEmitter();
    events.on('subagent:async-complete', value => report.completionEvents.push(value.runId));
    watcher = createResultWatcher({ events }, state, resultsDir, 600000, {
      notifier: { deliver: async value => { report.delivered.push(value.runId); return true; } },
      deliverIntercomResults: false,
    });
    watcher.startResultWatcher();
    await deliver('before');
    report.cases.push('An ordinary completion reaches the original extension notifier once.');
    for (let index = 0; index < 3; index++) {
      const prior = state.watcher;
      assert.ok(prior, 'Native watcher installed before deletion');
      if (index === 1) {
        const retired = path.join(root, 'retired-results');
        fs.renameSync(resultsDir, retired);
        fs.mkdirSync(resultsDir);
        // Windows can rename a watched directory without emitting an event.
        // Activity in the original directory lets the identity guard detect
        // replacement; this does not claim instantaneous silent-rename recovery.
        fs.writeFileSync(path.join(retired, 'wake.txt'), 'isolated watcher event');
      } else {
        removeTestDirectory(resultsDir);
        if (index === 2) {
          // Windows may keep a directory delete-pending until the native handle
          // closes. Retry only that OS race, ahead of the extension's 3s restart.
          const deadline = Date.now() + 1000;
          while (true) {
            try { fs.mkdirSync(resultsDir); break; }
            catch (error) {
              if (!['EPERM', 'EACCES'].includes(error.code) || Date.now() >= deadline) throw error;
              await delay(25);
            }
          }
        }
      }
      await until(() => state.watcher && state.watcher !== prior, 'native watcher recovery');
      await deliver('after-' + index);
      await cpu('recovery-' + index);
    }
    report.cases.push('Deletion, directory replacement and immediate recreation all recover through the extension error/restart path; new completions still arrive exactly once.');
    watcher.stopResultWatcher();
    assert.equal(state.watcher, null); assert.equal(state.watcherRestartTimer, null);
    await cpu('stopped');
    assert.deepEqual(report.delivered, ['before', 'after-0', 'after-1', 'after-2']);
    assert.deepEqual(report.completionEvents, report.delivered);
    report.cases.push('Stopping result delivery closes its native watcher and restart timer.');
    report.ok = true;
  }).catch(error => { report.error = error.stack; })
    .finally(() => {
      watcher?.stopResultWatcher(); fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
      app.exit(report.ok ? 0 : 1);
    });
}
