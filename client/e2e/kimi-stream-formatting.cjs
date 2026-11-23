'use strict';
// Exercise real ACP normalization, Runner message projection and Electron Markdown.
// All inputs are synthetic; no account, installed Agent or model service is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-kimi-stream-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  env.SODUWORK_KIMI_E2E_SCRATCH = scratch;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  let cleaned = false;
  function finish(code) {
    if (cleaned) return;
    cleaned = true; clearTimeout(timer);
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) { console.error('Isolated profile cleanup failed:', error.message); code = 1; }
    process.exitCode = code ?? 1;
  }
  child.on('exit', finish);
  child.on('error', error => { console.error(error.message); finish(1); });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const { execFileSync } = require('node:child_process');
  const { create } = require('../main/agent-runtime/runner-messages');
  const root = path.resolve(__dirname, '../..');
  const args = process.argv.slice(2), baselineIndex = args.indexOf('--baseline-ref');
  const baselineRef = baselineIndex >= 0 ? args.splice(baselineIndex, 2)[1] : '';
  const output = path.resolve(args[0] || path.join(root, 'outputs/kimi-stream-formatting'));
  const python = args[1] || process.env.SODUWORK_TEST_PYTHON || 'python3';
  const scratch = process.env.SODUWORK_KIMI_E2E_SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-kimi-stream-'));
  app.setPath('userData', path.join(scratch, 'profile'));
  const report = { ok: false, isolatedProfile: true, realElectron: true, realModel: false,
    realAgent: false, realHub: false, baselineRef, cases: [], externalRequests: [] };
  let win;
  const run = source => win.webContents.executeJavaScript(source, true);
  const update = (kind, text) => ({ sessionUpdate: kind, content: { type: 'text', text } });
  function chunks(text) {
    const chars = Array.from(text), steps = [];
    for (let i = 0; i < chars.length; i += 3) {
      // Kimi can forward an empty reasoning_content before every content delta.
      steps.push({ update: update('agent_thought_chunk', '') });
      steps.push({ update: update('agent_message_chunk', chars.slice(i, i + 3).join('')) });
    }
    return steps;
  }
  function project(cases) {
    const script = String.raw`
import json, sys
from tempfile import TemporaryDirectory
from unittest.mock import patch
from app.services import acp_bridge, local_stream

payload = json.load(sys.stdin)
cases = payload["cases"]
if payload.get("bridgeSource"):
    # Load committed baseline code in memory without changing the checkout.
    exec(compile(payload["bridgeSource"], "acp_bridge_baseline.py", "exec"), acp_bridge.__dict__)
result = []
for case in cases:
    with TemporaryDirectory(prefix="kimi-stream-work-") as folder:
        bridge = acp_bridge.AcpBridge([], folder, "kimi", "workspace")
        run = {"cli": "kimi", "segment": 1}
        frames = []
        sequence = 0
        for step in case["steps"]:
            native = []
            with patch.object(acp_bridge, "_emit", side_effect=native.append):
                if step.get("finish"):
                    bridge._flush_message()
                elif "update" in step:
                    bridge._update(step["update"])
            rows = []
            for event in native:
                for row in local_stream._items_from(event, run):
                    sequence += 1
                    rows.append({**row, "seq": sequence, "round": 1, "seg": 1})
            frames.append({"items": rows, "checkpoint": step.get("checkpoint"),
                           "finished": bool(step.get("finish"))})
        result.append({"name": case["name"], "frames": frames})
print(json.dumps(result, ensure_ascii=False))
`;
    const env = { ...process.env, HOME: scratch, USERPROFILE: scratch,
      APPDATA: scratch, LOCALAPPDATA: scratch, SODUWORK_DATA_ROOT: scratch,
      SODUWORK_APPROVAL_CHANNEL: '', PYTHONDONTWRITEBYTECODE: '1' };
    let bridgeSource = '';
    if (baselineIndex >= 0) {
      assert.match(baselineRef || '', /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/, 'baseline must be a Git ref');
      bridgeSource = execFileSync('git', ['show', baselineRef + ':hub-backend/app/services/acp_bridge.py'],
        { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    }
    return JSON.parse(execFileSync(python, ['-c', script], { cwd: path.join(root, 'hub-backend'),
      env, input: JSON.stringify({ cases, bridgeSource }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }));
  }
  async function render(state, finished) {
    await run(`ctx._snap = ${JSON.stringify({ ...state, status: finished ? 'idle' : 'streaming' })}; renderer._render(); void 0;`);
    // Wait for the production Markdown throttle, then inspect the rendered DOM.
    await new Promise(resolve => setTimeout(resolve, 90));
    return run(`(() => {
      renderer._render(); const list=document.querySelector('#nchatList');
      return { textRows:[...list.querySelectorAll('.nmsg.ai > .ntext')].map(node=>node.textContent.trim()),
        headings:[...list.querySelectorAll('.ntext h2')].map(node=>node.textContent),
        tables:[...list.querySelectorAll('.ntext table')].map(node=>({rows:node.rows.length,text:node.textContent})),
        code:[...list.querySelectorAll('.ntext pre code')].map(node=>node.textContent),
        thoughts:[...list.querySelectorAll('.nthink-body')].map(node=>node.textContent),
        sourceMessages:ctx._snap.messages.filter(row=>row.role==='assistant').map(row=>({done:row.done,blocks:row.blocks})) };
    })()`);
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1200, height: 850, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
      report.externalRequests.push(request.url); callback({ cancel: true });
    });
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    const paragraph = '## 合成验证\n\n这是一段连续的中文回答，不应因为空思考事件被拆成许多短行。\n\n';
    const table = '| 项目 | 结果 |\n| --- | --- |\n| 流式正文 | 完整 |\n\n';
    const code = '```js\nconst greeting = "你好";\nconsole.log(greeting);\n```\n\n';
    const end = '最后一段仍然保留正常排版。';
    const full = paragraph + table + code + end;
    const cases = [
      { name: 'empty-thoughts-preserve-streamed-markdown', steps: [
        ...chunks(paragraph), { checkpoint: 'paragraph' },
        ...chunks(table), { checkpoint: 'table' },
        ...chunks(code), { checkpoint: 'code' },
        ...chunks(end), { checkpoint: 'complete-live' }, { finish: true, checkpoint: 'settled' },
      ] },
      { name: 'real-thought-and-tool-boundaries-remain-distinct', steps: [
        ...chunks('先解释当前任务。'), { update: update('agent_thought_chunk', '真实思考：需要先检查。') },
        ...chunks('检查前的说明。'), { update: { sessionUpdate: 'tool_call', toolCallId: 'synthetic-inspect',
          title: 'Inspect synthetic file', kind: 'read', rawInput: { path: 'fixture.txt' } } },
        { update: { sessionUpdate: 'tool_call_update', toolCallId: 'synthetic-inspect', status: 'completed',
          content: [{ type: 'text', text: 'Synthetic inspection completed.' }] } },
        ...chunks('检查后的最终回答。'), { checkpoint: 'boundaries-live' }, { finish: true, checkpoint: 'boundaries-settled' },
      ] },
    ];
    const projected = project(cases);
    for (const scenario of projected) {
      await run('renderer.reset(); ctx._ref=' + JSON.stringify(scenario.name) + ';void 0;');
      const state = { adapterId: 'kimi', round: 1, messages: [{ role: 'user', text: 'Synthetic formatting request' }], tools: [] };
      const stream = create(state), checks = [], tools = [];
      for (const frame of scenario.frames) {
        for (const item of frame.items) {
          if (!stream.apply(item, String(item.full || item.text || ''))) tools.push(item);
        }
        if (frame.finished) stream.finish();
        if (!frame.checkpoint) continue;
        const observed = await render(state, frame.finished);
        fs.writeFileSync(path.join(output, scenario.name + '-' + frame.checkpoint + '.png'),
          (await win.webContents.capturePage()).toPNG());
        const texts = state.messages.filter(row => row.role === 'assistant' && row.blocks[0]?.kind === 'text');
        if (scenario.name.startsWith('empty-thoughts')) {
          assert.equal(texts.length, 1, frame.checkpoint + ': empty thoughts cannot split one answer');
          assert.equal(observed.textRows.length, 1, frame.checkpoint + ': one Markdown container during generation');
          assert.equal(observed.thoughts.length, 0, 'empty thoughts do not render blank activity');
          assert.deepEqual(observed.headings, ['合成验证']);
          if (frame.checkpoint !== 'paragraph') {
            assert.equal(observed.tables.length, 1); assert.equal(observed.tables[0].rows, 2);
          }
          if (['code', 'complete-live', 'settled'].includes(frame.checkpoint)) {
            assert.deepEqual(observed.code, ['const greeting = "你好";\nconsole.log(greeting);\n']);
          }
          if (['complete-live', 'settled'].includes(frame.checkpoint)) assert.equal(texts[0].blocks[0].text, full);
          assert.equal(texts[0].done, frame.finished, 'settlement closes the existing answer');
        } else {
          assert.deepEqual(texts.map(row => row.blocks[0].text), ['先解释当前任务。', '检查前的说明。', '检查后的最终回答。']);
          assert.deepEqual(observed.textRows, ['先解释当前任务。', '检查前的说明。', '检查后的最终回答。']);
          assert.deepEqual(observed.thoughts, ['真实思考：需要先检查。']);
          assert.deepEqual(tools.map(row => row.kind), ['do', 'out'], 'real tool events remain in their own channel');
        }
        checks.push({ checkpoint: frame.checkpoint, textRows: observed.textRows.length,
          thoughts: observed.thoughts.length, tables: observed.tables.length, codeBlocks: observed.code.length });
      }
      report.cases.push({ name: scenario.name, ok: true, checks });
    }
    assert.equal(report.externalRequests.length, 0);
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (!process.env.SODUWORK_KIMI_E2E_SCRATCH) fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(report.ok ? 0 : 1);
  });
}
