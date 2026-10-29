const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(
  __dirname, '..', 'components', 'panels', 'task-context-view.js'), 'utf8');

function load() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.TaskProjectContextView;
}

test('project context stays hidden for tasks without a project', () => {
  assert.equal(load().html({ visible: false }), '');
});

test('project context presents a stable pre-dispatch baseline', () => {
  const html = load().html({
    visible: true,
    state: 'available',
    stateLabel: '执行时准备',
    projectName: 'SoduWork <核心>',
    repoName: 'SoduWork monorepo',
    branch: 'release1.12',
    memoryCount: 2,
  });
  assert.match(html, /执行时准备/);
  assert.match(html, /SoduWork monorepo/);
  assert.match(html, /2 条已验收经验/);
  assert.doesNotMatch(html, /<核心>/);
});

test('project context exposes concise evidence without internal protocol data', () => {
  const html = load().html({
    visible: true,
    state: 'ready',
    stateLabel: '已就绪',
    repoName: 'SoduWork monorepo',
    branch: 'release1.12',
    baselineCommit: '1234567890abcdef',
    sourceCount: 2,
    sources: [
      { path: 'AGENTS.md', kind: 'agent-rules' },
      { path: '.soduwork/MEMORY.md', kind: 'project-memory' },
      { path: 'package.json', kind: 'manifest' },
    ],
    commands: ['npm test'],
    latestMemory: { title: '修复派活', summary: '回归通过', commit: 'abcdef1234' },
  });
  assert.match(html, /@12345678/);
  assert.match(html, /工程规则/);
  assert.match(html, /项目记忆/);
  assert.match(html, /工程清单/);
  assert.match(html, /npm test/);
  assert.match(html, /最近已验收经验/);
  assert.doesNotMatch(html, /agent-rules/);
  assert.doesNotMatch(html, /projectContextPrompt|C:\\\\Program Files/);
});
