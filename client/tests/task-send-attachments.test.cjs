'use strict';
// Call real registered send IPC and attachment staging with stub Hub preparation and inference.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { createRequire } = require('node:module');
const { MAX_FILES, MAX_BYTES } = require('../main/pi-session/attachments');

function fixture(t, taskFiles = [], preparationError = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-send-attachments-'));
  const cwd = path.join(directory, 'workspace'); fs.mkdirSync(cwd);
  const app = new EventEmitter(); app.getPath = () => directory;
  const handlers = new Map(), submitted = [], stopped = [], prepared = [];
  const handle = { ref: 'qa-ref', sessionId: 'qa-chat', cwd,
    on: () => () => {},
    snapshot: () => ({ messages: [] }), status: () => 'idle', inFlight: () => false, close() {},
    submit(text, files, options) {
      submitted.push({ text, files, options });
      return { accepted: true, completion: Promise.resolve({ ok: true }) };
    } };
  let runtimeOpens = 0;
  const bridge = { get: ref => ref === handle.ref ? handle : null, list: () => [handle], closeAll() {},
    open() { runtimeOpens++; return { ok: true, session: handle }; } };
  const taskInput = { async prepare(...args) {
    prepared.push(args);
    if (preparationError) throw typeof preparationError === 'string' ? Error(preparationError) : preparationError;
    return { text: '完整需求正文与本轮交代', attachments: taskFiles, task: { id: 'task', title: '隔离需求' },
      executor: 'native', controlled: false, beforeTurn: async () => {}, beforeRetry: async () => {},
      afterTurn: async state => { stopped.push(state); } };
  } };
  const file = require.resolve('../main/pi-session/ipc'), nativeRequire = createRequire(file), module = { exports: {} };
  const mocks = { electron: { shell: {}, dialog: {} }, '../agent-runtime/pi-session-bridge': bridge,
    './task-input': taskInput, '../update-workloads': { guard: () => ({ ok: true }) },
    '../agent-runtime/usage-reporter': { createUsageReporter: () => ({ flush: async () => {}, observe() {} }) } };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){\n' +
    fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    name => mocks[name] || nativeRequire(name), module, module.exports, file, path.dirname(file));
  const now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'http://isolated.invalid', clientId: 'qa-device', session:
    Buffer.from(JSON.stringify({ typ: 'device', uid: 'qa-account', cid: 'qa-device', iat: now, exp: now + 1800 }))
      .toString('base64url') + '.' + '0'.repeat(64) };
  t.mock.method(require('../main/conversation/requirement-context'), 'cachedIdentity', () => identity);
  t.mock.method(global, 'fetch', async url => {
    if (String(url) === identity.hub + '/api/v1/skills') return Response.json({ skills: [], enabled: [] });
    if (String(url) === identity.hub + '/api/v1/memories/organization-context')
      return Response.json({ ok: true, prompt: '' });
    throw Error('Unexpected fixture network request: ' + String(url));
  });
  const installed = module.exports.install({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }, identityOf: async () => identity });
  const ready = installed.open({ adapterId: 'pi', cwd, capabilities: [] });
  t.after(async () => {
    app.emit('before-quit'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('soduwork-task-send-attachments-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { cwd, prepared, submitted, stopped, handle,
    send: async (files, execution = {}) => {
      const opened = await ready;
      assert.equal(opened.ok, true, opened.reason);
      assert.equal(opened.ref, handle.ref);
      assert.equal(runtimeOpens, 1, 'fixture setup registers the handle through production open exactly once');
      return handlers.get('pi-session-send')({}, handle.ref, '本轮用户指令', files,
        { taskId: 'task', submissionId: 'fixture-turn', taskExecution: execution });
    } };
}
const file = (name, text) => ({ name, data: Buffer.from(text) });

test('需求原有附件和执行者本轮同名补充材料均进入真实发送，不按文件名去重', async t => {
  const f = fixture(t, [file('缺陷清单.txt', '创建者的原始缺陷')]);
  const result = await f.send([file('缺陷清单.txt', '执行者补充的复现步骤')]);
  assert.equal(result.ok, true, result.reason); assert.equal(f.submitted.length, 1);
  const sent = f.submitted[0]; assert.equal(sent.text, '完整需求正文与本轮交代');
  assert.equal(sent.files.length, 2);
  assert.deepEqual(sent.files.map(row => fs.readFileSync(row.path, 'utf8')), ['创建者的原始缺陷', '执行者补充的复现步骤']);
  assert.notEqual(sent.files[0].path, sent.files[1].path);
  assert.equal(result.inputAttachments.length, 2); assert.deepEqual(result.attachmentWarnings, []);
});

test('发送IPC等待远端接收回执，回执返回后不等待执行完成', async t => {
  const f = fixture(t);
  let entering, admit, complete;
  const entered = new Promise(resolve => { entering = resolve; });
  const admission = new Promise(resolve => { admit = resolve; });
  const completion = new Promise(resolve => { complete = resolve; });
  f.handle.submit = () => { entering(); return admission; };
  let replied = false;
  const pending = f.send([]).then(value => { replied = true; return value; });
  await entered; assert.equal(replied, false);
  admit({ accepted: true, queued: true, queueId: 'remote-turn', position: 2, completion });
  const accepted = await pending;
  assert.equal(accepted.ok, true); assert.equal(accepted.accepted, true); assert.equal(accepted.queued, true);
  assert.equal(accepted.queueId, 'remote-turn'); assert.equal(accepted.position, 2);
  assert.deepEqual(f.stopped, []);
  complete({ ok: true }); await new Promise(resolve => setImmediate(resolve));
});

test('远端拒绝接收后才撤销已准备回执，不将Promise误报为接收成功', async t => {
  const f = fixture(t);
  f.handle.submit = async () => ({ accepted: false, result: { ok: false, reason: '远端队列已满' } });
  assert.deepEqual(await f.send([]), { ok: false, reason: '远端队列已满' });
  assert.deepEqual(f.stopped, ['stopped']);
});

test('追问不重复下载需求旧附件，仍保留执行者本轮新材料', async t => {
  const f = fixture(t, []);
  const result = await f.send([file('新日志.txt', '本轮新增报错')], { followUp: true });
  assert.equal(result.ok, true, result.reason); assert.equal(f.submitted[0].files.length, 1);
  assert.equal(fs.readFileSync(f.submitted[0].files[0].path, 'utf8'), '本轮新增报错');
  assert.equal(f.prepared[0][5].followUp, true);
});

test('合并后的附件数量遵循统一上限，超限拒绝整轮并释放需求回执', async t => {
  for (const count of [MAX_FILES, MAX_FILES + 1]) {
    const f = fixture(t, Array.from({ length: MAX_FILES - 1 }, (_, i) => file('需求-' + i + '.txt', '原材料')));
    const result = await f.send(Array.from({ length: count - MAX_FILES + 1 }, (_, i) => file('本轮-' + i + '.txt', '补充材料')));
    assert.equal(result.ok, count === MAX_FILES);
    if (count === MAX_FILES) assert.equal(f.submitted[0].files.length, MAX_FILES);
    else {
      assert.match(result.reason, /20.*附件/); assert.equal(f.submitted.length, 0);
      assert.deepEqual(f.stopped, ['stopped']);
    }
  }
});

test('两类附件合计超过大小上限时不能只发送需求附件', async t => {
  const f = fixture(t, [file('需求.txt', '已有材料')]);
  // Use a sparse file to test stat limits; reject it before reading or copying its large contents.
  const large = path.join(f.cwd, 'large.bin'), fd = fs.openSync(large, 'w');
  try { fs.ftruncateSync(fd, MAX_BYTES); } finally { fs.closeSync(fd); }
  const result = await f.send([{ name: '本轮补充.bin', path: large }]);
  assert.equal(result.ok, false); assert.match(result.reason, /256 MB/);
  assert.equal(f.submitted.length, 0); assert.deepEqual(f.stopped, ['stopped']);
});

test('本轮材料无法读取时保留错误并阻止不完整的需求执行', async t => {
  const f = fixture(t, [file('需求.txt', '原始材料')]);
  const result = await f.send([{ name: '补充.txt', path: path.join(f.cwd, 'missing.txt') }]);
  assert.equal(result.ok, false); assert.match(result.reason, /补充.txt.*无法读取/);
  assert.equal(f.submitted.length, 0); assert.deepEqual(f.stopped, ['stopped']);
});

test('续轮回执失效后按普通对话发送，也不能丢弃或截断本轮材料', async t => {
  const f = fixture(t, [], Object.assign(Error('需求已完成'), {code:'TASK_FINISHED'}));
  const result = await f.send([file('追问.txt', '完成后的补充问题')], { followUp: true });
  assert.equal(result.ok, true, result.reason);
  assert.equal(fs.readFileSync(f.submitted[0].files[0].path, 'utf8'), '完成后的补充问题');
  const excess = await f.send(Array.from({ length: MAX_FILES + 1 }, (_, i) => file(i + '.txt', '补充')), { followUp: true });
  assert.equal(excess.ok, false); assert.match(excess.reason, /20.*附件/);
  assert.equal(f.submitted.length, 1); assert.deepEqual(f.stopped, []);
});

test('active or unavailable receipt must never silently downgrade a follow-up to ordinary chat', async t => {
  for (const reason of ['这项需求已在会话中执行或排队，请勿重复安排执行', '网络请求失败', '没有权限']) {
    const f=fixture(t,[],reason);
    const result=await f.send([], {followUp:true});
    assert.equal(result.ok,false);assert.equal(result.reason,reason);assert.equal(f.submitted.length,0);
  }
});