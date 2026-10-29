'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../main/access-control/policy');
const { independentReview, sessionResources } = require('../main/pi-session/session-resources');
const goalReview = require('../main/conversation/goal-review');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-internal-review-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const observations = { resources: [], verdicts: [], disposed: 0, previous: 0 };
  const cases = [
    ['read', { path: path.join(cwd, 'inside.txt') }],
    ['read', { path: path.join(root, 'outside.txt') }],
    ['write', { path: path.join(cwd, 'forbidden.txt'), content: 'blocked' }],
    ['bash', { command: 'echo forbidden' }],
    ['custom_tool', {}],
  ];
  const sdk = {
    SettingsManager: { create: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options) { observations.resources.push(options); }
      async reload() {}
      getSkills() { return { skills: [], diagnostics: [] }; }
    },
    async createAgentSession(args) {
      assert.deepEqual(args.tools, ['read', 'list', 'glob', 'grep']);
      const session = {
        agent: { beforeToolCall: async () => { observations.previous++; } },
        subscribe: () => () => {},
        async prompt() {
          // Exercise the hook installed by the production independentReview
          // path. No model or UI broker is involved in these hidden decisions.
          for (const [name, params] of cases) {
            observations.verdicts.push(await session.agent.beforeToolCall({ toolCall: { name }, args: params }));
          }
          throw new Error('End local verifier fixture after hook checks');
        },
        dispose() { observations.disposed++; },
      };
      return { session };
    },
  };
  const machine = goalReview.machine;
  goalReview.machine = () => ({ pass: true, checks: [] });
  t.after(() => { goalReview.machine = machine; fs.rmSync(root, { recursive: true, force: true }); });
  return { cwd, root, sdk, observations };
}

for (const mode of ['standard', 'readonly']) {
  test('hidden ' + mode + ' review denies external reads and writes without waiting', async t => {
    const f = fixture(t);
    await independentReview({ sdk: f.sdk, cwd: f.cwd, agentDir: f.root,
      accessPolicy: policy.create(mode, f.cwd), goal: {}, spec: {}, evidence: {}, outputSnapshot: {} });
    assert.equal(f.observations.resources[0].noExtensions, true);
    assert.equal(f.observations.verdicts[0], undefined);
    for (const result of f.observations.verdicts.slice(1)) assert.equal(result.block, true);
    assert.equal(f.observations.previous, 5);
    assert.equal(f.observations.disposed, 1);
  });
}

test('old hidden review without a policy retains the native hook and extension behavior', async t => {
  const f = fixture(t);
  await independentReview({ sdk: f.sdk, cwd: f.cwd, agentDir: f.root,
    goal: {}, spec: {}, evidence: {}, outputSnapshot: {} });
  assert.equal(f.observations.resources[0].noExtensions, false);
  assert.deepEqual(f.observations.verdicts, Array(5).fill(undefined));
  assert.equal(f.observations.previous, 5);
});

test('internal finalizer resources inherit restricted extension loading while preserving legacy', async t => {
  const f = fixture(t);
  for (const mode of ['standard', 'readonly', 'full', null]) {
    await sessionResources(f.sdk, f.cwd, f.root, [], [], {
      accessPolicy: mode ? policy.create(mode, f.cwd) : undefined,
    });
  }
  assert.deepEqual(f.observations.resources.map(options => options.noExtensions), [true, true, false, false]);
});
