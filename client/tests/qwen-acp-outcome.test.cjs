const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const modulePath = path.resolve(__dirname, '../../hub-backend/app/services/qwen_acp_outcome.mjs');
const helper = import(pathToFileURL(modulePath).href);

function nativeCapture() {
  return {
    calls: [],
    beginResponse(...args) { this.calls.push(['begin', ...args]); return 'begin-result'; },
    restartAttempt(...args) { this.calls.push(['retry', ...args]); return 'retry-result'; },
    observeFinishReason(...args) { this.calls.push(['finish', ...args]); return 'finish-result'; },
  };
}

test('only the final native output limit changes ACP success and preserves metadata', async () => {
  const { captureOutcome, promptOutcome } = await helper;
  const capture = captureOutcome(nativeCapture());
  const result = { stopReason: 'end_turn', usage: { outputTokens: 7 },
    _meta: { branchPoint: { id: 'branch' }, soduwork: { unrelated: true } } };
  capture.observeFinishReason('MAX_TOKENS');
  assert.deepEqual(promptOutcome(result, capture), { ...result, stopReason: 'max_tokens',
    _meta: { ...result._meta, soduwork: { unrelated: true, outputLimit: true } } });
  assert.equal(result.stopReason, 'end_turn');
  capture.observeFinishReason('STOP');
  assert.equal(promptOutcome(result, capture), result);
});

test('native callbacks keep their receiver, arguments, return values, and failures', async () => {
  const { captureOutcome, promptOutcome } = await helper;
  const capture = captureOutcome(nativeCapture());
  assert.equal(capture.beginResponse('native-scope'), 'begin-result');
  assert.equal(capture.restartAttempt(true, 2), 'retry-result');
  assert.equal(capture.observeFinishReason('MAX_TOKENS', 'detail'), 'finish-result');
  assert.deepEqual(capture.calls, [['begin', 'native-scope'], ['retry', true, 2],
    ['finish', 'MAX_TOKENS', 'detail']]);
  const error = new Error('native callback failure');
  const throwing = captureOutcome({ ...nativeCapture(), observeFinishReason() { throw error; } });
  assert.throws(() => throwing.observeFinishReason('MAX_TOKENS'), value => value === error);
  const result = { stopReason: 'end_turn' };
  assert.equal(promptOutcome(result, throwing), result);
  assert.deepEqual(Object.keys(capture), ['calls', 'beginResponse', 'restartAttempt', 'observeFinishReason']);
});

test('new model rounds and retries invalidate an earlier output limit', async () => {
  const { captureOutcome, promptOutcome } = await helper;
  for (const [method, args] of [['beginResponse', []], ['restartAttempt', [true]], ['restartAttempt', [false]]]) {
    const capture = captureOutcome(nativeCapture());
    const result = { stopReason: 'end_turn' };
    capture.observeFinishReason('MAX_TOKENS');
    capture[method](...args);
    assert.equal(promptOutcome(result, capture), result);
    capture.observeFinishReason('MAX_TOKENS');
    capture.observeFinishReason(undefined);
    assert.equal(promptOutcome(result, capture).stopReason, 'max_tokens');
  }
});

test('prompt scopes are independent and cancellation or native budgets keep their meaning', async () => {
  const { captureOutcome, promptOutcome } = await helper;
  const first = captureOutcome(nativeCapture());
  const second = captureOutcome(nativeCapture());
  first.observeFinishReason('MAX_TOKENS');
  second.observeFinishReason('STOP');
  assert.equal(promptOutcome({ stopReason: 'end_turn' }, first).stopReason, 'max_tokens');
  assert.equal(promptOutcome({ stopReason: 'end_turn' }, second).stopReason, 'end_turn');
  for (const stopReason of ['cancelled', 'max_tokens', 'max_turn_requests', 'refusal']) {
    const native = { stopReason };
    assert.equal(promptOutcome(native, first), native);
  }
  const signal = AbortSignal.abort();
  const cancelled = { stopReason: 'end_turn' };
  assert.equal(promptOutcome(cancelled, first, signal), cancelled);
});

test('unsupported native interfaces and all unreviewed source fail closed', async () => {
  const { captureOutcome, promptOutcome, transformSource } = await helper;
  assert.throws(() => captureOutcome({}), /interface is unavailable/);
  assert.throws(() => promptOutcome({ stopReason: 'end_turn' }, {}), /capture is unavailable/);
  for (const filename of ['acpAgent-DYVOMNZP.js', 'chunk-WG5L7ABP.js', 'other.js']) {
    for (const version of ['0.27.4', '0.27.5']) {
      assert.throws(() => transformSource('changed source', filename, version), /unsupported/);
    }
  }
});

test('the real loader strips host state and leaves unrelated modules untouched', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'soduwork qwen 结算 '));
  try {
    const entry = path.join(root, 'unrelated.mjs');
    writeFileSync(entry, 'console.log(JSON.stringify({value:42,hook:process.env.SODUWORK_QWEN_ACP_OUTCOME,options:process.env.NODE_OPTIONS}))');
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: {
      ...process.env, SODUWORK_QWEN_ACP_OUTCOME: '1',
      NODE_OPTIONS: '--import=' + pathToFileURL(modulePath).href,
    }, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { value: 42 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real loader rejects unknown or changed packages before their entrypoint runs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'soduwork qwen 校验 '));
  try {
    const pkg = path.join(root, 'node_modules', '@qwen-code', 'qwen-code');
    mkdirSync(path.join(pkg, 'chunks'), { recursive: true });
    const entry = path.join(pkg, 'cli.js');
    writeFileSync(entry, 'throw new Error("UNSAFE_ENTRYPOINT_EXECUTED");');
    for (const filename of ['acpAgent-DYVOMNZP.js', 'chunk-WG5L7ABP.js']) {
      writeFileSync(path.join(pkg, 'chunks', filename), 'changed source');
    }
    for (const version of ['0.27.5', '0.27.4']) {
      writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@qwen-code/qwen-code', version, type: 'module' }));
      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: {
        ...process.env, SODUWORK_QWEN_ACP_OUTCOME: '1',
        NODE_OPTIONS: '--import=' + pathToFileURL(modulePath).href,
      }, timeout: 10000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Qwen Code ACP outcome interface is unsupported/);
      assert.doesNotMatch(result.stderr, /UNSAFE_ENTRYPOINT_EXECUTED/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
