'use strict';
// Use production sessions and SDK with local HTTP/SSE fault injection, without accounts or live models.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(10); }
  throw Error('Retry fixture did not settle');
}
async function fixture(t, retry = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-retry-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  // Shorten backoff while retaining intervals beyond the UI merge window so each retry remains observable.
  // Keep this wire fixture bounded and fast; production six-retry defaults are
  // covered by session-resources and the explicit schedule test below.
  fs.writeFileSync(path.join(f.agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 100, ...retry },
  }));
  await f.open();
  const retries = [];
  f.handle.on(() => {
    const row = f.handle.snapshot().modelRetry;
    if (row?.active && !retries.some(item => item.attempt === row.attempt)) retries.push(row);
  });
  return { ...f, retries };
}
function streamError(status = 503, message = '模型并发调度连接中断，请稍后重试（HTTP ' + status + '）') {
  return { respond(response) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': soduwork-keepalive\n\n');
    response.end('data: ' + JSON.stringify({ error: { message, type: 'soduwork_proxy_error', code: status } }) + '\n\n');
  } };
}

const denial = 'Bearer synthetic-credential https://fixture.invalid/private synthetic-prompt';
function deny(response) {
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: denial } }));
}

test('A conversation shows personal and company credential guidance when the model service returns HTTP 401', async t => {
  const f = await fixture(t);
  f.reply(() => ({ respond(response) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: denial } }));
  } }));
  await f.handle.submit('验证模型凭据提示。').completion;
  const snapshot = f.handle.snapshot();
  assert.equal(f.requests.length, 1);
  assert.equal(snapshot.completion.retryable, false);
  assert.match(snapshot.completion.error, /「我的模型」.*个人 Key.*企业服务.*管理员.*HTTP 401/);
  assert.ok(snapshot.statusText.includes(snapshot.completion.error));
  assert.doesNotMatch(snapshot.statusText, /synthetic-|fixture\.invalid/);
});

test('initial HTTP 403 returns one neutral error without tools or retries', async t => {
  const f = await fixture(t);
  f.reply(() => ({ respond: deny }));
  await f.handle.submit('Answer without tools.').completion;
  const snapshot = f.handle.snapshot();
  assert.equal(f.requests.length, 1);
  assert.equal(snapshot.tools.length, 0);
  assert.equal(snapshot.completion.retryable, false);
  assert.equal(snapshot.completion.error, '模型请求被拒绝（HTTP 403）');
  assert.ok(snapshot.statusText.includes(snapshot.completion.error));
  assert.doesNotMatch(snapshot.statusText, /synthetic-|fixture\.invalid/);
});

test('a Hub trace reaches the real session after a rejected tool continuation', async t => {
  const f = await fixture(t);
  const trace = '0123456789abcdef0123456789abcdef';
  f.reply((_body, count) => count === 1 ? { tool: 'write', args: { path: 'trace.txt', content: 'retained' } }
    : { respond(response) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ error: { type: 'soduwork_proxy_error', code: 403,
        message: 'HTTP 403: rejected [soduwork-trace:' + trace + ']', upstreamRequestId: 'private-provider-id' } }) + '\n\n');
    } });
  await f.handle.submit('Write trace.txt and summarize.').completion;
  const snapshot = f.handle.snapshot();
  assert.equal(snapshot.completion.error, '工具已完成，请求模型继续生成时被拒绝（HTTP 403） [soduwork-trace:' + trace + ']');
  assert.equal(snapshot.completion.retryable, false);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'trace.txt'), 'utf8'), 'retained');
  assert.equal(f.requests.length, 2);
  assert.doesNotMatch(snapshot.statusText, /private-provider-id/);
});

for (const status of [200, 403]) {
  test('same model and credentials succeed on direct inference, tool continuation returns ' + status, async t => {
    const f = await fixture(t);
    const provider = JSON.parse(fs.readFileSync(path.join(f.agentDir, 'models.json'))).providers.soduwork;
    const target = new URL(provider.baseUrl + '/chat/completions');
    const model = provider.models[0].id, authorization = 'Bearer ' + process.env.SODUWORK_PROXY_KEY;
    const controls = [];
    f.reply(body => {
      if (body.stream !== false && body.messages.at(-1).role !== 'tool') {
        return { tool: 'write', args: { path: 'report.md', content: 'fixture report' } };
      }
      return { respond(response) {
        controls.push([body.model, response.req.url, response.req.headers.authorization === authorization]);
        if (body.stream === false) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        } else if (status === 403) {
          deny(response);
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        }
      } };
    });
    const direct = await fetch(target, { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'ping' }] }) });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).choices[0].message.content, 'ok');
    await f.handle.submit('Write report.md and summarize.').completion;
    const snapshot = f.handle.snapshot();
    assert.deepEqual(controls, Array(2).fill([model, target.pathname, true]));
    assert.equal(f.requests.length, 3);
    assert.equal(snapshot.tools.filter(row => row.name === 'write' && row.state === 'done').length, 1);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'report.md'), 'utf8'), 'fixture report');
    if (status === 403) {
      assert.equal(snapshot.completion.reason, 'error');
      assert.equal(snapshot.completion.retryable, false);
      assert.equal(snapshot.completion.error, '工具已完成，请求模型继续生成时被拒绝（HTTP 403）');
      assert.ok(snapshot.statusText.includes(snapshot.completion.error));
      assert.doesNotMatch(snapshot.statusText, /synthetic-|fixture\.invalid/);
    } else {
      assert.equal(snapshot.completion.reason, 'stop');
      f.reply(() => ({ respond: deny }));
      await f.handle.submit('Start a different task.').completion;
      assert.equal(f.requests.length, 4);
      assert.ok(f.requests.at(-1).messages.some(row => row.role === 'tool'));
      assert.equal(f.handle.snapshot().completion.error, '模型请求被拒绝（HTTP 403）');
      assert.equal(f.handle.snapshot().completion.retryable, false);
    }
  });
}

test('three transient stream failures recover automatically without replaying a completed tool', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply((_body, count) => count === 1 ? { tool: 'write', args: { path: 'report.md', content: '# Saved once' } }
    : count <= 4 ? streamError() : { text: '报告已完成。' });
  await f.handle.submit('请生成报告并总结。').completion;
  const snapshot = f.handle.snapshot();
  assert.equal(snapshot.status, 'idle');
  assert.equal(f.requests.length, 5, 'one tool request, three failed answers and one successful answer');
  assert.deepEqual(f.retries.map(row => row.attempt), [1, 2, 3]);
  assert.ok(f.retries.every(row => row.max === 3));
  assert.deepEqual(f.retries.map(row => row.delayMs), [100, 200, 400]);
  assert.ok(f.retries.every(row => row.retryAt > 0 && row.retryAt - row.delayMs <= Date.now()));
  assert.equal(snapshot.tools.filter(row => row.name === 'write').length, 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'report.md'), 'utf8'), '# Saved once');
  for (const body of f.requests.slice(2)) {
    assert.equal(body.messages.filter(row => row.role === 'tool').length, 1, 'reuse confirmed tool receipt');
    assert.equal(body.messages.filter(row => row.role === 'user' && JSON.stringify(row).includes('请生成报告')).length, 1);
  }
});

test('an explicit retry schedule controls each transient retry delay', { timeout: 15000 }, async t => {
  // This observer reads 50 ms-coalesced UI snapshots. Keep each retry visible
  // while using a schedule that differs from the default exponential backoff.
  const f = await fixture(t, { maxRetries: 3, delayScheduleMs: [100, 200, 300] });
  f.reply((_body, count) => count <= 3 ? streamError() : { text: '按计划重试后完成。' });
  await f.handle.submit('验证显式重试间隔。').completion;
  assert.deepEqual(f.retries.map(row => row.attempt), [1, 2, 3]);
  assert.deepEqual(f.retries.map(row => row.delayMs), [100, 200, 300]);
  assert.equal(f.requests.length, 4);
  assert.equal(f.handle.snapshot().status, 'idle');
});

test('persistent stream failure stops after three retries and a single explicit recovery can continue', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply(() => streamError());
  const turn = f.handle.submit('请完成原任务。');
  await turn.completion;
  assert.equal(f.requests.length, 4);
  assert.equal(f.handle.snapshot().completion.retryable, true);
  assert.match(f.handle.snapshot().statusText, /已自动重试 3 次/);
  await delay(60);
  assert.equal(f.requests.length, 4, 'no hidden provider retries or infinite continuation');
  f.reply(() => ({ text: '已接续完成。' }));
  const result = f.handle.updateQueue(turn.queueId, 'retry-model');
  assert.equal(result.ok, true);
  assert.equal(f.handle.updateQueue(turn.queueId, 'retry-model').ok, false, 'recovery token is single-use');
  await until(() => f.requests.length === 5 && !f.handle.inFlight());
  assert.equal(f.handle.snapshot().status, 'idle');
});

test('connection failures before response headers retry three times without resubmitting the task', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.reply((_body, count) => count <= 3 ? { respond(response) { response.destroy(); } }
    : { text: '连接恢复后完成原请求。' });
  const turn = f.handle.submit('首次连接失败后继续原请求。');
  await turn.completion;
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.retries.map(row => row.attempt), [1, 2, 3]);
  assert.deepEqual(f.retries.map(row => row.delayMs), [100, 200, 400]);
  assert.equal(f.handle.snapshot().status, 'idle');
  for (const body of f.requests) {
    assert.equal(body.messages.filter(row => row.role === 'user' &&
      JSON.stringify(row).includes('首次连接失败后继续原请求')).length, 1);
  }
});

test('authentication and quota failures never consume transient retry attempts', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const [code, message] of [[401, '模型凭据无效（HTTP 401）'], [403, '无模型权限（HTTP 403）'],
    [429, 'insufficient_quota HTTP 429'], [503, 'billing limit exceeded HTTP 503']]) {
    const count = f.requests.length;
    f.reply(() => streamError(code, message));
    await f.handle.send('校验永久错误。', [], { internal: true });
    assert.equal(f.requests.length, count + 1);
    assert.equal(f.handle.snapshot().completion.retryable, false);
  }
  assert.equal(f.retries.length, 0);
});

test('stopping during retry backoff prevents any subsequent model call', { timeout: 15000 }, async t => {
  const f = await fixture(t, { baseDelayMs: 200 });
  f.reply(() => streamError());
  const turn = f.handle.submit('停止重试样本。');
  await until(() => f.retries.length === 1);
  f.handle.cancel();
  await turn.completion;
  await delay(300);
  assert.equal(f.requests.length, 1);
  assert.equal(f.handle.inFlight(), false);
  assert.notEqual(f.handle.snapshot().status, 'idle', 'stopped request is not marked successful');
});
