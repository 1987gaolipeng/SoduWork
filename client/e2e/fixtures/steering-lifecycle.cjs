'use strict';
const fs = require('node:fs'), path = require('node:path');
const control = require('../../main/pi-session/run-control');
async function create(root, options = {}) {
  const f = await require('./resumed-pi.cjs').create(root, { contextWindow: options.largeTool ? 8192 : 200000,
    signal: options.signal });
  const file = path.join(f.agentDir, 'extensions/search.ts');
  const release = path.join(root, 'release-tool'), aborted = path.join(root, 'tool-aborted');
  if (options.largeTool) fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    // Exceed the retained context slice while staying below proactive native
    // compaction: the following synthetic overflow owns the summary boundary.
    .replace('Search results: fixture source verified', 'Recorded fixture evidence. '.repeat(600)));
  if (options.slowTool) fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace('async execute(id,args)', 'async execute(id,args,signal)')
    .replace('return {content:', `await new Promise(resolve => {
      const finish = () => { clearInterval(timer); signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => fs.writeFileSync(${JSON.stringify(aborted)}, 'abort received');
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)}) || !fs.existsSync(${JSON.stringify(root)})) finish(); }, 10);
      signal?.addEventListener('abort', onAbort, {once:true}); if (signal?.aborted) onAbort();
    }); return {content:`));
  const original = control.startMonitor;
  let context, closing;
  const monitor = (state, ctx) => { context = ctx; original(state, ctx); };
  const onAbort = () => { void close().catch(() => {}); };
  async function close() {
    if (closing) return closing;
    options.signal?.removeEventListener('abort', onAbort);
    if (control.startMonitor === monitor) control.startMonitor = original;
    if (fs.existsSync(root)) fs.writeFileSync(release, 'release');
    context?.piSession.abortCompaction();
    closing = f.close();
    return closing;
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  control.startMonitor = monitor;
  try { options.signal?.throwIfAborted(); await f.open(); }
  catch (error) { await close(); throw error; }
  finally { if (control.startMonitor === monitor) control.startMonitor = original; }
  return { ...f, handle: f.handle, get runtime() { return context.piSession; },
    releaseTool() { fs.writeFileSync(release, 'release'); },
    toolAborted: () => fs.existsSync(aborted),
    close,
  };
}
function holdCompaction(f) {
  let closed = false;
  f.reply((_body, count) => {
    if (count === 1) return { tool: 'web_search', args: { query: 'before-compaction-once' } };
    if (count === 2) return { respond: response => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length is 8192 tokens; prompt is too long' } }));
    } };
    if (count === 3) return { respond: response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': compaction-wait\n\n');
      response.on('close', () => { closed = true; });
    } };
    return { text: '引导后的答复已完成。' };
  });
  return () => closed;
}
module.exports = { create, holdCompaction };
