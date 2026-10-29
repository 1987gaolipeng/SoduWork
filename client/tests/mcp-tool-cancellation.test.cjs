'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const helper = require('../e2e/fixtures/mcp-cancellation-server.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description = 'condition', timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(15); }
  throw Error('Timed out waiting for ' + description);
}
function lines(root, name) { const file = path.join(root, name); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []; }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mcp-cancel-'));
  const controller = new AbortController();
  t.signal.addEventListener('abort', () => controller.abort(), { once: true });
  let f;
  t.after(async () => { controller.abort(); await f?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  f = await helper.create(root, { signal: controller.signal });
  f.nextTurnLiveProcesses = [];
  f.reply((_body, count) => {
    if (count === 1) return { tool: 'ctx_execute', args: { mode: 'hang' } };
    f.nextTurnLiveProcesses.push(...(f.activeTree || []).filter(alive));
    return { text: '已按补充要求完成。' };
  });
  return f;
}
async function started(f) {
  await until(() => lines(f.processDir, 'workers').length, 'a real hanging MCP descendant');
  await until(() => fs.readdirSync(f.processDir).some(file => file.startsWith('heartbeat-')), 'worker side effect');
  f.activeTree = [...lines(f.processDir, 'servers'), ...lines(f.processDir, 'workers')];
  return lines(f.processDir, 'servers')[0];
}
async function stopped(f) {
  await until(() => f.activeTree.every(pid => !alive(pid)), 'the owned process tree to exit');
  const ticks = () => fs.readdirSync(f.processDir).filter(file => file.startsWith('heartbeat-'))
    .map(file => fs.readFileSync(path.join(f.processDir, file), 'utf8')).join('');
  const before = ticks(); await delay(120); assert.equal(ticks(), before, 'cancelled tools must not retain background side effects');
}

test('real Pi steering cancels a non-cooperative MCP process tree before sending guidance exactly once', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = f.handle.submit('执行隔离工具。'); await started(f);
  const rpc = lines(f.processDir, 'requests').map(JSON.parse).find(value => value.method === 'tools/call');
  assert.equal(rpc.params.arguments.timeout, 120000, 'missing context-mode timeout gets a bounded default');
  const selected = f.handle.submit('GUIDE_ONCE：使用已有结果。');
  const request = f.handle.updateQueue(selected.queueId, 'send-now');
  const duplicate = f.handle.updateQueue(selected.queueId, 'send-now');
  await until(() => lines(f.processDir, 'cancellations').length, 'MCP cancellation notification');
  assert.equal(f.requests.length, 1, 'no next model call before cancellation settles');
  assert.equal((await request).ok, true); assert.equal((await duplicate).ok, true);
  assert.equal((await first.completion).cancelled, true);
  assert.equal((await selected.completion).ok, true);
  await stopped(f);
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages.at(-1)), /GUIDE_ONCE/);
  assert.equal(f.handle.snapshot().execution.queue.length, 0);
  assert.equal(f.runtime.isIdle, true);
  assert.deepEqual(f.nextTurnLiveProcesses, [], 'new model work must never overlap the cancelled process tree');
});

test('real Pi manual stop waits for a hung MCP tree to terminate and a subsequent turn succeeds', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = f.handle.submit('执行后停止。'); await started(f);
  f.handle.cancel();
  await first.completion; await stopped(f);
  assert.equal(f.runtime.isIdle, true);
  assert.equal((await f.handle.submit('STOP_CONTINUE：继续当前会话。').completion).ok, true);
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages.at(-1)), /STOP_CONTINUE/);
  assert.deepEqual(f.nextTurnLiveProcesses, []);
});

test('real Pi watchdog timeout terminates the actual MCP tree and does not leave continuation blocked', { timeout: 20000 }, async t => {
  const f = await fixture(t), first = f.handle.submit('执行超时隔离工具。'); await started(f);
  f.expireTool();
  await until(() => lines(f.processDir, 'cancellations').length, 'watchdog cancellation');
  assert.equal(f.requests.length, 1);
  await first.completion; await stopped(f);
  assert.equal(f.runtime.isIdle, true);
  assert.equal((await f.handle.submit('TIMEOUT_CONTINUE：从已有结果继续。').completion).ok, true);
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages.at(-1)), /TIMEOUT_CONTINUE/);
  assert.deepEqual(f.nextTurnLiveProcesses, []);
});

test('real dynamically registered context-mode tools receive default and maximum execution bounds', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.reply((_body, count) => count === 1 ? { tool: 'ctx_execute_file', args: { mode: 'complete' } }
    : count === 3 ? { tool: 'ctx_execute', args: { mode: 'complete', timeout: 999999999 } }
      : { text: '有界执行已完成。' });
  assert.equal((await f.handle.submit('执行文件。').completion).ok, true);
  assert.equal((await f.handle.submit('执行较长任务。').completion).ok, true);
  const calls = lines(f.processDir, 'requests').map(JSON.parse).filter(value => value.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params.name, 'ctx_execute_file');
  assert.equal(calls[0].params.arguments.timeout, 120000);
  assert.equal(calls[1].params.arguments.timeout, 600000);
});

test('real Pi cancellation preserves an earlier completed background worker while stopping the current worker and guiding once', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  let earlierWorker, currentWorker, serverPid;
  f.reply((_body, count) => {
    if (count === 1) return { tool: 'ctx_execute', args: { mode: 'hang', background: true } };
    if (count === 3) return { tool: 'ctx_execute', args: { mode: 'hang-exit-response' } };
    if (count === 4) {
      assert.equal(alive(earlierWorker), true, 'the prior background work must remain alive when guidance starts');
      assert.equal(alive(serverPid), true, 'the shared MCP supervisor must survive');
      assert.equal(alive(currentWorker), false, 'the cancelled worker must exit before a new model request');
    }
    return { text: '后台服务保持运行，当前步骤已处理。' };
  });
  assert.equal((await f.handle.submit('启动隔离后台任务。').completion).ok, true);
  await until(() => fs.existsSync(path.join(f.processDir, 'heartbeat-1')), 'earlier background worker heartbeat');
  [earlierWorker] = lines(f.processDir, 'workers');
  [serverPid] = lines(f.processDir, 'servers');
  const first = f.handle.submit('启动另一个隔离工具。');
  await until(() => lines(f.processDir, 'workers').length === 2, 'later foreground worker');
  currentWorker = lines(f.processDir, 'workers')[1];
  await until(() => fs.existsSync(path.join(f.processDir, 'heartbeat-2')), 'later worker heartbeat');
  const selected = f.handle.submit('BACKGROUND_GUIDE_ONCE：保留原后台服务并继续。');
  const guiding = f.handle.updateQueue(selected.queueId, 'send-now');
  const duplicate = f.handle.updateQueue(selected.queueId, 'send-now');
  assert.equal((await guiding).ok, true); assert.equal((await duplicate).ok, true);
  assert.equal((await first.completion).cancelled, true);
  const guidedResult = await selected.completion;
  assert.equal(guidedResult.ok, true, JSON.stringify(guidedResult));
  assert.equal(f.requests.length, 4);
  assert.match(JSON.stringify(f.requests[3].messages.at(-1)), /BACKGROUND_GUIDE_ONCE/);
  assert.equal(lines(f.processDir, 'servers').length, 1, 'cancelling one worker must not replace its supervisor');
  assert.equal(alive(earlierWorker), true); assert.equal(alive(serverPid), true); assert.equal(alive(currentWorker), false);
  const earlier = path.join(f.processDir, 'heartbeat-1'), current = path.join(f.processDir, 'heartbeat-2');
  const earlierLength = fs.statSync(earlier).size, stoppedLength = fs.statSync(current).size;
  await delay(150);
  assert.ok(fs.statSync(earlier).size > earlierLength, 'existing background service still performs its work');
  assert.equal(fs.statSync(current).size, stoppedLength, 'cancelled tool has no remaining side effects');
  assert.equal(f.runtime.isIdle, true);
});

async function direct(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mcp-transport-'));
  const transport = require('../main/pi-session/mcp-tool-transport');
  const child = cp.spawn(process.execPath, [path.resolve(__dirname, '../e2e/fixtures/mcp-cancellation-server.cjs'), 'serve', root],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  transport.observe(child);
  let buffer = '', next = 0, ready; const pending = new Map(), readyPromise = new Promise(resolve => { ready = resolve; });
  child.stdout.on('data', data => {
    buffer += data.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      let message; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'fixture/ready') { ready(); continue; }
      const p = pending.get(message.id); if (p) { pending.delete(message.id); p.resolve(message.result); }
    }
  });
  child.on('exit', () => { for (const p of pending.values()) p.reject(Error('MCP server exited')); pending.clear(); });
  t.after(async () => { await helper.cleanup(root); fs.rmSync(root, { recursive: true, force: true }); });
  await readyPromise;
  return { child, root, transport,
    call(signal, mode) {
      const id = ++next;
      const promise = transport.run(signal, () => new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fixture', arguments: { mode } } }) + '\n');
      }));
      // Tests inspect both success and error intentionally; attach immediately
      // so an expected native exit cannot become an unhandled rejection.
      const settled = Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
      return { id, promise, settled };
    },
    release(id) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'fixture/release', params: { id } }) + '\n'); },
  };
}

test('aborting after an MCP response leaves the completed idle service alive', { timeout: 10000 }, async t => {
  const f = await direct(t), controller = new AbortController();
  await f.call(controller.signal, 'complete').promise;
  controller.abort(); await delay(1100);
  assert.equal(alive(f.child.pid), true);
  assert.equal(lines(f.root, 'cancellations').length, 0, 'completed RPC must release its abort listener');
  assert.equal((await f.call(new AbortController().signal, 'complete').promise).content[0].text, 'fixture complete');
});

test('cancelling one request never kills a shared MCP service while another request is active', { timeout: 12000 }, async t => {
  const f = await direct(t), firstSignal = new AbortController(), secondSignal = new AbortController();
  const first = f.call(firstSignal.signal, 'hang'), second = f.call(secondSignal.signal, 'hang');
  await until(() => lines(f.root, 'workers').length === 2, 'two active independent MCP requests');
  firstSignal.abort(); await delay(1100);
  assert.equal(alive(f.child.pid), true, 'a different active request protects the shared transport');
  f.release(second.id);
  assert.equal((await second.promise).content[0].text, 'released');
  await until(() => !alive(f.child.pid), 'cancelled-only transport to be reclaimed');
  assert.ok((await first.settled).error);
});

test('an already aborted scope cannot dispatch a new real MCP tool call', { timeout: 10000 }, async t => {
  const f = await direct(t), controller = new AbortController();
  controller.abort();
  const result = await f.call(controller.signal, 'hang').settled;
  assert.ok(result.error);
  await delay(100);
  assert.equal(lines(f.root, 'workers').length, 0);
  assert.equal(lines(f.root, 'requests').map(JSON.parse).filter(value => value.method === 'tools/call').length, 0);
  assert.equal(alive(f.child.pid), true);
});

test('unscoped active MCP requests protect their service from another scope cancellation', { timeout: 12000 }, async t => {
  const f = await direct(t), controller = new AbortController();
  const scoped = f.call(controller.signal, 'hang');
  // This request deliberately has no tool cancellation owner.
  f.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'unowned-call', method: 'tools/call',
    params: { name: 'outside-scope', arguments: { mode: 'hang' } } }) + '\n');
  await until(() => lines(f.root, 'workers').length === 2, 'unscoped request to begin');
  controller.abort(); await delay(1100);
  assert.equal(alive(f.child.pid), true);
  f.release('unowned-call');
  await until(() => !alive(f.child.pid), 'cancelled owned request cleanup after unscoped request completes');
  assert.ok((await scoped.settled).error);
});

test('observing a real child keeps stdout paused and preserves output for a later reader', { timeout: 10000 }, async t => {
  const transport = require('../main/pi-session/mcp-tool-transport');
  const child = cp.spawn(process.execPath, ['-e',
    'process.stdout.write("READY_SENTINEL");setInterval(()=>{},1000);'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { await helper.killOwned(child.pid); await closed; });
  transport.observe(child);
  // Do not attach a reader yet. The observer must not turn stdout into a
  // flowing stream or consume a tool's startup/ready output by itself.
  assert.equal(child.stdout.readableFlowing, null);
  await until(() => child.stdout.readableLength > 0, 'stdout to buffer without a consumer');
  await delay(120);
  assert.equal(child.stdout.readableFlowing, null);
  assert.equal(child.stdout.read().toString(), 'READY_SENTINEL');
});

test('a real non-MCP tool can write its cooperative quit protocol after cancellation', { timeout: 10000 }, async t => {
  const transport = require('../main/pi-session/mcp-tool-transport');
  const child = cp.spawn(process.execPath, ['-e',
    'require("node:readline").createInterface({input:process.stdin}).on("line",line=>{' +
    'if(line==="quit"){process.stdout.write("QUIT_CONFIRMED");process.exit(0)}});process.stdout.write("READY\\n");'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (alive(child.pid)) await helper.killOwned(child.pid); await closed; });
  transport.observe(child);
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  const controller = new AbortController();
  const result = await transport.run(controller.signal, async () => {
    await until(() => output.includes('READY'), 'ordinary tool readiness');
    controller.abort();
    // This is an intentional shutdown message, not a new MCP tools/call.
    child.stdin.write('quit\n');
    return closed;
  });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(output, /QUIT_CONFIRMED/);
});
