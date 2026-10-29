'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const modelConfig = require('../main/pi-session/model-config');
const { piProvider } = require('../main/conversation/model-selection');
const connectors = require('../main/conversation-connectors.cjs');
const grants = require('../main/pi-session/plugin-grant');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 1000; i++) { if (fn()) return; await pause(5); } throw Error('boundary timeout'); }

test('native Pi ordinary turns use fresh connector scope, hide guidance, survive unavailability and cancel preparation', { timeout: 30000 }, async t => {
  const sdk = await import('../node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-connectors-'));
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const app = { getPath: () => root }, requests = [], sessions = [], toolCalls = [];
  let issued = 0, unavailable = false, holdDirectory = false, directoryWaiting = false;
  const grantFiles = () => fs.existsSync(grants._grantRoot(app)) ? fs.readdirSync(grants._grantRoot(app)) : [];
  const server = http.createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw); requests.push(body);
      const lastUser = body.messages.findLast(row => row.role === 'user');
      const prompt = JSON.stringify(lastUser?.content || '');
      const call = prompt.includes('plugin_mcp_list') && body.messages.at(-1).role !== 'tool';
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe-' + requests.length,
        type: 'function', function: { name: 'connector_probe', arguments: '{}' } }] }
        : { role: 'assistant', content: 'Fixture complete.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const session of sessions) session.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const model = { id: 'fixture', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    key: 'fixture', contextWindow: 32768 };
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'),
    modelsStorePath: path.join(root, 'models.db') });
  runtime.registerProvider('soduwork', piProvider(model));
  const probe = { name: 'connector_probe', label: 'Fixture connector', description: 'Read-only fixture',
    parameters: { type: 'object', properties: {} },
    async execute() {
      assert.equal(grantFiles().length, 1, 'the actual grant must survive until the tool finishes');
      toolCalls.push(grantFiles()[0]);
      return { content: [{ type: 'text', text: 'Fixture read complete' }], details: {} };
    } };
  t.mock.method(modelConfig, 'prepare', async () => ({ ok: true, agentDir, provider: 'soduwork', model }));
  t.mock.method(require('../main/pi-session/sdk-loader'), 'load', async () => ({ ...sdk,
    ModelRuntime: { create: async () => runtime },
    createAgentSession: args => sdk.createAgentSession({ ...args, tools: ['connector_probe'], customTools: [probe] }) }));
  const resources = require('../main/pi-session/session-resources'), load = resources.sessionResources;
  t.mock.method(resources, 'sessionResources', async (...args) => {
    args[5] = { ...args[5], noExtensions: true };
    return { ...await load(...args), extensionsDeferred: false };
  });
  t.mock.method(require('../main/pi-session/media-artifacts'), 'recover', async () => ({ files: [], errors: [] }));
  const resolveConnectors = connectors.resolver({ app, identity: identity(), identityOf: async () => identity(),
    allowed: true, bridgePath: () => '/fixture/mcp.mjs', platformGuidance: async () => '',
    fetchPolicy: async () => ({ ok: true, skills: [{ name: 'mcp-tools' }], enabled: ['mcp-tools'], revoked: [] }),
    catalog: async () => {
      if (holdDirectory) { directoryWaiting = true; return new Promise(() => {}); }
      if (unavailable) throw Error('Private provider diagnostic');
      return { company: [], enabledCompany: [], personal: [{ name: 'fixture', enabled: true, approved: true }] };
    },
    request: async () => ({ mcpGrant: { ticket: 'private-pi-ticket-' + (++issued), servers: ['fixture'] } }),
  });
  const driver = require('../main/pi-session/session');
  const opened = await driver.open({ app, identity: {}, cwd, resolveConnectors, ref: 'ordinary-connectors' });
  assert.equal(opened.ok, true, opened.reason);
  const session = opened.session; sessions.push(session);
  async function send(text) {
    const result = await session.submit(text).completion; assert.equal(result.ok, true, result.reason);
    await until(() => !session.inFlight()); assert.deepEqual(grantFiles(), []); return result;
  }
  await send('Read the first fixture'); await send('Read it again without selecting a plugin');
  assert.equal(toolCalls.length, 2); assert.notEqual(toolCalls[0], toolCalls[1]);
  assert.equal(issued, 2); assert.deepEqual(session.snapshot().activePlugins, []);
  assert.doesNotMatch(JSON.stringify(session.snapshot()), /soduwork-conversation-connectors|plugin_mcp_list|private-pi-ticket/);
  assert.deepEqual(session.snapshot().messages.filter(row => row.role === 'user').map(row => row.text),
    ['Read the first fixture', 'Read it again without selecting a plugin']);
  unavailable = true;
  await send('Normal conversation without external data');
  assert.equal(toolCalls.length, 2); assert.equal(issued, 2);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Private provider diagnostic/);
  holdDirectory = true;
  const before = requests.length, pending = session.submit('cancel before model');
  await until(() => directoryWaiting);
  assert.equal(session.inFlight(), true);
  const cancelledAt = Date.now(); session.cancel();
  const result = await pending.completion;
  assert.equal(result.cancelled, true); assert.ok(Date.now() - cancelledAt < 700);
  assert.equal(requests.length, before); assert.deepEqual(grantFiles(), []);
});
