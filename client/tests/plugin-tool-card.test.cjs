'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
const tools = require('../components/panels/panels-chat-tools');
delete global.window;

test('plugin MCP calls render business meaning without bridge or grant paths', () => {
  const view = tools.render({
    name: 'bash', state: 'done',
    get result() { throw new Error('Command summaries must not read the full result'); },
    get partial() { throw new Error('Command summaries must not read streaming output'); },
    args: { command: 'node "C:/SoduWork/skills/mcp-tools/scripts/mcp.mjs" ' +
      '--config "C:/Users/me/pi-agent/mcp/grants/private-turn.json" ' +
      'call soduwork-plugin plugin_mcp_call ' +
      "'{\"server\":\"worklog\",\"tool\":\"records_search\",\"arguments\":{}}'" },
  });
  assert.equal(view.title, '连接器');
  assert.equal(view.sub, 'worklog · records_search');
  assert.doesNotMatch(JSON.stringify(view), /--config|private-turn|mcp\.mjs/);
  assert.equal(view.summaryOnly, true);
  assert.equal(view.body, '');
  assert.equal(view.tip, '');
});

test('ordinary SoduWork task bridge calls keep concise familiar wording', () => {
  const view = tools.render({
    name: 'bash', state: 'running',
    get result() { throw new Error('Command summaries must not read the full result'); },
    get partial() { throw new Error('Command summaries must not read streaming output'); },
    args: { command: 'node "C:/SoduWork/mcp.mjs" call soduwork task_propose \'{}\'' },
  });
  assert.equal(view.title, 'SoduWork');
  assert.equal(view.sub, '提议一张任务卡');
  assert.equal(view.summaryOnly, true);
  assert.equal(view.body, '');
  assert.equal(view.tip, '');
});

test('connector bridge discovery and native MCP tools keep connector wording without reading receipts', () => {
  const noReceipts = { state: 'done',
    get result() { throw Error('metadata must not load a result'); },
    get partial() { throw Error('metadata must not load partial output'); } };
  const discovery = tools.render(Object.assign(Object.create(noReceipts), { name: 'bash', args: {
    command: 'node "C:/Soduwork/mcp.mjs" --config "C:/private/grant.json" list soduwork-plugin' } }));
  assert.equal(discovery.title, '连接器'); assert.equal(discovery.sub, '读取本轮连接器工具');
  for (const name of ['plugin_mcp_list', 'mcp__soduwork-plugin__plugin_mcp_list']) {
    const view = tools.render(Object.assign(Object.create(noReceipts), { name, args: { server: 'worklog' } }));
    assert.equal(view.title, '连接器'); assert.equal(view.sub, '查看 worklog 的能力');
    assert.equal(view.summaryOnly, true); assert.equal(view.body, ''); assert.equal(view.tip, '');
  }
  const called = tools.render(Object.assign(Object.create(noReceipts), { name: 'mcp__soduwork_plugin__plugin_mcp_call',
    args: { server: 'worklog', tool: 'records_search' } }));
  assert.equal(called.title, '连接器'); assert.equal(called.sub, 'worklog · records_search');
  const business = tools.render({ name: 'run_business_plugin', state: 'done', args: {}, result: 'business result' });
  assert.equal(business.title, '调用');
});

test('built-in MCP server labels use the current brand without changing protocol input', () => {
  for (const server of ['soduwork', 'SoduWork']) {
    const tool = { name: 'bash', state: 'running', args: { command: 'node "C:/SoduWork/mcp.mjs" list "' + server + '"' } };
    const before = JSON.stringify(tool);
    assert.equal(tools.render(tool).sub, '查看 SoduWork 的工具');
    assert.equal(JSON.stringify(tool), before);
  }
});

test('third-party MCP names and user command text retain their original spelling', () => {
  for (const server of ['soduwork-client', 'my-soduwork', 'worklog']) {
    const tool = { name: 'bash', state: 'done', args: { command: 'node mcp.mjs list ' + server } };
    assert.equal(tools.render(tool).sub, '查看 ' + server + ' 的工具');
  }
  // Show compact command activity while retaining raw commands in execution records.
  const tool = { name: 'bash', state: 'done', args: { command: 'echo soduwork' } };
  const plain = tools.render(tool);
  assert.equal(plain.sub, '');
  assert.equal(plain.body, '');
  assert.equal(plain.summaryOnly, true);
  assert.equal(tool.args.command, 'echo soduwork');
  assert.equal(tools.render({ name: 'bash', state: 'done', args: { command: 'node mcp.mjs list soduwork-plugin' } }).sub, '读取本轮连接器工具');
});
