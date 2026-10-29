'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../main/conversation/office-engine');

test('Office documents prefer the free local Python engine', () => {
  const calls = [];
  const result = engine.probe({
    env: {}, platform: 'win32',
    run(command, args, options) {
      calls.push({ command, args, options });
      return command === 'python.exe'
        ? { status: 0, stdout: 'python-docx + openpyxl + python-pptx\n', stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'python-office');
  assert.match(result.detail, /免费本地引擎/);
  assert.equal(calls[0].options.shell, false);
});

test('async Python probes start all launchers without blocking the main process', async () => {
  const calls = [];
  const resolvers = [];
  const request = engine.probeAsync({
    env: {}, platform: 'win32',
    run(command) {
      calls.push(command);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['python.exe', 'python', 'py.exe', 'py']);
  resolvers.forEach((resolve, index) => resolve({
    status: index === 0 ? 0 : 1,
    stdout: index === 0 ? 'python-docx + openpyxl + python-pptx\n' : '', stderr: '',
  }));
  const result = await request;
  assert.equal(result.ok, true);
  assert.equal(result.command, 'python.exe');
});

test('a global paid Office CLI is never discovered implicitly', () => {
  const calls = [];
  const result = engine.probe({
    env: {}, platform: 'win32',
    run(command) {
      calls.push(command);
      return { status: 1, stdout: '', stderr: 'missing' };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /免费办公文档引擎/);
  assert.equal(calls.some((item) => /officecli/i.test(item)), false);
});

test('Office CLI remains an explicit optional adapter', () => {
  const target = 'C:\\tools\\officecli.cmd';
  const result = engine.probe({
    env: { SODUWORK_OFFICECLI: target, ComSpec: 'cmd.exe' }, platform: 'win32',
    exists: (item) => item === target,
    run(command) {
      if (/^(?:python|py)(?:\.exe)?$/i.test(command)) {
        return { status: 1, stdout: '', stderr: 'missing' };
      }
      return { status: 0, stdout: 'officecli 1.0.143\n', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'officecli-optional');
  assert.match(result.detail, /自选适配器/);
});
