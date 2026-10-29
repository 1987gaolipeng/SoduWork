'use strict';

// Exercise the production work-card path without importing any SDK into main,
// opening the full desktop app, contacting a Hub, or preparing a model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env, PI_TELEMETRY: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const args = [__filename, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  if (process.platform === 'linux' && !env.DISPLAY) args.push('--ozone-platform=headless');
  const result = require('node:child_process').spawnSync(electron, args, {
    env, windowsHide: true, stdio: 'inherit', timeout: 120000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-storage-e2e-'));
const profile = path.join(root, 'profile'), cwd = path.join(root, 'workspace');
fs.mkdirSync(profile); fs.mkdirSync(cwd);
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok: false, root, cases: [],
  boundary: 'Real isolated Electron and utilityProcess, production work-conversation-cards default path and SDK native storage in the worker. No loadStorageSdk injection, model, Hub, business profile or paid requests.' };
let runtime, bridge, skillRuntime, hooks, forbiddenImports = [], fetches = 0, authFactories = 0;
const originalFetch = global.fetch;
function identity(uid = 'storage-user-a') {
  const now = Math.floor(Date.now() / 1000);
  return { hub: 'https://fixture.invalid', clientId: 'storage-fixture-device',
    session: Buffer.from(JSON.stringify({ typ: 'device', uid, cid: 'storage-fixture-device',
      iat: now - 10, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
}
let current = identity();
async function bounded(promise, label, timeoutMs = 30000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function noSdkInMain() {
  assert.deepEqual(forbiddenImports, []);
  const loaded = Object.keys(require.cache).filter(file =>
    /[/\\]pi-session[/\\](?:session|session-open|sdk-loader)\.js$/.test(file) ||
    /[/\\]agent-runtime[/\\]process-storage\.js$/.test(file) || /[/\\]@earendil-works[/\\]/.test(file) ||
    /[/\\]windows-fs-watch-guard\.cjs$/.test(file));
  assert.deepEqual(loaded, [], 'SDK execution/storage must remain in the utility process');
}
function assertWorker() {
  const diagnostics = runtime.diagnostics(app);
  assert.equal(diagnostics.transport, 'utilityProcess');
  assert.ok(Number.isInteger(diagnostics.pid) && diagnostics.pid > 0);
  assert.notEqual(diagnostics.pid, process.pid);
  return diagnostics;
}

app.whenReady().then(async () => {
  // Synchronous Node hooks cover CJS and dynamic ESM imports. A cache-only
  // check could miss the ESM-only SDK, so fail at resolution in Electron main.
  assert.equal(typeof require('node:module').registerHooks, 'function', 'SDK isolation probe requires supported Electron Node hooks');
  hooks = require('node:module').registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (/[/\\]@earendil-works[/\\]/.test(result.url || '') ||
        /[/\\]pi-session[/\\](?:session|session-open|sdk-loader)\.js$/.test(result.url || '') ||
        /[/\\]agent-runtime[/\\]process-storage\.js$/.test(result.url || '') ||
        /[/\\]windows-fs-watch-guard\.cjs$/.test(result.url || '')) {
      forbiddenImports.push(result.url); throw Error('SDK storage/execution imported in Electron main: ' + result.url);
    }
    return result;
  } });
  global.fetch = async () => { fetches++; throw Error('Storage-only creation must not contact a Hub/model'); };
  const { createProcessSession } = require('../main/agent-runtime/process-session');
  const cards = require('../main/conversation/work-conversation-cards');
  const opening = require('../main/conversation/work-conversation-opening');
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  function createRuntime() {
    return createProcessSession({ authFactory() { authFactories++; throw Error('Storage-only creation must not acquire credentials'); } });
  }
  function store() {
    return cards.create({ app, identityOf: async () => current, newCwd: () => cwd,
      session: { ...runtime, archivedConversation: async (targetApp, id) =>
        (await runtime.historyEntry(targetApp, id)).entry || null } });
  }
  runtime = createRuntime();
  bridge = createPiSessionBridge({ app, sessionModule: runtime, runnerAdapters: [] });
  let controller = store();
  const made = await bounded(controller.reserve({ title: 'Runtime storage work form' }), 'native storage reservation');
  assert.equal(made.ok, true, made.reason);
  assert.equal(made.workOnly, true);
  const firstWorker = assertWorker();
  const found = await runtime.historyEntry(app, made.sessionId);
  assert.equal(found.ok, true, found.reason);
  const archive = found.entry.path;
  assert.equal(found.entry.workOnly, true);
  assert.equal(found.entry.title, 'Runtime storage work form');
  const entries = fs.readFileSync(archive, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries[0].type, 'session');
  assert.equal(entries[0].id, made.sessionId);
  assert.equal(entries[1].type, 'session_info');
  assert.equal(entries[2].customType, cards.ENTRY_TYPE);
  assert.ok(entries.every(entry => entry.type !== 'message'));
  noSdkInMain();
  report.cases.push('Production default work-card reserve creates real SDK session/title/owner metadata in a different utility-process PID, without a model message.');

  const prepared = opening.prepare(app, { chatId: made.sessionId, adapterId: 'qwen', accessMode: 'readonly' },
    found.entry, current, true, bridge);
  assert.equal(prepared.first, true);
  await prepared.validate({ identityOf: async () => current });
  current = identity('storage-user-b');
  await assert.rejects(prepared.validate({ identityOf: async () => current }), /账号或服务已切换/);
  current = identity();
  await prepared.validate({ identityOf: async () => current });
  noSdkInMain();
  report.cases.push('First execution preparation validates the real native work archive through the production bridge history reader, preserves ownership checks, and imports no SDK execution module into Electron main.');

  const card = { id: 'runtime-storage-form', actionId: 'work.requirement.create', prompt: 'Preserve the complete requirement.',
    seed: { title: 'Storage fixture' }, state: { note: 'Full content and final constraint.' }, closed: false,
    files: [{ name: 'input.txt', type: 'text/plain', lastModified: 10, data: Buffer.from('complete fixture bytes').toString('base64') }] };
  const saved = await controller.save(made.sessionId, card);
  assert.equal(saved.ok, true, saved.reason);
  const read = await controller.read(made.sessionId);
  assert.equal(read.ok, true, read.reason);
  assert.deepEqual(read.cards, [saved.card]);
  assert.equal(Buffer.from(read.cards[0].files[0].data, 'base64').toString(), 'complete fixture bytes');
  current = identity('storage-user-b');
  assert.equal((await controller.read(made.sessionId)).ok, false);
  assert.equal((await controller.save(made.sessionId, { ...card, prompt: 'must not overwrite' })).ok, false);
  current = identity();
  assert.deepEqual((await controller.read(made.sessionId)).cards, [saved.card]);
  noSdkInMain();
  report.cases.push('Real card/body/binary attachment save/read preserves all bytes and rejects access or modification from another account.');

  await bridge.dispose(); await runtime.dispose();
  runtime = createRuntime(); controller = store();
  bridge = createPiSessionBridge({ app, sessionModule: runtime, runnerAdapters: [] });
  const reopened = await bounded(controller.read(made.sessionId), 'history and form after worker restart');
  assert.equal(reopened.ok, true, reopened.reason);
  assert.equal(reopened.workOnly, true);
  assert.deepEqual(reopened.cards, [saved.card]);
  const secondWorker = assertWorker();
  assert.notEqual(secondWorker.pid, firstWorker.pid);
  assert.notEqual(secondWorker.generation, firstWorker.generation);
  assert.equal((await runtime.historyEntry(app, made.sessionId)).entry.path, archive);
  const resume = (await bridge.historyEntry(app, made.sessionId)).entry;
  await opening.prepare(app, { chatId: made.sessionId, adapterId: 'pi' }, resume, current, true, bridge)
    .validate({ identityOf: async () => current });
  noSdkInMain();
  report.cases.push('Stopping the worker and constructing a fresh runtime restores the same native archive and complete form state in a new process generation.');
  // Exercise the real non-Pi adapter preparation path with a local dispatch
  // sink. Policy resolution and SDK metadata parsing remain production code.
  const skillDir = path.join(root, 'trusted-skill'); fs.mkdirSync(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: fixture-skill\ndescription: >-\n  Trusted fixture\n  multiline description\n---\nUse the trusted fixture guide.\n');
  skillRuntime = require('../main/agent-runtime/process-session');
  const turnSkills = Symbol('fixture-turn-skills'), dispatched = [];
  const skillResult = await bounded(require('../main/agent-runtime/prepared-turn.cjs').send({
    state: { disposed: false, cancelRequested: false, started: false },
    opts: { app, cwd, resolveSkills: async selected => {
      assert.deepEqual(selected, ['fixture-skill']);
      return { items: [{ name: 'fixture-skill', path: skillDir, installed: true }] };
    } },
    next: { text: 'Use the selected trusted skill.', attachments: [], options: { skills: ['fixture-skill'] } },
    skillTurn: require('../main/pi-session/skill-turn'), pluginTurn: require('../main/pi-session/plugin-turn'),
    emit() {}, invalidateObservation() {}, redactors: new Set(), appendUser() {},
    dispatch: async (text, files, options) => { dispatched.push(options); return { ok: true }; },
    continueTurn() { throw Error('The isolated first turn must use dispatch'); },
    conversationPrompt: text => text, skillRows: () => [], TURN_SKILLS: turnSkills,
  }), 'non-Pi skill preparation');
  assert.equal(skillResult.ok, true, skillResult.reason);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0][turnSkills], [{ name: 'fixture-skill', description: 'Trusted fixture multiline description', path: skillDir }]);
  assert.match(dispatched[0].promptText, /SKILL\.md/);
  const skillWorker = skillRuntime.diagnostics(app);
  assert.equal(skillWorker.transport, 'utilityProcess'); assert.notEqual(skillWorker.pid, process.pid);
  assert.equal(skillWorker.auths, 0);
  noSdkInMain();
  report.skillWorker = skillWorker;
  report.cases.push('The actual non-Pi prepared-turn path parses trusted Skill metadata in a utility process while Electron main imports neither the SDK nor its filesystem watch guard.');
  assert.equal(fetches, 0);
  assert.equal(authFactories, 0);
  assert.equal(fs.existsSync(path.join(profile, 'pi-agent', 'models.json')), false);
  assert.equal(fs.existsSync(path.join(profile, 'pi-agent', 'auth.json')), false);
  report.processes = { mainPid: process.pid, firstWorker, secondWorker };
  report.network = { mainFetches: fetches, authenticationCapabilitiesCreated: authFactories, modelConfigurationPrepared: false };
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  await Promise.resolve(bridge?.dispose()).catch(error => { report.bridgeCleanupError = String(error.message || error); report.ok = false; });
  await Promise.resolve(runtime?.dispose()).catch(error => { report.cleanupError = String(error.message || error); report.ok = false; });
  await Promise.resolve(skillRuntime?.dispose()).catch(error => { report.skillCleanupError = String(error.message || error); report.ok = false; });
  hooks?.deregister(); global.fetch = originalFetch;
  const output = path.join(root, 'report.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, report: output }, null, 2));
  app.exit(report.ok ? 0 : 1);
});
