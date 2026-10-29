'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const continuation = require('../main/pi-session/output-continuation');
const events = require('../main/pi-session/event-stream');
const { piProvider } = require('../main/conversation/model-selection');

test('real Pi SDK HTTP stop → bounded hidden continuation → actual isolated tool, and promise-only retry stops', { timeout: 30000 }, async t => {
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-handoff-http-'));
  const requests = []; let executions = 0, session;
  const server = http.createServer((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      const body = JSON.parse(data); requests.push(body);
      const second = requests.length === 2, empty = requests.length === 6;
      const delta = empty ? { role: 'assistant' } : second
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_once', type: 'function', function: { name: 'fixture_write', arguments: '{}' } }] }
        : { role: 'assistant', content: requests.length === 3 ? '已完成测试文件写入。' : requests.length === 4 ? '现在立即执行检查，一次到位。' : '马上开始，先补检索：' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'handoff-fixture',
        choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: second ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: empty ? 0 : 10, total_tokens: empty ? 20 : 30 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    session?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'), modelsStorePath: path.join(root, 'models.db') });
  runtime.registerProvider('handoff-fixture', piProvider({ id: 'handoff-fixture', key: 'isolated-fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', contextWindow: 32000 }));
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const manager = sdk.SessionManager.create(root, root);
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model: runtime.getModel('handoff-fixture', 'handoff-fixture'), resourceLoader: loader, settingsManager: settings,
    sessionManager: manager, tools: ['fixture_write'], customTools: [{ name: 'fixture_write', label: 'isolated write',
      description: 'Write an isolated verification artifact', parameters: { type: 'object', properties: {} },
      execute: async () => { executions++; fs.writeFileSync(path.join(root, 'proof.txt'), 'actual SDK tool execution');
        return { content: [{ type: 'text', text: 'Written.' }], details: {} }; } }] }));
  const acc = events.create(); session.subscribe(event => acc.push(event));
  const got = await continuation.complete(session, acc, '请写入测试文件', {});
  assert.deepEqual(got, { continuations: 1, incomplete: false });
  assert.equal(executions, 1); assert.equal(requests.length, 3);
  assert.equal(fs.readFileSync(path.join(root, 'proof.txt'), 'utf8'), 'actual SDK tool execution');
  assert.ok(requests[1].messages.some(m => JSON.stringify(m).includes(continuation.MARKER)));
  assert.equal(acc.snapshot().messages.filter(m => m.role === 'user').length, 1);
  assert.equal(acc.status(), 'idle');
  const refused = await continuation.complete(session, acc, '继续', {});
  assert.deepEqual(refused, { continuations: 1, incomplete: true, incompleteReason: 'output-loop' });
  acc.markIncomplete(refused.incompleteReason);
  assert.equal(requests.length, 5, 'rephrasing the same hand-off cannot produce endless requests');
  assert.equal(executions, 1, 'prior tool was not re-executed');
  assert.equal(acc.status(), 'incomplete');
  assert.equal(acc.snapshot().completion.reason, 'stop');
  const archive = sdk.SessionManager.open(manager.getSessionFile());
  assert.equal(archive.getBranch().filter(row => row.type === 'message' && row.message.role === 'toolResult').length, 1);
  const empty = await continuation.complete(session, acc, '请检查测试文件', {});
  assert.deepEqual(empty, { continuations: 0, incomplete: false }, 'empty provider output has no action promise to retry');
  assert.equal(requests.length, 6, 'input-only usage never causes hidden automatic requests');
  assert.equal(acc.state.usage.input, 20); assert.equal(acc.state.usage.output, 0);
  assert.equal(acc.state.usage.totalTokens, 20); assert.equal(acc.status(), 'no-output');
  assert.equal(executions, 1);
});
