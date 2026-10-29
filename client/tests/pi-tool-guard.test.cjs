const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../main/pi-session/tool-guard');

test('blocks filesystem-root scans but allows bounded workspace searches', () => {
  assert.match(guard.unsafeReason('find / -iname "plugin*"'), /扫描整台电脑/);
  assert.match(guard.unsafeReason('Get-ChildItem C:\\ -Recurse -Filter *.md'), /扫描整台电脑/);
  assert.equal(guard.unsafeReason('find ./src -iname "plugin*"'), '');
  assert.equal(guard.unsafeReason('rg --files "C:/Program Files/code/soduwork/client"'), '');
});

test('blocks long waits and unbounded loops', () => {
  assert.match(guard.unsafeReason('sleep 90 && curl http://127.0.0.1'), /显式等待/);
  assert.match(guard.unsafeReason('Start-Sleep -Seconds 100'), /显式等待/);
  assert.match(guard.unsafeReason('while true; do curl localhost; done'), /退出条件/);
  assert.equal(guard.unsafeReason('sleep 2 && echo ready'), '');
});

test('applies command profiles and clamps model supplied timeouts', () => {
  assert.equal(guard.timeoutSeconds('rg TODO src', undefined), 120);
  assert.equal(guard.timeoutSeconds('git clone https://example.test/repo.git', undefined), 300);
  assert.equal(guard.timeoutSeconds(
    'node "C:/SoduWork/skills/mcp-tools/scripts/mcp.mjs" --config grant.json call soduwork-plugin plugin_mcp_call',
    undefined), 300);
  assert.equal(guard.timeoutSeconds('npm run build', undefined), 600);
  assert.equal(guard.timeoutSeconds('kubectl rollout status deploy/web', undefined), 900);
  assert.equal(guard.timeoutSeconds('npm run build', 9999), 900);
  assert.equal(guard.timeoutSeconds('npm run build', 12), 120);
  assert.equal(guard.timeoutSeconds('rg TODO src', 1), 15);
});

test('derives a per-tool hard fallback from the effective command timeout', () => {
  assert.deepEqual(guard.executionPolicy('bash', {
    command: 'git fetch origin', timeout: 480,
  }), {
    kind: 'network', timeoutSeconds: 480, hardLimitMs: 510000,
  });
  assert.deepEqual(guard.executionPolicy('read', { path: 'README.md' }), {
    kind: 'tool', timeoutSeconds: 0, hardLimitMs: guard.OTHER_TOOL_LIMIT_MS,
  });
  assert.equal(guard.SOFT_NOTICE_MS, 30000);
  assert.equal(guard.STALL_NOTICE_MS, 90000);
});

test('guarded bash injects a timeout and keeps native cancellation path', async () => {
  const calls = [];
  const sdk = {
    createBashTool(_cwd, options) {
      assert.equal(options.commandPrefix, 'prefix');
      assert.equal(options.shellPath, 'C:/SoduWork/shell/bin/bash.exe');
      return {
        name: 'bash', description: 'bash', parameters: {}, promptGuidelines: [],
        async execute(_id, params, signal) {
          calls.push({ params, signal });
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      };
    },
  };
  const settings = {
    getShellCommandPrefix: () => 'prefix',
    getShellPath: () => '',
  };
  const tool = guard.createGuardedBash(sdk, 'C:/work', settings, {
    resolve: () => ({ shellPath: 'C:/SoduWork/shell/bin/bash.exe', source: 'test' }),
  });
  const signal = new AbortController().signal;
  await tool.execute('1', { command: 'rg TODO src' }, signal);
  assert.equal(calls[0].params.timeout, 120);
  assert.equal(calls[0].signal, signal);
  await assert.rejects(() => tool.execute('2', { command: 'find / -iname x' }, signal), /缩小范围/);
});

test('async guarded bash waits for a verified shell and preserves tool execution', async () => {
  let constructed = false;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const signal = new AbortController().signal;
  const settings = { getShellPath: () => 'configured/bash.exe', getShellCommandPrefix: () => 'prefix' };
  const sdk = { createBashTool(cwd, options) {
    constructed = true;
    assert.equal(cwd, 'C:/work');
    assert.equal(options.shellPath, 'verified/bash.exe');
    assert.equal(options.commandPrefix, 'prefix');
    return { name: 'bash', async execute(id, params, receivedSignal) {
      assert.equal(id, 'run-1');
      assert.equal(receivedSignal, signal);
      assert.equal(params.timeout, 120);
      return { content: [{ type: 'text', text: 'executed' }] };
    } };
  } };
  const toolPromise = guard.prepareGuardedBash(sdk, 'C:/work', settings, {
    resolve() { throw Error('synchronous resolution must not run'); },
    async resolveAsync(options) {
      assert.equal(options.configuredPath, 'configured/bash.exe');
      await ready;
      return { shellPath: 'verified/bash.exe' };
    },
  });
  assert.equal(constructed, false);
  release();
  const tool = await toolPromise;
  assert.equal(constructed, true);
  assert.equal((await tool.execute('run-1', { command: 'rg TODO src' }, signal)).content[0].text, 'executed');
});

test('async guarded bash rejects failed shell preparation without constructing a tool', async () => {
  const sdk = { createBashTool() { assert.fail('must not create a tool with an unavailable shell'); } };
  await assert.rejects(guard.prepareGuardedBash(sdk, 'C:/work', null, {
    async resolveAsync() { throw Error('shell unavailable'); },
  }), /shell unavailable/);
});
