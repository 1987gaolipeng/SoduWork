'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const stream = require('../../main/pi-session/event-stream');
module.exports = async function run(onStage) {
  const { Agent } = await import('../../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-stream-write-'));
  const file = path.join(directory, '长文件.html');
  const acc = stream.create(); let round = 0, writes = 0;
  const call = { type: 'toolCall', id: 'streamed-file', name: 'write', arguments: {} };
  const inspect = stage => onStage(stage, acc.uiSnapshot(), { exists: fs.existsSync(file), writes });
  const agent = new Agent({ initialState: {
    model: { id: 'fixture', api: 'fixture', provider: 'fixture' },
    tools: [{ name: 'write', description: 'Write the test file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      async execute(id, args) {
        await inspect('executing'); fs.writeFileSync(args.path, args.content); writes++;
        return { content: [{ type: 'text', text: 'Written' }] };
      } }],
  }, streamFn() {
    const toolTurn = round++ === 0;
    const message = { role: 'assistant', api: 'fixture', provider: 'fixture', model: 'fixture',
      timestamp: Date.now(), stopReason: toolTurn ? 'toolUse' : 'stop',
      content: toolTurn ? [call] : [{ type: 'text', text: '文件已写入。' }],
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    return { async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      if (toolTurn) {
        yield { type: 'toolcall_start', contentIndex: 0, partial: message };
        call.arguments = { path: file, content: '' };
        yield { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' + JSON.stringify(file) + ',"content":"', partial: message };
        await inspect('preparing');
        for (let i = 0; i < 32; i++) {
          const chunk = 'x'.repeat(10000); call.arguments.content += chunk;
          yield { type: 'toolcall_delta', contentIndex: 0, delta: chunk, partial: message };
          await inspect('chunk');
        }
        yield { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message };
      }
      yield { type: 'done', message };
    }, result: async () => message };
  } });
  agent.subscribe(event => acc.push(event));
  try {
    await agent.prompt('Write the isolated test file.');
    acc.push({ type: 'agent_settled' });
    await inspect('complete');
    return { bytes: fs.statSync(file).size, writes, tools: acc.state.tools.length };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
};
