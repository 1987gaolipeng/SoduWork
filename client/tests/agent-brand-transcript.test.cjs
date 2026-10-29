const test = require('node:test');
const assert = require('node:assert/strict');
const brand = require('../components/panels/agent-brand');

const source = (agentId, runId = '', nodeKey = '') => ({ agentId, runId, nodeKey });
const heads = parts => parts.join('').match(/class="nchat-agent-source(?: nchat-crew)?"/g) || [];
const crewHtml = () => ({ html: '<span class="crew-stack">Pi and Qwen</span>', title: 'Pi and Qwen', taskId: 'task-1' });

test('one turn shares its crew header across thinking, tool groups and model segments', () => {
  const transcript = brand.transcript({ turnScoped: true, crewHtml });
  const parts = ['<div data-chat-node="turn-metrics"></div>'];
  const first = source('pi', 'run-1', 'think');
  transcript.before(parts, first, 'message:1', true);
  parts.push('<div>Thinking</div>');
  transcript.appendTools((target, tools) => target.push(...tools.map(tool => '<div>' + tool.id + '</div>')),
    parts, [{ id: 'read', sourceAgent: first }, { id: 'review', sourceAgent: source('qwen', 'run-2', 'review') }], [], 'message:1');
  transcript.before(parts, source('pi', 'run-3', 'answer'), 'message:2', true);
  parts.push('<div>Answer</div>');
  assert.equal(heads(parts).length, 1);
  assert.match(parts[0], /nchat-crew/);
  assert.match(parts[1], /turn-metrics/);
  assert.match(parts.join(''), /Thinking.*read.*review.*Answer/);
});

test('a tool-first turn uses the shared crew callback and retains task-run details', () => {
  const calls = [];
  const transcript = brand.transcript({ turnScoped: true, crewHtml: (value, anchor) => {
    calls.push([value, anchor]);
    return crewHtml();
  } });
  const first = source('pi', 'run-1', 'read');
  const parts = [];
  transcript.appendTools((target, tools) => target.push('<div>' + tools[0].id + '</div>'),
    parts, [{ id: 'read-first', sourceAgent: first }], [], 'message:0');
  transcript.before(parts, source('qwen', 'run-2', 'answer'), 'message:1', true);
  assert.equal(heads(parts).length, 1);
  assert.deepEqual(calls, [[first, 'message:0:agent:read-first']]);
  assert.match(parts[0], /nchat-crew/);
  assert.match(parts[0], /data-crew-run="run-1"/);
  assert.match(parts[0], /data-crew-task="task-1"/);
});

test('user boundaries repaint the same run and Agent once in each turn', () => {
  const transcript = brand.transcript({ turnScoped: true, crewHtml });
  const parts = [];
  const first = source('pi', 'shared-run', 'first');
  transcript.before(parts, first, 'message:1', true);
  transcript.appendTools(() => {}, parts, [{ id: 'tool-1', sourceAgent: first }], [], 'message:1');
  transcript.breakRun();
  transcript.before(parts, null, 'message:2');
  transcript.appendTools(() => {}, parts, [{ id: 'tool-2', sourceAgent: first }], [], 'message:2');
  transcript.before(parts, first, 'message:3', true);
  assert.equal(heads(parts).length, 2);
  assert.match(parts[0], /agent-source:message:1/);
  assert.match(parts[1], /agent-source:message:2:agent:tool-2/);
});

test('unattributed segments neither consume nor reset the turn header', () => {
  const transcript = brand.transcript({ turnScoped: true, crewHtml });
  const parts = [];
  transcript.before(parts, null, 'message:0', true);
  transcript.before(parts, { agentId: '<img onerror=bad>' }, 'message:1', true);
  assert.equal(heads(parts).length, 0);
  transcript.before(parts, source('pi'), 'message:2', true);
  transcript.before(parts, undefined, 'message:3', true);
  transcript.before(parts, source('qwen'), 'message:4', true);
  assert.equal(heads(parts).length, 1);
  assert.doesNotMatch(parts.join(''), /onerror/);
});

test('turn-level dedup preserves source-specific tool groups and provenance', () => {
  const transcript = brand.transcript({ turnScoped: true, crewHtml });
  const first = source('pi', 'run-1', 'read'), next = source('pi', 'run-2', 'read');
  const input = [{ id: 'a', sourceAgent: first }, { id: 'b', sourceAgent: first },
    { id: 'c', sourceAgent: next }, { id: 'd', sourceAgent: source('qwen', 'run-2', 'review') }];
  const original = structuredClone(input), groups = [], parts = [], seen = [];
  transcript.appendTools((target, group, previous, anchor, marker) => {
    assert.equal(previous, seen);
    assert.equal(marker, 'extra-option');
    groups.push({ ids: group.map(tool => tool.id), anchor });
    target.push('<div>' + group.map(tool => tool.id).join(',') + '</div>');
  }, parts, input, seen, 'message:1', 'extra-option');
  assert.deepEqual(groups, [
    { ids: ['a', 'b'], anchor: 'message:1:agent:a' },
    { ids: ['c'], anchor: 'message:1:agent:c' },
    { ids: ['d'], anchor: 'message:1:agent:d' },
  ]);
  assert.deepEqual(input, original);
  assert.notEqual(brand.sourceKey(first), brand.sourceKey(next));
  assert.equal(heads(parts).length, 1);
});

test('missing crew presentation falls back to one trusted Agent mark per turn', () => {
  for (const renderCrew of [undefined, () => null]) {
    const transcript = brand.transcript({ turnScoped: true, crewHtml: renderCrew });
    const parts = [];
    transcript.before(parts, source('pi'), 'message:1', true);
    transcript.appendTools(() => {}, parts, [{ id: 'tool', sourceAgent: source('pi') }], [], 'message:1');
    transcript.before(parts, source('qwen'), 'message:2', true);
    assert.equal(heads(parts).length, 1);
    assert.match(parts[0], /data-output-agent="pi"/);
    assert.match(parts[0], /title="Pi"/);
  }
});

test('independent transcript render passes reconstruct a visible turn header', () => {
  for (const anchor of ['message:1', 'message:81']) {
    const parts = [];
    const transcript = brand.transcript({ turnScoped: true, crewHtml });
    transcript.before(parts, source('pi', 'shared-run'), anchor, true);
    transcript.appendTools(() => {}, parts, [{ id: 'read', sourceAgent: source('pi', 'shared-run') }], [], anchor);
    assert.equal(heads(parts).length, 1);
    assert.match(parts[0], new RegExp('agent-source:' + anchor));
  }
});
