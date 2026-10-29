'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const routes = require('../components/panels/plugin-route-directory');

test('插件路由目录聚合抽象底座、在线席位和可选模型', () => {
  const data = routes.normalize({
    kinds: [
      { key: 'local:qwen', name: 'Qwen Code', modelPick: true },
      { key: 'local:codex', name: 'Codex', modelPick: false },
    ],
    agents: [
      { id: 'runner:r1:qwen', cli: 'qwen', online: true,
        capabilities: { available: ['browser'] } },
      { id: 'runner:r2:qwen', cli: 'qwen', online: true,
        capabilities: { available: ['office'] } },
      { id: 'runner:r3:qwen', cli: 'qwen', online: false,
        capabilities: { available: ['computer'] } },
      { id: 'runner:r4:codex', cli: 'codex', online: true,
        capabilities: { available: ['computer', 'repository'] } },
      { id: 'hosted-seat', online: true },
    ],
    defaultModel: 'company-default',
    models: ['company-default', 'review-model', 'review-model'],
  });

  const kind = key => data.kinds.find(item => item.key === key);
  assert.equal(kind('local:qwen').onlineSeats, 2);
  assert.equal(kind('local:codex').onlineSeats, 1);
  assert.equal(kind('hosted').onlineSeats, 1);
  assert.equal(kind('local:codex').modelPick, false);
  assert.equal(routes.capableSeats(kind('local:qwen'), ['browser']), 1);
  assert.equal(routes.capableSeats(kind('local:qwen'), ['computer']), 0);
  assert.equal(routes.capableSeats(kind('local:codex'), ['computer', 'repository']), 1);
  assert.equal(routes.capableSeats(kind('hosted'), ['browser']), 0);
  assert.equal(routes.capableSeats(kind('local:qwen'), []), 2);
  assert.deepEqual(data.models, ['company-default', 'review-model']);
  assert.equal(data.defaultModel, 'company-default');
});

test('插件只保存机器无关的 Agent 类型，不接受具体 Runner 身份', () => {
  assert.equal(routes.isPortableAgentKind(''), true);
  assert.equal(routes.isPortableAgentKind('hosted'), true);
  assert.equal(routes.isPortableAgentKind('local:future-agent'), true);
  assert.equal(routes.isPortableAgentKind('runner:r1:pi'), false);
  assert.equal(routes.isPortableAgentKind('local:bad_kind'), false);
});
