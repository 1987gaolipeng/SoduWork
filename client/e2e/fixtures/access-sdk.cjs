'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
async function create(root, mode = 'standard', changed = () => {}, options = {}) {
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
  let calls = 0;
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', data => { text += data; });
    request.on('end', async () => {
      const body = JSON.parse(text), last = body.messages.at(-1);
      if (options.beforeResponse) await options.beforeResponse(body);
      let operation = null;
      if (last.role === 'user') {
        const content = typeof last.content === 'string' ? last.content : last.content.map(x => x.text || '').join('');
        try { operation = JSON.parse(content); } catch (error) { if (!options.reply) throw error; }
      }
      if (options.reply) operation = options.reply(body, operation);
      calls++;
      const delta = operation ? { role: 'assistant', tool_calls: [{ index: 0, id: 'op_' + calls,
        type: 'function', function: { name: operation.tool, arguments: JSON.stringify(operation.args) } }] }
        : { role: 'assistant', content: 'Operation finished.' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason) => response.write('data: ' + JSON.stringify({ id: 'access-fixture', object: 'chat.completion.chunk',
        model: 'access-fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      send(delta, null); send({}, operation ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, 'auth.json'), modelsStorePath: path.join(root, 'models.db') });
  const provider = require('../../main/conversation/model-selection').piProvider({ id: 'access-fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', key: 'local-fixture', contextWindow: 32000 });
  runtime.registerProvider('access-fixture', provider);
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir: root, settingsManager,
    noExtensions: !options.extensionPaths?.length, additionalExtensionPaths: options.extensionPaths || [], noSkills: true,
    additionalSkillPaths: options.skillDirs || [], noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Isolated test' });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd: workspace, agentDir: root, modelRuntime: runtime,
    model: runtime.getModel('access-fixture', 'access-fixture'), settingsManager, resourceLoader,
    sessionManager: options.persist ? sdk.SessionManager.create(workspace, path.join(root, 'sessions')) : sdk.SessionManager.inMemory(), tools: options.restrictReadonly && mode === 'readonly' ? ['read'] : ['read', 'write', 'edit', ...(options.customTools || []).map(tool => tool.name)], customTools: options.customTools || [] });
  const policy = mode ? require('../../main/access-control/policy').create(mode, workspace) : null;
  const scopes = require('../../main/access-control/resource-read-scope');
  const skillReadScope = scopes.fromSkills(resourceLoader.getSkills().skills);
  const readScope = () => scopes.combine(skillReadScope, options.readScope?.());
  const access = require('../../main/access-control/pi').install(session, policy, workspace, changed, { readScope });
  return { session, access, workspace, sdk,
    async rebuild(nextPolicy, previous = session) {
      const nextResources = await require('../../main/pi-session/session-resources').sessionResources(sdk, workspace, root, options.skillDirs || [], [], { noExtensions: nextPolicy.mode !== 'full' });
      nextResources.settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
      const rebuilt = await sdk.createAgentSession({ cwd: workspace, agentDir: root, modelRuntime: runtime,
        model: previous.model, settingsManager: nextResources.settingsManager, resourceLoader: nextResources.resourceLoader,
        sessionManager: previous.sessionManager, tools: options.restrictReadonly && nextPolicy.mode === 'readonly' ? ['read'] : ['read', 'write', 'edit', ...(options.customTools || []).map(tool => tool.name)], customTools: options.customTools || [] });
      return { ...rebuilt, resources: nextResources };
    },
    send: (tool, args) => session.prompt(JSON.stringify({ tool, args })),
    async close() { access?.broker.close(); await session.abort(); session.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { create };
