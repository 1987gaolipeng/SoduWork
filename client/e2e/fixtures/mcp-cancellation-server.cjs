'use strict';
// An isolated, deliberately non-cooperative NDJSON MCP server. Its hanging
// calls own a real descendant that keeps writing until the process tree dies.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const readline = require('node:readline');

function serve(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(path.join(root, 'servers'), process.pid + '\n');
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const pending = new Map();
  readline.createInterface({ input: process.stdin }).on('line', line => {
    let request; try { request = JSON.parse(line); } catch { return; }
    fs.appendFileSync(path.join(root, 'requests'), JSON.stringify(request) + '\n');
    if (request.method === 'notifications/cancelled') {
      // Match the offending adapter: cancellation never resolves tools/call.
      fs.appendFileSync(path.join(root, 'cancellations'), JSON.stringify(request.params) + '\n');
      return;
    }
    if (request.method === 'fixture/release') {
      const id = request.params.id;
      if (pending.has(id)) { pending.delete(id); reply(id, { content: [{ type: 'text', text: 'released' }] }); }
      return;
    }
    if (request.method !== 'tools/call') { if (request.id != null) reply(request.id, {}); return; }
    const args = request.params.arguments || {};
    if (args.mode === 'complete') {
      reply(request.id, { content: [{ type: 'text', text: 'fixture complete' }] }); return;
    }
    pending.set(request.id, request);
    const heartbeat = path.join(root, 'heartbeat-' + request.id);
    const worker = cp.spawn(process.execPath, ['-e',
      'const fs=require("node:fs");const file=process.argv[1];' +
      'fs.appendFileSync(file,"tick\\n");setInterval(()=>fs.appendFileSync(file,"tick\\n"),25);', heartbeat],
    { windowsHide: true, stdio: 'ignore' });
    fs.appendFileSync(path.join(root, 'workers'), worker.pid + '\n');
    if (args.background === true) {
      // A successfully completed RPC may still own a legitimate live daemon.
      pending.delete(request.id);
      reply(request.id, { content: [{ type: 'text', text: 'background worker started' }] });
    } else if (args.mode === 'hang-exit-response') {
      // Model the real executor: killing the worker naturally releases the
      // pending RPC, while the shared MCP supervisor itself stays available.
      worker.once('exit', () => {
        if (!pending.delete(request.id)) return;
        reply(request.id, { isError: true, content: [{ type: 'text', text: 'worker was terminated' }] });
      });
    }
  });
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'fixture/ready' }) + '\n');
}

async function killOwned(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => cp.execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000 }, () => resolve()));
  } else { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

async function cleanup(root) {
  // These files contain only PIDs created by this fixture. Never enumerate or
  // terminate real sessions, installed runtimes, or the user's MCP servers.
  for (const name of ['servers', 'workers']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const pid of fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number)) {
      try { process.kill(pid, 0); await killOwned(pid); } catch {}
    }
  }
}

async function create(root, options = {}) {
  const f = await require('./resumed-pi.cjs').create(root, { signal: options.signal });
  const processDir = path.join(root, 'mcp');
  const stoppedMarker = path.join(root, 'fixture-closed');
  fs.mkdirSync(processDir, { recursive: true });
  const source = `import {spawn} from 'node:child_process'; import fs from 'node:fs';
export default function(pi) {
  let child, ready, nextId=0, buffer=''; const pending=new Map();
  async function start() {
    if(fs.existsSync(${JSON.stringify(stoppedMarker)}) || !fs.existsSync(${JSON.stringify(root)})) throw Error('Fixture is closed');
    if (child) return ready;
    let resolveReady; ready=new Promise(resolve=>{resolveReady=resolve});
    child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(__filename)},'serve',${JSON.stringify(processDir)}],{stdio:['pipe','pipe','pipe']});
    child.stdout.on('data',data=>{ buffer+=data.toString(); let end;
      while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg;
        try{msg=JSON.parse(line)}catch{continue} if(msg.method==='fixture/ready'){resolveReady();continue}
        const waiter=pending.get(msg.id);if(waiter){pending.delete(msg.id);if(msg.result?.isError)waiter.reject(Error(msg.result.content?.[0]?.text||'tool failed'));else waiter.resolve(msg.result)}
      }
    });
    child.on('exit',()=>{child=null;for(const waiter of pending.values())waiter.reject(Error('MCP server exited'));pending.clear()});
    child.on('error',error=>{for(const waiter of pending.values())waiter.reject(error);pending.clear()});
    await ready;
  }
  pi.on('before_agent_start',async()=>{
    await start();
    // Dynamic registration exercises the production hook, not a one-time SDK
    // tool-array patch. execute deliberately omits the SDK AbortSignal.
    for(const name of ['ctx_execute','ctx_execute_file']) pi.registerTool({name,label:name,description:'Isolated cancellation fixture',
      parameters:{type:'object',properties:{mode:{type:'string'},timeout:{type:'number'},background:{type:'boolean'}},required:['mode']},
      async execute(id,args){await start();const requestId=++nextId;
        return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});
          child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name,arguments:args}})+'\\n')});
      }
    });
  });
}`;
  fs.writeFileSync(path.join(f.agentDir, 'extensions/search.ts'), source);
  const control = require('../../main/pi-session/run-control');
  const original = control.startMonitor; let state, context;
  const monitor = (next, ctx) => { state = next; context = ctx; original(next, ctx); };
  let closing;
  const onAbort = () => { void close().catch(() => {}); };
  async function close() {
    if (closing) return closing;
    options.signal?.removeEventListener('abort', onAbort);
    if (control.startMonitor === monitor) control.startMonitor = original;
    if (fs.existsSync(root)) fs.writeFileSync(stoppedMarker, 'closed');
    closing = (async () => {
      // Stop queued/session work before terminating its transports; otherwise
      // a delayed before_agent_start can spawn a replacement after cleanup.
      try { await f.close(); } finally { await cleanup(processDir); }
    })();
    return closing;
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  control.startMonitor = monitor;
  try { options.signal?.throwIfAborted(); await f.open(); }
  catch (error) { await close(); throw error; }
  finally { if (control.startMonitor === monitor) control.startMonitor = original; }
  return { ...f, handle: f.handle, processDir,
    get runtime() { return context.piSession; },
    get runState() { return state; },
    expireTool() {
      const tool = [...state.activeTools.values()][0];
      if (!tool) throw Error('No real active tool to expire');
      tool.startedAt = Date.now() - tool.hardLimitMs - 1;
      // Invoke the exact production watchdog branch without waiting ten minutes.
      control.stopStalledTool(state, tool, context);
    },
    close,
  };
}

if (require.main === module && process.argv[2] === 'serve') serve(process.argv[3]);
module.exports = { create, cleanup, killOwned };
