'use strict';
// Production Pi SDK/session/tool execution with a loopback synthetic provider.
// No paid model, user's profile or business workspace participates.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const config = require('../../main/pi-session/model-config');
const TEXT = { first: 'QUEUE_FIRST: save the file once, then continue thinking.',
  now: 'QUEUE_NOW: inspect the attached note and answer immediately.', later: 'QUEUE_LATER: respond after the immediate message.' };
async function until(check, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw Error('Timed out waiting for isolated Pi queue state');
}
async function create(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-immediate-sdk-'));
  const cwd = path.join(root, 'work'), agentDir = path.join(root, 'agent'); fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  const output = path.join(cwd, 'native-once.txt'), note = path.join(cwd, 'note.txt'); fs.writeFileSync(note, 'Attachment must stay with QUEUE_NOW');
  const received = [], events = [], held = new Map(); let offered = false, firstClosed = false;
  function chunk(res, delta, finish) {
    res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: finish || null }] }) + '\n\n');
  }
  function finish(res) { if (res.destroyed) return; chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n'); }
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', part => { raw += part; }); req.on('end', () => {
      const body = JSON.parse(raw), last = [...body.messages].reverse().find(row => row.role === 'user');
      const value = JSON.stringify(last?.content), kind = value.includes('QUEUE_NOW') ? 'now' : value.includes('QUEUE_LATER') ? 'later' : 'first';
      received.push({ kind, body }); events.push('request:' + kind);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (kind === 'first' && !offered) {
        offered = true;
        chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: 'write_once', type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path: output, content: 'Native tool ran once' }) } }] });
        chunk(res, {}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
      }
      chunk(res, { role: 'assistant', content: kind === 'first' ? 'Thinking about the remaining work.' : 'Received ' + kind + '.' });
      if (kind === 'first' || kind === 'now' && options.holdNow !== false) {
        held.set(kind, res); events.push('stream:' + kind);
        res.on('close', () => { events.push('close:' + kind); if (kind === 'first') firstClosed = true; held.delete(kind); });
      } else finish(res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const model = { id: 'fixture', label: 'Fixture', contextWindow: 32000, input: ['text'], key: 'fixture',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
  const modelPath = config.writeModels(agentDir, model), prepare = config.prepare, createRuntime = sdk.ModelRuntime.create;
  const oldKey = process.env.SODUWORK_PROXY_KEY; process.env.SODUWORK_PROXY_KEY = 'fixture';
  config.prepare = async () => ({ ok: true, provider: 'soduwork', agentDir, model });
  sdk.ModelRuntime.create = () => createRuntime.call(sdk.ModelRuntime,
    { modelsPath: modelPath, authPath: path.join(agentDir, 'auth.json'), modelsStorePath: path.join(agentDir, 'models.db') });
  let handle;
  async function close() {
    handle?.close(); config.prepare = prepare; sdk.ModelRuntime.create = createRuntime;
    if (oldKey === undefined) delete process.env.SODUWORK_PROXY_KEY; else process.env.SODUWORK_PROXY_KEY = oldKey;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  try {
    const opened = await require('../../main/pi-session/session').open({
      app: { isPackaged: false, getPath: () => root }, identity: {}, cwd, ephemeral: true,
    });
    if (!opened.ok) throw Error(opened.reason);
    handle = opened.session;
    return { handle, root, cwd, output, note, received, events, text: TEXT,
      attachment: { path: note, name: 'note.txt', mimeType: 'text/plain' },
      waitForHold: kind => until(() => held.has(kind || 'first')),
      release: kind => { const res = held.get(kind); if (res) finish(res); },
      firstClosed: () => firstClosed, close, until };
  } catch (error) { await close(); throw error; }
}
module.exports = { create, until, TEXT };
