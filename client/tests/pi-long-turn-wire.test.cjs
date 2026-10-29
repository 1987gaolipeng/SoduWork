'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const config = require('../main/pi-session/model-config');

test('real session completes 270 distinct writes without an implicit per-turn budget', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-long-turn-'));
  const cwd = path.join(root, 'work'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  let requests = 0;
  const captured = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', part => raw += part); req.on('end', () => {
      captured.push(JSON.parse(raw));
      const first = requests++ === 0;
      const delta = first ? { role: 'assistant', tool_calls: Array.from({ length: 270 }, (_, i) => ({
        index: i, id: 'write-' + i, type: 'function', function: { name: 'write',
          arguments: JSON.stringify({ path: path.join(cwd, i + '.txt'), content: 'output ' + i }) },
      })) } : { role: 'assistant', content: 'All 270 files are saved.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = await import(pathToFileURL(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const model = { id: 'fixture', label: 'Fixture', contextWindow: 128000, input: ['text'], key: 'fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
  const modelsPath = config.writeModels(agentDir, model), prepare = config.prepare, create = sdk.ModelRuntime.create;
  const oldKey = process.env.SODUWORK_PROXY_KEY; process.env.SODUWORK_PROXY_KEY = 'fixture';
  config.prepare = async () => ({ ok: true, provider: 'soduwork', agentDir, model });
  sdk.ModelRuntime.create = () => create.call(sdk.ModelRuntime, { modelsPath,
    authPath: path.join(agentDir, 'auth.json'), modelsStorePath: path.join(agentDir, 'models.db') });
  let session;
  t.after(async () => {
    if (session) await session.close();
    config.prepare = prepare; sdk.ModelRuntime.create = create;
    if (oldKey === undefined) delete process.env.SODUWORK_PROXY_KEY; else process.env.SODUWORK_PROXY_KEY = oldKey;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const opened = await require('../main/pi-session/session').open({ app: { isPackaged: false, getPath: () => root },
    identity: {}, cwd, ephemeral: true });
  assert.equal(opened.ok, true, opened.reason); session = opened.session;
  await session.submit('Save the 270 requested files and report completion.', []).completion;
  const snapshot = session.snapshot();
  assert.equal(snapshot.completion.reason, 'stop', JSON.stringify(snapshot.completion));
  assert.equal(snapshot.execution.stopped, false);
  assert.equal(requests, 2);
  assert.equal(captured[1].messages.filter(message => message.role === 'tool').length, 270);
  for (let i = 0; i < 270; i++) assert.equal(fs.readFileSync(path.join(cwd, i + '.txt'), 'utf8'), 'output ' + i);
});
